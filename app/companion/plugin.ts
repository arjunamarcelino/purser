// The localhost companion: a Vite DEV-SERVER plugin (apply: "serve") that lets the board stream three
// fixed commands and read the proposer's records. It is a local command runner, so every request
// must prove it comes from this dev page:
//   Host ∈ {127.0.0.1:port, localhost:port} (DNS rebinding), Origin present + same, Sec-Fetch-Site
//   same-origin, POST + application/json (forces a CORS preflight cross-site), and the per-process
//   token from <meta name="purser-token"> compared in constant time. Never in a URL, never logged.
// Commands are fixed argv arrays (no shell); the only variable is a validated task id passed as ONE
// argv element. Jobs outlive connections (start → id; stream replays by seq; explicit cancel).

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Plugin } from "vite";

export const SAFE_TASK_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const JOB_TIMEOUT_MS = 10 * 60_000;
const SPEND_COOLDOWN_MS = 30_000;
const MAX_LINES = 5000;
const MAX_LINE = 500;
const MAX_BODY = 4096;
const RECORDS_MAX_BYTES = 4 * 1024 * 1024;
const RECORDS_MAX_LINES = 2000;

export type JobKind = "attack" | "tests" | "baseline";
const JOB_KINDS: readonly unknown[] = ["attack", "tests", "baseline"] satisfies JobKind[];
/** Jobs that send real testnet transactions, and so share the cooldown. */
export const spendsTestnet = (kind: JobKind): boolean => kind !== "tests";
interface Line {
  seq: number;
  line: string;
}
interface Job {
  id: string;
  kind: JobKind;
  task: string | null;
  lines: Line[];
  seq: number;
  done: boolean;
  code: number | null;
  child: ChildProcess;
  listeners: Set<() => void>;
}

export interface CompanionOptions {
  repoRoot: string;
  contractId: string;
  recordsPath?: string;
}

// eslint-style control/ANSI stripping and secret redaction for anything a child prints.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const SECRETS = [/ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/g, /\bsk-[A-Za-z0-9_-]{16,}/g, /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi];
export function cleanLine(raw: string): string {
  let s = raw.replace(ANSI, "").replace(CONTROL, "");
  for (const re of SECRETS) s = s.replace(re, "[redacted]");
  return s.length > MAX_LINE ? `${s.slice(0, MAX_LINE)}…` : s;
}

/** Minimal environment: tool paths only. Secrets are read by the proposer from its own env files. */
function childEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "TMPDIR", "CARGO_HOME", "RUSTUP_HOME", "NEAR_SANDBOX_BIN_PATH", "LANG"];
  return Object.fromEntries(keep.flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])));
}

export function argvFor(kind: JobKind, task: string | null): { cmd: string; args: string[] } {
  switch (kind) {
    case "attack":
      return { cmd: "pnpm", args: ["--filter", "@purser/proposer", "run", "crew", "--network", "testnet", "--scenario", "attack", `--task=${task}`] };
    case "tests":
      return { cmd: "make", args: ["prove"] };
    case "baseline":
      return { cmd: "pnpm", args: ["--filter", "@purser/proposer", "run", "naive-baseline"] };
  }
}

export interface GuardRequest {
  method?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}

/** Returns null if the request may proceed, or the reason it may not. Exported for tests. */
export function guard(req: GuardRequest, port: number, token: string): string | null {
  const h = (k: string) => {
    const v = req.headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const host = h("host");
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!host || !allowedHosts.includes(host)) return "host";
  if (h("origin") !== `http://${host}`) return "origin";
  if (h("sec-fetch-site") !== "same-origin") return "fetch-site";
  if (req.method !== "POST") return "method";
  if (!(h("content-type") ?? "").startsWith("application/json")) return "content-type";
  const given = Buffer.from(h("x-purser-token") ?? "");
  const want = Buffer.from(token);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return "token";
  return null;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const v: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("body must be an object");
  return v as Record<string, unknown>;
}

/** The last lines of the records file: no symlinks, bounded size, partial trailing line ignored. */
export function readRecordLines(path: string): string[] {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); // a symlink fails to open (ELOOP)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    if (code === "ELOOP") throw new Error("records file must be a regular file");
    throw e;
  }
  try {
    const st = fstatSync(fd); // checked on the opened descriptor: no check-then-open race
    if (!st.isFile()) throw new Error("records file must be a regular file");
    const size = st.size;
    const start = Math.max(0, size - RECORDS_MAX_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    const complete = text.slice(0, text.lastIndexOf("\n") + 1); // a line still being appended is skipped
    const lines = complete.split("\n").filter(Boolean);
    return lines.slice(start > 0 ? 1 : 0).slice(-RECORDS_MAX_LINES); // first line may be cut when tailing
  } finally {
    closeSync(fd);
  }
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
};

export function purserCompanion(opts: CompanionOptions): Plugin {
  const token = randomBytes(32).toString("hex");
  const recordsPath = opts.recordsPath ?? resolve(opts.repoRoot, "proposer/out/records.jsonl");
  let current: Job | null = null;
  let lastSpendEnd = 0;

  const push = (job: Job, raw: string) => {
    for (const piece of raw.split(/\r?\n/)) {
      if (piece === "") continue;
      job.lines.push({ seq: ++job.seq, line: cleanLine(piece) });
      if (job.lines.length > MAX_LINES) job.lines.shift();
    }
    for (const l of job.listeners) l();
  };

  const start = (kind: JobKind, task: string | null): Job => {
    const { cmd, args } = argvFor(kind, task);
    const child = spawn(cmd, args, { cwd: opts.repoRoot, env: childEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"], shell: false });
    const job: Job = { id: randomUUID(), kind, task, lines: [], seq: 0, done: false, code: null, child, listeners: new Set() };
    push(job, `$ ${cmd} ${args.join(" ")}`);
    child.stdout?.setEncoding("utf8").on("data", (d: string) => push(job, d));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => push(job, d));
    const killer = setTimeout(() => killGroup(job, "timed out after 10 minutes"), JOB_TIMEOUT_MS);
    const finish = (code: number | null) => {
      if (job.done) return;
      clearTimeout(killer);
      job.done = true;
      job.code = code;
      if (spendsTestnet(kind)) lastSpendEnd = Date.now();
      push(job, `[exit ${code ?? "signal"}]`);
    };
    child.on("error", (e) => {
      push(job, `failed to start: ${e.message}`);
      finish(127);
    });
    child.on("close", (code) => finish(code));
    return job;
  };

  const killGroup = (job: Job, why: string) => {
    if (job.done || job.child.pid === undefined) return;
    push(job, `[stopping: ${why}]`);
    try {
      process.kill(-job.child.pid, "SIGTERM"); // the whole group: pnpm/cargo spawn grandchildren
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        if (!job.done && job.child.pid !== undefined) process.kill(-job.child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, 5000).unref();
  };

  return {
    name: "purser-companion",
    apply: "serve",
    transformIndexHtml: () => [{ tag: "meta", attrs: { name: "purser-token", content: token }, injectTo: "head" }],
    configureServer(server) {
      const port = () => server.config.server.port ?? 5173;
      server.httpServer?.once("close", () => current && killGroup(current, "dev server stopped"));
      // Jobs run in their own process group (so they can be killed as one), which also means Ctrl-C
      // in the terminal never reaches them. Kill the group synchronously on the way out.
      const reap = () => {
        const pid = current && !current.done ? current.child.pid : undefined;
        if (pid !== undefined) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      };
      process.once("exit", reap);
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.once(sig, () => {
          reap();
          process.exit(128 + (sig === "SIGINT" ? 2 : sig === "SIGTERM" ? 15 : 1));
        });
      }

      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/__purser/")) return next();
        const denied = guard(req, port(), token);
        if (denied) return send(res, 403, { error: "forbidden", reason: denied });
        let body: Record<string, unknown>;
        try {
          body = await readJson(req);
        } catch (e) {
          return send(res, 400, { error: e instanceof Error ? e.message : "bad request" });
        }
        const path = url.split("?")[0];

        if (path === "/__purser/records") {
          const task = body.task;
          if (typeof task !== "string" || !SAFE_TASK_ID.test(task)) return send(res, 400, { error: "invalid task" });
          try {
            const records = readRecordLines(recordsPath).flatMap((l) => {
              try {
                const r = JSON.parse(l) as Record<string, unknown>;
                return r.task === task && r.network === "testnet" && r.contract_id === opts.contractId ? [r] : [];
              } catch {
                return [];
              }
            });
            return send(res, 200, { records });
          } catch (e) {
            return send(res, 500, { error: e instanceof Error ? e.message : "records unavailable" });
          }
        }

        if (path === "/__purser/jobs") {
          if (!JOB_KINDS.includes(body.kind)) return send(res, 400, { error: "unknown job" });
          const kind = body.kind as JobKind;
          const task = kind === "attack" ? body.task : null;
          if (kind === "attack" && (typeof task !== "string" || !SAFE_TASK_ID.test(task))) return send(res, 400, { error: "invalid task" });
          if (current && !current.done) return send(res, 409, { error: "a job is already running", jobId: current.id, kind: current.kind });
          if (spendsTestnet(kind) && Date.now() - lastSpendEnd < SPEND_COOLDOWN_MS) return send(res, 429, { error: "cooling down: this run spends testnet NEAR" });
          current = start(kind, task as string | null);
          return send(res, 202, { jobId: current.id, kind });
        }

        if (path === "/__purser/jobs/current") {
          return send(res, 200, current ? { jobId: current.id, kind: current.kind, task: current.task, done: current.done, code: current.code } : { jobId: null });
        }

        if (path === "/__purser/jobs/cancel") {
          if (!current || body.jobId !== current.id) return send(res, 404, { error: "no such job" });
          killGroup(current, "cancelled");
          return send(res, 202, { ok: true });
        }

        if (path === "/__purser/jobs/events") {
          const job = current;
          if (!job || body.jobId !== job.id) return send(res, 404, { error: "no such job" });
          const after = typeof body.after === "number" ? body.after : 0;
          res.statusCode = 200;
          res.setHeader("content-type", "application/x-ndjson");
          res.setHeader("cache-control", "no-store");
          let sent = after;
          const oldest = job.lines[0]?.seq;
          if (oldest !== undefined && after < oldest - 1) {
            res.write(`${JSON.stringify({ seq: oldest - 1, line: `[… ${oldest - 1 - after} earlier line(s) no longer buffered]` })}\n`);
            sent = oldest - 1;
          }
          const flush = () => {
            for (const l of job.lines) {
              if (l.seq > sent) {
                res.write(`${JSON.stringify(l)}\n`);
                sent = l.seq;
              }
            }
            if (job.done) {
              res.end(`${JSON.stringify({ seq: sent, done: true, code: job.code })}\n`);
              job.listeners.delete(flush);
            }
          };
          job.listeners.add(flush);
          req.on("close", () => job.listeners.delete(flush)); // the job keeps running; the client can re-attach
          flush();
          return;
        }

        return send(res, 404, { error: "not found" });
      });
    },
  };
}
