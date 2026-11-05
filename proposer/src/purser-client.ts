// The proposer's only window onto the chain: typed views, and one change method signed with a
// delegate's function-call key. Plain JsonRpcProvider on purpose — FailoverRpcProvider catches
// contract errors, re-broadcasts refusals to the next provider and loses the error type.

import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import {
  AccessKeyDepositWithFunctionCallActionError,
  AccessKeyDoesNotExistError,
  AccessKeyMethodNameMismatchActionError,
  AccessKeyNotEnoughAllowanceActionError,
  AccessKeyNotFoundActionError,
  AccessKeyReceiverMismatchActionError,
  AccessKeyRequiresFullAccessActionError,
  ContractExecutionError,
  HostGuestPanicError,
  InvalidTransactionError,
  TransactionExecutionError,
} from "near-api-js/rpc-errors";
import {
  type CommitmentId,
  type PurserViews,
  type RefusalCode,
  type ReservationState,
  type RetryClass,
  classifyRefusal,
  parseU64Safe,
  toCommitmentId,
} from "@purser/types";
import type { Secret } from "./config.ts";

export { parseU64Safe };

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

const txHashOf = (err: unknown): string | null => {
  const r = (err as { transactionResult?: { transaction?: { hash?: string } } }).transactionResult;
  return r?.transaction?.hash ?? null;
};

/**
 * Classify a failed send. The rule that keeps retries exactly-once: a failure is FINAL only with
 * proof of what happened to the transaction —
 *   - it executed and failed (a contract/action execution error carrying the outcome): a frozen
 *     refusal on an EXACT message match, anything else `unclassified` (never passed off as a refusal);
 *   - it was never accepted (the node rejected it at validation, e.g. an access-key violation).
 * Everything else — timeouts, HTTP 5xx, exhausted retries, cut-off bodies — is `unknown`: the
 * transaction may have been broadcast, so the caller resolves it via get_idempotency.
 */
export function classifySendError(err: unknown): SendResult {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.constructor.name : typeof err;

  if (err instanceof InvalidTransactionError || err instanceof AccessKeyDoesNotExistError || isAccessKeyActionError(err)) {
    return { kind: "rejected_by_protocol", errorClass: name, raw: message };
  }
  const executed = err instanceof ContractExecutionError || err instanceof TransactionExecutionError;
  if (!executed) return { kind: "unknown", raw: `${name}: ${message}` };

  const raw = err instanceof HostGuestPanicError ? err.panicMessage : message;
  const refusal = classifyRefusal(raw);
  if (refusal) return { kind: "refused", code: refusal.code, retry: refusal.retry, raw, txHash: txHashOf(err) };
  return { kind: "unclassified", raw: `${name}: ${raw}`, txHash: txHashOf(err) };
}

const isAccessKeyActionError = (err: unknown) =>
  err instanceof AccessKeyNotFoundActionError ||
  err instanceof AccessKeyReceiverMismatchActionError ||
  err instanceof AccessKeyMethodNameMismatchActionError ||
  err instanceof AccessKeyRequiresFullAccessActionError ||
  err instanceof AccessKeyNotEnoughAllowanceActionError ||
  err instanceof AccessKeyDepositWithFunctionCallActionError;

// Measured on nearcore 2.14 (sandbox): one proposal burns ~6.4 Tgas end to end (transfer + 10 Tgas
// settlement callback) and uses ~0.0006 NEAR of the function-call allowance. 50 Tgas is ~8x headroom.
export const PROPOSE_GAS = 50_000_000_000_000n;

/** What the agent needs from a delegate: its account id and one exact-bytes send. */
export interface Sender {
  readonly accountId: string;
  proposeRaw(argsJson: string): Promise<SendResult>;
}

/** A delegate's signing handle. The function-call key can call `propose_payment` and nothing else. */
export class DelegateSender implements Sender {
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

/**
 * Refuse to sign with anything but a function-call key scoped to exactly `propose_payment` on
 * this contract with a finite allowance. Checked against the chain at startup, so a hand-edited
 * env file holding a full-access key cannot widen the proposer's authority.
 */
export async function assertProposeOnlyKey(provider: JsonRpcProvider, accountId: string, key: Secret, contractId: string): Promise<void> {
  const publicKey = KeyPair.fromString(key.reveal() as KeyPairString).getPublicKey().toString();
  const k = await provider.viewAccessKey({ accountId, publicKey });
  type FunctionCallPermission = { FunctionCall?: { receiver_id: string; method_names: string[]; allowance?: string | null } };
  const permission = k.permission as FunctionCallPermission | "FullAccess";
  const perm = typeof permission === "object" ? permission.FunctionCall : undefined;
  if (!perm) throw new Error(`${accountId}: the configured key is a FULL-ACCESS key; the proposer may only hold a propose_payment function-call key`);
  if (perm.receiver_id !== contractId) throw new Error(`${accountId}: key is scoped to ${perm.receiver_id}, not ${contractId}`);
  if (perm.method_names.length !== 1 || perm.method_names[0] !== "propose_payment") {
    throw new Error(`${accountId}: key allows [${perm.method_names.join(", ")}] (empty = every method); expected exactly [propose_payment]`);
  }
  if (perm.allowance === null || perm.allowance === undefined) throw new Error(`${accountId}: key has an unlimited allowance`);
}

export const hex = (bytes: readonly number[] | null | undefined): string | null =>
  bytes ? Buffer.from(bytes).toString("hex") : null;
