#!/usr/bin/env node
// Rewrite the evidence table in README.md from docs/METRICS.json (written by `make metrics`).
// The table sits between the metrics:begin / metrics:end markers; nothing in it is typed by hand.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const m = JSON.parse(fs.readFileSync(path.join(root, "docs", "METRICS.json"), "utf8"));
if (m.quick) {
  console.error("readme-evidence: refusing a QUICK summary");
  process.exit(1);
}
const T = (g) => (g / 1e12).toFixed(2);
const c = m.counters;
const rows = [
  ["Budget overruns", `**${c.overrun.total}** across ${c.overrun.over} concurrent race runs (target 0)`],
  ["Duplicate authorizations", `**${c.duplicate.total}** across ${c.duplicate.over} \`(delegate, request_id)\` pairs (target 0)`],
  ["Valid requests wrongly blocked", `**${c.wrongly_blocked.total}** of ${c.wrongly_blocked.over} (target 0)`],
  ["Attack suite", `${m.attack_core_cases} core cases, ${m.attack_core_all_pass ? "each passing" : "NOT all passing"} ${m.n}/${m.n}, plus the racing variants and the fault-build guard`],
  ["Property tests", `invariant held over ${m.proptest_cases.core.toLocaleString("en-US")} + ${m.proptest_cases.contract.toLocaleString("en-US")} generated sequences`],
  ["Timeouts and retries", `${m.timeout.release_on_silence} releases on silence, ${m.timeout.duplicate_on_retry} duplicates on retry, reservation retained in ${m.timeout.reservation_retained}/${m.n} runs`],
  ["Added latency per authorization", `+${m.latency.added_wall_ms} ms wall (sandbox, not testnet); ${m.latency.blocks_admit_to_settle_median} blocks from admission to settlement`],
  ["Gas per authorization", `${T(m.gas.propose_median)} Tgas (propose) + ${T(m.gas.settle_median)} Tgas (settlement callback) = ${T(m.gas.sum_median)} Tgas`],
  ["Storage per commitment", `${m.storage_bytes_per_commitment_median} bytes`],
];
const table = ["| Metric | Measured on our harness |", "|---|---|", ...rows.map(([a, b]) => `| ${a} | ${b} |`)].join("\n");
const block = `<!-- metrics:begin -->\n${table}\n\nRun: N=${m.n}, commit \`${m.git_sha.slice(0, 12)}\`${m.dirty ? " (dirty tree)" : ""}, wasm sha256 \`${m.wasm_sha256.slice(0, 16)}…\`. Reproduce with \`make metrics\`.\n<!-- metrics:end -->`;
const file = path.join(root, "README.md");
const readme = fs.readFileSync(file, "utf8");
const re = /<!-- metrics:begin -->[\s\S]*?<!-- metrics:end -->/;
if (!re.test(readme)) {
  console.error("readme-evidence: markers not found in README.md");
  process.exit(1);
}
fs.writeFileSync(file, readme.replace(re, () => block));
console.log("readme-evidence: README.md updated");
