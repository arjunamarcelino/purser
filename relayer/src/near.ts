// The relayer's NEAR side. Views go through @purser/chain-read (pinned final block, 429-aware retry);
// the three sends use the relayer's function-call key. Every number crosses the boundary here, once,
// as a decimal string -> bigint (the contract serialises every u64/u128 view field as a string).

import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import {
  AccessKeyDoesNotExistError,
  AccessKeyMethodNameMismatchActionError,
  AccessKeyNotEnoughAllowanceActionError,
  AccessKeyNotFoundActionError,
  AccessKeyReceiverMismatchActionError,
  AccessKeyRequiresFullAccessActionError,
  ContractExecutionError,
  InvalidTransactionError,
  TransactionExecutionError,
} from "near-api-js/rpc-errors";
import { NearChainReader, UnknownBlockError, retryRateLimited, withTimeout } from "@purser/chain-read";
import type { PurserViews, ReservationState } from "@purser/types";
import { z } from "zod";
import { StartupError, type Secret } from "./config.ts";
import type { Hex } from "./evm.ts";

// ---- the one decimal-string parser ---------------------------------------------------------------

const DECIMAL = /^(0|[1-9][0-9]*)$/;
/** A u64/u128 on the wire: a decimal string (never a JSON number). */
export const bigintFromDecimalString = z
  .string()
  .regex(DECIMAL, { error: "expected a decimal string" })
  .transform((s) => BigInt(s));
/** created_at / updated_at are u64 JSON numbers; chain-read's parser has already made them bigint. */
const nsField = z.union([z.bigint(), z.number().int().nonnegative().transform((n) => BigInt(n))]);
const hex = z.string().regex(/^0x[0-9a-fA-F]*$/).transform((s) => s as Hex);
const hash32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((s) => s as Hex);

const STATES = ["Reserved", "Signed", "Confirmed", "Unknown", "Failed", "Cancelled"] as const satisfies readonly ReservationState[];
const state = z.enum(STATES);

const CommitmentSchema = z.object({
  id: z.number().int().nonnegative(),
  state,
  created_at: nsField,
  intent: z.object({ chain: z.union([z.literal("NearNative"), z.object({ Evm: z.object({ chain_id: z.number() }) })]) }),
});

const EvmTxSchema = z.object({
  max_fee_per_gas: bigintFromDecimalString,
  max_priority_fee_per_gas: bigintFromDecimalString,
  to: z.string(),
  value: bigintFromDecimalString,
  raw_tx: hex.nullish(),
  tx_hash: hash32.nullish(),
});

const SignedTxSchema = z.object({
  commitment_id: z.number().int().nonnegative(),
  state,
  path: z.string(),
  chain_id: bigintFromDecimalString,
  nonce: bigintFromDecimalString,
  from: z.string(),
  signed_at_ns: bigintFromDecimalString.nullish(),
  original: EvmTxSchema,
  cancel: EvmTxSchema.nullish(),
  evidence: z.string().nullish(),
});

const LaneSchema = z.object({ path: z.string(), chain_id: bigintFromDecimalString, address: z.string(), next_nonce: bigintFromDecimalString.nullish(), in_flight: z.number().nullish() });

const CfgSchema = z.object({
  chain_id: bigintFromDecimalString,
  max_fee_ceiling: bigintFromDecimalString,
  max_priority_ceiling: bigintFromDecimalString,
  min_unknown_age_ns: bigintFromDecimalString,
  reserved_ambiguous_min_age_ns: bigintFromDecimalString,
  cancel_bump_bps: bigintFromDecimalString,
});

export interface CommitmentLite {
  id: number;
  state: ReservationState;
  evm: boolean;
  createdAtNs: bigint;
}
export interface EvmTx {
  maxFee: bigint;
  tip: bigint;
  to: string;
  value: bigint;
  raw: Hex | null;
  txHash: Hex | null;
}
export interface SignedTx {
  cid: number;
  state: ReservationState;
  path: string;
  chainId: bigint;
  nonce: bigint;
  from: string;
  signedAtNs: bigint | null;
  original: EvmTx;
  cancel: EvmTx | null;
  evidence: string | null;
}
export interface Lane {
  address: string;
  nextNonce: bigint | null;
}
export interface EvmCfg {
  chainId: bigint;
  maxFeeCeiling: bigint;
  maxPriorityCeiling: bigint;
  minUnknownAgeNs: bigint;
  reservedAmbiguousMinAgeNs: bigint;
  cancelBumpBps: bigint;
}

const toTx = (t: z.infer<typeof EvmTxSchema>): EvmTx => ({ maxFee: t.max_fee_per_gas, tip: t.max_priority_fee_per_gas, to: t.to, value: t.value, raw: t.raw_tx ?? null, txHash: t.tx_hash ?? null });

export function parseCommitment(v: unknown): CommitmentLite | null {
  if (v === null) return null;
  const c = CommitmentSchema.parse(v);
  return { id: c.id, state: c.state, evm: typeof c.intent.chain === "object", createdAtNs: c.created_at };
}
export function parseSignedTx(v: unknown): SignedTx | null {
  if (v === null) return null;
  const s = SignedTxSchema.parse(v);
  return { cid: s.commitment_id, state: s.state, path: s.path, chainId: s.chain_id, nonce: s.nonce, from: s.from, signedAtNs: s.signed_at_ns ?? null, original: toTx(s.original), cancel: s.cancel ? toTx(s.cancel) : null, evidence: s.evidence ?? null };
}
export function parseLane(v: unknown): Lane | null {
  if (v === null) return null;
  const l = LaneSchema.parse(v);
  return { address: l.address, nextNonce: l.next_nonce ?? null };
}
export function parseCfg(v: unknown): EvmCfg | null {
  if (v === null) return null;
  const c = CfgSchema.parse(v);
  return { chainId: c.chain_id, maxFeeCeiling: c.max_fee_ceiling, maxPriorityCeiling: c.max_priority_ceiling, minUnknownAgeNs: c.min_unknown_age_ns, reservedAmbiguousMinAgeNs: c.reserved_ambiguous_min_age_ns, cancelBumpBps: c.cancel_bump_bps };
}

// ---- client --------------------------------------------------------------------------------------

/** `sent`: executed. `refused`: rejected or failed with proof. `unknown`: may or may not have landed; re-read views. */
export type SendResult = "sent" | "refused" | "unknown";

export interface AttestOutcome {
  success: boolean;
  blockNumber: bigint;
  blockHash: Hex;
}

export interface NearClient {
  /** Pin all views of one tick to one final block (call at the start of a tick). */
  pin(): Promise<void>;
  nowNs(): Promise<bigint>;
  getEvmCfg(): Promise<EvmCfg | null>;
  getRelayer(): Promise<string | null>;
  getCommitment(cid: number): Promise<CommitmentLite | null>;
  getSignedTx(cid: number): Promise<SignedTx | null>;
  getLane(path: string): Promise<Lane | null>;
  /** Idempotent by contract design: a blind resend is safe. Finality is always `Finalized`. */
  attest(cid: number, txHash: Hex, outcome: AttestOutcome): Promise<SendResult>;
  /** Idempotent: a no-op `false` once the commitment has left Reserved/Signed. */
  markUnknown(cid: number): Promise<SendResult>;
  /** Compare-and-set on the contract: a second call fails, so an `unknown` is resolved by re-reading get_signed_tx. */
  requestCancel(cid: number, maxFee: bigint, tip: bigint): Promise<SendResult>;
}

export const RELAYER_METHODS = ["attest_external", "mark_unknown", "request_cancel"] as const;
// Measured by the contract's gas tests are provisional; request_cancel starts a sign promise
// (contract requires >= EVM_MIN_PREPAID = 100 Tgas prepaid).
const GAS_ATTEST = 50_000_000_000_000n;
const GAS_CANCEL = 200_000_000_000_000n;

const isProtocolRejection = (err: unknown) =>
  err instanceof InvalidTransactionError ||
  err instanceof AccessKeyDoesNotExistError ||
  err instanceof AccessKeyNotFoundActionError ||
  err instanceof AccessKeyReceiverMismatchActionError ||
  err instanceof AccessKeyMethodNameMismatchActionError ||
  err instanceof AccessKeyRequiresFullAccessActionError ||
  err instanceof AccessKeyNotEnoughAllowanceActionError;

export function classifyNearSendError(err: unknown): SendResult {
  if (isProtocolRejection(err) || err instanceof ContractExecutionError || err instanceof TransactionExecutionError) return "refused";
  return "unknown";
}

export interface RpcNearClientOptions {
  rpcUrl: string;
  contractId: string;
  accountId: string;
  key: Secret;
  signal: AbortSignal;
  timeoutMs?: number;
}

export class RpcNearClient implements NearClient {
  readonly provider: JsonRpcProvider;
  readonly #reader: NearChainReader;
  readonly #account: Account;
  readonly #contractId: string;
  readonly #signal: AbortSignal;
  readonly #timeoutMs: number;
  #height: bigint | null = null;

  constructor(opts: RpcNearClientOptions) {
    // near-api-js 7: `retries` is the ATTEMPT count; chain-read does the 429 retrying.
    this.provider = new JsonRpcProvider({ url: opts.rpcUrl }, { retries: 1 });
    this.#reader = new NearChainReader({ rpcUrl: opts.rpcUrl, contractId: opts.contractId, provider: this.provider });
    this.#contractId = opts.contractId;
    this.#signal = opts.signal;
    this.#timeoutMs = opts.timeoutMs ?? 60_000;
    this.#account = new Account(opts.accountId, this.provider, KeyPairSigner.fromSecretKey(opts.key.reveal() as KeyPairString));
  }

  async pin(): Promise<void> {
    this.#height = (await this.#reader.finalBlock(this.#signal)).height;
  }

  async nowNs(): Promise<bigint> {
    const b = await retryRateLimited(() => withTimeout(this.provider.viewBlock({ finality: "final" }), this.#signal), { signal: this.#signal });
    return BigInt(b.header.timestamp_nanosec);
  }

  async #view<M extends keyof PurserViews>(method: M, args: PurserViews[M]["args"]): Promise<unknown> {
    if (this.#height === null) await this.pin();
    try {
      return await this.#reader.view(method, args, this.#height as bigint, this.#signal);
    } catch (err) {
      if (!(err instanceof UnknownBlockError)) throw err;
      await this.pin();
      return this.#reader.view(method, args, this.#height as bigint, this.#signal);
    }
  }

  async getEvmCfg() {
    return parseCfg(await this.#view("get_evm_cfg", {}));
  }
  async getRelayer() {
    const v = await this.#view("get_relayer", {});
    return v === null ? null : z.string().parse(v);
  }
  async getCommitment(cid: number) {
    return parseCommitment(await this.#view("get_commitment", { commitment_id: cid }));
  }
  async getSignedTx(cid: number) {
    return parseSignedTx(await this.#view("get_signed_tx", { commitment_id: cid }));
  }
  async getLane(path: string) {
    return parseLane(await this.#view("evm_lane", { path }));
  }

  attest(cid: number, txHash: Hex, o: AttestOutcome): Promise<SendResult> {
    const args = {
      commitment_id: cid,
      tx_hash: txHash,
      outcome: { Landed: { success: o.success, finality: "Finalized", block_number: o.blockNumber.toString(), block_hash: o.blockHash, signature: null } },
    };
    return this.#send("attest_external", args, GAS_ATTEST);
  }
  markUnknown(cid: number): Promise<SendResult> {
    return this.#send("mark_unknown", { commitment_id: cid }, GAS_ATTEST);
  }
  requestCancel(cid: number, maxFee: bigint, tip: bigint): Promise<SendResult> {
    return this.#send("request_cancel", { commitment_id: cid, max_fee: maxFee.toString(), tip: tip.toString() }, GAS_CANCEL);
  }

  /** One attempt, never retried here: an uncertain send is resolved by re-reading views next tick. */
  async #send(methodName: (typeof RELAYER_METHODS)[number], args: object, gas: bigint): Promise<SendResult> {
    const call = this.#account.callFunctionRaw({
      contractId: this.#contractId,
      methodName,
      args: new TextEncoder().encode(JSON.stringify(args)),
      gas,
      deposit: 0n,
      waitUntil: "EXECUTED_OPTIMISTIC",
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("send timed out"), { name: "TimeoutError" })), this.#timeoutMs);
    });
    try {
      const res = await Promise.race([call, timeout]);
      const status = res.status as { SuccessValue?: string } | string;
      return typeof status === "object" && status.SuccessValue !== undefined ? "sent" : "unknown";
    } catch (err) {
      return classifyNearSendError(err);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Refuse to run with a key that can do more than the relayer's three calls. Checked against the chain
 * at startup so a hand-edited env file holding a full-access key cannot widen the relayer's authority.
 */
export async function assertRelayerKey(provider: JsonRpcProvider, accountId: string, key: Secret, contractId: string): Promise<void> {
  const publicKey = KeyPair.fromString(key.reveal() as KeyPairString).getPublicKey().toString();
  const k = await retryRateLimited(() => provider.viewAccessKey({ accountId, publicKey }));
  type FunctionCallPermission = { FunctionCall?: { receiver_id: string; method_names: string[] } };
  const permission = k.permission as FunctionCallPermission | "FullAccess";
  const perm = typeof permission === "object" ? permission.FunctionCall : undefined;
  if (!perm) throw new StartupError("the configured relayer key is a FULL-ACCESS key; use a function-call key");
  if (perm.receiver_id !== contractId) throw new StartupError("the relayer key is scoped to a different contract");
  const allowed = new Set<string>(RELAYER_METHODS);
  if (perm.method_names.length === 0 || perm.method_names.some((m) => !allowed.has(m))) {
    throw new StartupError(`the relayer key must allow only [${RELAYER_METHODS.join(", ")}] (empty = every method)`);
  }
}
