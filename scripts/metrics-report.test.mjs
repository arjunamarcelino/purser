import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { aggregate, median, p95 } from "./metrics-report.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => path.join(here, "metrics-fixtures", n);
const cli = path.join(here, "metrics-report.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "metrics-test-"));
const run = (dir, out) => spawnSync(process.execPath, [cli, "--in", dir, "--out", out], { encoding: "utf8" });

test("stat helpers", () => {
  assert.equal(median([3n, 1n, 2n]), 2n);
  assert.equal(median([1, 2, 3, 4]), 2n);
  assert.equal(p95(Array.from({ length: 20 }, (_, i) => i + 1)), 19n);
});

test("good fixtures produce a report with expected medians", () => {
  const out = path.join(tmp(), "METRICS.test.md");
  const r = run(fx("good"), out);
  assert.equal(r.status, 0, r.stderr);
  const md = fs.readFileSync(out, "utf8");
  assert.match(md, /measured on our harness/);
  assert.match(md, /make metrics/);
  assert.match(md, /mock signer and excludes the real signer/);
  assert.match(md, /Added wall time = .* \*\*200 ms\*\*/); // 1230 - 1030 pooled medians
  assert.match(md, /median 3, p95 4, range 3 to 4/); // blocks 3,3,4
  assert.match(md, /case_1_three_delegates_legit_purchases_succeed` \| 3\/3 \| core/);
  assert.match(md, /case_2b_external_parallel_dispatch_races` \| 3\/3/);
  assert.doesNotMatch(md, /QUICK run/);
  assert.deepEqual(fs.readdirSync(path.dirname(out)), ["METRICS.test.md"]); // no temp file left
});

test("nonzero overrun exits nonzero and writes nothing", () => {
  const d = tmp();
  const out = path.join(d, "out.md");
  const r = run(fx("overrun"), out);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /count\.overrun nonzero/);
  assert.deepEqual(fs.readdirSync(d), []);
});

test("missing required metric throws", () => {
  assert.throws(() => aggregate(fx("missing")), /storage\.commitment_bytes absent/);
  const d = tmp();
  const r = run(fx("missing"), path.join(d, "out.md"));
  assert.notEqual(r.status, 0);
  assert.deepEqual(fs.readdirSync(d), []);
});

test("quick runs are bannered and refuse METRICS.md", () => {
  const q = tmp();
  fs.cpSync(fx("good"), q, { recursive: true });
  const mp = path.join(q, "runs", "meta.json");
  const meta = JSON.parse(fs.readFileSync(mp, "utf8"));
  meta.quick = true;
  fs.writeFileSync(mp, JSON.stringify(meta));
  const d = tmp();
  const bad = run(q, path.join(d, "METRICS.md"));
  assert.notEqual(bad.status, 0);
  assert.deepEqual(fs.readdirSync(d), []);
  const ok = run(q, path.join(d, "METRICS.quick.md"));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(fs.readFileSync(path.join(d, "METRICS.quick.md"), "utf8"), /QUICK run, not the published report/);
});

test("a failed core case blocks output", () => {
  const q = tmp();
  fs.cpSync(fx("good"), q, { recursive: true });
  const f = path.join(q, "runs", "attacks-2.tsv");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("case_5_tampered_recipient_rejected\t0", "case_5_tampered_recipient_rejected\t101"));
  const d = tmp();
  const r = run(q, path.join(d, "out.md"));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /case_5.* passed 2\/3/);
  assert.deepEqual(fs.readdirSync(d), []);
});
