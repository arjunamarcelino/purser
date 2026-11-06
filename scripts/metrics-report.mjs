#!/usr/bin/env node
// Aggregates raw metrics-harness runs into a markdown report.
// usage: node scripts/metrics-report.mjs --in <dir> --out <file.md>
// <dir> holds runs/attacks-<i>.tsv, runs/metrics-<i>.log, runs/proptest.log, runs/meta.json.
// Fails closed: any broken check exits nonzero and writes nothing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LINE = /^METRIC ([a-z_.]+) (-?\d+) ?(.*)$/;

export const REQUIRED = [
  "count.overrun", "count.duplicate", "count.wrongly_blocked",
  "gas.propose", "gas.settle",
  "lat.blocks_admit_to_settle", "lat.wall_ms",
  "storage.commitment_bytes",
  "timeout.release_on_silence", "timeout.duplicate_on_retry", "timeout.reservation_retained",
];
const ZERO_CHECKS = [
  "count.overrun", "count.duplicate", "count.wrongly_blocked",
  "timeout.release_on_silence", "timeout.duplicate_on_retry",
];

export function parseMetrics(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    // libtest prints "test <name> ... " before the first line a test writes with --nocapture, so the
    // first METRIC of every test sits behind that prefix; strip exactly that, nothing looser.
    const line = raw.replace(/\r$/, "").replace(/^test \S+ \.\.\. (?=METRIC )/, "");
    if (!line.startsWith("METRIC ")) continue;
    const m = LINE.exec(line);
    if (!m) throw new Error(`malformed METRIC line: ${line}`);
    const tags = {};
    for (const kv of m[3].split(/\s+/).filter(Boolean)) {
      const i = kv.indexOf("=");
      if (i < 1) throw new Error(`malformed tag '${kv}' in: ${line}`);
      tags[kv.slice(0, i)] = kv.slice(i + 1);
    }
    out.push({ name: m[1], value: BigInt(m[2]), tags });
  }
  return out;
}

const big = (v) => (typeof v === "bigint" ? v : BigInt(v));
function sorted(xs) { return [...xs].map(big).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); }
export function median(xs) {
  const s = sorted(xs);
  if (!s.length) throw new Error("median of empty set");
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2n;
}
export function p95(xs) {
  const s = sorted(xs);
  if (!s.length) throw new Error("p95 of empty set");
  return s[Math.max(0, Math.ceil(0.95 * s.length) - 1)];
}
export function stats(xs) {
  const s = sorted(xs);
  return { n: s.length, min: s[0], median: median(s), p95: p95(s), max: s[s.length - 1] };
}
const fmt = (v) => big(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const statsCells = (s) => `${s.n} | ${fmt(s.min)} | ${fmt(s.median)} | ${fmt(s.p95)} | ${fmt(s.max)}`;

function readIndexed(dir, prefix, ext) {
  const runsDir = path.join(dir, "runs");
  if (!fs.existsSync(runsDir)) throw new Error(`missing ${runsDir}`);
  const re = new RegExp(`^${prefix}-(\\d+)\\.${ext}$`);
  return fs.readdirSync(runsDir)
    .map((f) => ({ f, m: re.exec(f) }))
    .filter((x) => x.m)
    .map((x) => ({ i: Number(x.m[1]), text: fs.readFileSync(path.join(runsDir, x.f), "utf8") }))
    .sort((a, b) => a.i - b.i);
}

function parseTsv(text, label) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length !== 2 || !/^-?\d+$/.test(parts[1])) throw new Error(`${label}: bad TSV line '${line}'`);
    rows.push({ name: parts[0], exit: Number(parts[1]) });
  }
  return rows;
}

// Throws on structural problems (missing metric, count mismatch). Returns {failures, markdown}.
export function aggregate(dir) {
  const metaPath = path.join(dir, "runs", "meta.json");
  if (!fs.existsSync(metaPath)) throw new Error(`missing ${metaPath}`);
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const N = Number(meta.n ?? meta.N);
  if (!Number.isInteger(N) || N < 1) throw new Error("meta.json: n must be a positive integer");

  const attacks = readIndexed(dir, "attacks", "tsv");
  const mlogs = readIndexed(dir, "metrics", "log");
  if (attacks.length !== N) throw new Error(`expected ${N} attacks-<i>.tsv, found ${attacks.length}`);
  if (mlogs.length !== N) throw new Error(`expected ${N} metrics-<i>.log, found ${mlogs.length}`);

  const failures = [];

  // Per-case results.
  const perRun = attacks.map((a) => parseTsv(a.text, `attacks-${a.i}.tsv`));
  const caseNames = perRun[0].map((r) => r.name).sort();
  if (!caseNames.length) throw new Error("attacks-*.tsv has no cases");
  perRun.forEach((rows, k) => {
    const names = rows.map((r) => r.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(caseNames)) {
      throw new Error(`attacks run ${attacks[k].i} case set differs from run ${attacks[0].i} (running != expected)`);
    }
  });
  const passes = new Map(caseNames.map((n) => [n, 0]));
  for (const rows of perRun) for (const r of rows) if (r.exit === 0) passes.set(r.name, passes.get(r.name) + 1);
  const isRace = (n) => /^case_\d+b_/.test(n);
  const isCore = (n) => /^case_\d+_/.test(n);
  const coreNames = caseNames.filter(isCore);
  if (coreNames.length === 0) throw new Error("no core case_<n>_ cases found");
  for (const n of coreNames) if (passes.get(n) !== N) failures.push(`core case ${n} passed ${passes.get(n)}/${N}`);
  for (const n of caseNames.filter((x) => !isCore(x) && !isRace(x))) {
    if (passes.get(n) !== N) failures.push(`guard test ${n} passed ${passes.get(n)}/${N}`);
  }

  // METRIC lines.
  const runs = mlogs.map((l) => parseMetrics(l.text));
  runs.forEach((ms, k) => {
    for (const req of REQUIRED) {
      if (!ms.some((m) => m.name === req)) throw new Error(`required metric ${req} absent in metrics-${mlogs[k].i}.log`);
    }
  });
  const all = runs.flat();
  const by = (name, pred = () => true) => all.filter((m) => m.name === name && pred(m));
  const vals = (ms) => ms.map((m) => m.value);

  for (const name of ZERO_CHECKS) {
    const bad = by(name).filter((m) => m.value !== 0n);
    if (bad.length) failures.push(`${name} nonzero in ${bad.length} sample(s): ${bad.map((m) => m.value).join(",")}`);
  }
  const retained = by("timeout.reservation_retained").filter((m) => m.value !== 1n);
  if (retained.length) failures.push(`timeout.reservation_retained != 1 in ${retained.length} sample(s)`);

  // Proptest (run once).
  const ptPath = path.join(dir, "runs", "proptest.log");
  if (!fs.existsSync(ptPath)) throw new Error(`missing ${ptPath}`);
  const ptText = fs.readFileSync(ptPath, "utf8");
  const pt = parseMetrics(ptText).filter((m) => m.name === "proptest.cases");
  if (!pt.length) throw new Error("required metric proptest.cases absent in proptest.log");
  const ptResult = /test result: (\w+)\. (\d+) passed; (\d+) failed/.exec(ptText);
  if (!ptResult) throw new Error("proptest.log has no libtest result line");
  if (ptResult[1] !== "ok" || ptResult[3] !== "0") failures.push(`proptest run: ${ptResult[0]}`);

  // Report data.
  const sumTag = (name, tag) => by(name).reduce((s, m) => s + BigInt(m.tags[tag] ?? 0), 0n);
  const counts = [
    ["count.overrun", "runs", "merchant balance deltas vs cap, cross-checked against payment_confirmed receipts"],
    ["count.duplicate", "pairs", "(delegate, request_id) pairs: payment_reserved events and merchant transfers vs distinct ids"],
    ["count.wrongly_blocked", "valid", "valid serial requests refused (valid/hostile tagged at generation)"],
  ].map(([name, tag, what]) => ({
    name, what, total: vals(by(name)).reduce((a, b) => a + b, 0n), denom: sumTag(name, tag), tag, samples: by(name).length,
  }));

  const gasRound = (m) => m.tags.round === undefined || Number(m.tags.round) >= 3;
  const gasRows = [];
  for (const [label, name, filt] of [
    ["propose_payment receipt (NEAR)", "gas.propose", (m) => (m.tags.path ?? "near") === "near" && gasRound(m)],
    ["on_near_settled receipt (NEAR)", "gas.settle", (m) => (m.tags.path ?? "near") === "near" && gasRound(m)],
  ]) {
    const ms = by(name, filt);
    if (!ms.length) throw new Error(`no ${name} samples left after round>=3 filter`);
    gasRows.push({ label, s: stats(vals(ms)) });
  }
  const pairSum = [];
  runs.forEach((ms) => {
    const p = ms.filter((m) => m.name === "gas.propose" && (m.tags.path ?? "near") === "near" && gasRound(m));
    const s = ms.filter((m) => m.name === "gas.settle" && (m.tags.path ?? "near") === "near" && gasRound(m));
    if (p.length && s.length) pairSum.push(median(vals(p)) + median(vals(s)));
  });
  if (pairSum.length) gasRows.push({ label: "sum of the two (per-run medians)", s: stats(pairSum) });
  const evmGas = [];
  for (const [label, name] of [["EVM propose (mock signer)", "gas.evm.propose"], ["EVM settle (mock signer)", "gas.evm.settle"]]) {
    const ms = by(name);
    if (ms.length) evmGas.push({ label, s: stats(vals(ms)) });
  }

  const blocks = stats(vals(by("lat.blocks_admit_to_settle")));
  const wallProp = by("lat.wall_ms", (m) => m.tags.arm === "propose");
  const wallBase = by("lat.wall_ms", (m) => m.tags.arm === "baseline");
  if (!wallProp.length || !wallBase.length) throw new Error("lat.wall_ms needs both arm=propose and arm=baseline samples");
  const sp = stats(vals(wallProp));
  const sb = stats(vals(wallBase));
  const added = sp.median - sb.median;

  const storage = stats(vals(by("storage.commitment_bytes")));
  const race = [];
  for (const n of caseNames.filter(isRace)) {
    const key = n.match(/^case_(\d+b)_/)[1];
    const att = by("race.attempts", (m) => m.tags.case === key);
    race.push({ name: n, pass: passes.get(n), att: att.length ? stats(vals(att)) : null });
  }
  const rel = (n) => passes.get(n);

  const timeouts = ["timeout.release_on_silence", "timeout.duplicate_on_retry", "timeout.reservation_retained"].map((name) => {
    const v = by(name);
    return { name, total: vals(v).reduce((a, b) => a + b, 0n), samples: v.length };
  });

  // Markdown.
  const L = [];
  const quick = Boolean(meta.quick);
  if (quick) L.push("> **QUICK run, not the published report.** Reduced repeats and proptest depth. Do not cite these numbers.", "");
  L.push("# Purser metrics", "");
  L.push("Everything below is **measured on our harness**: a local near-workspaces sandbox, not testnet or mainnet. Block times, gas and latency on a live network will differ. Nothing here is an audit or a proof; it is the observed behavior of the shipped wasm under the listed workload.", "");
  L.push("Reproduce: `make metrics` (from a clean checkout; `QUICK=1 make metrics` for a short run).", "");
  L.push("## Run header", "", "| Field | Value |", "|---|---|");
  const hdr = [
    ["git sha", `${meta.git_sha ?? "unknown"}${meta.dirty ? " (dirty tree)" : ""}`],
    ["wasm sha256", meta.wasm_sha256 ?? "unknown"],
    ["nearcore / workspaces", meta.nearcore_version ?? "unknown"],
    ["toolchain", meta.toolchain ?? "unknown"],
    ["date", meta.date ?? "unknown"],
    ["repeats (N)", String(N)],
    ["mode", quick ? "QUICK" : "full"],
  ];
  for (const [k, v] of hdr) L.push(`| ${k} | \`${v}\` |`);
  L.push("");

  L.push("## Safety counters (must all be zero)", "");
  L.push("| Counter | Total | Over | What it counts |", "|---|---|---|---|");
  for (const c of counts) L.push(`| \`${c.name}\` | ${c.total} | ${c.denom} ${c.tag} across ${c.samples} run(s) | ${c.what} |`);
  L.push("");
  L.push("Not counted: anything outside the generated workload, other chains, or a hostile owner. Oracles are independent of the contract's own accounting view, so a bug there cannot hide itself.", "");

  L.push("## Timeout behavior", "", "| Metric | Total | Samples | Meaning |", "|---|---|---|---|");
  const tmean = {
    "timeout.release_on_silence": "reservations released although no outcome was known (expected 0)",
    "timeout.duplicate_on_retry": "duplicate payments after retry past the timeout (expected 0)",
    "timeout.reservation_retained": "1 = reservation kept on an unknown outcome (expected 1 each run)",
  };
  for (const t of timeouts) L.push(`| \`${t.name}\` | ${t.total} | ${t.samples} | ${tmean[t.name]} |`);
  L.push("");

  L.push("## Attack suite (each case run alone, N times)", "");
  L.push("Core cases must pass N/N. Racing cases (2b/4b) depend on real scheduling; their attempt counts are shown and any failure is disclosed here, not hidden.", "");
  L.push("| Case | Passed | Kind |", "|---|---|---|");
  for (const n of caseNames.filter((x) => !isRace(x))) L.push(`| \`${n}\` | ${rel(n)}/${N} | ${isCore(n) ? "core" : "guard"} |`);
  L.push("");
  if (race.length) {
    L.push("| Racing case | Passed | Attempts needed (n, min / median / p95 / max) |", "|---|---|---|");
    for (const r of race) {
      L.push(`| \`${r.name}\` | ${r.pass}/${N} | ${r.att ? `${r.att.n} samples: ${fmt(r.att.min)} / ${fmt(r.att.median)} / ${fmt(r.att.p95)} / ${fmt(r.att.max)}` : "no race.attempts emitted"} |`);
    }
    L.push("");
  }

  L.push("## Gas (NEAR path)", "");
  L.push("Rounds before 3 are dropped as warm-up. Units are gas burnt.", "");
  L.push("| Receipt | n | min | median | p95 | max |", "|---|---|---|---|---|---|");
  for (const g of gasRows) L.push(`| ${g.label} | ${statsCells(g.s)} |`);
  L.push("", "Counts: gas burnt by the propose receipt and the `on_near_settled` receipt. Does not count: the transfer receipt itself, tx-to-receipt conversion, or attached-gas prepay.", "");
  if (evmGas.length) {
    L.push("| EVM receipt | n | min | median | p95 | max |", "|---|---|---|---|---|---|");
    for (const g of evmGas) L.push(`| ${g.label} | ${statsCells(g.s)} |`);
    L.push("", "EVM gas uses the mock signer and excludes the real signer's yield/resume cost. Live figures are recorded beside the tests in `contract/tests/evm.rs`.", "");
  }

  L.push("## Latency (sandbox, not testnet)", "");
  L.push(`Blocks from admission to settlement (from receipt heights): median ${fmt(blocks.median)}, p95 ${fmt(blocks.p95)}, range ${fmt(blocks.min)} to ${fmt(blocks.max)} (n=${blocks.n}).`, "");
  L.push("| Arm | n | min ms | median ms | p95 ms | max ms |", "|---|---|---|---|---|---|");
  L.push(`| propose_payment | ${statsCells(sp)} |`, `| baseline transfer | ${statsCells(sb)} |`, "");
  L.push(`Added wall time = median(propose) - median(baseline) = **${fmt(added)} ms** (sandbox). Sandbox wall-clock is dominated by block time and polling, so read the block count above as the honest figure. No means are reported.`, "");

  L.push("## Storage", "");
  L.push(`Bytes per admitted commitment: median ${fmt(storage.median)}, range ${fmt(storage.min)} to ${fmt(storage.max)} (n=${storage.n}). Counts the commitment record; the idempotency entry and the owner-paid stake are described in the README limits.`, "");

  L.push("## Property tests (run once)", "");
  L.push("| Test | Cases run (emitted by the test) |", "|---|---|");
  for (const m of pt) L.push(`| \`${m.tags.test ?? "?"}\` | ${fmt(m.value)} |`);
  L.push("", `libtest: \`${ptResult[0]}\``, "");

  L.push("## What this does not show", "");
  L.push("- Testnet or mainnet behavior, real block times, or real signer latency.", "- Behavior of a deployed contract other than the wasm hashed above.", "- Absence of bugs outside the generated workload.", "");

  const core = caseNames.filter((n) => /^case_\d+_/.test(n));
  const summary = {
    note: "Measured on our harness (local sandbox). Generated by scripts/metrics-report.mjs; do not edit.",
    git_sha: meta.git_sha, dirty: !!meta.dirty, wasm_sha256: meta.wasm_sha256, n: N, quick,
    counters: Object.fromEntries(counts.map((c) => [c.name.replace("count.", ""), { total: Number(c.total), over: Number(c.denom), unit: c.tag }])),
    timeout: Object.fromEntries(["release_on_silence", "duplicate_on_retry", "reservation_retained"].map((k) => [k, by(`timeout.${k}`).reduce((a, m) => a + Number(m.value), 0)])),
    attack_core_cases: core.length, attack_core_all_pass: core.every((n) => passes.get(n) === N),
    gas: { propose_median: Number(gasRows[0].s.median), settle_median: Number(gasRows[1].s.median), sum_median: gasRows[2] ? Number(gasRows[2].s.median) : null },
    latency: { blocks_admit_to_settle_median: Number(blocks.median), added_wall_ms: Number(added), propose_median_ms: Number(sp.median), baseline_median_ms: Number(sb.median) },
    storage_bytes_per_commitment_median: Number(storage.median),
    proptest_cases: Object.fromEntries(pt.map((m) => [m.tags.test ?? "?", Number(m.value)])),
  };
  return { failures, markdown: L.join("\n"), quick, summary };
}

export function writeAtomic(out, markdown) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, markdown);
  fs.renameSync(tmp, out);
}

function main() {
  const a = process.argv.slice(2);
  const arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const dir = arg("--in");
  const out = arg("--out");
  if (!dir || !out) { console.error("usage: metrics-report.mjs --in <dir> --out <file.md>"); process.exit(2); }
  let res;
  try { res = aggregate(dir); } catch (e) { console.error(`metrics-report: ${e.message}`); process.exit(1); }
  const outAbs = path.resolve(out);
  const base = path.basename(outAbs);
  if (res.quick && base === "METRICS.md") {
    console.error("metrics-report: a QUICK run must not write METRICS.md; use docs/METRICS.quick.md");
    process.exit(1);
  }
  if (res.quick && base !== "METRICS.quick.md") {
    console.error("metrics-report: a QUICK run must write to a file named METRICS.quick.md");
    process.exit(1);
  }
  if (res.failures.length) {
    for (const f of res.failures) console.error(`metrics-report: CHECK FAILED: ${f}`);
    process.exit(1);
  }
  writeAtomic(outAbs, res.markdown);
  writeAtomic(outAbs.replace(/\.md$/, ".json"), JSON.stringify(res.summary, null, 2) + "\n");
  console.log(`metrics-report: wrote ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
