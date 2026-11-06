// The relayer loop. `decide` is a pure reducer from (contract state, chain observations) to actions;
// `Relayer` gathers the observations and runs the actions. There is no local state that matters: the
// contract is the queue, and a restart re-derives everything from its views. The in-memory sets below
// only avoid repeating reads, warnings and broadcasts.
//
// What the relayer may do, and nothing else: broadcast bytes the contract signed, report what finalized,
// mark a stale commitment Unknown, and (on an operator's trigger) ask for the one nonce-burn cancel.

import { setTimeout as delay } from "node:timers/promises";
import { SEPOLIA_CHAIN_ID } from "./config.ts";
import { TRANSFER_GAS, verifyRaw, type EvmClient, type Hex, type RawVerdict, type Receipt, type SendOutcome } from "./evm.ts";
import { describeError, type Logger, type WarnCode } from "./log.ts";
import type { Lane, NearClient, SendResult, SignedTx } from "./near.ts";

export { TRANSFER_GAS };

/** The nonce-consumed-without-receipt anomaly needs this many consecutive ticks when there is no second RPC to ask. */
export const NONCE_ANOMALY_TICKS = 3;
/** Ids discovered per round of concurrent `get_commitment` reads. */
export const SCAN_BATCH = 4;

// ---- pure core -----------------------------------------------------------------------------------

export interface HashObs {
  receipt: Receipt | null;
  /** The block hash re-fetched at `receipt.blockNumber` (only read when that block is at or below `finalized`). */
  refetchedHash: Hex | null;
  /**
   * Every OTHER configured RPC reports the same status and block hash, with that block at or below ITS finalized
   * head. Computed for any release evidence (a cancel, a reverted original). True when there is no other RPC;
   * `Observations.singleRpc` says so, and decide() then refuses release evidence unless the operator opted in.
   */
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
  /** Only ONE RPC is configured: nothing can corroborate release evidence. */
  singleRpc: boolean;
  /** RELAYER_ALLOW_SINGLE_RPC_EVIDENCE=1. */
  allowSingleRpcEvidence: boolean;
  /**
   * Corroboration of "nonce consumed at finalized, no receipt for either hash". `others`: "none" = no second RPC;
   * "agree" = every other RPC says the same; "disagree" = at least one cannot confirm. `priorStreak` = consecutive
   * earlier ticks on which the condition held (only consulted when there is no second RPC).
   */
  nonceCheck: { others: "none" | "agree" | "disagree"; priorStreak: number };
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
  /** The nonce-consumed condition held this tick but is not yet confirmed: count it, do not stop. */
  | { t: "suspect"; reason: "nonce_consumed_no_receipt" }
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
      // Release evidence on ONE RPC's word is never sent unless the operator explicitly opted in.
      if (releaseEvidence && o.singleRpc && !o.allowSingleRpcEvidence) {
        out.push({ t: "warn", code: "evidence_needs_second_rpc" });
        continue;
      }
      out.push({ t: "attest", kind, hash, success, blockNumber: r.blockNumber, blockHash: r.blockHash });
    }
    return out;
  }

  // 2. Nothing mined. If the sender's nonce is already consumed at `finalized` yet neither of our hashes has
  //    a receipt, something else won the nonce (or the RPC is pruned, or a load balancer served two backends).
  //    One read is not enough to stop: every other RPC must say the same, or (alone) it must hold on
  //    NONCE_ANOMALY_TICKS consecutive ticks. The stop is re-evaluated every tick and clears with the condition.
  if (o.nonceFinalized !== null && o.nonceFinalized > tx.nonce) {
    const n = o.nonceCheck;
    if (n.others === "agree" || (n.others === "none" && n.priorStreak + 1 >= NONCE_ANOMALY_TICKS)) return [{ t: "anomaly", reason: "nonce_consumed_no_receipt" }];
    return [{ t: "suspect", reason: "nonce_consumed_no_receipt" }];
  }

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
  /** RELAYER_ALLOW_SINGLE_RPC_EVIDENCE=1: attest release evidence on one RPC's word (default false). */
  allowSingleRpcEvidence?: boolean;
  /** Concurrent `get_commitment` reads while discovering ids (default SCAN_BATCH). */
  scanBatch?: number;
}

const TERMINAL = new Set(["Confirmed", "Failed", "Cancelled"]);

export class Relayer {
  readonly #d: RelayerDeps;
  /** First id never read. Ids below it are known: terminal/non-EVM (`#done`) or live (`#active`). Memory only. */
  #nextUnseen = 0;
  #caughtUp = false;
  /** Live EVM commitments -> created_at (immutable, so it is read once at discovery). */
  readonly #active = new Map<number, bigint>();
  readonly #done = new Set<number>();
  /** Stopped for the process lifetime: a broadcast came back with a different hash than the contract signed. */
  readonly #hardStopped = new Set<number>();
  /** Currently stopped by an observation-based anomaly; re-evaluated (and cleared) on every tick. */
  readonly #anomalies = new Map<number, AnomalyReason>();
  readonly #nonceStreak = new Map<number, number>();
  readonly #lastBroadcast = new Map<string, number>();
  readonly #warned = new Set<string>();
  readonly #recipientKind = new Map<number, "eoa" | "contract" | "unknown">();
  /** A lane's address never changes for a path. */
  readonly #lanes = new Map<string, Lane>();

  constructor(deps: RelayerDeps) {
    this.#d = deps;
  }

  get stoppedCids(): ReadonlySet<number> {
    return new Set([...this.#hardStopped, ...this.#anomalies.keys()]);
  }

  /** One pass over every live EVM commitment. Returns how many were active. */
  async tick(): Promise<number> {
    const { near, log } = this.#d;
    await near.pin();
    const nowNs = await near.nowNs();
    const cfg = await near.getEvmCfg();
    if (cfg === null) {
      log({ event: "warn", code: "read_failed", cid: null, detail: "evm_cfg_unset" });
      return 0;
    }

    await this.#discover();
    const cids = [...this.#active.keys()].sort((x, y) => x - y);
    log({ event: "tick", active: cids.length, scanned_to: this.#nextUnseen });

    for (const cid of cids) {
      try {
        await this.#process(cid, nowNs, cfg);
      } catch (err) {
        log({ event: "error", where: "process", class: describeError(err) });
      }
    }
    return cids.length;
  }

  /**
   * Find ids this process has not seen yet, `scanBatch` reads at a time (ids are contiguous; the first absent id
   * is the end). Each id is read here exactly once for its whole life: a terminal one is remembered and never
   * read again; a live one is afterwards read through `get_signed_tx` only (its state, in the same read the
   * decision needs). Once caught up, a tick probes ONE id past the end.
   */
  async #discover(): Promise<void> {
    const { near, log } = this.#d;
    const width = Math.max(1, this.#d.scanBatch ?? SCAN_BATCH);
    let first = true;
    for (;;) {
      const size = first && this.#caughtUp ? 1 : width;
      first = false;
      const ids = Array.from({ length: size }, (_, i) => this.#nextUnseen + i);
      const results = await Promise.allSettled(ids.map((id) => near.getCommitment(id)));
      for (const [i, r] of results.entries()) {
        const cid = ids[i] as number;
        if (r.status === "rejected") {
          // Never skip an id we could not read: stop here, retry from this id next tick.
          log({ event: "error", where: "scan", class: describeError(r.reason) });
          log({ event: "warn", code: "cursor_stalled", cid });
          return;
        }
        const c = r.value;
        if (c === null) {
          this.#caughtUp = true;
          return;
        }
        this.#nextUnseen = cid + 1;
        if (!c.evm || TERMINAL.has(c.state)) this.#done.add(cid);
        else this.#active.set(cid, c.createdAtNs);
      }
      this.#caughtUp = false;
    }
  }

  async #lane(path: string): Promise<Lane | null> {
    const known = this.#lanes.get(path);
    if (known) return known;
    const lane = await this.#d.near.getLane(path);
    if (lane) this.#lanes.set(path, lane);
    return lane;
  }

  async #process(cid: number, nowNs: bigint, cfg: NonNullable<Awaited<ReturnType<NearClient["getEvmCfg"]>>>): Promise<void> {
    const { near, evm } = this.#d;
    if (this.#hardStopped.has(cid)) return;
    const createdAtNs = this.#active.get(cid);
    if (createdAtNs === undefined) return;
    // The single per-tick read of this id: it carries the state, so no separate get_commitment is needed.
    const tx = await near.getSignedTx(cid);
    if (tx === null) return;
    if (TERMINAL.has(tx.state)) {
      this.#active.delete(cid);
      this.#done.add(cid);
      this.#clear(cid);
      return;
    }
    const base = { nowNs, cfg: { minUnknownAgeNs: cfg.minUnknownAgeNs, reservedAmbiguousMinAgeNs: cfg.reservedAmbiguousMinAgeNs } };
    const state: CidState = { tx, createdAtNs, stopped: false };
    const single = evm.length < 2;
    const shared = { singleRpc: single, allowSingleRpcEvidence: this.#d.allowSingleRpcEvidence === true, nonceCheck: { others: "none" as const, priorStreak: this.#nonceStreak.get(cid) ?? 0 } };

    let obs: Observations;
    if (tx.state === "Reserved") {
      obs = { ...base, ...shared, finalizedNumber: null, nonceFinalized: null, original: null, cancel: null, verdict: { original: "absent", cancel: "absent" }, canRebroadcast: false, recipient: "eoa", balanceShort: false };
    } else {
      const lane = await this.#lane(tx.path);
      if (!lane) return;
      const primary = evm[0] as EvmClient;
      const from = lane.address as Hex;
      const laneRef = { address: lane.address, nonce: tx.nonce };
      const verdict = {
        original: await verifyRaw({ raw: tx.original.raw, txHash: tx.original.txHash, to: tx.original.to, value: tx.original.value, maxFee: tx.original.maxFee, tip: tx.original.tip }, laneRef, SEPOLIA_CHAIN_ID),
        cancel: tx.cancel ? await verifyRaw({ raw: tx.cancel.raw, txHash: tx.cancel.txHash, to: tx.cancel.to, value: tx.cancel.value, maxFee: tx.cancel.maxFee, tip: tx.cancel.tip }, laneRef, SEPOLIA_CHAIN_ID) : ("absent" as RawVerdict),
      };
      // Order matters: the finalized nonce is read BEFORE the receipts (see decide, rule 2).
      const nonceFinalized = await primary.getNonce(from, "finalized");
      const fin = await primary.getFinalized();
      const original = tx.original.txHash ? await this.#observe(tx.original.txHash, fin.number, "original") : null;
      const cancel = tx.cancel?.txHash ? await this.#observe(tx.cancel.txHash, fin.number, "cancel") : null;
      const consumed = nonceFinalized > tx.nonce && original?.receipt == null && cancel?.receipt == null;
      const others = consumed ? await this.#othersConfirmConsumed(from, tx) : "none";
      const signed = tx.state === "Signed";
      const recipient = signed ? await this.#recipient(cid, tx.original.to as Hex) : "eoa";
      const balanceShort = signed ? await this.#balanceShort(from, tx.original.value, tx.original.maxFee, cfg.maxFeeCeiling) : false;
      obs = {
        ...base,
        ...shared,
        nonceCheck: { others, priorStreak: shared.nonceCheck.priorStreak },
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

    const actions = decide(state, obs);
    const nonceHeld = actions.some((a) => a.t === "suspect" || (a.t === "anomaly" && a.reason === "nonce_consumed_no_receipt"));
    if (!nonceHeld) this.#nonceStreak.delete(cid);
    const prior = this.#anomalies.get(cid);
    if (prior !== undefined && !actions.some((a) => a.t === "anomaly")) {
      this.#anomalies.delete(cid);
      this.#d.log({ event: "anomaly_cleared", cid, reason: prior });
    }
    for (const a of actions) await this.#run(cid, a);
  }

  #clear(cid: number): void {
    this.#anomalies.delete(cid);
    this.#nonceStreak.delete(cid);
    this.#recipientKind.delete(cid);
  }

  /** Release evidence (a cancel, or a reverted original) needs every other RPC to report the same status AND block, final there too. */
  async #observe(hash: Hex, finalizedNumber: bigint, kind: Kind): Promise<HashObs> {
    const [primary, ...others] = this.#d.evm as [EvmClient, ...EvmClient[]];
    const receipt = await primary.getReceipt(hash);
    if (receipt === null) return { receipt: null, refetchedHash: null, agreed: true };
    if (receipt.blockNumber > finalizedNumber) return { receipt, refetchedHash: null, agreed: true };
    const refetched = await primary.getBlock(receipt.blockNumber);
    let agreed = true;
    if (kind === "cancel" || receipt.status === "reverted") {
      for (const other of others) {
        try {
          const r = await other.getReceipt(hash);
          if (r === null || r.status !== receipt.status || r.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
            agreed = false;
            continue;
          }
          const [fin, block] = await Promise.all([other.getFinalized(), other.getBlock(receipt.blockNumber)]);
          if (fin.number < receipt.blockNumber || block === null || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) agreed = false;
        } catch (err) {
          agreed = false;
          this.#d.log({ event: "error", where: "evidence_second_rpc", class: describeError(err), rpc: other.label });
        }
      }
    }
    return { receipt, refetchedHash: refetched?.hash ?? null, agreed };
  }

  /** The other RPCs must also see the nonce consumed at finalized and no receipt for either hash. */
  async #othersConfirmConsumed(from: Hex, tx: SignedTx): Promise<"none" | "agree" | "disagree"> {
    const others = this.#d.evm.slice(1);
    if (others.length === 0) return "none";
    for (const other of others) {
      try {
        if ((await other.getNonce(from, "finalized")) <= tx.nonce) return "disagree";
        for (const h of [tx.original.txHash, tx.cancel?.txHash ?? null]) if (h && (await other.getReceipt(h)) !== null) return "disagree";
      } catch (err) {
        this.#d.log({ event: "error", where: "nonce_second_rpc", class: describeError(err), rpc: other.label });
        return "disagree";
      }
    }
    return "agree";
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
        // Logged on the transition only; the next tick re-evaluates and clears it if the condition is gone.
        if (this.#anomalies.get(cid) !== a.reason) {
          this.#anomalies.set(cid, a.reason);
          log({ event: "anomaly", cid, reason: a.reason });
        }
        return;
      case "suspect": {
        const streak = (this.#nonceStreak.get(cid) ?? 0) + 1;
        this.#nonceStreak.set(cid, streak);
        log({ event: "warn", code: "nonce_unconfirmed", cid, detail: `${streak}/${NONCE_ANOMALY_TICKS}` });
        return;
      }
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
            this.#hardStopped.add(cid);
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

export interface CancelOutcome {
  result: SendResult;
  /** The signed cancel is visible in `get_signed_tx` (at optimistic finality): the request took effect. */
  onChain: boolean;
}
/** 0 = the cancel is on chain (requested now or earlier); 1 = refused, nothing requested; 3 = unresolved, check before re-running. */
export function cancelExitCode(o: CancelOutcome): 0 | 1 | 3 {
  if (o.onChain) return 0;
  return o.result === "refused" ? 1 : 3;
}
export interface CancelOptions {
  /** Polls of the optimistic view after an uncertain send (default 6). */
  pollAttempts?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Ask the contract for the single nonce-burn cancel of an Unknown commitment. The running loop sees
 * the signed cancel in `get_signed_tx` and broadcasts it. The contract's compare-and-set is the only real guard
 * against a duplicate: a second request fails there. The send is NEVER retried here; an uncertain one
 * (`unknown`) is resolved by polling `get_signed_tx` at OPTIMISTIC finality (the pinned final view lags a send
 * that waited for EXECUTED_OPTIMISTIC), and a `Failure` outcome is a definite `refused`.
 */
export async function requestCancel(near: NearClient, log: Logger, cid: number, maxFee: bigint, tip: bigint, opts: CancelOptions = {}): Promise<CancelOutcome> {
  const before = await near.getSignedTxFresh(cid);
  if (before === null || before.state !== "Unknown" || before.cancel !== null) {
    const onChain = before?.cancel != null;
    log({ event: "cancel_requested", cid, max_fee: maxFee, tip, result: "refused", on_chain: onChain });
    return { result: "refused", onChain };
  }
  let result = await near.requestCancel(cid, maxFee, tip);
  let onChain = result === "sent";
  if (result === "unknown") {
    const sleep = opts.sleep ?? ((ms: number) => delay(ms));
    for (let i = 0; i < (opts.pollAttempts ?? 6) && !onChain; i++) {
      await sleep(opts.pollMs ?? 2000);
      try {
        if ((await near.getSignedTxFresh(cid))?.cancel) {
          onChain = true;
          result = "sent";
        }
      } catch (err) {
        log({ event: "error", where: "cancel_resolve", class: describeError(err) });
      }
    }
  }
  log({ event: "cancel_requested", cid, max_fee: maxFee, tip, result, on_chain: onChain });
  return { result, onChain };
}
