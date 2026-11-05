// Glue between the view-only ChainReader and the repo: every response is zod-parsed before any
// write, and an unrecognised shape fails loudly instead of being coerced into something plausible.

import { z } from "zod";
import type {
  Commitment as ChainCommitment,
  Config as ChainConfigView,
  Delegate as ChainDelegate,
  InvariantView as ChainInvariant,
  PurserViews,
  TaskBudget as ChainTask,
} from "@purser/types";
import type { ChainReader } from "@purser/chain-read";
import { ChainShapeError } from "./errors.ts";
import type { CommitmentRow, TaskRow } from "./db/types.ts";

// Extra fields are tolerated (the contract may grow views); missing or mistyped ones are not.
// Amounts are decimal strings and never pass through `number`.
const Yocto = z.string().regex(/^\d{1,39}$/);
const Account = z.string().min(1);

// A new ReservationState must fail here: mapping it to Failed would make the cache lie about a reservation.
const ReservationState = z.enum(["Reserved", "Signed", "Confirmed", "Unknown", "Failed", "Cancelled"]);

const TokenSpec = z.union([z.literal("NearNative"), z.object({ Nep141: z.object({ contract: Account }) })]);
const Chain = z.union([z.literal("NearNative"), z.object({ Evm: z.object({ chain_id: z.number().int() }) })]);

export const TaskBudgetSchema = z.object({
  active_crew: z.number().int(),
  cap: Yocto,
  completed: Yocto,
  created_at: z.bigint(),
  crew_cap: z.number().int(),
  frozen: z.boolean(),
  outstanding: Yocto,
  owner: Account,
  token: TokenSpec,
}) satisfies z.ZodType<ChainTask>;

export const CommitmentSchema = z.object({
  actual_spent: Yocto.nullable().exactOptional(),
  created_at: z.bigint(),
  delegate: Account,
  evm_tx: z.string().nullable().exactOptional(),
  id: z.number().int().nonnegative(),
  intent: z.object({
    amount: Yocto,
    chain: Chain,
    memo: z.string().nullable().exactOptional(),
    recipient: Account,
    token: TokenSpec,
  }),
  near_tx: z.string().nullable().exactOptional(),
  payload_hash: z.array(z.number().int().min(0).max(255)).length(32).nullable().exactOptional(),
  payload_version: z.number().int().nullable().exactOptional(),
  request_id: z.string(),
  reserved_amount: Yocto,
  state: ReservationState,
  task: z.string(),
  updated_at: z.bigint(),
}) satisfies z.ZodType<ChainCommitment>;

export const DelegateSchema = z.object({
  account_id: Account,
  active: z.boolean(),
  added_at: z.bigint(),
  derivation_path: z.string(),
  public_key: z.string().nullable().exactOptional(),
}) satisfies z.ZodType<ChainDelegate>;

export const InvariantViewSchema = z.object({
  cap: Yocto,
  completed: Yocto,
  frozen: z.boolean(),
  holds: z.boolean(),
  outstanding: Yocto,
  used: Yocto,
}) satisfies z.ZodType<ChainInvariant>;

export const ConfigSchema = z.object({
  max_memo_len: z.number().int(),
  max_request_id_len: z.number().int(),
  max_task_id_len: z.number().int(),
  reconcile_min_age_ns: Yocto,
}) satisfies z.ZodType<ChainConfigView>;

export type TaskBudget = z.infer<typeof TaskBudgetSchema>;
export type Commitment = z.infer<typeof CommitmentSchema>;
export type Delegate = z.infer<typeof DelegateSchema>;
export type InvariantView = z.infer<typeof InvariantViewSchema>;
export type ChainConfig = z.infer<typeof ConfigSchema>;

function parse<T>(schema: z.ZodType<T>, what: string, raw: unknown): T {
  const r = schema.safeParse(raw);
  // The message names paths and codes only; zod's default text can quote the offending value.
  if (!r.success) {
    const where = r.error.issues.map((i) => `${i.path.join(".") || "<root>"} (${i.code})`).slice(0, 5).join(", ");
    throw new ChainShapeError(`${what}: unexpected shape at ${where}`);
  }
  return r.data;
}

type Args<M extends keyof PurserViews> = PurserViews[M]["args"];

export async function readTask(reader: ChainReader, args: Args<"get_task">, height: bigint, signal: AbortSignal): Promise<TaskBudget | null> {
  const raw = await reader.view("get_task", args, height, signal);
  return raw === null ? null : parse(TaskBudgetSchema, "get_task", raw);
}

export async function readInvariant(reader: ChainReader, args: Args<"invariant">, height: bigint, signal: AbortSignal): Promise<InvariantView | null> {
  const raw = await reader.view("invariant", args, height, signal);
  return raw === null ? null : parse(InvariantViewSchema, "invariant", raw);
}

export async function readDelegates(reader: ChainReader, args: Args<"list_delegates">, height: bigint, signal: AbortSignal): Promise<Delegate[]> {
  return parse(z.array(DelegateSchema), "list_delegates", await reader.view("list_delegates", args, height, signal));
}

export async function readCommitment(reader: ChainReader, args: Args<"get_commitment">, height: bigint, signal: AbortSignal): Promise<Commitment | null> {
  const raw = await reader.view("get_commitment", args, height, signal);
  return raw === null ? null : parse(CommitmentSchema, "get_commitment", raw);
}

export async function readTaskIds(reader: ChainReader, args: Args<"list_task_ids">, height: bigint, signal: AbortSignal): Promise<string[]> {
  return parse(z.array(z.string()), "list_task_ids", await reader.view("list_task_ids", args, height, signal));
}

export async function readConfig(reader: ChainReader, args: Args<"get_config">, height: bigint, signal: AbortSignal): Promise<ChainConfig> {
  return parse(ConfigSchema, "get_config", await reader.view("get_config", args, height, signal));
}

const hex = (bytes: number[]): string => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");

export function commitmentToRow(c: Commitment): CommitmentRow {
  const nearTx = c.near_tx ?? null;
  return {
    commitment_id: c.id,
    delegate: c.delegate,
    recipient: c.intent.recipient,
    reserved_amount: c.reserved_amount,
    actual_spent: c.actual_spent ?? null,
    state: c.state,
    request_id: c.request_id,
    payload_hash: c.payload_hash ? hex(c.payload_hash) : null,
    near_tx: nearTx,
    evm_tx: c.evm_tx ?? null,
    // The contract carries no tx hash on-chain for most rows; "pending" means "not resolved yet", not "absent".
    tx_status: nearTx ? "resolved" : "pending",
  };
}

/** `frozen` defaults to the task's own flag; the poller passes `invariant().frozen`, the authoritative source. */
export function taskToRow(t: TaskBudget, taskId: string, frozen: boolean = t.frozen): TaskRow {
  return {
    task_id: taskId,
    owner: t.owner,
    token: t.token === "NearNative" ? "NearNative" : `Nep141:${t.token.Nep141.contract}`,
    cap: t.cap,
    completed_cached: t.completed,
    outstanding_cached: t.outstanding,
    crew_cap: t.crew_cap,
    frozen,
  };
}
