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

export async function signTx(o: { nonce: number; to: Hex; value: bigint; maxFee: bigint; tip: bigint }): Promise<{ raw: Hex; hash: Hex }> {
  const raw = await ACCOUNT.signTransaction({ type: "eip1559", chainId: 11155111, nonce: o.nonce, to: o.to, value: o.value, gas: 21_000n, maxFeePerGas: o.maxFee, maxPriorityFeePerGas: o.tip });
  return { raw, hash: keccak256(raw) };
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

  /** Mine whatever the current base fee allows, lowest-nonce first, highest fee wins a nonce. */
  mine(): void {
    for (;;) {
      const cands = [...this.#mempool.entries()].filter(([, t]) => t.nonce === this.nonce && t.maxFee >= this.baseFee).sort((a, b) => Number(b[1].maxFee - a[1].maxFee));
      const pick = cands[0];
      if (!pick) return;
      this.head += 1n;
      this.receipts.set(pick[0], { status: "success", blockNumber: this.head, blockHash: blockHash(this.head) });
      this.nonce += 1n;
      for (const [h, t] of [...this.#mempool]) if (t.nonce < this.nonce) this.#mempool.delete(h);
    }
  }
  finalizeAll(): void {
    this.finalized = this.head;
  }

  client(label: string): EvmClient {
    const self = this;
    const guard = () => {
      if (self.failWith) throw self.failWith;
    };
    return {
      label,
      chainId: async () => 11155111n,
      getReceipt: async (h) => (guard(), self.receipts.get(h) ?? null),
      getFinalized: async (): Promise<BlockRef> => ({ number: self.finalized, hash: blockHash(self.finalized) }),
      getBlock: async (n): Promise<BlockRef | null> => ({ number: n, hash: blockHash(n) }),
      getNonce: async (_a: Hex, tag: BlockTag) => (tag === "finalized" ? self.finalizedNonce() : self.nonce),
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
    if (this.failReadsWith) throw this.failReadsWith;
    if (this.failCommitmentOnce.delete(cid)) throw new Error("HTTP request failed. Status: 502");
    const c = this.commits.get(cid);
    return c ? { id: cid, state: c.state, evm: true, createdAtNs: c.createdAtNs } : null;
  }
  async getSignedTx(cid: number) {
    return this.commits.get(cid)?.tx ?? null;
  }
  async getLane(): Promise<Lane> {
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
    const { raw, hash } = await signTx({ nonce: Number(c.tx.nonce), to: LANE_ADDRESS, value: 0n, maxFee, tip });
    c.tx = { ...c.tx, cancel: { maxFee, tip, to: LANE_ADDRESS, value: 0n, raw, txHash: hash } };
    return "sent";
  }
}
