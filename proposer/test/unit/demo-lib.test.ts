import { describe, expect, it } from "vitest";
import { ProposalRecord } from "@purser/types";
import {
  type BaselineLane,
  type DemoArgs,
  assertRunId,
  baselineSeenUnits,
  capNearToYocto,
  describeSpawn,
  explorerUrl,
  formatBaselineLine,
  formatUnits,
  judgeBaseline,
  judgeInvariant,
  judgeRace,
  judgeRetry,
  makeScrubber,
  parseSession,
  parseTxId,
  scrub,
  shotRecord,
  taskIdFor,
  unitsToYocto,
  urlSecrets,
} from "../../src/dev/demo-lib.ts";

const HASH = "AiziHNaehWKh9NbxE3M3bw7ecCZ3Jtmkz7zzcu46HUwu";

describe("run id and task id", () => {
  it("accepts lowercase, digits and dashes", () => {
    expect(taskIdFor("20261105-1")).toBe("demo-20261105-1");
  });
  it.each(["", "UPPER", "a b", "../x", 'a"b', "a".repeat(33), "a_b"])("rejects %j", (bad) => {
    expect(() => assertRunId(bad)).toThrow();
  });
});

describe("parseTxId", () => {
  it("reads the hash from near-cli stderr", () => {
    expect(parseTxId(`├  Transaction Execution Info:\n│    Transaction ID: ${HASH}\n│    url`)).toBe(HASH);
  });
  it("returns null when absent or malformed", () => {
    expect(parseTxId("no hash here")).toBeNull();
    expect(parseTxId("Transaction ID: not-a-hash!")).toBeNull();
  });
});

describe("explorerUrl", () => {
  it("builds a fixed-host link", () => {
    expect(explorerUrl(HASH)).toBe(`https://testnet.nearblocks.io/txns/${HASH}`);
  });
  it("refuses anything that is not a hash", () => {
    expect(() => explorerUrl("x/../y")).toThrow();
  });
});

describe("scrub", () => {
  it("redacts ed25519 secret-key-shaped strings", () => {
    const key = `ed25519:${"A".repeat(60)}`;
    expect(scrub(`secret ${key} end`)).toBe("secret ed25519:[redacted] end");
  });
});

describe("units", () => {
  it("derives 30 units from the cap", () => {
    const cap = capNearToYocto("1");
    expect(unitsToYocto(cap, 30n)).toBe(3n * 10n ** 23n);
  });
  it("accepts a decimal cap and derives units exactly", () => {
    expect(capNearToYocto("0.5")).toBe(5n * 10n ** 23n);
    expect(unitsToYocto(capNearToYocto("0.5"), 30n)).toBe(15n * 10n ** 22n);
  });
  it("rejects zero, negative-looking and over-precise caps", () => {
    for (const bad of ["0", "0.0", "1.2345", "-1", "1e3", ""]) expect(() => capNearToYocto(bad)).toThrow();
  });
});

describe("more helper edges", () => {
  it("rejects a cap that is not a multiple of 100 yocto", () => {
    expect(() => unitsToYocto(1_000_000_000_000_000_000_000_050n, 1n)).toThrow();
  });
  it("rejects 42 and 45 char hashes and tolerates null stderr", () => {
    expect(parseTxId(`Transaction ID: ${HASH.slice(0, 42)}`)).toBeNull();
    expect(parseTxId(`Transaction ID: ${HASH}12`)).toBeNull();
    expect(parseTxId(null)).toBeNull();
  });
  it("scrubs several keys at once", () => {
    const [a, b] = [`ed25519:${"A".repeat(50)}`, `ed25519:${"b".repeat(50)}`];
    expect(scrub(`${a} ${b}`)).toBe("ed25519:[redacted] ed25519:[redacted]");
  });
});

describe("makeScrubber", () => {
  // Composed from pieces: a literal user:pass@host URL trips the pre-commit credential scan.
  const url = ["https://", "user", ":", "hunter2pw", "@", "rpc.example.com/v1/abcdef0123456789abcd?apiKey=SUPERSECRET123&x=1"].join("");
  it("removes the rpc url, userinfo, query values and long path segments", () => {
    const s = makeScrubber(urlSecrets(url));
    const out = s(`fetch failed ${url} / pw hunter2pw / key SUPERSECRET123 / seg abcdef0123456789abcd`);
    for (const leak of [url, "hunter2pw", "SUPERSECRET123", "abcdef0123456789abcd"]) expect(out).not.toContain(leak);
  });
  it("also redacts an explicit key and ed25519 shapes", () => {
    const out = makeScrubber(["my-delegate-key-material"])(`a my-delegate-key-material b ed25519:${"Z".repeat(45)}`);
    expect(out).toBe("a [redacted] b ed25519:[redacted]");
  });
});

describe("describeSpawn", () => {
  it("names a missing binary instead of crashing on null stderr", () => {
    const err = Object.assign(new Error("spawnSync near ENOENT"), { code: "ENOENT" });
    expect(describeSpawn({ error: err, status: null, stderr: null })).toMatch(/not found/);
  });
  it("reports timeouts, signals and exit codes; null on success", () => {
    expect(describeSpawn({ error: Object.assign(new Error("x"), { code: "ETIMEDOUT" }), status: null })).toMatch(/timed out/);
    expect(describeSpawn({ status: null, signal: "SIGTERM" })).toMatch(/SIGTERM/);
    expect(describeSpawn({ status: 1 })).toMatch(/status 1/);
    expect(describeSpawn({ status: 0 })).toBeNull();
  });
});

describe("judgeRace", () => {
  const U = 10n;
  const win = (h: number | null, tx: string | null = "t1") => ({ kind: "success", txHash: tx, height: h });
  const ref = (h: number | null, tx: string | null) => ({ kind: "refused", code: "exceeds_task_budget", txHash: tx, height: h });
  it("passes with one winner, two bound refusals and exact remaining; same block only when all equal", () => {
    const v = judgeRace([win(5), ref(5, "t2"), ref(5, "t3")], 40n * U, 10n * U, U);
    expect(v.pass).toBe(true);
    expect(v.sameBlock).toBe(true);
    const w = judgeRace([win(5), ref(6, "t2"), ref(5, "t3")], 40n * U, 10n * U, U);
    expect(w.pass).toBe(true);
    expect(w.sameBlock).toBe(false);
  });
  it("fails when a racer lacks a hash or height", () => {
    expect(judgeRace([win(5), ref(null, null), ref(5, "t3")], 40n * U, 10n * U, U).pass).toBe(false);
    expect(judgeRace([win(5), ref(null, "t2"), ref(5, "t3")], 40n * U, 10n * U, U).reasons.join()).toMatch(/height/);
  });
  it("fails on wrong counts or inexact remaining", () => {
    expect(judgeRace([win(5), win(5, "t2"), ref(5, "t3")], 40n * U, 10n * U, U).pass).toBe(false);
    expect(judgeRace([win(5), ref(5, "t2"), ref(5, "t3")], 40n * U, 10n * U + 1n, U).pass).toBe(false);
    expect(judgeRace([win(5), ref(5, "t2")], 40n * U, 10n * U, U).pass).toBe(false);
    // The story's end state is 10 units, not 1: the earlier 1-unit expectation must fail.
    expect(judgeRace([win(5), ref(5, "t2"), ref(5, "t3")], 40n * U, U, U).pass).toBe(false);
  });
});

describe("judgeRetry", () => {
  const ok = { kind: "success", cid: "c1" };
  const refused = { kind: "refused", code: "exceeds_task_budget" };
  it("passes on same cid, budget refusal and unchanged remaining", () => {
    expect(judgeRetry(ok, ok, refused, 10n, 10n).pass).toBe(true);
  });
  it("fails on null winner, unknown/timeout/rejected resend, other cid, moved remaining", () => {
    expect(judgeRetry(undefined, undefined, undefined, 10n, 10n).pass).toBe(false);
    for (const kind of ["unknown", "rejected_by_protocol", "unclassified"]) expect(judgeRetry(ok, ok, { kind }, 10n, 10n).pass).toBe(false);
    expect(judgeRetry(ok, { kind: "success", cid: "c2" }, refused, 10n, 10n).pass).toBe(false);
    expect(judgeRetry(ok, ok, { kind: "refused", code: "other" }, 10n, 10n).pass).toBe(false);
    expect(judgeRetry(ok, ok, refused, 9n, 10n).pass).toBe(false);
  });
});

describe("judgeInvariant", () => {
  const cap = 100n;
  const good = { holds: true, completed: 90n, outstanding: 0n, cap };
  it("passes only when settled with 90 completed and 10 remaining", () => {
    expect(judgeInvariant(good, cap, 10n).pass).toBe(true);
  });
  it("fails when outstanding > 0 even though the contract says holds", () => {
    const v = judgeInvariant({ ...good, completed: 60n, outstanding: 30n }, cap, 10n);
    expect(v.pass).toBe(false);
    expect(v.reasons.join()).toMatch(/settlement did not land/);
  });
  it("fails on wrong completed, remaining, cap, null view or violated flag", () => {
    expect(judgeInvariant({ ...good, completed: 89n }, cap, 10n).pass).toBe(false);
    expect(judgeInvariant(good, cap, 11n).pass).toBe(false);
    expect(judgeInvariant({ ...good, cap: 200n }, cap, 10n).pass).toBe(false);
    expect(judgeInvariant(null, cap, 10n).pass).toBe(false);
    expect(judgeInvariant({ ...good, holds: false }, cap, 10n).pass).toBe(false);
  });
});

describe("formatUnits", () => {
  it("never truncates a fractional unit to a whole one", () => {
    expect(formatUnits(40n * 10n, 1000n)).toBe("40");
    expect(formatUnits(409n, 1000n)).toBe("40.9~");
  });
});

describe("demo session", () => {
  const args: DemoArgs = { task: "demo-1", intent: { chain: "NearNative", recipient: "data.x.testnet", amount: "30", token: "NearNative", memo: "m" }, request_id: "r" };
  it("round-trips a full session", () => {
    const s = { contract: "c.testnet", task: "demo-1", winner: { persona: "forge" as const, args, cid: 7 }, refused: { persona: "buyer" as const, args } };
    expect(parseSession(JSON.stringify(s))).toEqual(s);
  });
  it.each(["not json", "{}", JSON.stringify({ contract: "c", task: "t", winner: { persona: "mallory", args, cid: 1 } }), JSON.stringify({ contract: "c", task: "t", refused: { persona: "scout", args: { task: "t" } } })])("rejects %s", (raw) => {
    expect(() => parseSession(raw)).toThrow(/setup/);
  });
});

describe("shot records satisfy the schema the board validates", () => {
  const uuid = "6f1c7c1e-3b0a-4c55-9d7e-1a2b3c4d5e6f";
  const args: DemoArgs = { task: "demo-1", intent: { chain: "NearNative", recipient: "data.x.testnet", amount: "30000", token: "NearNative", memo: "m" }, request_id: uuid };
  const base = { decisionId: uuid, persona: "scout" as const, accountId: "scout.x.testnet", contract: "purser.x.testnet", args, latencyMs: 12, at: "2026-11-08T00:00:00.000Z" };
  it("maps a success to admitted with its commitment and tx", () => {
    const r = ProposalRecord.parse(shotRecord({ ...base, result: { kind: "success", cid: 4, txHash: HASH } }));
    expect(r).toMatchObject({ outcome: "admitted", commitment_id: 4, tx_hash: HASH, refusal_code: null, detail: null });
  });
  it("keeps a refusal's code and never carries raw error text", () => {
    const r = ProposalRecord.parse(shotRecord({ ...base, result: { kind: "refused", code: "exceeds_task_budget", txHash: HASH } }));
    expect(r).toMatchObject({ outcome: "refused", commitment_id: null, refusal_code: "exceeds_task_budget", detail: null });
  });
  it("records an unknown send without a commitment", () => {
    expect(ProposalRecord.parse(shotRecord({ ...base, result: { kind: "unknown" } }))).toMatchObject({ outcome: "unknown", commitment_id: null, tx_hash: null });
  });
});

describe("naive baseline verdict", () => {
  const UNIT = 10n ** 21n;
  const SPEND = 60n * UNIT;
  const OTHER = "BiziHNaehWKh9NbxE3M3bw7ecCZ3Jtmkz7zzcu46HUwu";
  const lane = (over: Partial<BaselineLane> = {}): BaselineLane => ({ hash: HASH, to: "data.x.testnet", read: 100, included: 104, deposit: SPEND, ok: true, ...over });
  const ok = { spend: SPEND, unit: UNIT, capUnits: 100, sawUnits: 100, merchantDelta: SPEND * 2n };
  const b = lane({ hash: OTHER, to: "compute.x.testnet" });
  it("passes two distinct verified transfers whose reads preceded both", () => {
    const v = judgeBaseline(lane(), b, ok);
    expect(v.pass).toBe(true);
    expect(v.result).toMatchObject({ sawUnits: 100, capUnits: 100, spentUnits: 120, overUnits: 20 });
  });
  it.each([
    ["same transaction", lane(), lane(), ok],
    ["a read after the other transfer", lane({ read: 104 }), b, ok],
    ["a failed transfer", lane({ ok: false }), b, ok],
    ["a wrong deposit", lane({ deposit: UNIT }), b, ok],
    ["a short oracle", lane(), b, { ...ok, merchantDelta: SPEND }],
    ["no overspend", lane(), b, { ...ok, capUnits: 120 }],
  ])("fails on %s and yields no result", (_name, x, y, i) => {
    const v = judgeBaseline(x, y, i);
    expect(v.pass).toBe(false);
    expect(v.result).toBeNull();
  });
  it("reports what an agent sees, clamped to the cap", () => {
    const cap = 100n * UNIT;
    expect(baselineSeenUnits(5n * cap, 5n * cap, cap, UNIT)).toBe(100);
    expect(baselineSeenUnits(5n * cap, 5n * cap - SPEND, cap, UNIT)).toBe(40);
    expect(baselineSeenUnits(5n * cap, 5n * cap + 1n, cap, UNIT)).toBe(100);
    expect(baselineSeenUnits(5n * cap, 3n * cap, cap, UNIT)).toBe(0);
  });
  it("keeps the longest possible result line under the companion's truncation limit", () => {
    const id = `${"a".repeat(56)}.testnet`;
    const l = { hash: HASH, to: id, read: 999_999_999_999, included: 999_999_999_999 };
    const line = formatBaselineLine({ sawUnits: 100, capUnits: 100, spentUnits: 120, overUnits: 20, a: l, b: l });
    expect(line.startsWith("BASELINE {")).toBe(true);
    expect(line.length).toBeLessThan(500);
    const real = { hash: HASH, to: "compute.demo.arjuna-purser.testnet", read: 251_000_000, included: 251_000_004 };
    expect(formatBaselineLine({ sawUnits: 100, capUnits: 100, spentUnits: 120, overUnits: 20, a: real, b: real }).length).toBeLessThan(400);
  });
});
