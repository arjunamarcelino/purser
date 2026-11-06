// In-memory EvmClient and NearClient for the sims. The fake chain mines the way a node would (fee >= base
// fee, nonce order, same-nonce replacement); the fake contract applies the transitions the relayer relies on.

import { keccak256, parseTransaction, type TransactionSerialized } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { BlockRef, BlockTag, EvmClient, Hex, Receipt, SendOutcome } from "../../src/evm.ts";
import type { AttestOutcome, CommitmentLite, EvmCfg, Lane, NearClient, SendResult, SignedTx } from "../../src/near.ts";

export const blockHash = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;

// A throwaway key for tests only (the contract's MPC signer stands in for it in production).
const ACCOUNT = privateKeyToAccount(`0x${"07".repeat(32)}`);
export const LANE_ADDRESS = ACCOUNT.address;
export const RECIPIENT = "0x1111111111111111111111111111111111111111" as const;

export async function signTx(o: { nonce: number; to: Hex; value: bigint; maxFee: bigint; tip: bigint; gas?: bigint; data?: Hex; chainId?: number; accessList?: Array<{ address: Hex; storageKeys: Hex[] }> }): Promise<{ raw: Hex; hash: Hex }> {
  const raw = await ACCOUNT.signTransaction({
    type: "eip1559",
    chainId: o.chainId ?? 11155111,
    nonce: o.nonce,
    to: o.to,
    value: o.value,
    gas: o.gas ?? 21_000n,
    maxFeePerGas: o.maxFee,
    maxPriorityFeePerGas: o.tip,
    ...(o.data ? { data: o.data } : {}),
    ...(o.accessList ? { accessList: o.accessList } : {}),
  });
  return { raw, hash: keccak256(raw) };
}

/** A legacy (type 0) transaction from the same key: the relayer must refuse anything but type 0x02. */
export async function signLegacy(o: { nonce: number; to: Hex; value: bigint; gasPrice: bigint }): Promise<{ raw: Hex; hash: Hex }> {
  const raw = await ACCOUNT.signTransaction({ type: "legacy", chainId: 11155111, nonce: o.nonce, to: o.to, value: o.value, gas: 21_000n, gasPrice: o.gasPrice });
  return { raw, hash: keccak256(raw) };
}

/**
 * How ONE RPC's view differs from the chain's truth: a stale/other-fork backend, a lagging finalized head, a
 * pruned node. Used both by the in-memory client and (through rpc-stub.ts) by the real viem adapter.
 */
export interface ViewOpts {
  /** Rewrite what this RPC answers for a receipt lookup (`real` is the chain's receipt or null). */
  receipt?: (hash: Hex, real: Receipt | null) => Receipt | null;
  /** Offset applied to this RPC's finalized head (negative = lagging). */
  finalizedLag?: bigint;
  /** Rewrite what this RPC answers for the finalized nonce. */
  finalizedNonce?: (real: bigint) => bigint;
}

export class FakeChain {
  head = 100n;
  finalized = 90n;
  baseFee = 1n;
  readonly #mempool = new Map<Hex, { raw: Hex; nonce: bigint; maxFee: bigint; to: string; value: bigint }>();
  readonly receipts = new Map<Hex, Receipt>();
  nonce = 0n;
  balance = 10n ** 20n;
  code: Hex = "0x";
  /** Make every read of this kind throw (for scrub tests). */
  failWith: Error | null = null;
  sends = 0;
  /** Mine the next transactions as reverted (status 0). */
  revertMined = false;
  /** Block hashes a node would report AFTER a reorg: the receipt keeps the old hash, the block lookup returns this. */
  readonly reorgedBlocks = new Map<bigint, Hex>();

  /** Mine whatever the current base fee allows, lowest-nonce first, highest fee wins a nonce. */
  mine(): void {
    for (;;) {
      const cands = [...this.#mempool.entries()].filter(([, t]) => t.nonce === this.nonce && t.maxFee >= this.baseFee).sort((a, b) => Number(b[1].maxFee - a[1].maxFee));
      const pick = cands[0];
      if (!pick) return;
      this.head += 1n;
      this.receipts.set(pick[0], { status: this.revertMined ? "reverted" : "success", blockNumber: this.head, blockHash: blockHash(this.head) });
      this.nonce += 1n;
      for (const [h, t] of [...this.#mempool]) if (t.nonce < this.nonce) this.#mempool.delete(h);
    }
  }
  finalizeAll(): void {
    this.finalized = this.head;
  }
  /** Replace the canonical block at `n` (its receipts keep the old hash, as after a reorg). */
  reorg(n: bigint): void {
    this.reorgedBlocks.set(n, `0x${"ba".repeat(31)}${n.toString(16).padStart(2, "0").slice(-2)}`);
  }
  blockAt(n: bigint): Hex {
    return this.reorgedBlocks.get(n) ?? blockHash(n);
  }

  client(label: string, view: ViewOpts = {}): EvmClient {
    const self = this;
    const guard = () => {
      if (self.failWith) throw self.failWith;
    };
    return {
      label,
      chainId: async () => 11155111n,
      getReceipt: async (h) => {
        guard();
        const real = self.receipts.get(h) ?? null;
        return view.receipt ? view.receipt(h, real) : real;
      },
      getFinalized: async (): Promise<BlockRef> => {
        const n = self.finalized + (view.finalizedLag ?? 0n);
        return { number: n, hash: self.blockAt(n) };
      },
      getBlock: async (n): Promise<BlockRef | null> => ({ number: n, hash: self.blockAt(n) }),
      getNonce: async (_a: Hex, tag: BlockTag) => (tag === "finalized" ? (view.finalizedNonce ? view.finalizedNonce(self.finalizedNonce()) : self.finalizedNonce()) : self.nonce),
      getCode: async () => self.code,
      getBalance: async () => self.balance,
      sendRaw: async (raw): Promise<SendOutcome> => {
        self.sends += 1;
        const hash = keccak256(raw);
        const p = parseTransaction(raw as TransactionSerialized);
        const nonce = BigInt(p.nonce ?? 0);
        if (self.receipts.has(hash) || nonce < self.nonce) return { kind: "Landed" };
        const existing = [...self.#mempool.values()].find((t) => t.nonce === nonce);
        if (self.#mempool.has(hash)) return { kind: "Pending" };
        if (existing && (p.maxFeePerGas ?? 0n) <= existing.maxFee) return { kind: "Underpriced" };
        self.#mempool.set(hash, { raw, nonce, maxFee: p.maxFeePerGas ?? 0n, to: p.to ?? "", value: p.value ?? 0n });
        self.mine();
        return { kind: "Accepted", hash };
      },
    };
  }

  /** Nonce as of the finalized block: count only receipts at or below it. */
  finalizedNonce(): bigint {
    return BigInt([...this.receipts.values()].filter((r) => r.blockNumber <= this.finalized).length);
  }
}

export interface FakeCommitment {
  state: SignedTx["state"];
  createdAtNs: bigint;
  tx: SignedTx;
}

export class FakeNear implements NearClient {
  nowNsValue = 2_000_000_000_000n;
  readonly commits = new Map<number, FakeCommitment>();
  readonly calls: string[] = [];
  failReadsWith: Error | null = null;
  failCommitmentOnce = new Set<number>();
  /** Per-method view counts and the peak number of concurrent get_commitment reads. */
  readonly views = { getCommitment: 0, getSignedTx: 0, getSignedTxFresh: 0, getLane: 0 };
  maxConcurrentCommitmentReads = 0;
  #inflight = 0;
  /** What the pinned FINAL view still shows for a cid (it lags a send); the optimistic view shows the truth. */
  readonly staleFinal = new Map<number, SignedTx>();
  /** Make the next `requestCancel` apply on the contract but report this to the caller (a lost response / timeout). */
  nextCancelReport: SendResult | null = null;
  /** The next `requestCancel` never reaches the contract at all (so an `unknown` report is truly unresolved). */
  dropNextCancel = false;
  /** Keep the final view stale after a cancel until `staleFinal` is cleared. */
  lagFinalView = false;
  readonly cfg: EvmCfg = { chainId: 11155111n, maxFeeCeiling: 10_000n, maxPriorityCeiling: 100n, minUnknownAgeNs: 300_000_000_000n, reservedAmbiguousMinAgeNs: 3_600_000_000_000n, cancelBumpBps: 12_500n };

  async addSigned(cid: number, o: { maxFee: bigint; value?: bigint }): Promise<void> {
    const value = o.value ?? 10n ** 15n;
    const { raw, hash } = await signTx({ nonce: 0, to: RECIPIENT, value, maxFee: o.maxFee, tip: 1n });
    const tx: SignedTx = {
      cid,
      state: "Signed",
      path: "lane",
      chainId: 11155111n,
      nonce: 0n,
      from: LANE_ADDRESS,
      signedAtNs: this.nowNsValue,
      original: { maxFee: o.maxFee, tip: 1n, to: RECIPIENT, value, raw, txHash: hash },
      cancel: null,
      evidence: null,
    };
    this.commits.set(cid, { state: "Signed", createdAtNs: this.nowNsValue, tx });
  }

  state(cid: number): SignedTx["state"] {
    return (this.commits.get(cid) as FakeCommitment).state;
  }
  #sync(c: FakeCommitment, state: SignedTx["state"]): void {
    c.state = state;
    c.tx = { ...c.tx, state };
  }

  async pin() {}
  async nowNs() {
    return this.nowNsValue;
  }
  async getEvmCfg() {
    return this.cfg;
  }
  async getRelayer() {
    return "relayer.testnet";
  }
  async getCommitment(cid: number): Promise<CommitmentLite | null> {
    this.views.getCommitment += 1;
    this.#inflight += 1;
    this.maxConcurrentCommitmentReads = Math.max(this.maxConcurrentCommitmentReads, this.#inflight);
    try {
      await Promise.resolve();
      await Promise.resolve();
      if (this.failReadsWith) throw this.failReadsWith;
      if (this.failCommitmentOnce.delete(cid)) throw new Error("HTTP request failed. Status: 502");
      const c = this.commits.get(cid);
      return c ? { id: cid, state: c.state, evm: true, createdAtNs: c.createdAtNs } : null;
    } finally {
      this.#inflight -= 1;
    }
  }
  async getSignedTx(cid: number) {
    this.views.getSignedTx += 1;
    return this.staleFinal.get(cid) ?? this.commits.get(cid)?.tx ?? null;
  }
  async getSignedTxFresh(cid: number) {
    this.views.getSignedTxFresh += 1;
    return this.commits.get(cid)?.tx ?? null;
  }
  async getLane(): Promise<Lane> {
    this.views.getLane += 1;
    return { address: LANE_ADDRESS, nextNonce: 0n };
  }

  async attest(cid: number, txHash: Hex, o: AttestOutcome): Promise<SendResult> {
    this.calls.push(`attest:${cid}:${txHash === this.commits.get(cid)?.tx.cancel?.txHash ? "cancel" : "original"}:${o.success}`);
    const c = this.commits.get(cid);
    if (!c || (c.state !== "Signed" && c.state !== "Unknown")) return "sent";
    if (txHash === c.tx.original.txHash && o.success) this.#sync(c, "Confirmed");
    else {
      const evidence = txHash === c.tx.original.txHash ? "original_reverted" : "cancel_landed";
      c.tx = { ...c.tx, evidence };
      this.#sync(c, "Unknown");
    }
    return "sent";
  }
  async markUnknown(cid: number): Promise<SendResult> {
    this.calls.push(`mark_unknown:${cid}`);
    const c = this.commits.get(cid);
    if (c?.state === "Signed" && this.nowNsValue - (c.tx.signedAtNs ?? 0n) >= this.cfg.minUnknownAgeNs) this.#sync(c, "Unknown");
    return "sent";
  }
  async requestCancel(cid: number, maxFee: bigint, tip: bigint): Promise<SendResult> {
    this.calls.push(`request_cancel:${cid}`);
    const c = this.commits.get(cid);
    if (!c || c.state !== "Unknown" || c.tx.cancel) return "refused";
    if (this.dropNextCancel) {
      this.dropNextCancel = false;
      return this.nextCancelReport ?? "unknown";
    }
    if (this.lagFinalView) this.staleFinal.set(cid, c.tx);
    const { raw, hash } = await signTx({ nonce: Number(c.tx.nonce), to: LANE_ADDRESS, value: 0n, maxFee, tip });
    c.tx = { ...c.tx, cancel: { maxFee, tip, to: LANE_ADDRESS, value: 0n, raw, txHash: hash } };
    const report = this.nextCancelReport;
    this.nextCancelReport = null;
    return report ?? "sent";
  }
}
