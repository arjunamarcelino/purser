import { describe, expect, it } from "vitest";
import { Relayer, requestCancel } from "../../src/worker.ts";
import type { LogEvent } from "../../src/log.ts";
import { FakeChain, FakeNear } from "./fakes.ts";

function setup(opts: { maxFee: bigint; baseFee: bigint; rpcs?: number; allowSingle?: boolean }) {
  const chain = new FakeChain();
  chain.baseFee = opts.baseFee;
  const near = new FakeNear();
  const events: LogEvent[] = [];
  let clock = 0;
  const relayer = new Relayer({
    near,
    evm: Array.from({ length: opts.rpcs ?? 1 }, (_, i) => chain.client(`provider#${i + 1}`)),
    log: (e) => events.push(e),
    nowMs: () => clock,
    rebroadcastMs: 60_000,
    ...(opts.allowSingle !== undefined ? { allowSingleRpcEvidence: opts.allowSingle } : {}),
  });
  return { chain, near, events, relayer, advanceMs: (ms: number) => (clock += ms) };
}

describe("relayer sim: instant-mine", () => {
  it("broadcasts, waits for finality, then attests success and the commitment settles", async () => {
    const { chain, near, events, relayer } = setup({ maxFee: 100n, baseFee: 1n });
    await near.addSigned(0, { maxFee: 100n });

    await relayer.tick();
    expect(chain.receipts.size).toBe(1); // mined on broadcast
    expect(near.calls).toEqual([]); // head is not finalized yet: no attestation
    expect(near.state(0)).toBe("Signed");

    chain.finalizeAll();
    await relayer.tick();
    expect(near.calls).toEqual(["attest:0:original:true"]);
    expect(near.state(0)).toBe("Confirmed");

    await relayer.tick(); // terminal: nothing more to do
    expect(near.calls).toHaveLength(1);
    expect(events.some((e) => e.event === "attested" && e.result === "sent")).toBe(true);
    expect(events.some((e) => e.event === "anomaly")).toBe(false);
  });

  it("two agreeing RPCs also settle", async () => {
    const { chain, near, relayer } = setup({ maxFee: 100n, baseFee: 1n, rpcs: 2 });
    await near.addSigned(0, { maxFee: 100n });
    await relayer.tick();
    chain.finalizeAll();
    await relayer.tick();
    expect(near.state(0)).toBe("Confirmed");
    expect(chain.sends).toBe(2); // broadcast to every provider
  });

  it("warns (once) when the recipient is a contract or the balance is short, and still broadcasts", async () => {
    const { chain, near, events, relayer } = setup({ maxFee: 100n, baseFee: 1n });
    chain.code = "0x6001";
    chain.balance = 0n;
    await near.addSigned(0, { maxFee: 100n });
    await relayer.tick();
    await relayer.tick();
    const warns = events.filter((e) => e.event === "warn").map((e) => (e.event === "warn" ? e.code : ""));
    expect(warns.filter((c) => c === "recipient_is_contract")).toHaveLength(1);
    expect(warns).toContain("balance_low");
  });
});

describe("relayer sim: stuck original -> mark_unknown -> cancel -> cancel attested", () => {
  it("runs the whole reclaim flow and stops acting once evidence is recorded", async () => {
    // One RPC: the cancel is release evidence, attested only because the operator opted in.
    const { chain, near, events, relayer, advanceMs } = setup({ maxFee: 10n, baseFee: 1000n, allowSingle: true });
    await near.addSigned(0, { maxFee: 10n });

    await relayer.tick();
    expect(chain.receipts.size).toBe(0); // un-minable: fee below base fee
    expect(near.state(0)).toBe("Signed");

    // Too early: no mark_unknown.
    near.nowNsValue += near.cfg.minUnknownAgeNs - 1n;
    advanceMs(61_000);
    await relayer.tick();
    expect(near.calls).toEqual([]);

    near.nowNsValue += 1n;
    await relayer.tick();
    expect(near.calls).toEqual(["mark_unknown:0"]);
    expect(near.state(0)).toBe("Unknown");

    // Operator trigger: the contract signs the cancel at the ceiling.
    const log = (e: LogEvent) => events.push(e);
    expect(await requestCancel(near, log, 0, 10_000n, 100n)).toEqual({ result: "sent", onChain: true });
    expect(await requestCancel(near, log, 0, 10_000n, 100n)).toEqual({ result: "refused", onChain: true }); // compare-and-set; the first cancel is on chain

    advanceMs(61_000);
    await relayer.tick(); // broadcasts the cancel; mined at once
    expect([...chain.receipts.values()]).toHaveLength(1);
    expect(near.state(0)).toBe("Unknown");

    chain.finalizeAll();
    await relayer.tick();
    expect(near.calls.at(-1)).toBe("attest:0:cancel:true");
    expect(near.commits.get(0)?.tx.evidence).toBe("cancel_landed");
    expect(near.state(0)).toBe("Unknown"); // only the owner's confirm_release moves it

    const before = near.calls.length;
    await relayer.tick();
    await relayer.tick();
    expect(near.calls).toHaveLength(before); // no re-attest: waiting for the owner
    expect(events.filter((e) => e.event === "warn" && e.code === "awaiting_owner_confirm_release")).toHaveLength(1);
  });

  it("an unmined original that disappears behind someone else's nonce is an anomaly only after 3 consecutive ticks (one RPC), then ignored", async () => {
    const { chain, near, events, relayer, advanceMs } = setup({ maxFee: 10n, baseFee: 1000n });
    await near.addSigned(0, { maxFee: 10n });
    await relayer.tick();
    // Another party burns nonce 0 (no receipt for either of our hashes is visible).
    chain.receipts.set(`0x${"ee".repeat(32)}`, { status: "success", blockNumber: 85n, blockHash: `0x${"cc".repeat(32)}` });
    const anomalies = () => events.filter((e) => e.event === "anomaly" && e.reason === "nonce_consumed_no_receipt").length;
    for (let i = 0; i < 2; i++) {
      advanceMs(61_000);
      await relayer.tick();
      expect(anomalies()).toBe(0); // one or two reads are not enough to stop
    }
    advanceMs(61_000);
    await relayer.tick();
    expect(anomalies()).toBe(1);
    const sends = chain.sends;
    near.nowNsValue += near.cfg.minUnknownAgeNs * 2n;
    advanceMs(61_000);
    await relayer.tick();
    expect(chain.sends).toBe(sends);
    expect(near.calls).toEqual([]);
  });
});

describe("relayer sim: scan cursor", () => {
  it("never skips an id it could not read", async () => {
    const { chain, near, events, relayer } = setup({ maxFee: 100n, baseFee: 1n });
    await near.addSigned(0, { maxFee: 100n });
    await near.addSigned(1, { maxFee: 100n });
    near.failCommitmentOnce.add(1);
    expect(await relayer.tick()).toBe(1); // id 1 unreadable this tick
    expect(events.some((e) => e.event === "warn" && e.code === "cursor_stalled")).toBe(true);
    expect(await relayer.tick()).toBe(2); // read next tick: not skipped
    chain.finalizeAll();
  });

  it("an RPC failure on one cid does not stop the others", async () => {
    const { chain, near, relayer } = setup({ maxFee: 100n, baseFee: 1n });
    await near.addSigned(0, { maxFee: 100n });
    await relayer.tick();
    chain.finalizeAll();
    chain.failWith = new Error("HTTP request failed. Status: 502");
    await relayer.tick(); // receipt read fails: logged, nothing attested
    expect(near.calls).toEqual([]);
    chain.failWith = null;
    await relayer.tick();
    expect(near.state(0)).toBe("Confirmed");
  });
});
