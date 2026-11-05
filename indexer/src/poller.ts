// Mirrors the contract into the cache. View calls only: nothing here signs, sends, or reads cache
// rows to decide anything about funds. The cache is written only from what the chain returned at H.

import type { ChainReader, Sleep } from "@purser/chain-read";
import { UnknownBlockError } from "@purser/chain-read";
import {
  commitmentToRow,
  readCommitment,
  readConfig,
  readDelegates,
  readInvariant,
  readTask,
  readTaskIds,
  taskToRow,
  type Commitment,
} from "./chain.ts";
import type { CommitmentRow, DelegateRow, Repo, TaskSnapshot } from "./db/types.ts";
import { ChainReadError, ChainShapeError, MetaMismatchError, RepoUnavailableError } from "./errors.ts";
import { nullResolver, type TxResolver } from "./txlink.ts";

const PAGE = 100;
const MAX_REPINS = 3;
const FULL_REREAD_EVERY = 20;
const SCHEMA_VERSION = "1";
const CURSOR_KEY = "commitment_cursor";

export interface PassConfig {
  network: string;
  contractId: string;
  passBudgetMs: number;
}

export interface PassOptions {
  reader: ChainReader;
  repo: Repo;
  resolver?: TxResolver;
  now?: () => Date;
  signal: AbortSignal;
  config: PassConfig;
  passNo: number;
  /** also re-read stored Failed/Cancelled rows this pass (default: every 20th pass) */
  includeFailed?: boolean;
  log?: (line: string) => void;
}

export interface TaskOutcome {
  taskId: string;
  status: "applied" | "skipped_stale" | "failed" | "deferred";
  commitmentsSeen: number;
  asOfHeight: bigint;
  error?: string;
}

export interface PassResult {
  /** every listed task was read and written, so the pass metadata advanced */
  complete: boolean;
  aborted: boolean;
  height: bigint | null;
  tasks: TaskOutcome[];
  ignoredCommitments: number;
  /** a failure was rate limiting (429) rather than a shape/other error */
  rateLimited: boolean;
  failureKinds: string[];
}

const RATE_LIMITED = /\b429\b|rate limit/i;
const isRateLimited = (e: unknown): boolean => e instanceof Error && RATE_LIMITED.test(`${e.message} ${String((e as { cause?: unknown }).cause ?? "")}`);

/** A failure line carries the kind and where, never the chain's values. */
function describe(e: unknown): string {
  if (e instanceof ChainShapeError) return `chain_shape: ${e.message}`;
  if (e instanceof Error) return `chain_read: ${e.name}`;
  return "chain_read: unknown";
}

async function pageAll<T>(fetch: (from: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = await fetch(from);
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}

interface TaskRead {
  taskId: string;
  base: Omit<TaskSnapshot, "commitments">;
}

async function readOneTask(reader: ChainReader, taskId: string, h: bigint, signal: AbortSignal): Promise<TaskRead> {
  const task = await readTask(reader, { task_id: taskId }, h, signal);
  if (task === null) throw new ChainReadError("get_task returned null for a listed task");
  const inv = await readInvariant(reader, { task_id: taskId }, h, signal);
  if (inv === null) throw new ChainReadError("invariant returned null for a listed task");
  const delegates = await pageAll((from_index) => readDelegates(reader, { task_id: taskId, from_index, limit: PAGE }, h, signal));
  const rows: DelegateRow[] = delegates.map((d) => ({ account_id: d.account_id, active: d.active }));
  return { taskId, base: { task: taskToRow(task, taskId, inv.frozen), delegates: rows } };
}

async function runPassAt(opts: PassOptions, reader: ChainReader, h: bigint): Promise<PassResult> {
  const { repo, signal, config, passNo } = opts;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const resolver = opts.resolver ?? nullResolver;
  const startedMs = now().getTime();
  const result: PassResult = { complete: false, aborted: false, height: h, tasks: [], ignoredCommitments: 0, rateLimited: false, failureKinds: [] };

  await readConfig(reader, {}, h, signal);
  const taskIds = await pageAll((from_index) => readTaskIds(reader, { from_index, limit: PAGE }, h, signal));
  const listed = new Set(taskIds);

  // Commitments by id: probe past the highest stored id, then re-read the stored open set.
  const storedMax = await repo.maxCommitmentId();
  const cursorRaw = await repo.getMeta(CURSOR_KEY);
  const cursor = cursorRaw !== null && /^\d+$/.test(cursorRaw) ? Number(cursorRaw) : null;
  // No cursor means no proof of what was written: start from the beginning (re-reads are idempotent).
  const probeStart = cursor === null ? 0 : Math.min(cursor, storedMax + 1);
  const byId = new Map<number, Commitment>();
  let probeEnd = probeStart;
  for (;;) {
    if (now().getTime() - startedMs > config.passBudgetMs) break;
    const c = await readCommitment(reader, { commitment_id: probeEnd }, h, signal);
    if (c === null) break;
    byId.set(probeEnd, c);
    probeEnd++;
  }
  const open = await repo.openCommitmentIds({ includeFailed: opts.includeFailed ?? passNo % FULL_REREAD_EVERY === 0 });
  for (const id of open) {
    if (byId.has(id)) continue;
    if (signal.aborted || now().getTime() - startedMs > config.passBudgetMs) break;
    const c = await readCommitment(reader, { commitment_id: id }, h, signal);
    if (c !== null) byId.set(id, c);
  }

  const byTask = new Map<string, Commitment[]>();
  for (const c of byId.values()) {
    if (!listed.has(c.task)) {
      result.ignoredCommitments++;
      log(`ignored commitment ${c.id}: task not listed`);
      continue;
    }
    const arr = byTask.get(c.task) ?? [];
    arr.push(c);
    byTask.set(c.task, arr);
  }

  // Round-robin start so a budget cut hits different tasks each pass.
  const order = taskIds.length === 0 ? [] : [...taskIds.slice(passNo % taskIds.length), ...taskIds.slice(0, passNo % taskIds.length)];
  const reads: TaskRead[] = [];
  for (const taskId of order) {
    if (signal.aborted) {
      result.aborted = true;
      break;
    }
    if (now().getTime() - startedMs > config.passBudgetMs) {
      result.tasks.push({ taskId, status: "deferred", commitmentsSeen: 0, asOfHeight: h });
      continue;
    }
    try {
      reads.push(await readOneTask(reader, taskId, h, signal));
    } catch (e) {
      if (e instanceof UnknownBlockError || e instanceof MetaMismatchError) throw e;
      if (signal.aborted) {
        result.aborted = true;
        break;
      }
      result.tasks.push({ taskId, status: "failed", commitmentsSeen: 0, asOfHeight: h, error: describe(e) });
      result.failureKinds.push(e instanceof ChainShapeError ? "chain_shape" : "chain_read");
      result.rateLimited ||= isRateLimited(e);
      log(`task ${taskId}: ${describe(e)}`);
    }
  }

  for (const r of reads) {
    const cs = byTask.get(r.taskId) ?? [];
    if (signal.aborted) {
      result.aborted = true;
      result.tasks.push({ taskId: r.taskId, status: "deferred", commitmentsSeen: cs.length, asOfHeight: h });
      continue;
    }
    try {
      const rows: CommitmentRow[] = [];
      let cut = false;
      for (const c of cs) {
        let row = commitmentToRow(c);
        if (row.near_tx === null && row.state === "Confirmed") {
          if (signal.aborted || now().getTime() - startedMs > config.passBudgetMs) {
            cut = true;
            break;
          }
          const hit = await resolver.resolve(row, { network: config.network, contractId: config.contractId, height: h, signal });
          if (hit) row = { ...row, near_tx: hit.near_tx, tx_status: "resolved" };
        }
        rows.push(row);
      }
      if (cut) {
        if (signal.aborted) result.aborted = true;
        result.tasks.push({ taskId: r.taskId, status: "deferred", commitmentsSeen: cs.length, asOfHeight: h });
        continue;
      }
      const outcome = await repo.applyTaskSnapshot({ ...r.base, commitments: rows }, h);
      result.tasks.push({ taskId: r.taskId, status: outcome, commitmentsSeen: rows.length, asOfHeight: h });
    } catch (e) {
      if (e instanceof UnknownBlockError || e instanceof MetaMismatchError || e instanceof RepoUnavailableError) throw e;
      if (signal.aborted) {
        result.aborted = true;
        result.tasks.push({ taskId: r.taskId, status: "deferred", commitmentsSeen: cs.length, asOfHeight: h });
        continue;
      }
      result.tasks.push({ taskId: r.taskId, status: "failed", commitmentsSeen: 0, asOfHeight: h, error: "apply_failed" });
      result.failureKinds.push("apply_failed");
      result.rateLimited ||= isRateLimited(e);
      log(`task ${r.taskId}: apply_failed: ${e instanceof Error ? e.name : "unknown"}`);
    }
  }
  const done = new Set(result.tasks.filter((t) => t.status === "applied" || t.status === "skipped_stale").map((t) => t.taskId));
  // Every id read by the probe whose task is not done is unwritten, whatever is stored above it.
  // Ids below probeStart came from the stored open set, so they are already written.
  const unwritten: number[] = [];
  for (const [taskId, cs] of byTask) if (!done.has(taskId)) for (const c of cs) if (c.id >= probeStart) unwritten.push(c.id);

  await repo.setMeta(CURSOR_KEY, String(Math.min(probeEnd, ...unwritten)));

  const failed = result.aborted || result.tasks.length < taskIds.length || result.tasks.some((t) => t.status !== "applied" && t.status !== "skipped_stale");
  if (!result.aborted && result.failureKinds.length === 0) await repo.reconcileTaskPresence(taskIds, h);
  if (!failed) {
    const summaries = (await repo.listTasks()).filter((t) => listed.has(t.task_id));
    const minH = summaries.reduce<bigint | null>((m, t) => (m === null || t.as_of_height < m ? t.as_of_height : m), null);
    await repo.setMeta("last_complete_height", String(minH ?? h));
    if ((await repo.getMeta("schema_version")) === null) await repo.setMeta("schema_version", SCHEMA_VERSION);
    await repo.setMeta("last_pass_at", now().toISOString());
    result.complete = true;
  }
  return result;
}

/** One pass. Throws MetaMismatchError and repo errors; chain failures are reported in the result. */
export async function runPass(opts: PassOptions): Promise<PassResult> {
  const { reader, signal } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_REPINS; attempt++) {
    try {
      const { height } = await reader.finalBlock(signal);
      return await runPassAt(opts, reader, height);
    } catch (e) {
      if (signal.aborted) return { complete: false, aborted: true, height: null, tasks: [], ignoredCommitments: 0, rateLimited: false, failureKinds: [] };
      if (e instanceof UnknownBlockError) {
        lastErr = e;
        continue;
      }
      if (e instanceof MetaMismatchError || e instanceof RepoUnavailableError) throw e;
      const kind = e instanceof ChainShapeError ? "chain_shape" : "chain_read";
      opts.log?.(describe(e));
      return { complete: false, aborted: false, height: null, tasks: [], ignoredCommitments: 0, rateLimited: isRateLimited(e), failureKinds: [kind] };
    }
  }
  opts.log?.(describe(lastErr));
  return { complete: false, aborted: false, height: null, tasks: [], ignoredCommitments: 0, rateLimited: false, failureKinds: ["unknown_block"] };
}

export interface PollerOptions extends Omit<PassOptions, "now" | "passNo" | "includeFailed"> {
  clock?: () => Date;
  sleep: Sleep;
  intervalMs: number;
  random?: () => number;
  onPass?: (r: PassResult, passNo: number) => void;
  /** stop after this many passes (--once uses 1) */
  maxPasses?: number;
}

const MAX_RATE_BACKOFF = 60_000;
const FAILURE_BACKOFF = 30_000;

/** Loop until aborted. Returns the last result; rethrows only fatal errors. */
export async function runPoller(opts: PollerOptions): Promise<PassResult | null> {
  const { signal, sleep, intervalMs } = opts;
  const random = opts.random ?? Math.random;
  const clock = opts.clock ?? (() => new Date());
  let delay = intervalMs;
  let last: PassResult | null = null;
  for (let passNo = 1; !signal.aborted; passNo++) {
    last = await runPass({ ...opts, now: clock, passNo, includeFailed: passNo % FULL_REREAD_EVERY === 0 || (last !== null && !last.complete) });
    opts.onPass?.(last, passNo);
    if (last.aborted || (opts.maxPasses !== undefined && passNo >= opts.maxPasses)) break;
    if (last.rateLimited) delay = Math.min(Math.max(delay, intervalMs) * 2, MAX_RATE_BACKOFF);
    else if (!last.complete) delay = FAILURE_BACKOFF;
    else delay = intervalMs;
    try {
      await sleep(delay + random() * (delay / 10), signal);
    } catch (e) {
      if (signal.aborted) break;
      throw e;
    }
  }
  return last;
}
