import pg from "pg";
import { SqlRepo, type Q, type Row } from "./core.ts";
import { RepoUnavailableError } from "./types.ts";

const MIGRATION_LOCK = 727274;

/** Placeholder style used by the shared SQL is `?`; none of it contains a literal `?`. */
function toPg(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

export class PostgresRepo extends SqlRepo {
  private readonly pool: pg.Pool;
  private readonly secrets: string[];

  constructor(connectionString: string, opts: { readOnly?: boolean } = {}) {
    super("pg");
    this.readOnly = opts.readOnly ?? false;
    this.secrets = [connectionString];
    try {
      const u = new URL(connectionString);
      for (const s of [u.password, decodeURIComponent(u.password), u.username]) if (s) this.secrets.push(s);
    } catch {
      // unparseable URL: the whole string is already treated as secret
    }
    this.pool = new pg.Pool({ connectionString, max: 5 });
    // An idle client erroring would otherwise crash the process; the next query surfaces the failure.
    this.pool.on("error", () => undefined);
    // Defence in depth for the API process: even a stray write statement is rejected by the server.
    // pg queues this ahead of the first query the pool hands out on the new client.
    if (this.readOnly) {
      this.pool.on("connect", (c) => {
        c.query("SET default_transaction_read_only = on").catch(() => undefined);
      });
    }
  }

  /** Errors must never carry the connection string or credentials. */
  private scrub(e: unknown): unknown {
    if (!(e instanceof Error)) return new RepoUnavailableError("database error");
    let msg = e.message;
    for (const s of this.secrets) if (s) msg = msg.split(s).join("[redacted]");
    if (msg === e.message) return e;
    return new RepoUnavailableError(msg);
  }

  private qOf(c: pg.PoolClient): Q {
    return {
      run: async (sql, params) => (await c.query(toPg(sql), params)).rowCount ?? 0,
      all: async (sql, params) => (await c.query(toPg(sql), params)).rows as Row[],
      exec: async (sql) => {
        await c.query(sql);
      },
    };
  }

  private async withClient<T>(begin: string, fn: (q: Q) => Promise<T>): Promise<T> {
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (e) {
      throw this.scrub(e);
    }
    let broken = false;
    try {
      await client.query(begin);
      try {
        const r = await fn(this.qOf(client));
        await client.query("COMMIT");
        return r;
      } catch (e) {
        try {
          await client.query("ROLLBACK");
        } catch {
          broken = true;
        }
        throw e;
      }
    } catch (e) {
      throw this.scrub(e);
    } finally {
      client.release(broken ? true : undefined);
    }
  }

  protected tx<T>(fn: (q: Q) => Promise<T>): Promise<T> {
    return this.withClient("BEGIN", fn);
  }

  protected snapshot<T>(fn: (q: Q) => Promise<T>): Promise<T> {
    return this.withClient("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", fn);
  }

  async init(): Promise<void> {
    if (this.readOnly) return this.snapshot((q) => this.verifySchema(q));
    await this.tx(async (q) => {
      // serve and poll may both start against a fresh database
      await q.run("SELECT pg_advisory_xact_lock(?)", [String(MIGRATION_LOCK)]);
      await this.migrate(q);
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.pool.end();
  }
}
