// Driver-independent Repo logic. A driver supplies only transport (`Q`), transactions and migration plumbing,
// so SQLite and Postgres cannot drift apart in behaviour.
import { readdirSync, readFileSync } from "node:fs";
import {
  InvalidCursorError,
  assertYocto,
  clampLimit,
  decodeCursor,
  encodeCursor,
  toBigInt,
} from "./codec.ts";
import { CANONICAL_TABLES, canonicalLines, canonicalResult, canonicalSql } from "./canonical.ts";
import {
  MetaMismatchError,
  RepoUnavailableError,
  type CommitmentRow,
  type Counts,
  type HistoryPage,
  type HistoryRow,
  type Repo,
  type ReservationState,
  type TaskSnapshot,
  type TaskSummary,
  type TxStatus,
} from "./types.ts";

export type Row = Record<string, unknown>;
export type Dialect = "sqlite" | "pg";

/** One connection (inside a transaction when obtained from `tx`). `?` placeholders; the pg driver rewrites them. */
export interface Q {
  run(sql: string, params: unknown[]): Promise<number>;
  all(sql: string, params: unknown[]): Promise<Row[]>;
  exec(sql: string): Promise<void>;
}

export interface Migration {
  version: number;
  sql: string;
}

const STATES: readonly ReservationState[] = ["Reserved", "Signed", "Confirmed", "Unknown", "Failed", "Cancelled"];
const TX_STATUSES: readonly TxStatus[] = ["resolved", "pending", "unavailable"];

export function loadMigrations(dialect: Dialect): Migration[] {
  const dir = new URL("./migrations/", import.meta.url);
  const out: Migration[] = [];
  for (const f of readdirSync(dir)) {
    const m = new RegExp(`^(\\d+)_.*\\.${dialect}\\.sql$`).exec(f);
    if (m?.[1]) out.push({ version: Number(m[1]), sql: readFileSync(new URL(f, dir), "utf8") });
  }
  return out.sort((a, b) => a.version - b.version);
}

const SCHEMA_MIGRATIONS_DDL =
  "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)";

const same = (t: string) =>
  `${t}.task_id = excluded.task_id AND ${t}.request_id = excluded.request_id AND ${t}.delegate = excluded.delegate ` +
  `AND ${t}.recipient = excluded.recipient AND ${t}.reserved_amount = excluded.reserved_amount`;

function statements(now: string) {
  return {
    taskUpsert:
      `INSERT INTO task (task_id, owner, token, cap, completed_cached, outstanding_cached, crew_cap, frozen, as_of_height, synced_at) ` +
      `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${now}) ` +
      `ON CONFLICT (task_id) DO UPDATE SET owner = excluded.owner, token = excluded.token, cap = excluded.cap, ` +
      `completed_cached = excluded.completed_cached, outstanding_cached = excluded.outstanding_cached, ` +
      `crew_cap = excluded.crew_cap, frozen = excluded.frozen, missing_since_height = NULL, ` +
      `as_of_height = excluded.as_of_height, synced_at = excluded.synced_at ` +
      `WHERE excluded.as_of_height >= task.as_of_height`,
    delegateUpsert:
      `INSERT INTO delegate_snapshot (task_id, account_id, active, as_of_height, observed_at) VALUES (?, ?, ?, ?, ${now}) ` +
      `ON CONFLICT (task_id, account_id) DO UPDATE SET active = excluded.active, as_of_height = excluded.as_of_height ` +
      `WHERE excluded.as_of_height >= delegate_snapshot.as_of_height`,
    activeDelegates: `SELECT account_id FROM delegate_snapshot WHERE task_id = ? AND active = ?`,
    deactivateDelegate:
      `UPDATE delegate_snapshot SET active = ?, as_of_height = ? WHERE task_id = ? AND account_id = ? AND as_of_height <= ?`,
    commitmentUpsert:
      `INSERT INTO commitment_event (commitment_id, task_id, delegate, recipient, reserved_amount, actual_spent, state, ` +
      `request_id, payload_hash, near_tx, evm_tx, tx_status, as_of_height, observed_at) ` +
      `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${now}) ` +
      `ON CONFLICT (commitment_id) DO UPDATE SET task_id = excluded.task_id, delegate = excluded.delegate, ` +
      `recipient = excluded.recipient, reserved_amount = excluded.reserved_amount, actual_spent = excluded.actual_spent, ` +
      `state = excluded.state, request_id = excluded.request_id, payload_hash = excluded.payload_hash, ` +
      `near_tx = CASE WHEN ${same("commitment_event")} THEN COALESCE(excluded.near_tx, commitment_event.near_tx) ELSE excluded.near_tx END, ` +
      `evm_tx = CASE WHEN ${same("commitment_event")} THEN COALESCE(excluded.evm_tx, commitment_event.evm_tx) ELSE excluded.evm_tx END, ` +
      `tx_status = CASE WHEN ${same("commitment_event")} AND commitment_event.tx_status = 'resolved' THEN 'resolved' ELSE excluded.tx_status END, ` +
      `as_of_height = excluded.as_of_height ` +
      `WHERE excluded.as_of_height >= commitment_event.as_of_height`,
  };
}

const COMMITMENT_COLS =
  "commitment_id, delegate, recipient, reserved_amount, actual_spent, state, request_id, payload_hash, near_tx, evm_tx, tx_status";

function str(v: unknown): string {
  if (typeof v !== "string") throw new TypeError("expected text column");
  return v;
}
function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : str(v);
}
function bool(v: unknown): boolean {
  return v === true || v === 1 || v === 1n;
}

function mapCommitment(r: Row): CommitmentRow {
  const state = str(r["state"]);
  const txStatus = str(r["tx_status"]);
  if (!STATES.includes(state as ReservationState)) throw new TypeError("unknown state in database");
  if (!TX_STATUSES.includes(txStatus as TxStatus)) throw new TypeError("unknown tx_status in database");
  return {
    commitment_id: Number(toBigInt(r["commitment_id"])),
    delegate: str(r["delegate"]),
    recipient: str(r["recipient"]),
    reserved_amount: str(r["reserved_amount"]),
    actual_spent: strOrNull(r["actual_spent"]),
    state: state as ReservationState,
    request_id: str(r["request_id"]),
    payload_hash: strOrNull(r["payload_hash"]),
    near_tx: strOrNull(r["near_tx"]),
    evm_tx: strOrNull(r["evm_tx"]),
    tx_status: txStatus as TxStatus,
  };
}

function isoOf(v: unknown): string {
  return v instanceof Date ? v.toISOString() : str(v);
}

export abstract class SqlRepo implements Repo {
  protected readonly dialect: Dialect;
  private readonly S: ReturnType<typeof statements>;
  protected readOnly = false;

  constructor(dialect: Dialect) {
    this.dialect = dialect;
    this.S = statements(dialect === "pg" ? "now()" : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  }

  /** Write transaction (BEGIN IMMEDIATE / BEGIN). */
  protected abstract tx<T>(fn: (q: Q) => Promise<T>): Promise<T>;
  /** Consistent multi-statement read. */
  protected abstract snapshot<T>(fn: (q: Q) => Promise<T>): Promise<T>;
  abstract init(): Promise<void>;
  abstract [Symbol.asyncDispose](): Promise<void>;

  private get collate(): string {
    return this.dialect === "pg" ? 'COLLATE "C"' : "COLLATE BINARY";
  }
  private b(v: boolean): unknown {
    return this.dialect === "pg" ? v : v ? 1n : 0n;
  }
  private i(v: number | bigint): unknown {
    return this.dialect === "pg" ? v.toString() : BigInt(v);
  }
  private writable(): void {
    if (this.readOnly) throw new RepoUnavailableError("repository is read-only");
  }

  protected async migrate(q: Q): Promise<void> {
    await q.exec(SCHEMA_MIGRATIONS_DDL);
    const rows = await q.all("SELECT version FROM schema_migrations", []);
    const current = rows.reduce((m, r) => Math.max(m, Number(toBigInt(r["version"]))), 0);
    const migrations = loadMigrations(this.dialect);
    const codeVersion = migrations.at(-1)?.version ?? 0;
    if (current > codeVersion) {
      throw new RepoUnavailableError(`database schema version ${current} is newer than this code (${codeVersion})`);
    }
    for (const m of migrations) {
      if (m.version <= current) continue;
      await q.exec(m.sql);
      await q.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
        this.i(m.version),
        new Date().toISOString(),
      ]);
    }
  }

  /** Read-only connections never migrate; they require the schema the code expects. */
  protected async verifySchema(q: Q): Promise<void> {
    const codeVersion = loadMigrations(this.dialect).at(-1)?.version ?? 0;
    let current = 0;
    try {
      const rows = await q.all("SELECT MAX(version) AS v FROM schema_migrations", []);
      current = rows[0]?.["v"] == null ? 0 : Number(toBigInt(rows[0]["v"]));
    } catch {
      throw new RepoUnavailableError("database is not initialised (run the poller first)");
    }
    if (current !== codeVersion) {
      throw new RepoUnavailableError(`database schema version ${current} does not match this code (${codeVersion})`);
    }
  }

  async ensureScope(scope: { network: string; contractId: string }): Promise<void> {
    const want: Array<[string, string]> = [["network", scope.network], ["contract_id", scope.contractId]];
    const check = async (q: Q) => {
      const rows = await q.all("SELECT key, value FROM meta WHERE key IN ('network', 'contract_id')", []);
      const have = new Map(rows.map((r) => [str(r["key"]), str(r["value"])]));
      for (const [k, v] of want) {
        const got = have.get(k);
        if (got === undefined) throw new RepoUnavailableError("database scope is not recorded yet");
        if (got !== v) {
          throw new MetaMismatchError(`database was created for another ${k} (have "${got}", want "${v}")`);
        }
      }
    };
    if (this.readOnly) return this.snapshot(check);
    await this.tx(async (q) => {
      for (const [k, v] of want) {
        await q.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING", [k, v]);
      }
      await check(q);
    });
  }

  async applyTaskSnapshot(snap: TaskSnapshot, asOfHeight: bigint): Promise<"applied" | "skipped_stale"> {
    this.writable();
    const t = snap.task;
    if (!Number.isSafeInteger(t.crew_cap) || t.crew_cap < 0) throw new TypeError("crew_cap: not a non-negative integer");
    const taskParams = [
      t.task_id, t.owner, t.token,
      assertYocto(t.cap, "cap"),
      assertYocto(t.completed_cached, "completed_cached"),
      assertYocto(t.outstanding_cached, "outstanding_cached"),
      this.i(t.crew_cap), this.b(t.frozen), this.i(asOfHeight),
    ];
    const commitmentParams = snap.commitments.map((c) => [
      this.i(c.commitment_id), t.task_id, c.delegate, c.recipient,
      assertYocto(c.reserved_amount, "reserved_amount"),
      c.actual_spent === null ? null : assertYocto(c.actual_spent, "actual_spent"),
      c.state, c.request_id, c.payload_hash, c.near_tx, c.evm_tx, c.tx_status, this.i(asOfHeight),
    ]);
    return this.tx(async (q) => {
      if ((await q.run(this.S.taskUpsert, taskParams)) === 0) return "skipped_stale";
      for (const d of snap.delegates) {
        await q.run(this.S.delegateUpsert, [t.task_id, d.account_id, this.b(d.active), this.i(asOfHeight)]);
      }
      const present = new Set(snap.delegates.map((d) => d.account_id));
      const active = await q.all(this.S.activeDelegates, [t.task_id, this.b(true)]);
      for (const r of active) {
        const id = str(r["account_id"]);
        if (!present.has(id)) {
          await q.run(this.S.deactivateDelegate, [this.b(false), this.i(asOfHeight), t.task_id, id, this.i(asOfHeight)]);
        }
      }
      for (const p of commitmentParams) await q.run(this.S.commitmentUpsert, p);
      return "applied";
    });
  }

  async reconcileTaskPresence(presentTaskIds: string[], asOfHeight: bigint): Promise<void> {
    this.writable();
    const present = new Set(presentTaskIds);
    await this.tx(async (q) => {
      const rows = await q.all("SELECT task_id, missing_since_height FROM task", []);
      for (const r of rows) {
        const id = str(r["task_id"]);
        const missing = r["missing_since_height"] != null;
        if (present.has(id) && missing) {
          await q.run("UPDATE task SET missing_since_height = NULL WHERE task_id = ?", [id]);
        } else if (!present.has(id) && !missing) {
          await q.run("UPDATE task SET missing_since_height = ? WHERE task_id = ? AND as_of_height <= ?", [
            this.i(asOfHeight), id, this.i(asOfHeight),
          ]);
        }
      }
    });
  }

  async openCommitmentIds(opts: { includeFailed: boolean }): Promise<number[]> {
    const states = opts.includeFailed
      ? ["Reserved", "Signed", "Unknown", "Failed", "Cancelled"]
      : ["Reserved", "Signed", "Unknown"];
    const rows = await this.snapshot((q) =>
      q.all(
        `SELECT commitment_id FROM commitment_event WHERE state IN (${states.map(() => "?").join(", ")}) ORDER BY commitment_id`,
        states,
      ),
    );
    return rows.map((r) => Number(toBigInt(r["commitment_id"])));
  }

  async maxCommitmentId(): Promise<number> {
    const rows = await this.snapshot((q) => q.all("SELECT MAX(commitment_id) AS m FROM commitment_event", []));
    const m = rows[0]?.["m"];
    return m == null ? -1 : Number(toBigInt(m));
  }

  async getMeta(key: string): Promise<string | null> {
    const rows = await this.snapshot((q) => q.all("SELECT value FROM meta WHERE key = ?", [key]));
    return rows[0] ? str(rows[0]["value"]) : null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.writable();
    await this.tx(async (q) => {
      await q.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [
        key, value,
      ]);
    });
  }

  async listTasks(): Promise<TaskSummary[]> {
    const rows = await this.snapshot((q) =>
      q.all(`SELECT task_id, synced_at, as_of_height, missing_since_height FROM task ORDER BY task_id ${this.collate}`, []),
    );
    return rows.map((r) => ({
      task_id: str(r["task_id"]),
      synced_at: isoOf(r["synced_at"]),
      as_of_height: toBigInt(r["as_of_height"]),
      missing_since_height: r["missing_since_height"] == null ? null : toBigInt(r["missing_since_height"]),
    }));
  }

  async listHistory(opts: { task: string; limit: number; cursor?: string }): Promise<HistoryPage> {
    const limit = clampLimit(opts.limit);
    const before = opts.cursor === undefined ? undefined : decodeCursor(opts.cursor);
    const where = before === undefined ? "task_id = ?" : "task_id = ? AND commitment_id < ?";
    const params: unknown[] = before === undefined ? [opts.task] : [opts.task, this.i(before)];
    params.push(this.i(limit + 1));
    const rows = await this.snapshot((q) =>
      q.all(
        `SELECT task_id, as_of_height, ${COMMITMENT_COLS} FROM commitment_event WHERE ${where} ORDER BY commitment_id DESC LIMIT ?`,
        params,
      ),
    );
    const page = rows.slice(0, limit).map(
      (r): HistoryRow => ({ ...mapCommitment(r), task_id: str(r["task_id"]), as_of_height: toBigInt(r["as_of_height"]) }),
    );
    const last = page.at(-1);
    return { rows: page, next: rows.length > limit && last ? encodeCursor(last.commitment_id) : null };
  }

  async counts(): Promise<Counts> {
    const names = ["task", "commitment_event", "delegate_snapshot", "attestation", "relayer_job", "meta"] as const;
    const out = await this.snapshot(async (q) => {
      const o: Record<string, number> = {};
      for (const n of names) {
        const rows = await q.all(`SELECT COUNT(*) AS n FROM ${n}`, []);
        o[n] = Number(toBigInt(rows[0]?.["n"]));
      }
      return o;
    });
    return {
      task: out["task"] ?? 0,
      commitment_event: out["commitment_event"] ?? 0,
      delegate_snapshot: out["delegate_snapshot"] ?? 0,
      attestation: out["attestation"] ?? 0,
      relayer_job: out["relayer_job"] ?? 0,
      meta: out["meta"] ?? 0,
    };
  }

  async canonicalDump(): Promise<{ lines: string[]; sha256: string }> {
    const lines = await this.snapshot(async (q) => {
      const all: string[] = [];
      for (const spec of CANONICAL_TABLES) {
        all.push(...canonicalLines(spec, await q.all(canonicalSql(spec, this.collate), [])));
      }
      return all;
    });
    return canonicalResult(lines);
  }

  async wipe(): Promise<void> {
    this.writable();
    await this.tx(async (q) => {
      for (const t of ["attestation", "relayer_job", "commitment_event", "delegate_snapshot", "task", "meta"]) {
        await q.run(`DELETE FROM ${t}`, []);
      }
    });
  }
}

export { InvalidCursorError };
