// The relayer loop. `decide` is a pure reducer from (contract state, chain observations) to actions;
// `Relayer` gathers the observations and runs the actions. There is no local state that matters: the
// contract is the queue, and a restart re-derives everything from its views. The in-memory sets below
// only avoid repeating reads, warnings and broadcasts.
//
// What the relayer may do, and nothing else: broadcast bytes the contract signed, report what finalized,
// mark a stale commitment Unknown, and (on an operator's trigger) ask for the one nonce-burn cancel.

import { setTimeout as delay } from "node:timers/promises";
import { SEPOLIA_CHAIN_ID } from "./config.ts";
import { verifyRaw, type EvmClient, type Hex, type RawVerdict, type Receipt, type SendOutcome } from "./evm.ts";
import { describeError, type Logger, type WarnCode } from "./log.ts";
import type { NearClient, SendResult, SignedTx } from "./near.ts";

/** Gas of a plain transfer: the contract fixes it (evm_tx::GAS_LIMIT). */
export const TRANSFER_GAS = 21_000n;

// ---- pure core -----------------------------------------------------------------------------------

export interface HashObs {
  receipt: Receipt | null;
  /** The block hash re-fetched at `receipt.blockNumber` (only read when that block is at or below `finalized`). */
  refetchedHash: Hex | null;
  /** Every OTHER configured RPC reports the same status and block hash. True when there is no other RPC. */
  agreed: boolean;
}

export interface Observations {
  nowNs: bigint;
  cfg: { minUnknownAgeNs: bigint; reservedAmbiguousMinAgeNs: bigint };
  finalizedNumber: bigint | null;
  /** `eth_getTransactionCount(from, finalized)`, read BEFORE the receipts. */
  nonceFinalized: bigint | null;
  original: HashObs | null;
  cancel: HashObs | null;
  verdict: { original: RawVerdict; cancel: RawVerdict };
  /** False inside the rebroadcast cool-down. */
  canRebroadcast: boolean;
  recipient: "eoa" | "contract" | "unknown";
  balanceShort: boolean;
}

export interface CidState {
  tx: SignedTx;
  createdAtNs: bigint;
  /** An anomaly was recorded: no further action on this cid. */
  stopped: boolean;
}

export type Kind = "original" | "cancel";
export type AnomalyReason = "invalid_raw" | "hash_mismatch" | "both_landed" | "nonce_consumed_no_receipt" | "wrong_chain";

export type Action =
  | { t: "broadcast"; kind: Kind; raw: Hex; hash: Hex }
  | { t: "attest"; kind: Kind; hash: Hex; success: boolean; blockNumber: bigint; blockHash: Hex }
  | { t: "mark_unknown" }
  | { t: "anomaly"; reason: AnomalyReason }
  | { t: "warn"; code: WarnCode };

type Finality = "none" | "mined" | "reorg_guard" | "finalized";

/** A receipt counts as final only if its block is at or below the finalized head AND the block hash re-read now still matches. */
export function finalityOf(h: HashObs | null, finalizedNumber: bigint | null): Finality {
  if (h === null || h.receipt === null) return "none";
  if (finalizedNumber === null || h.receipt.blockNumber > finalizedNumber) return "mined";
  return h.refetchedHash !== null && h.refetchedHash.toLowerCase() === h.receipt.blockHash.toLowerCase() ? "finalized" : "reorg_guard";
}

const verdictAnomaly = (v: RawVerdict): AnomalyReason | null => {
  if (v === "ok" || v === "absent") return null;
  if (v === "bad_chain") return "wrong_chain";
  if (v === "bad_hash") return "hash_mismatch";
  return "invalid_raw";
};

export function decide(s: CidState, o: Observations): Action[] {
  if (s.stopped) return [];
  const { tx } = s;

  if (tx.state === "Reserved") {
    // A Reserved EVM commitment whose sign callback never arrived: only the age rule applies.
    return o.nowNs - s.createdAtNs >= o.cfg.reservedAmbiguousMinAgeNs ? [{ t: "mark_unknown" }] : [];
  }
  if (tx.state !== "Signed" && tx.state !== "Unknown") return [];

  if (tx.chainId !== SEPOLIA_CHAIN_ID) return [{ t: "anomaly", reason: "wrong_chain" }];
  const bad = verdictAnomaly(o.verdict.original) ?? verdictAnomaly(o.verdict.cancel);
  if (bad !== null) return [{ t: "anomaly", reason: bad }];

  const oFin = finalityOf(o.original, o.finalizedNumber);
  const cFin = finalityOf(o.cancel, o.finalizedNumber);
  if (oFin !== "none" && cFin !== "none") return [{ t: "anomaly", reason: "both_landed" }];

  // 1. Something was mined: report it once it is final, otherwise wait. Never broadcast or mark Unknown meanwhile.
  const mined: Array<[Kind, HashObs, Finality, Hex]> = [];
  if (o.original && oFin !== "none" && tx.original.txHash) mined.push(["original", o.original, oFin, tx.original.txHash]);
  if (o.cancel && cFin !== "none" && tx.cancel?.txHash) mined.push(["cancel", o.cancel, cFin, tx.cancel.txHash]);
  if (mined.length > 0) {
    const out: Action[] = [];
    for (const [kind, h, fin, hash] of mined) {
      const r = h.receipt as Receipt;
      if (fin === "reorg_guard") {
        out.push({ t: "warn", code: "reorg_guard" });
        continue;
      }
      if (fin === "mined") continue;
      const success = r.status === "success";
      const releaseEvidence = kind === "cancel" || !success;
      if (releaseEvidence && tx.evidence !== null) {
        out.push({ t: "warn", code: "awaiting_owner_confirm_release" });
        continue;
      }
      if (releaseEvidence && !h.agreed) {
        out.push({ t: "warn", code: "evidence_rpcs_disagree" });
        continue;
      }
      out.push({ t: "attest", kind, hash, success, blockNumber: r.blockNumber, blockHash: r.blockHash });
    }
    return out;
  }

  // 2. Nothing mined. If the sender's nonce is already consumed at `finalized` yet neither of our hashes has
  //    a receipt, something else won the nonce (or the RPC is pruned): stop and alert, do not guess.
  if (o.nonceFinalized !== null && o.nonceFinalized > tx.nonce) return [{ t: "anomaly", reason: "nonce_consumed_no_receipt" }];

  const out: Action[] = [];
  if (tx.state === "Signed") {
    if (o.recipient === "contract") out.push({ t: "warn", code: "recipient_is_contract" });
    if (o.recipient === "unknown") out.push({ t: "warn", code: "recipient_unknown" });
    if (o.balanceShort) out.push({ t: "warn", code: "balance_low" });
    if (o.canRebroadcast && o.verdict.original === "ok" && tx.original.raw && tx.original.txHash) {
      out.push({ t: "broadcast", kind: "original", raw: tx.original.raw, hash: tx.original.txHash });
    }
    const signedAt = tx.signedAtNs ?? s.createdAtNs;
    if (o.nowNs - signedAt >= o.cfg.minUnknownAgeNs) out.push({ t: "mark_unknown" });
  } else if (tx.cancel && o.canRebroadcast && o.verdict.cancel === "ok" && tx.cancel.raw && tx.cancel.txHash) {
    out.push({ t: "broadcast", kind: "cancel", raw: tx.cancel.raw, hash: tx.cancel.txHash });
  }
  return out;
}

// ---- effect runner -------------------------------------------------------------------------------

export interface RelayerDeps {
  near: NearClient;
  /** Primary first. Decisions use the primary; broadcasts go to all; release evidence needs the others to agree. */
  evm: EvmClient[];
  log: Logger;
  /** Wall clock in ms; only throttles rebroadcasts. */
  nowMs?: () => number;
  rebroadcastMs?: number;
}

const TERMINAL = new Set(["Confirmed", "Failed", "Cancelled"]);

export class Relayer {
  readonly #d: RelayerDeps;
  #cursor = 0;
  readonly #done = new Set<number>();
  readonly #stopped = new Set<number>();
  readonly #lastBroadcast = new Map<string, number>();
  readonly #warned = new Set<string>();
  readonly #recipientKind = new Map<number, "eoa" | "contract" | "unknown">();

  constructor(deps: RelayerDeps) {
    this.#d = deps;
  }

  get stoppedCids(): ReadonlySet<number> {
    return this.#stopped;
  }

  /** One pass over every non-terminal EVM commitment. Returns how many were active. */
  async tick(): Promise<number> {
    const { near, log } = this.#d;
    await near.pin();
    const nowNs = await near.nowNs();
    const cfg = await near.getEvmCfg();
    if (cfg === null) {
      log({ event: "warn", code: "read_failed", cid: null, detail: "evm_cfg_unset" });
      return 0;
    }

    const active: number[] = [];
    let scanned = this.#cursor;
    for (let cid = this.#cursor; ; cid++) {
      if (this.#done.has(cid)) {
        scanned = cid + 1;
        continue;
      }
      let c;
      try {
        c = await near.getCommitment(cid);
      } catch (err) {
        // Never skip an id we could not read: stop the scan here, retry from this id next tick.
        log({ event: "error", where: "scan", class: describeError(err) });
        log({ event: "warn", code: "cursor_stalled", cid });
        break;
      }
      if (c === null) break; // ids are assigned contiguously: the first absent id is the end
      scanned = cid + 1;
      if (!c.evm || TERMINAL.has(c.state)) this.#done.add(cid);
      else active.push(cid);
    }
    while (this.#done.has(this.#cursor)) this.#cursor++;
    this.#d.log({ event: "tick", active: active.length, scanned_to: scanned });

    const lanes = new Map<string, Awaited<ReturnType<NearClient["getLane"]>>>();
    for (const cid of active) {
      try {
        await this.#process(cid, nowNs, cfg, lanes);
      } catch (err) {
        log({ event: "error", where: "process", class: describeError(err) });
      }
    }
    return active.length;
  }

  async #process(cid: number, nowNs: bigint, cfg: NonNullable<Awaited<ReturnType<NearClient["getEvmCfg"]>>>, lanes: Map<string, Awaited<ReturnType<NearClient["getLane"]>>>): Promise<void> {
    const { near, evm } = this.#d;
    if (this.#stopped.has(cid)) return;
    const [commitment, tx] = await Promise.all([near.getCommitment(cid), near.getSignedTx(cid)]);
    if (commitment === null || tx === null) return;
    const base = { nowNs, cfg: { minUnknownAgeNs: cfg.minUnknownAgeNs, reservedAmbiguousMinAgeNs: cfg.reservedAmbiguousMinAgeNs } };
    const state: CidState = { tx, createdAtNs: commitment.createdAtNs, stopped: false };

    let obs: Observations;
    if (tx.state === "Reserved") {
      obs = { ...base, finalizedNumber: null, nonceFinalized: null, original: null, cancel: null, verdict: { original: "absent", cancel: "absent" }, canRebroadcast: false, recipient: "eoa", balanceShort: false };
    } else {
      if (!lanes.has(tx.path)) lanes.set(tx.path, await near.getLane(tx.path));
      const lane = lanes.get(tx.path);
      if (!lane) return;
      const primary = evm[0] as EvmClient;
      const from = lane.address as Hex;
      const verdict = {
        original: await verifyRaw({ raw: tx.original.raw, txHash: tx.original.txHash, to: tx.original.to, value: tx.original.value }, { address: lane.address, nonce: tx.nonce }, SEPOLIA_CHAIN_ID),
        cancel: tx.cancel ? await verifyRaw({ raw: tx.cancel.raw, txHash: tx.cancel.txHash, to: tx.cancel.to, value: tx.cancel.value }, { address: lane.address, nonce: tx.nonce }, SEPOLIA_CHAIN_ID) : ("absent" as RawVerdict),
      };
      // Order matters: the finalized nonce is read BEFORE the receipts (see decide, rule 2).
      const nonceFinalized = await primary.getNonce(from, "finalized");
      const fin = await primary.getFinalized();
      const original = tx.original.txHash ? await this.#observe(tx.original.txHash, fin.number, tx.cancel !== null) : null;
      const cancel = tx.cancel?.txHash ? await this.#observe(tx.cancel.txHash, fin.number, true) : null;
      const signed = tx.state === "Signed";
      const recipient = signed ? await this.#recipient(cid, tx.original.to as Hex) : "eoa";
      const balanceShort = signed ? await this.#balanceShort(from, tx.original.value, tx.original.maxFee, cfg.maxFeeCeiling) : false;
      obs = {
        ...base,
        finalizedNumber: fin.number,
        nonceFinalized,
        original,
        cancel,
        verdict,
        canRebroadcast: this.#mayBroadcast(cid, tx.state === "Signed" ? "original" : "cancel"),
        recipient,
        balanceShort,
      };
    }

    for (const a of decide(state, obs)) await this.#run(cid, a);
  }

  async #observe(hash: Hex, finalizedNumber: bigint, needAgreement: boolean): Promise<HashObs> {
    const [primary, ...others] = this.#d.evm as [EvmClient, ...EvmClient[]];
    const receipt = await primary.getReceipt(hash);
    if (receipt === null) return { receipt: null, refetchedHash: null, agreed: true };
    if (receipt.blockNumber > finalizedNumber) return { receipt, refetchedHash: null, agreed: true };
    const refetched = await primary.getBlock(receipt.blockNumber);
    let agreed = true;
    if (needAgreement) {
      for (const other of others) {
        try {
          const r = await other.getReceipt(hash);
          if (r === null || r.status !== receipt.status || r.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()) agreed = false;
        } catch (err) {
          agreed = false;
          this.#d.log({ event: "error", where: "evidence_second_rpc", class: describeError(err), rpc: other.label });
        }
      }
    }
    return { receipt, refetchedHash: refetched?.hash ?? null, agreed };
  }

  async #recipient(cid: number, to: Hex): Promise<"eoa" | "contract" | "unknown"> {
    const known = this.#recipientKind.get(cid);
    if (known !== undefined) return known;
    try {
      const code = await (this.#d.evm[0] as EvmClient).getCode(to);
      const kind = code === "0x" ? "eoa" : "contract";
      this.#recipientKind.set(cid, kind);
      return kind;
    } catch {
      return "unknown";
    }
  }

  async #balanceShort(from: Hex, value: bigint, maxFee: bigint, ceiling: bigint): Promise<boolean> {
    try {
      const balance = await (this.#d.evm[0] as EvmClient).getBalance(from);
      // value + the original's worst-case gas + headroom for the one cancel at the fee ceiling.
      return balance < value + TRANSFER_GAS * maxFee + TRANSFER_GAS * ceiling;
    } catch {
      return false;
    }
  }

  #mayBroadcast(cid: number, kind: Kind): boolean {
    const last = this.#lastBroadcast.get(`${cid}:${kind}`);
    return last === undefined || (this.#d.nowMs ?? Date.now)() - last >= (this.#d.rebroadcastMs ?? 60_000);
  }

  async #run(cid: number, a: Action): Promise<void> {
    const { near, log } = this.#d;
    switch (a.t) {
      case "anomaly":
        this.#stopped.add(cid);
        log({ event: "anomaly", cid, reason: a.reason });
        return;
      case "warn": {
        const key = `${cid}:${a.code}`;
        if (this.#warned.has(key)) return;
        this.#warned.add(key);
        log({ event: "warn", code: a.code, cid });
        return;
      }
      case "mark_unknown": {
        const result = await near.markUnknown(cid);
        log({ event: "mark_unknown", cid, result });
        return;
      }
      case "attest": {
        const result = await near.attest(cid, a.hash, { success: a.success, blockNumber: a.blockNumber, blockHash: a.blockHash });
        log({ event: "mined", cid, kind: a.kind, hash: a.hash, success: a.success, block: a.blockNumber, finalized: true });
        log({ event: "attested", cid, kind: a.kind, hash: a.hash, success: a.success, block: a.blockNumber, result });
        return;
      }
      case "broadcast": {
        this.#lastBroadcast.set(`${cid}:${a.kind}`, (this.#d.nowMs ?? Date.now)());
        const results = await Promise.all(
          this.#d.evm.map(async (c): Promise<[string, SendOutcome]> => {
            try {
              return [c.label, await c.sendRaw(a.raw)];
            } catch {
              return [c.label, { kind: "Unknown" }];
            }
          }),
        );
        for (const [rpc, r] of results) {
          log({ event: "broadcast", cid, kind: a.kind, hash: a.hash, rpc, outcome: r.kind });
          if (r.kind === "Accepted" && r.hash.toLowerCase() !== a.hash.toLowerCase()) {
            this.#stopped.add(cid);
            log({ event: "anomaly", cid, reason: "hash_mismatch" });
            return;
          }
        }
        return;
      }
    }
  }

  /** The long-running loop. Reads back off on 429 inside the clients; a failed tick just waits for the next. */
  async run(signal: AbortSignal, opts: { pollMs: number; once?: boolean; random?: () => number }): Promise<void> {
    const random = opts.random ?? Math.random;
    for (;;) {
      signal.throwIfAborted();
      try {
        await this.tick();
      } catch (err) {
        if (signal.aborted) return;
        this.#d.log({ event: "error", where: "tick", class: describeError(err) });
      }
      if (opts.once) return;
      try {
        await delay(opts.pollMs + random() * (opts.pollMs / 4), undefined, { signal });
      } catch {
        return;
      }
    }
  }
}

// ---- operator trigger: the one cancel ------------------------------------------------------------

/**
 * Ask the contract for the single nonce-burn cancel of an Unknown commitment. The running loop sees
 * the signed cancel in `get_signed_tx` and broadcasts it. Compare-and-set on the contract: a duplicate
 * request fails there, so an `unknown` send is resolved by re-reading the view.
 */
export async function requestCancel(near: NearClient, log: Logger, cid: number, maxFee: bigint, tip: bigint): Promise<SendResult> {
  await near.pin();
  const tx = await near.getSignedTx(cid);
  if (tx === null || tx.state !== "Unknown" || tx.cancel !== null) {
    log({ event: "cancel_requested", cid, max_fee: maxFee, tip, result: "refused" });
    return "refused";
  }
  let result = await near.requestCancel(cid, maxFee, tip);
  if (result === "unknown") {
    await near.pin();
    const after = await near.getSignedTx(cid);
    if (after?.cancel) result = "sent";
  }
  log({ event: "cancel_requested", cid, max_fee: maxFee, tip, result });
  return result;
}
