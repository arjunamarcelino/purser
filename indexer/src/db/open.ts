import { PostgresRepo } from "./postgres.ts";
import { SqliteRepo } from "./sqlite.ts";
import type { Repo } from "./types.ts";

type Target = { kind: "sqlite"; path: string } | { kind: "postgres"; url: string };

/** Never echoes the input: a postgres URL carries credentials. */
function parse(databaseUrl: string): Target {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(databaseUrl);
  const scheme = m?.[1]?.toLowerCase();
  if (scheme === "sqlite") {
    let path = databaseUrl.slice("sqlite:".length);
    if (path.startsWith("//")) path = path.slice(2);
    if (path === "") throw new Error("DATABASE_URL: sqlite path is empty");
    return { kind: "sqlite", path };
  }
  if (scheme === "postgres" || scheme === "postgresql") return { kind: "postgres", url: databaseUrl };
  throw new Error(`DATABASE_URL: unsupported scheme "${scheme ?? "(none)"}" (use sqlite: or postgres:)`);
}

/** Returns an un-initialised repo; the caller runs `init()` and `ensureScope()`. */
export async function openRepo(databaseUrl: string): Promise<Repo> {
  const t = parse(databaseUrl);
  return t.kind === "sqlite" ? new SqliteRepo(t.path) : new PostgresRepo(t.url);
}

/** For the API process: both backends open read-only (sqlite: read-only connection; postgres: no migrations, read-only sessions); `init()` only verifies the schema. */
export async function openRepoReadOnly(databaseUrl: string): Promise<Repo> {
  const t = parse(databaseUrl);
  return t.kind === "sqlite" ? new SqliteRepo(t.path, { readOnly: true }) : new PostgresRepo(t.url, { readOnly: true });
}
