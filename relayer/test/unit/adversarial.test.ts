// End-to-end sims through the REAL ViemEvmClient (a local JSON-RPC stub in front of the fake chain): a reverted
// receipt, two RPCs that disagree, a reorg between receipt and finality, and a transient missing receipt.
import { afterEach, describe, expect, it } from "vitest";
import { Relayer } from "../../src/worker.ts";
import type { LogEvent } from "../../src/log.ts";
import type { Receipt } from "../../src/evm.ts";
import { FakeChain, FakeNear } from "./fakes.ts";
import { startRpcStub, type RpcStub, type StubOptions } from "./rpc-stub.ts";

const stubs: RpcStub[] = [];
afterEach(async () => {
  await Promise.all(stubs.splice(0).map((s) => s.close()));
});

async function rig(rpcs: StubOptions[], o: { allowSingle?: boolean } = {}) {
  const chain = new FakeChain();
  const near = new FakeNear();
  const events: LogEvent[] = [];
  const started = await Promise.all(rpcs.map((r) => startRpcStub(chain, r)));
  stubs.push(...started);
  const relayer = new Relayer({
    near,
    evm: started.map((s, i) => s.client(`provider#${i + 1}`)),
    log: (e) => events.push(e),
    nowMs: () => 0,
    ...(o.allowSingle !== undefined ? { allowSingleRpcEvidence: o.allowSingle } : {}),
  });
  const warns = (code: string) => events.filter((e) => e.event === "warn" && e.code === code).length;
  const anomalies = () => events.filter((e) => e.event === "anomaly").length;
  return { chain, near, events, relayer, warns, anomalies };
}

const asSuccess = (_h: string, real: Receipt | null): Receipt | null => (real ? { ...real, status: "success" } : null);

describe("reverted original (release evidence) with NO cancel", () => {
  it("two RPCs that agree: attests success=false and records original_reverted", async () => {
    const t = await rig([{}, {}]);
    t.chain.revertMined = true;
    await t.near.addSigned(0, { maxFee: 100n });
    await t.relayer.tick();
    t.chain.finalizeAll();
    await t.relayer.tick();
    expect(t.near.calls).toEqual(["attest:0:original:false"]);
    expect(t.near.commits.get(0)?.tx.evidence).toBe("original_reverted");
  });

  for (const [name, second] of [
    ["the second RPC has no receipt", { receipt: () => null }],
    ["the second RPC says it succeeded", { receipt: asSuccess }],
    ["the second RPC's finalized head lags behind the block", { finalizedLag: -50n }],
    ["the second RPC is down", { fail: () => 500 }],
  ] as Array<[string, StubOptions["view"] & { fail?: () => number }]>) {
    it(`two RPCs disagree (${name}): no attest, warns evidence_rpcs_disagree`, async () => {
      const { fail, ...view } = second as { fail?: () => number } & NonNullable<StubOptions["view"]>;
      const t = await rig([{}, { view, ...(fail ? { fail } : {}) }]);
      t.chain.revertMined = true;
      await t.near.addSigned(0, { maxFee: 100n });
      await t.relayer.tick();
      t.chain.finalizeAll();
      await t.relayer.tick();
      await t.relayer.tick();
      expect(t.near.calls).toEqual([]);
      expect(t.warns("evidence_rpcs_disagree")).toBe(1);
      expect(t.near.state(0)).toBe("Signed");
    });
  }

  it("one RPC only: withheld (warn), and attested only with the explicit opt-in", async () => {
    const off = await rig([{}]);
    off.chain.revertMined = true;
    await off.near.addSigned(0, { maxFee: 100n });
    await off.relayer.tick();
    off.chain.finalizeAll();
    await off.relayer.tick();
    expect(off.near.calls).toEqual([]);
    expect(off.warns("evidence_needs_second_rpc")).toBe(1);

    const on = await rig([{}], { allowSingle: true });
    on.chain.revertMined = true;
    await on.near.addSigned(0, { maxFee: 100n });
    await on.relayer.tick();
    on.chain.finalizeAll();
    await on.relayer.tick();
    expect(on.near.calls).toEqual(["attest:0:original:false"]);
  });

  it("a SUCCESS receipt is attested on one RPC without any opt-in", async () => {
    const t = await rig([{}]);
    await t.near.addSigned(0, { maxFee: 100n });
    await t.relayer.tick();
    t.chain.finalizeAll();
    await t.relayer.tick();
    expect(t.near.calls).toEqual(["attest:0:original:true"]);
  });
});

describe("reorg guard through the real adapter", () => {
  it("a block hash that no longer matches the receipt is never attested; it is once it matches again", async () => {
    const t = await rig([{}]);
    await t.near.addSigned(0, { maxFee: 100n });
    await t.relayer.tick();
    t.chain.finalizeAll();
    t.chain.reorg(t.chain.head);
    await t.relayer.tick();
    await t.relayer.tick();
    expect(t.near.calls).toEqual([]);
    expect(t.warns("reorg_guard")).toBe(1);
    t.chain.reorgedBlocks.clear();
    await t.relayer.tick();
    expect(t.near.calls).toEqual(["attest:0:original:true"]);
  });
});

describe("a missing receipt is not a permanent stop", () => {
  it("one RPC: a receipt hidden for ONE tick does not stop the commitment; it is attested next tick", async () => {
    let hide = false;
    const t = await rig([{ view: { receipt: (_h, real) => (hide ? null : real) } }]);
    await t.near.addSigned(0, { maxFee: 100n });
    await t.relayer.tick();
    t.chain.finalizeAll();
    hide = true;
    await t.relayer.tick();
    expect(t.anomalies()).toBe(0);
    expect(t.warns("nonce_unconfirmed")).toBe(1); // counted as a suspicion, not a stop
    hide = false;
    await t.relayer.tick();
    expect(t.near.calls).toEqual(["attest:0:original:true"]);
    expect(t.anomalies()).toBe(0);
  });

  it("one RPC: 3 consecutive ticks stop it; the stop clears and the attest follows when the receipt returns", async () => {
    let hide = false;
    const t = await rig([{ view: { receipt: (_h, real) => (hide ? null : real) } }]);
    await t.near.addSigned(0, { maxFee: 100n });
    await t.relayer.tick();
    t.chain.finalizeAll();
    hide = true;
    await t.relayer.tick();
    await t.relayer.tick();
    expect(t.anomalies()).toBe(0);
    await t.relayer.tick();
    expect(t.anomalies()).toBe(1);
    expect(t.relayer.stoppedCids.has(0)).toBe(true);
    hide = false;
    await t.relayer.tick();
    expect(t.events.some((e) => e.event === "anomaly_cleared")).toBe(true);
    expect(t.relayer.stoppedCids.has(0)).toBe(false);
    expect(t.near.calls).toEqual(["attest:0:original:true"]);
  });

  it("two RPCs: the primary alone missing the receipt never stops it (the second still has it)", async () => {
    const t = await rig([{ view: { receipt: () => null } }, {}]);
    await t.near.addSigned(0, { maxFee: 100n });
    await t.relayer.tick();
    t.chain.finalizeAll();
    for (let i = 0; i < 5; i++) await t.relayer.tick();
    expect(t.anomalies()).toBe(0);
    expect(t.near.calls).toEqual([]);
  });

  it("two RPCs: both missing the receipt while the nonce is consumed stops it at once", async () => {
    const t = await rig([{ view: { receipt: () => null } }, { view: { receipt: () => null } }]);
    await t.near.addSigned(0, { maxFee: 100n });
    await t.relayer.tick();
    t.chain.finalizeAll();
    await t.relayer.tick();
    expect(t.anomalies()).toBe(1);
  });
});
