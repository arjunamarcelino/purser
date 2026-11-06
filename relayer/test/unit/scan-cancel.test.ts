import { describe, expect, it } from "vitest";
import { Relayer, SCAN_BATCH, cancelExitCode, requestCancel } from "../../src/worker.ts";
import { classifyNearStatus } from "../../src/near.ts";
import type { LogEvent } from "../../src/log.ts";
import { FakeChain, FakeNear } from "./fakes.ts";

const settle = (near: FakeNear, cid: number) => {
  const c = near.commits.get(cid);
  if (!c) throw new Error("no such commitment");
  c.state = "Confirmed";
  c.tx = { ...c.tx, state: "Confirmed" };
};
const snapshot = (near: FakeNear) => ({ ...near.views });
const delta = (a: ReturnType<typeof snapshot>, b: ReturnType<typeof snapshot>) => ({
  getCommitment: b.getCommitment - a.getCommitment,
  getSignedTx: b.getSignedTx - a.getSignedTx,
  getLane: b.getLane - a.getLane,
});

describe("scan cost", () => {
  it("counts view calls per tick: terminal ids are read once ever, each live id once per tick, lanes once", async () => {
    const chain = new FakeChain();
    chain.baseFee = 1_000n; // nothing mines: ids 3 and 4 stay live
    const near = new FakeNear();
    for (let cid = 0; cid < 5; cid++) await near.addSigned(cid, { maxFee: 10n });
    for (const cid of [0, 1, 2]) settle(near, cid);
    const relayer = new Relayer({ near, evm: [chain.client("provider#1")], log: () => {}, nowMs: () => 0 });

    const t0 = snapshot(near);
    expect(await relayer.tick()).toBe(2);
    const first = delta(t0, snapshot(near));
    // discovery: ids 0-3 then 4-7 (5 is the end; 6 and 7 were read in the same concurrent batch)
    expect(first).toEqual({ getCommitment: 2 * SCAN_BATCH, getSignedTx: 2, getLane: 1 });
    expect(near.maxConcurrentCommitmentReads).toBe(SCAN_BATCH); // concurrency is bounded

    const t1 = snapshot(near);
    expect(await relayer.tick()).toBe(2);
    // steady state: ONE probe past the end, one get_signed_tx per live id, no lane read, no terminal re-read
    expect(delta(t1, snapshot(near))).toEqual({ getCommitment: 1, getSignedTx: 2, getLane: 0 });

    settle(near, 3);
    const t2 = snapshot(near);
    await relayer.tick(); // learns id 3 is terminal from its single read
    const t3 = snapshot(near);
    await relayer.tick();
    expect(delta(t3, snapshot(near))).toEqual({ getCommitment: 1, getSignedTx: 1, getLane: 0 });
    expect(delta(t2, t3).getSignedTx).toBe(2);
  });

  it("a parked Unknown id does not make later ids be re-read through get_commitment", async () => {
    const chain = new FakeChain();
    chain.baseFee = 1_000n;
    const near = new FakeNear();
    for (let cid = 0; cid < 3; cid++) await near.addSigned(cid, { maxFee: 10n });
    const c0 = near.commits.get(0);
    if (c0) {
      c0.state = "Unknown";
      c0.tx = { ...c0.tx, state: "Unknown" };
    }
    const relayer = new Relayer({ near, evm: [chain.client("provider#1")], log: () => {}, nowMs: () => 0 });
    await relayer.tick();
    const t = snapshot(near);
    await relayer.tick();
    expect(delta(t, snapshot(near)).getCommitment).toBe(1);
  });

  it("still never skips an id it could not read, and resumes from it", async () => {
    const chain = new FakeChain();
    const near = new FakeNear();
    const events: LogEvent[] = [];
    for (let cid = 0; cid < 6; cid++) await near.addSigned(cid, { maxFee: 100n });
    near.failCommitmentOnce.add(2);
    const relayer = new Relayer({ near, evm: [chain.client("provider#1")], log: (e) => events.push(e), nowMs: () => 0 });
    expect(await relayer.tick()).toBe(2); // ids 0,1 known; 2 failed, 3 (same batch) was not trusted past the gap
    expect(events.some((e) => e.event === "warn" && e.code === "cursor_stalled")).toBe(true);
    expect(await relayer.tick()).toBe(6);
  });
});

describe("request_cancel resolution", () => {
  const unknownCommitment = async (near: FakeNear) => {
    await near.addSigned(0, { maxFee: 10n });
    const c = near.commits.get(0);
    if (c) {
      c.state = "Unknown";
      c.tx = { ...c.tx, state: "Unknown" };
    }
  };
  const run = (near: FakeNear, events: LogEvent[], attempts = 3) =>
    requestCancel(near, (e) => events.push(e), 0, 10_000n, 100n, { pollAttempts: attempts, pollMs: 0, sleep: async () => {} });

  it("an executed cancel whose FINAL view still lags is resolved through the optimistic view, without a second request", async () => {
    const near = new FakeNear();
    await unknownCommitment(near);
    near.lagFinalView = true;
    near.nextCancelReport = "unknown"; // the response was lost
    const events: LogEvent[] = [];
    const out = await run(near, events);
    expect(out).toEqual({ result: "sent", onChain: true });
    expect(cancelExitCode(out)).toBe(0);
    expect(near.calls.filter((c) => c.startsWith("request_cancel"))).toHaveLength(1); // never blind-retried
    expect(near.views.getSignedTx).toBe(0); // the lagging final view was not what decided it
    expect((await near.getSignedTx(0))?.cancel).toBeNull(); // ...and it really is stale
  });

  it("truly unresolved after the bounded poll: unknown, not on chain, non-zero exit, still one request", async () => {
    const near = new FakeNear();
    await unknownCommitment(near);
    near.dropNextCancel = true;
    const out = await run(near, [], 3);
    expect(out).toEqual({ result: "unknown", onChain: false });
    expect(cancelExitCode(out)).toBe(3);
    expect(near.views.getSignedTxFresh).toBe(1 + 3); // pre-check + three polls
    expect(near.calls.filter((c) => c.startsWith("request_cancel"))).toHaveLength(1);
  });

  it("a cancel already on chain is not a failure for the operator (exit 0, nothing sent)", async () => {
    const near = new FakeNear();
    await unknownCommitment(near);
    expect((await run(near, [])).onChain).toBe(true);
    const second = await run(near, []);
    expect(second).toEqual({ result: "refused", onChain: true });
    expect(cancelExitCode(second)).toBe(0);
  });

  it("refused with nothing on chain exits 1", async () => {
    const near = new FakeNear();
    await near.addSigned(0, { maxFee: 10n }); // Signed, not Unknown
    const out = await run(near, []);
    expect(out).toEqual({ result: "refused", onChain: false });
    expect(cancelExitCode(out)).toBe(1);
  });

  it("maps NEAR execution statuses: Failure is a definite refusal, no SuccessValue is unproven", () => {
    expect(classifyNearStatus({ SuccessValue: "" })).toBe("sent");
    expect(classifyNearStatus({ Failure: { ActionError: { kind: "FunctionCallError" } } })).toBe("refused");
    expect(classifyNearStatus({ SuccessReceiptId: "abc" })).toBe("unknown");
    expect(classifyNearStatus("NotStarted")).toBe("unknown");
    expect(classifyNearStatus(undefined)).toBe("unknown");
  });
});
