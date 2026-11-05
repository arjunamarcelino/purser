// The proposer's only window onto the chain: typed views, and one change method signed with a
// delegate's function-call key. Plain JsonRpcProvider on purpose — FailoverRpcProvider catches
// contract errors, re-broadcasts refusals to the next provider and loses the error type.

import { Account, JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";
import {
  type CommitmentId,
  type PurserViews,
  type RefusalCode,
  type ReservationState,
  type RetryClass,
  U64_BIGINT_FIELDS,
  classifyRefusal,
  toCommitmentId,
} from "@purser/types";
import type { Secret } from "./config.ts";

const bigintFields = new Set<string>(U64_BIGINT_FIELDS);

/**
 * JSON.parse that keeps u64 precision: block timestamps (~1.7e18 > 2^53) become bigint, read from
 * the exact source text; any other unsafe integer throws rather than silently rounding.
 */
export function parseU64Safe(text: string): unknown {
  const reviver = (key: string, value: unknown, ctx?: { source?: string }) => {
    if (typeof value !== "number" || !Number.isInteger(value)) return value;
    if (bigintFields.has(key) && ctx?.source !== undefined) return BigInt(ctx.source);
    if (!Number.isSafeInteger(value)) throw new RangeError(`unsafe integer in field "${key}"`);
    return value;
  };
  return JSON.parse(text, reviver as (k: string, v: unknown) => unknown);
}

const decoder = new TextDecoder();

export class PurserViewer {
  readonly provider: JsonRpcProvider;
  readonly contractId: string;

  constructor(provider: JsonRpcProvider, contractId: string) {
    this.provider = provider;
    this.contractId = contractId;
  }

  async view<M extends keyof PurserViews>(method: M, args: PurserViews[M]["args"]): Promise<PurserViews[M]["result"]> {
    const raw = await this.provider.callFunctionRaw({
      contractId: this.contractId,
      method,
      args: new TextEncoder().encode(JSON.stringify(args)),
      blockQuery: { finality: "optimistic" },
    });
    return parseU64Safe(decoder.decode(Uint8Array.from(raw.result))) as PurserViews[M]["result"];
  }

  async chainId(): Promise<string> {
    return (await this.provider.viewNodeStatus()).chain_id;
  }
}

export type ChainOutcome =
  | { kind: "admitted"; cid: CommitmentId; state: ReservationState; txHash: string | null; payloadHash: string | null }
  | { kind: "replayed"; cid: CommitmentId; state: ReservationState; txHash: string | null; payloadHash: string | null }
  | { kind: "refused"; code: RefusalCode; retry: RetryClass; raw: string; txHash: string | null }
  | { kind: "rejected_by_protocol"; errorClass: string; raw: string }
  | { kind: "unclassified"; raw: string; txHash: string | null }
  | { kind: "unknown"; raw: string };

/** What a send attempt produced, before any follow-up reads. */
export type SendResult =
  | { kind: "success"; cid: CommitmentId; txHash: string }
  | Exclude<ChainOutcome, { kind: "admitted" | "replayed" }>;

const ACCESS_KEY_ERRORS = new Set([
  "AccessKeyNotFoundActionError",
  "AccessKeyReceiverMismatchActionError",
  "AccessKeyMethodNameMismatchActionError",
  "AccessKeyRequiresFullAccessActionError",
  "AccessKeyNotEnoughAllowanceActionError",
  "AccessKeyDepositWithFunctionCallActionError",
  "InvalidAccessKeyError",
  "InvalidTxError",
]);
const TRANSPORT_UNKNOWN = new Set(["TransactionTimeoutError", "TimeoutError", "AbortError"]);

function errorName(err: unknown): string {
  if (err instanceof Error) {
    if (ACCESS_KEY_ERRORS.has(err.name) || TRANSPORT_UNKNOWN.has(err.name)) return err.name;
    // near-api-js error classes keep their class name; walk the prototype chain for a known one.
    for (let p: object | null = err; p !== null && p !== Error.prototype; p = Object.getPrototypeOf(p)) {
      const n = (p as { constructor?: { name?: string } }).constructor?.name;
      if (n && (ACCESS_KEY_ERRORS.has(n) || TRANSPORT_UNKNOWN.has(n))) return n;
    }
    return err.constructor.name;
  }
  return typeof err;
}

const txHashOf = (err: unknown): string | null => {
  const r = (err as { transactionResult?: { transaction?: { hash?: string } } }).transactionResult;
  return r?.transaction?.hash ?? null;
};

/**
 * Classify a failed send. A refusal is reported only on an EXACT frozen-message match; anything
 * else that executed is `unclassified`, never passed off as a refusal. Failures where we cannot
 * know whether the transaction landed are `unknown` and must be resolved via get_idempotency.
 */
export function classifySendError(err: unknown): SendResult {
  const name = errorName(err);
  const message = err instanceof Error ? err.message : String(err);
  const panic = (err as { panicMessage?: unknown }).panicMessage;
  const raw = typeof panic === "string" ? panic : message;

  if (ACCESS_KEY_ERRORS.has(name)) return { kind: "rejected_by_protocol", errorClass: name, raw: message };
  if (TRANSPORT_UNKNOWN.has(name) || (err instanceof TypeError && /fetch failed/i.test(message))) {
    return { kind: "unknown", raw: `${name}: ${message}` };
  }
  const refusal = classifyRefusal(raw);
  if (refusal) return { kind: "refused", code: refusal.code, retry: refusal.retry, raw, txHash: txHashOf(err) };
  // A contract/runtime failure that is not a frozen refusal (gas, serde, a new message...).
  if ((err as { transactionResult?: unknown }).transactionResult !== undefined || name.endsWith("Error")) {
    return { kind: "unclassified", raw: `${name}: ${raw}`, txHash: txHashOf(err) };
  }
  return { kind: "unknown", raw: `${name}: ${message}` };
}

export const PROPOSE_GAS = 50_000_000_000_000n; // 50 Tgas; measured burn is recorded in BUILD-START-VERIFICATION

/** A delegate's signing handle. The function-call key can call `propose_payment` and nothing else. */
export class DelegateSender {
  readonly accountId: string;
  readonly #account: Account;
  readonly #contractId: string;
  readonly #timeoutMs: number;

  constructor(opts: { provider: JsonRpcProvider; contractId: string; accountId: string; fcKey: Secret; timeoutMs?: number }) {
    this.accountId = opts.accountId;
    this.#contractId = opts.contractId;
    this.#timeoutMs = opts.timeoutMs ?? 60_000;
    const signer = KeyPairSigner.fromSecretKey(opts.fcKey.reveal() as KeyPairString);
    this.#account = new Account(opts.accountId, opts.provider, signer);
  }

  /** Send `propose_payment` with EXACTLY these argument bytes (journaled before this call). */
  async proposeRaw(argsJson: string): Promise<SendResult> {
    const call = this.#account.callFunctionRaw({
      contractId: this.#contractId,
      methodName: "propose_payment",
      args: new TextEncoder().encode(argsJson),
      gas: PROPOSE_GAS,
      deposit: 0n, // a function-call key cannot attach a deposit
      waitUntil: "EXECUTED_OPTIMISTIC", // explicit: the settlement callback's cid is final here
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("send timed out"), { name: "TimeoutError" })), this.#timeoutMs);
    });
    try {
      const res = await Promise.race([call, timeout]);
      const status = res.status as { SuccessValue?: string } | string;
      const value = typeof status === "object" ? status.SuccessValue : undefined;
      if (value === undefined) return { kind: "unknown", raw: `unexpected final status ${JSON.stringify(status)}` };
      const cid = toCommitmentId(JSON.parse(Buffer.from(value, "base64").toString("utf8")));
      return { kind: "success", cid, txHash: res.transaction.hash };
    } catch (err) {
      return classifySendError(err);
    } finally {
      clearTimeout(timer);
    }
  }
}

export const hex = (bytes: readonly number[] | null | undefined): string | null =>
  bytes ? Buffer.from(bytes).toString("hex") : null;
