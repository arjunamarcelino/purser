// Read-only loopback HTTP API over the cache. Never calls a Repo write method.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Repo } from "./db/types.ts";

export interface ApiOptions {
  repo: Repo;
  scope: { network: string; contractId: string };
  host: string;
  port: number;
  /** extra allowed Origin values (e.g. the vite dev origin) */
  allowedOrigins?: string[];
  now?: () => Date;
}

export interface Api {
  server: Server;
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const TASK_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const LIMIT_RE = /^\d{1,3}$/;
const CURSOR_RE = /^[A-Za-z0-9_-]*$/;
const MAX_CONNECTIONS = 64;
const TIMEOUT_MS = 10_000;

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** The single serializer: bigint never reaches JSON.stringify as a bigint. */
function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

function isUnavailable(e: unknown): boolean {
  return e instanceof Error && (e as { kind?: unknown }).kind === "repo_unavailable";
}

export function createApi(opts: ApiOptions): Api {
  const { repo, scope, host } = opts;
  if (!LOOPBACK.has(host)) throw new Error(`API host must be loopback, got "${host}"`);
  const now = opts.now ?? (() => new Date());
  let boundPort = opts.port;

  // IPv6 literals are bracketed in Host/Origin; only allowed when bound to ::1.
  const v6 = host === "::1";
  const hostOk = (h: string | undefined): boolean =>
    h === `127.0.0.1:${boundPort}` || h === `localhost:${boundPort}` || (v6 && h === `[::1]:${boundPort}`);
  const originOk = (o: string): boolean =>
    o === `http://127.0.0.1:${boundPort}` ||
    o === `http://localhost:${boundPort}` ||
    (v6 && o === `http://[::1]:${boundPort}`) ||
    (opts.allowedOrigins ?? []).includes(o);

  function send(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    const payload = status === 304 ? "" : toJson(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      ...(status === 304 ? {} : { "Content-Length": Buffer.byteLength(payload) }),
      ...extra,
    });
    res.end(req.method === "HEAD" ? undefined : payload);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostOk(req.headers.host)) throw new HttpError(403, "forbidden_host");
    const origin = req.headers.origin;
    if (origin !== undefined && !originOk(origin)) throw new HttpError(403, "forbidden_origin");
    if (req.method !== "GET" && req.method !== "HEAD") {
      throw Object.assign(new HttpError(405, "method_not_allowed"), { allow: "GET, HEAD" });
    }
    const raw = req.url ?? "";
    if (!raw.startsWith("/")) throw new HttpError(400, "bad_request");
    let url: URL;
    try {
      url = new URL(raw, "http://localhost");
    } catch {
      throw new HttpError(400, "bad_request");
    }
    const parts = url.pathname.split("/").filter((s, i) => i === 0 || s !== "");
    // parts[0] is "" for the leading slash
    const segs = parts.slice(1);

    if (segs.length === 1 && segs[0] === "status") {
      const [lastPass, lastHeight, schema] = await Promise.all([
        repo.getMeta("last_pass_at"),
        repo.getMeta("last_complete_height"),
        repo.getMeta("schema_version"),
      ]);
      return send(req, res, 200, {
        network: scope.network,
        contract_id: scope.contractId,
        server_time: now().toISOString(),
        last_pass_at: lastPass,
        last_complete_height: lastHeight,
        schema_version: schema,
      });
    }

    if (segs.length === 1 && segs[0] === "tasks") {
      const tasks = await repo.listTasks();
      return send(req, res, 200, {
        tasks: tasks.map((t) => ({
          task_id: t.task_id,
          synced_at: t.synced_at,
          as_of_height: t.as_of_height,
          missing_since_height: t.missing_since_height,
        })),
      });
    }

    if (segs.length === 3 && segs[0] === "tasks" && segs[2] === "history") {
      let task: string;
      try {
        task = decodeURIComponent(segs[1] ?? "");
      } catch {
        throw new HttpError(400, "bad_task");
      }
      if (!TASK_RE.test(task)) throw new HttpError(400, "bad_task");
      const limits = url.searchParams.getAll("limit");
      const cursors = url.searchParams.getAll("cursor");
      if (limits.length > 1 || cursors.length > 1) throw new HttpError(400, "bad_query");
      let limit = 50;
      if (limits[0] !== undefined) {
        if (!LIMIT_RE.test(limits[0])) throw new HttpError(400, "bad_limit");
        limit = Math.min(200, Math.max(1, Number(limits[0])));
      }
      const c = cursors[0];
      if (c !== undefined && (c.length > 256 || !CURSOR_RE.test(c))) throw new HttpError(400, "bad_cursor");

      const page = await repo.listHistory(c ? { task, limit, cursor: c } : { task, limit });
      const body = { rows: page.rows, next: page.next };
      const etag = `"${createHash("sha256").update(toJson(body)).digest("hex").slice(0, 32)}"`;
      if (req.headers["if-none-match"] === etag) return send(req, res, 304, null, { ETag: etag });
      return send(req, res, 200, body, { ETag: etag });
    }

    throw new HttpError(404, "not_found");
  }

  const server = createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof HttpError) {
        const allow = (e as { allow?: string }).allow;
        return send(req, res, e.status, { error: e.code }, allow ? { Allow: allow } : {});
      }
      if (isUnavailable(e)) return send(req, res, 503, { error: "history_unavailable" });
      if (e instanceof Error && (e as { kind?: unknown }).kind === "invalid_cursor") {
        return send(req, res, 400, { error: "bad_cursor" });
      }
      send(req, res, 500, { error: "internal" });
    });
  });
  server.requestTimeout = TIMEOUT_MS;
  server.headersTimeout = TIMEOUT_MS;
  server.maxConnections = MAX_CONNECTIONS;

  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(opts.port, host, () => {
          server.off("error", reject);
          boundPort = (server.address() as AddressInfo).port;
          resolve({ port: boundPort });
        });
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
