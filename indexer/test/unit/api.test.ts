import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi } from "../../src/api.ts";
import type { Api } from "../../src/api.ts";
import { RepoUnavailableError } from "../../src/db/types.ts";
import type { HistoryRow, Repo } from "../../src/db/types.ts";

const WRITES = ["init", "ensureScope", "applyTaskSnapshot", "reconcileTaskPresence", "setMeta", "wipe"];

function row(id: number): HistoryRow {
  return {
    commitment_id: id,
    delegate: "d.testnet",
    recipient: "r.testnet",
    reserved_amount: "1000000000000000000000000",
    actual_spent: null,
    state: "Reserved",
    request_id: `req-${id}`,
    payload_hash: null,
    near_tx: null,
    evm_tx: null,
    tx_status: "pending",
    task_id: "t1",
    as_of_height: 123456789012n,
  };
}

interface Stub {
  repo: Repo;
  writes: string[];
  fail: { err: unknown };
  lastHistory: unknown;
}

function stub(): Stub {
  const s: Stub = { repo: undefined as unknown as Repo, writes: [], fail: { err: null }, lastHistory: null };
  const guard = () => {
    if (s.fail.err) throw s.fail.err;
  };
  const meta: Record<string, string> = { last_pass_at: "2026-11-05T00:00:00.000Z", last_complete_height: "99", schema_version: "1" };
  const base: Record<string, unknown> = {
    getMeta: async (k: string) => (guard(), meta[k] ?? null),
    listTasks: async () => (
      guard(),
      [{ task_id: "t1", synced_at: "2026-11-05T00:00:00.000Z", as_of_height: 5n, missing_since_height: null }]
    ),
    listHistory: async (o: unknown) => (guard(), (s.lastHistory = o), { rows: [row(2), row(1)], next: "abc_-" }),
  };
  for (const w of WRITES) base[w] = async () => void s.writes.push(w);
  s.repo = base as unknown as Repo;
  return s;
}

function raw(port: number, opts: { method?: string; path: string; headers?: Record<string, string> }) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers: opts.headers ?? {} },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("api", () => {
  let s: Stub;
  let api: Api;
  let port: number;
  const get = (path: string, headers: Record<string, string> = {}) =>
    raw(port, { path, headers: { host: `127.0.0.1:${port}`, ...headers } });

  beforeEach(async () => {
    s = stub();
    api = createApi({
      repo: s.repo,
      scope: { network: "testnet", contractId: "purser.testnet" },
      host: "127.0.0.1",
      port: 0,
      allowedOrigins: ["http://localhost:5173"],
      now: () => new Date("2026-11-05T12:00:00.000Z"),
    });
    port = (await api.listen()).port;
  });
  afterEach(async () => {
    await api.close();
    expect(s.writes).toEqual([]);
  });

  it("refuses non-loopback host", () => {
    for (const host of ["0.0.0.0", "192.168.1.5", "example.com", ""]) {
      expect(() => createApi({ repo: s.repo, scope: { network: "n", contractId: "c" }, host, port: 0 })).toThrow(/loopback/);
    }
    expect(() => createApi({ repo: s.repo, scope: { network: "n", contractId: "c" }, host: "::1", port: 0 })).not.toThrow();
  });

  it("serves /status with JSON headers and no CORS", async () => {
    const r = await get("/status");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({
      network: "testnet",
      contract_id: "purser.testnet",
      server_time: "2026-11-05T12:00:00.000Z",
      last_pass_at: "2026-11-05T00:00:00.000Z",
      last_complete_height: "99",
      schema_version: "1",
    });
    expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(r.headers).filter((k) => k.startsWith("access-control-"))).toEqual([]);
  });

  it("no CORS headers on errors or with an allowed Origin", async () => {
    for (const r of [
      await get("/nope"),
      await get("/status", { origin: "http://localhost:5173" }),
      await get("/status", { origin: "http://evil.example" }),
    ]) {
      expect(Object.keys(r.headers).filter((k) => k.startsWith("access-control-"))).toEqual([]);
    }
  });

  it("serves /tasks with bigint as strings", async () => {
    const r = await get("/tasks");
    expect(JSON.parse(r.body)).toEqual({
      tasks: [{ task_id: "t1", synced_at: "2026-11-05T00:00:00.000Z", as_of_height: "5", missing_since_height: null }],
    });
  });

  it("serves history with stringified heights, default limit 50, and ETag/304", async () => {
    const r = await get("/tasks/t1/history");
    expect(r.status).toBe(200);
    const j = JSON.parse(r.body) as { rows: Record<string, unknown>[]; next: string };
    expect(j.rows[0]?.as_of_height).toBe("123456789012");
    expect(j.rows[0]?.reserved_amount).toBe("1000000000000000000000000");
    expect(j.next).toBe("abc_-");
    expect(s.lastHistory).toEqual({ task: "t1", limit: 50 });
    const etag = r.headers.etag as string;
    expect(etag).toContain("123456789012");
    const r2 = await get("/tasks/t1/history", { "if-none-match": etag });
    expect(r2.status).toBe(304);
    expect(r2.body).toBe("");
  });

  it("clamps and validates limit and cursor", async () => {
    await get("/tasks/t1/history?limit=999");
    expect(s.lastHistory).toEqual({ task: "t1", limit: 200 });
    await get("/tasks/t1/history?limit=0&cursor=Ab_-1");
    expect(s.lastHistory).toEqual({ task: "t1", limit: 1, cursor: "Ab_-1" });
    for (const q of ["limit=abc", "limit=-1", "limit=1.5", "limit=1e2", "limit=1000", "limit=", "limit=1&limit=2", "cursor=a%20b", "cursor=a.b", `cursor=${"a".repeat(257)}`]) {
      expect((await get(`/tasks/t1/history?${q}`)).status, q).toBe(400);
    }
    expect((await get(`/tasks/t1/history?cursor=${"a".repeat(256)}`)).status).toBe(200);
  });

  it("rejects bad task ids including SQL injection", async () => {
    for (const id of ["'%3B%20DROP%20TABLE%20task;--", encodeURIComponent("'; DROP TABLE task;--"), "a".repeat(65), "a%20b", "%ZZ", "a%2Fb"]) {
      expect((await get(`/tasks/${id}/history`)).status, id).toBe(400);
    }
    expect(s.lastHistory).toBeNull();
  });

  it("rejects bad Host (DNS rebinding)", async () => {
    for (const h of ["evil.example", `evil.example:${port}`, "127.0.0.1", `127.0.0.1:${port + 1}`, `127.0.0.1.evil.com:${port}`]) {
      expect((await raw(port, { path: "/status", headers: { host: h } })).status, h).toBe(403);
    }
    expect((await raw(port, { path: "/status", headers: { host: `localhost:${port}` } })).status).toBe(200);
  });

  it("checks Origin when present", async () => {
    expect((await get("/status", { origin: "http://evil.example" })).status).toBe(403);
    expect((await get("/status", { origin: `http://127.0.0.1:${port}` })).status).toBe(200);
    expect((await get("/status", { origin: `http://localhost:${port}` })).status).toBe(200);
    expect((await get("/status", { origin: "http://localhost:5173" })).status).toBe(200);
    expect((await get("/status", { origin: "null" })).status).toBe(403);
  });

  it("405 with Allow for non GET/HEAD, HEAD has no body", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const r = await raw(port, { method, path: "/status", headers: { host: `127.0.0.1:${port}` } });
      expect(r.status, method).toBe(405);
      expect(r.headers.allow).toBe("GET, HEAD");
    }
    const h = await raw(port, { method: "HEAD", path: "/status", headers: { host: `127.0.0.1:${port}` } });
    expect(h.status).toBe(200);
    expect(h.body).toBe("");
  });

  it("404 on unknown routes", async () => {
    for (const p of ["/", "/healthz", "/tasks/t1", "/tasks/t1/history/x", "/status/x"]) {
      expect((await get(p)).status, p).toBe(404);
    }
  });

  it("maps RepoUnavailableError to 503", async () => {
    s.fail.err = new RepoUnavailableError("db down at /var/secret.db");
    for (const p of ["/status", "/tasks", "/tasks/t1/history"]) {
      const r = await get(p);
      expect(r.status).toBe(503);
      expect(JSON.parse(r.body)).toEqual({ error: "history_unavailable" });
    }
  });

  it("hides internals on other errors", async () => {
    s.fail.err = new Error("SQLITE_ERROR: no such table task at /Users/x/db.sqlite\n    at stack");
    const r = await get("/tasks");
    expect(r.status).toBe(500);
    expect(JSON.parse(r.body)).toEqual({ error: "internal" });
    expect(r.body).not.toMatch(/SQLITE|Users|stack/);
  });

  it("sets timeouts and connection limit", () => {
    expect(api.server.requestTimeout).toBe(10_000);
    expect(api.server.headersTimeout).toBe(10_000);
    expect(api.server.maxConnections).toBe(64);
  });
});
