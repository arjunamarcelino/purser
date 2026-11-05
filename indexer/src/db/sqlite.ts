import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { SqlRepo, type Q, type Row } from "./core.ts";
import { RepoUnavailableError } from "./types.ts";

export class SqliteRepo extends SqlRepo {
  /** Exposed for tests and diagnostics; production code goes through the Repo interface. */
  readonly db: DatabaseSync;
  private readonly stmts = new Map<string, StatementSync>();
  // One connection: serialise every call so an `await` inside a transaction can never interleave with another.
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(path: string, opts: { readOnly?: boolean } = {}) {
    super("sqlite");
    this.readOnly = opts.readOnly ?? false;
    if (!this.readOnly && path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    // `Database` (the non-deprecated alias in the plan) does not exist in the installed Node 26.9.
    this.db = new DatabaseSync(path, { readOnly: this.readOnly, readBigInts: true, timeout: 5000 });
    if (!this.readOnly) this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  private prep(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private readonly q: Q = {
    run: async (sql, params) => Number(this.prep(sql).run(...(params as SQLInputValue[])).changes),
    all: async (sql, params) => this.prep(sql).all(...(params as SQLInputValue[])) as Row[],
    exec: async (sql) => {
      this.db.exec(sql);
    },
  };

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new RepoUnavailableError("repository is closed"));
    const next = this.chain.then(fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  protected tx<T>(fn: (q: Q) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const r = await fn(this.q);
        this.db.exec("COMMIT");
        return r;
      } catch (e) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // already rolled back by SQLite
        }
        throw e;
      }
    });
  }

  protected snapshot<T>(fn: (q: Q) => Promise<T>): Promise<T> {
    return this.serial(() => fn(this.q));
  }

  async init(): Promise<void> {
    if (this.readOnly) return this.snapshot((q) => this.verifySchema(q));
    await this.tx((q) => this.migrate(q));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.chain;
    if (this.closed) return;
    this.closed = true;
    this.stmts.clear();
    if (!this.readOnly) {
      try {
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // best effort
      }
    }
    this.db.close();
  }
}
