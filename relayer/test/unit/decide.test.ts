import { describe, expect, it } from "vitest";
import { decide, finalityOf, type CidState, type HashObs, type Observations } from "../../src/worker.ts";
import type { Receipt } from "../../src/evm.ts";
import type { SignedTx } from "../../src/near.ts";

const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const ORIG = H(1);
const CANCEL = H(2);
const MIN = 300n * 10n ** 9n; // 5 min
const SIGNED_AT = 1_000_000_000_000n;

function tx(over: Partial<SignedTx> = {}): SignedTx {
  return {
    cid: 0,
    state: "Signed",
    path: "p",
    chainId: 11155111n,
    nonce: 4n,
    from: "0xaa",
    signedAtNs: SIGNED_AT,
    original: { maxFee: 10n, tip: 1n, to: "0xbb", value: 5n, raw: "0x02aa", txHash: ORIG },
    cancel: null,
    evidence: null,
    ...over,
  };
}
const state = (t: SignedTx, stopped = false): CidState => ({ tx: t, createdAtNs: SIGNED_AT, stopped });
const receipt = (over: Partial<Receipt> = {}): Receipt => ({ status: "success", blockNumber: 100n, blockHash: H(100), ...over });
const mined = (r: Receipt, refetched: `0x${string}` | null = r.blockHash, agreed = true): HashObs => ({ receipt: r, refetchedHash: refetched, agreed });

function obs(over: Partial<Observations> = {}): Observations {
  return {
    nowNs: SIGNED_AT + 10n,
    cfg: { minUnknownAgeNs: MIN, reservedAmbiguousMinAgeNs: 3600n * 10n ** 9n },
    finalizedNumber: 90n,
    nonceFinalized: 4n,
    original: { receipt: null, refetchedHash: null, agreed: true },
    cancel: null,
    verdict: { original: "ok", cancel: "absent" },
    canRebroadcast: true,
    recipient: "eoa",
    balanceShort: false,
    singleRpc: false,
    allowSingleRpcEvidence: false,
    nonceCheck: { others: "none", priorStreak: 0 },
    ...over,
  };
}

describe("decide", () => {
  it("happy path: broadcasts a Signed transaction nobody has mined", () => {
    expect(decide(state(tx()), obs())).toEqual([{ t: "broadcast", kind: "original", raw: "0x02aa", hash: ORIG }]);
  });

  it("does not rebroadcast inside the cool-down (already-known path stays quiet)", () => {
    expect(decide(state(tx()), obs({ canRebroadcast: false }))).toEqual([]);
  });

  it("waits while the receipt is above the finalized head", () => {
    const r = receipt({ blockNumber: 100n });
    expect(decide(state(tx()), obs({ original: mined(r, null), finalizedNumber: 99n }))).toEqual([]);
  });

  it("attests a success at Finalized only, with the receipt's block", () => {
    const r = receipt();
    expect(decide(state(tx()), obs({ original: mined(r), finalizedNumber: 100n }))).toEqual([
      { t: "attest", kind: "original", hash: ORIG, success: true, blockNumber: 100n, blockHash: H(100) },
    ]);
  });

  it("reorg guard: refuses to attest when the re-fetched block hash differs from the receipt's", () => {
    const r = receipt();
    const out = decide(state(tx()), obs({ original: mined(r, H(999)), finalizedNumber: 120n }));
    expect(out).toEqual([{ t: "warn", code: "reorg_guard" }]);
    expect(decide(state(tx()), obs({ original: mined(r, null), finalizedNumber: 120n }))).toEqual([{ t: "warn", code: "reorg_guard" }]);
  });

  it("a reverted original attests success=false (release evidence) and needs agreeing RPCs", () => {
    const r = receipt({ status: "reverted" });
    expect(decide(state(tx()), obs({ original: mined(r), finalizedNumber: 100n }))).toEqual([
      { t: "attest", kind: "original", hash: ORIG, success: false, blockNumber: 100n, blockHash: H(100) },
    ]);
    expect(decide(state(tx()), obs({ original: mined(r, r.blockHash, false), finalizedNumber: 100n }))).toEqual([{ t: "warn", code: "evidence_rpcs_disagree" }]);
  });

  it("a success original needs no second RPC", () => {
    const out = decide(state(tx()), obs({ original: mined(receipt(), H(100), false), finalizedNumber: 100n }));
    expect(out[0]?.t).toBe("attest");
  });

  it("does not mark Unknown before min_unknown_age, does after (NEAR time from the view)", () => {
    expect(decide(state(tx()), obs({ nowNs: SIGNED_AT + MIN - 1n })).some((a) => a.t === "mark_unknown")).toBe(false);
    expect(decide(state(tx()), obs({ nowNs: SIGNED_AT + MIN })).some((a) => a.t === "mark_unknown")).toBe(true);
  });

  it("does not mark a mined-but-not-final original Unknown", () => {
    const r = receipt({ blockNumber: 100n });
    const out = decide(state(tx()), obs({ original: mined(r, null), finalizedNumber: 50n, nowNs: SIGNED_AT + MIN * 4n }));
    expect(out).toEqual([]);
  });

  it("marks an old Reserved EVM commitment Unknown only past the reserved threshold", () => {
    const t = tx({ state: "Reserved", signedAtNs: null });
    const hr = 3600n * 10n ** 9n;
    expect(decide(state(t), obs({ nowNs: SIGNED_AT + hr - 1n }))).toEqual([]);
    expect(decide(state(t), obs({ nowNs: SIGNED_AT + hr }))).toEqual([{ t: "mark_unknown" }]);
  });

  it("anomaly: nonce consumed at finalized with no receipt for either hash, once corroborated", () => {
    const agreed = { others: "agree", priorStreak: 0 } as const;
    expect(decide(state(tx()), obs({ nonceFinalized: 5n, nonceCheck: agreed }))).toEqual([{ t: "anomaly", reason: "nonce_consumed_no_receipt" }]);
    const u = tx({ state: "Unknown", cancel: { maxFee: 20n, tip: 2n, to: "0xaa", value: 0n, raw: "0x02bb", txHash: CANCEL } });
    expect(decide(state(u), obs({ nonceFinalized: 5n, nonceCheck: agreed, cancel: { receipt: null, refetchedHash: null, agreed: true }, verdict: { original: "ok", cancel: "ok" } }))).toEqual([{ t: "anomaly", reason: "nonce_consumed_no_receipt" }]);
  });

  it("one read of the nonce condition is only a suspicion: a second RPC must agree, or 3 consecutive ticks without one", () => {
    const suspect = [{ t: "suspect", reason: "nonce_consumed_no_receipt" }];
    const anomaly = [{ t: "anomaly", reason: "nonce_consumed_no_receipt" }];
    expect(decide(state(tx()), obs({ nonceFinalized: 5n }))).toEqual(suspect); // single RPC, first sighting
    expect(decide(state(tx()), obs({ nonceFinalized: 5n, nonceCheck: { others: "none", priorStreak: 1 } }))).toEqual(suspect);
    expect(decide(state(tx()), obs({ nonceFinalized: 5n, nonceCheck: { others: "none", priorStreak: 2 } }))).toEqual(anomaly);
    expect(decide(state(tx()), obs({ nonceFinalized: 5n, nonceCheck: { others: "disagree", priorStreak: 99 } }))).toEqual(suspect); // another RPC cannot confirm
    expect(decide(state(tx()), obs({ nonceFinalized: 5n, nonceCheck: { others: "agree", priorStreak: 0 } }))).toEqual(anomaly);
  });

  it("release evidence on a single RPC is withheld unless the operator opted in (reverted original AND cancel)", () => {
    const r = receipt({ status: "reverted" });
    const one = { singleRpc: true, finalizedNumber: 100n };
    expect(decide(state(tx()), obs({ ...one, original: mined(r) }))).toEqual([{ t: "warn", code: "evidence_needs_second_rpc" }]);
    expect(decide(state(tx()), obs({ ...one, original: mined(r), allowSingleRpcEvidence: true }))[0]?.t).toBe("attest");
    const u = tx({ state: "Unknown", cancel: { maxFee: 20n, tip: 2n, to: "0xaa", value: 0n, raw: "0x02bb", txHash: CANCEL } });
    const c = obs({ ...one, cancel: mined(receipt()), verdict: { original: "ok", cancel: "ok" } });
    expect(decide(state(u), c)).toEqual([{ t: "warn", code: "evidence_needs_second_rpc" }]);
    expect(decide(state(u), { ...c, allowSingleRpcEvidence: true })[0]?.t).toBe("attest");
    // a SUCCESS original is not release evidence: no second RPC, no opt-in needed
    expect(decide(state(tx()), obs({ ...one, original: mined(receipt()) }))[0]?.t).toBe("attest");
  });

  it("a stopped cid is never acted on again", () => {
    expect(decide(state(tx(), true), obs({ nowNs: SIGNED_AT + MIN * 9n }))).toEqual([]);
  });

  it("invalid raw bytes are an anomaly and are never broadcast", () => {
    for (const [v, reason] of [
      ["bad_hash", "hash_mismatch"],
      ["bad_signer", "invalid_raw"],
      ["bad_chain", "wrong_chain"],
      ["unparseable", "invalid_raw"],
    ] as const) {
      expect(decide(state(tx()), obs({ verdict: { original: v, cancel: "absent" } }))).toEqual([{ t: "anomaly", reason }]);
    }
  });

  it("both hashes with receipts is an anomaly", () => {
    const u = tx({ state: "Unknown", cancel: { maxFee: 20n, tip: 2n, to: "0xaa", value: 0n, raw: "0x02bb", txHash: CANCEL } });
    const out = decide(state(u), obs({ original: mined(receipt()), cancel: mined(receipt({ blockNumber: 101n, blockHash: H(101) })), finalizedNumber: 200n, verdict: { original: "ok", cancel: "ok" } }));
    expect(out).toEqual([{ t: "anomaly", reason: "both_landed" }]);
  });

  it("Unknown with a signed cancel broadcasts the cancel, not the original", () => {
    const u = tx({ state: "Unknown", cancel: { maxFee: 20n, tip: 2n, to: "0xaa", value: 0n, raw: "0x02bb", txHash: CANCEL } });
    expect(decide(state(u), obs({ verdict: { original: "ok", cancel: "ok" } }))).toEqual([{ t: "broadcast", kind: "cancel", raw: "0x02bb", hash: CANCEL }]);
  });

  it("a finalized cancel is attested as release evidence, once", () => {
    const u = tx({ state: "Unknown", cancel: { maxFee: 20n, tip: 2n, to: "0xaa", value: 0n, raw: "0x02bb", txHash: CANCEL } });
    const o = obs({ cancel: mined(receipt()), finalizedNumber: 100n, verdict: { original: "ok", cancel: "ok" } });
    expect(decide(state(u), o)).toEqual([{ t: "attest", kind: "cancel", hash: CANCEL, success: true, blockNumber: 100n, blockHash: H(100) }]);
    expect(decide(state(tx({ ...u, evidence: "cancel_landed" })), o)).toEqual([{ t: "warn", code: "awaiting_owner_confirm_release" }]);
    expect(decide(state(u), obs({ cancel: mined(receipt(), H(100), false), finalizedNumber: 100n, verdict: { original: "ok", cancel: "ok" } }))).toEqual([{ t: "warn", code: "evidence_rpcs_disagree" }]);
  });

  it("surfaces the preflight warnings for a Signed commitment", () => {
    const out = decide(state(tx()), obs({ recipient: "contract", balanceShort: true, canRebroadcast: false }));
    expect(out).toEqual([
      { t: "warn", code: "recipient_is_contract" },
      { t: "warn", code: "balance_low" },
    ]);
  });

  it("refuses any chain but Sepolia", () => {
    expect(decide(state(tx({ chainId: 1n })), obs())).toEqual([{ t: "anomaly", reason: "wrong_chain" }]);
  });

  it("finalityOf", () => {
    expect(finalityOf(null, 1n)).toBe("none");
    expect(finalityOf(mined(receipt()), null)).toBe("mined");
    expect(finalityOf(mined(receipt()), 100n)).toBe("finalized");
    expect(finalityOf(mined(receipt(), H(1)), 100n)).toBe("reorg_guard");
  });
});
