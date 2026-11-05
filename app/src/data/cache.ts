// The off-chain history cache (indexer) as the board sees it. Everything here is untrusted input:
// it feeds a display-only list and never any owner action, release or kill-switch path.
//
// Deliberately NOT a HistorySource and NOT a ProposalRecord: the cache is a lagging, read-only mirror
// of chain events, while ProposalRecord is the proposer's self-asserted shape (refusals live only there).

import { NEAR_ACCOUNT_ID, NEAR_TX_HASH, SAFE_TASK_ID } from "@purser/types";
import { safeText } from "../lib/format.ts";

export type TxStatus = "resolved" | "pending" | "unavailable";

export interface CachedCommitment {
  readonly taskId: string;
  readonly commitmentId: string;
  readonly delegate: string;
  readonly recipient: string;
  readonly reservedAmount: string;
  readonly actualSpent: string | null;
  readonly state: string;
  readonly requestId: string | null;
  readonly nearTx: string | null;
  readonly txStatus: TxStatus;
  readonly asOfHeight: number;
}

export interface CacheStatus {
  readonly lastPassAt: number | null; // epoch ms, indexer clock
  readonly serverTime: number; // epoch ms, indexer clock at response
  readonly asOfHeight: number | null;
  readonly network: string;
  readonly contractId: string;
}

export interface CacheHistory {
  readonly rows: CachedCommitment[];
  readonly dropped: number;
}

export interface CacheHistorySource {
  history(task: string, signal: AbortSignal): Promise<CacheHistory>;
}
export interface CacheStatusSource {
  status(signal: AbortSignal): Promise<CacheStatus>;
}

/** The server answered, but for another network or contract: render nothing from it. */
export class WrongIndexerError extends Error {
  constructor(detail: string) {
    super(`wrong indexer: ${detail}`);
    this.name = "WrongIndexerError";
  }
}

const YOCTO = /^\d{1,39}$/;
const DIGITS = /^\d{1,15}$/; // heights and ids: stay inside 2^53
const ID_SAFE = /^[A-Za-z0-9_-]{1,64}$/;
const STATE = /^[A-Za-z][A-Za-z_]{0,31}$/;
const TX_STATUSES: readonly string[] = ["resolved", "pending", "unavailable"];
const MAX_ROWS = 200;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A string that survives unchanged through control/bidi stripping and matches `re`; else null. */
function clean(v: unknown, re: RegExp): string | null {
  if (typeof v !== "string") return null;
  const s = safeText(v, 256);
  return s === v && re.test(s) ? s : null;
}

/** Validates one history row. Returns null for anything that is not exactly the documented shape. */
export function validateRow(raw: unknown, task: string): CachedCommitment | null {
  if (!isObj(raw)) return null;
  const taskId = clean(raw.task_id, SAFE_TASK_ID);
  if (taskId === null || taskId !== task) return null;
  const commitmentId = clean(raw.commitment_id, DIGITS);
  const delegate = clean(raw.delegate, NEAR_ACCOUNT_ID);
  const recipient = clean(raw.recipient, NEAR_ACCOUNT_ID);
  const reservedAmount = clean(raw.reserved_amount, YOCTO);
  const state = clean(raw.state, STATE);
  const asOf = clean(raw.as_of_height, DIGITS);
  if (!commitmentId || !delegate || !recipient || !reservedAmount || !state || !asOf) return null;
  const actualSpent = raw.actual_spent == null ? null : clean(raw.actual_spent, YOCTO);
  if (raw.actual_spent != null && actualSpent === null) return null;
  const requestId = raw.request_id == null ? null : clean(raw.request_id, ID_SAFE);
  if (raw.request_id != null && requestId === null) return null;
  const nearTx = raw.near_tx == null ? null : clean(raw.near_tx, NEAR_TX_HASH);
  if (raw.near_tx != null && nearTx === null) return null;
  const txStatus = typeof raw.tx_status === "string" && TX_STATUSES.includes(raw.tx_status) ? (raw.tx_status as TxStatus) : null;
  if (txStatus === null) return null;
  return { taskId, commitmentId, delegate, recipient, reservedAmount, actualSpent, state, requestId, nearTx, txStatus, asOfHeight: Number(asOf) };
}

/** Validates a whole /history body: invalid rows are dropped and counted, never rendered. */
export function parseHistory(body: unknown, task: string): CacheHistory {
  if (!isObj(body) || !Array.isArray(body.rows)) throw new Error("history: malformed response");
  const rows: CachedCommitment[] = [];
  let dropped = 0;
  for (const raw of body.rows.slice(0, MAX_ROWS)) {
    const row = validateRow(raw, task);
    if (row) rows.push(row);
    else dropped++;
  }
  dropped += Math.max(0, body.rows.length - MAX_ROWS);
  return { rows, dropped };
}

function toMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** Validates /status and rejects it outright if it describes a different network or contract. */
export function parseStatus(body: unknown, own: { network: string; contractId: string }): CacheStatus {
  if (!isObj(body)) throw new Error("status: malformed response");
  if (body.network !== own.network || body.contract_id !== own.contractId) {
    throw new WrongIndexerError(`${safeText(String(body.network), 32)} / ${safeText(String(body.contract_id), 64)}`);
  }
  const serverTime = toMs(body.server_time);
  if (serverTime === null) throw new Error("status: bad server_time");
  const h = body.last_complete_height;
  const height = h == null ? null : clean(typeof h === "number" ? String(h) : h, DIGITS);
  if (h != null && height === null) throw new Error("status: bad height");
  return { lastPassAt: toMs(body.last_pass_at), serverTime, asOfHeight: height === null ? null : Number(height), network: own.network, contractId: own.contractId };
}

/** Age of the last indexer pass in ms, on the INDEXER's clock (the browser clock only measures elapsed time since receipt). */
export function cacheAgeMs(status: CacheStatus, receivedAt: number, now: number): number | null {
  if (status.lastPassAt === null) return null;
  return Math.max(0, status.serverTime + (now - receivedAt) - status.lastPassAt);
}

const TIMEOUT_MS = 5_000;

export class IndexerClient implements CacheHistorySource, CacheStatusSource {
  readonly #own: { network: string; contractId: string };
  readonly #base: string;

  constructor(own: { network: string; contractId: string }, base = "/__indexer") {
    this.#own = own;
    this.#base = base;
  }

  async #get(path: string, signal: AbortSignal): Promise<unknown> {
    const res = await fetch(`${this.#base}${path}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`indexer: HTTP ${res.status}`);
    return res.json();
  }

  async status(signal: AbortSignal): Promise<CacheStatus> {
    return parseStatus(await this.#get("/status", signal), this.#own);
  }

  async history(task: string, signal: AbortSignal): Promise<CacheHistory> {
    if (!SAFE_TASK_ID.test(task)) throw new Error("history: bad task id");
    return parseHistory(await this.#get(`/tasks/${encodeURIComponent(task)}/history?limit=100`, signal), task);
  }
}
