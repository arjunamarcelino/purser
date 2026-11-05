// Shared contract between the poller, the DB drivers and the read API.
// Everything here is DERIVED from chain: no field may be used to authorize or release funds.
// Amounts are decimal yocto strings; heights/timestamps are bigint; never `number`.

export type ReservationState = "Reserved" | "Signed" | "Confirmed" | "Unknown" | "Failed" | "Cancelled";
export type TxStatus = "resolved" | "pending" | "unavailable";

export interface TaskRow {
  task_id: string;
  owner: string;
  /** "NearNative" or "Nep141:<contract>" */
  token: string;
  cap: string;
  completed_cached: string;
  outstanding_cached: string;
  crew_cap: number;
  frozen: boolean;
}

export interface DelegateRow {
  account_id: string;
  active: boolean;
}

export interface CommitmentRow {
  commitment_id: number;
  delegate: string;
  recipient: string;
  reserved_amount: string;
  actual_spent: string | null;
  state: ReservationState;
  request_id: string;
  /** hex of the 32-byte payload_hash, or null */
  payload_hash: string | null;
  near_tx: string | null;
  evm_tx: string | null;
  tx_status: TxStatus;
}

/** One task's state read at a single pinned final block. Written in ONE transaction. */
export interface TaskSnapshot {
  task: TaskRow;
  delegates: DelegateRow[];
  commitments: CommitmentRow[];
}

export interface HistoryRow extends CommitmentRow {
  task_id: string;
  as_of_height: bigint;
}

export interface TaskSummary {
  task_id: string;
  synced_at: string;
  as_of_height: bigint;
  missing_since_height: bigint | null;
}

export interface Counts {
  task: number;
  commitment_event: number;
  delegate_snapshot: number;
  attestation: number;
  relayer_job: number;
  meta: number;
}

export interface HistoryPage {
  rows: HistoryRow[];
  /** opaque keyset cursor for the next page, or null */
  next: string | null;
}

export interface Repo extends AsyncDisposable {
  /** Applies migrations; refuses if the DB schema version is newer than the code. */
  init(): Promise<void>;
  /** Fails closed (throws MetaMismatchError) if the DB was created for another (network, contract_id). */
  ensureScope(scope: { network: string; contractId: string }): Promise<void>;
  /**
   * Upserts task → delegates → commitments in one txn. The as_of_height guard lives in SQL
   * (`>=`); a stale height returns "skipped_stale" and writes nothing for that task.
   * Delegates absent from `snap.delegates` but present in the DB are set active=false.
   */
  applyTaskSnapshot(snap: TaskSnapshot, asOfHeight: bigint): Promise<"applied" | "skipped_stale">;
  /** Marks tasks (not in `presentTaskIds`) as missing; clears the mark for tasks that reappeared. */
  reconcileTaskPresence(presentTaskIds: string[], asOfHeight: bigint): Promise<void>;
  /** Stored commitments of a task whose state is non-terminal, or Failed/Cancelled when `includeFailed`. */
  openCommitmentIds(opts: { includeFailed: boolean }): Promise<number[]>;
  /** Highest commitment_id stored (for id probing), or -1. */
  maxCommitmentId(): Promise<number>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  listTasks(): Promise<TaskSummary[]>;
  listHistory(opts: { task: string; limit: number; cursor?: string }): Promise<HistoryPage>;
  counts(): Promise<Counts>;
  /** sha256 hex over canonical JSON lines; see plan "Canonical dump". Excludes synced_at/observed_at/last_pass_at. */
  canonicalDump(): Promise<{ lines: string[]; sha256: string }>;
  /** Deletes all cache rows (children first) and clears the scope guard. Used only by `rebuild`. */
  wipe(): Promise<void>;
}

/** Error taxonomy: classes with a `kind` literal (no enums: erasableSyntaxOnly). */
export class MetaMismatchError extends Error {
  readonly kind = "meta_mismatch" as const;
}
export class RepoUnavailableError extends Error {
  readonly kind = "repo_unavailable" as const;
}
