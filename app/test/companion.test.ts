// @vitest-environment node
// The companion is a local command runner and the dev server sits next to key files, so these run
// against a REAL Vite dev server, not mocks.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SAFE_TASK_ID as TYPES_TASK_ID } from "@purser/types";
import { SAFE_TASK_ID, cleanLine, guard, readRecordLines } from "../companion/plugin.ts";

const appDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appDir, "..");
const PORT = 5199;
let server: ViteDevServer;
let token = "";
const base = `http://127.0.0.1:${PORT}`;

beforeAll(async () => {
  server = await createServer({ configFile: resolve(appDir, "vite.config.ts"), root: appDir, logLevel: "silent", server: { port: PORT, strictPort: true } });
  await server.listen();
  const html = await (await fetch(`${base}/`)).text();
  token = /name="purser-token" content="([0-9a-f]{64})"/.exec(html)?.[1] ?? "";
}, 60_000);
afterAll(async () => {
  await server?.close();
});

const companion = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, "sec-fetch-site": "same-origin", "x-purser-token": token, ...headers },
    body: JSON.stringify(body),
  });

describe("dev server never serves secrets", () => {
  // Sentinel files in every protected location, so a 403 proves a real file was refused (a missing
  // path would just get the SPA's index.html).
  const SENTINEL = "PURSER-FS-PROBE-SENTINEL";
  const probes = [".env.fsprobe", ".near-keys/fsprobe.key", "proposer/out/fsprobe.jsonl", "proposer/out/journal/fsprobe.jsonl"].map((p) => resolve(repoRoot, p));
  const created: string[] = [];
  beforeAll(() => {
    for (const p of probes) {
      mkdirSync(dirname(p), { recursive: true });
      if (!existsSync(p)) {
        writeFileSync(p, SENTINEL, { mode: 0o600 });
        created.push(p);
      }
    }
  });
  afterAll(() => created.forEach((p) => rmSync(p, { force: true })));

  it.each(probes.flatMap((p) => ["", "?raw", "?import", "?url"].map((q) => [p, q] as const)))("GET /@fs%s%s is refused", async (p, q) => {
    const res = await fetch(`${base}/@fs${p}${q}`);
    const body = await res.text();
    expect(res.status).toBe(403);
    expect(body).not.toContain(SENTINEL);
  });

  it("does serve the app's own sources (the deny list is not just blocking everything)", async () => {
    expect((await fetch(`${base}/src/config.ts`)).status).toBe(200);
  });
});

describe("companion guards", () => {
  it("the page carries a per-process token", () => expect(token).toMatch(/^[0-9a-f]{64}$/));

  it.each([
    ["no token", { "x-purser-token": "" }, "token"],
    ["a wrong token", { "x-purser-token": "0".repeat(64) }, "token"],
    ["a foreign Origin", { origin: "http://evil.example" }, "origin"],
    ["a cross-site fetch", { "sec-fetch-site": "cross-site" }, "fetch-site"],
    ["a non-JSON body", { "content-type": "text/plain" }, "content-type"],
  ])("refuses %s", async (_name, headers, reason) => {
    const res = await companion("/__purser/jobs/current", {}, headers);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason: string }).reason).toBe(reason);
  });

  it("refuses a rebinding Host and a missing Origin (unit)", () => {
    const h = { origin: `http://127.0.0.1:${PORT}`, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-purser-token": "t" };
    expect(guard({ method: "POST", headers: { ...h, host: `attacker.example:${PORT}` } }, PORT, "t")).toBe("host");
    expect(guard({ method: "POST", headers: { ...h, host: `127.0.0.1:${PORT}`, origin: undefined } }, PORT, "t")).toBe("origin");
    expect(guard({ method: "GET", headers: { ...h, host: `127.0.0.1:${PORT}` } }, PORT, "t")).toBe("method");
    expect(guard({ method: "POST", headers: { ...h, host: `127.0.0.1:${PORT}` } }, PORT, "t")).toBeNull();
  });

  it.each(["--network=mainnet", "-x", "a/b", "A", "x\ny", "x".repeat(65), "‮abc"])("refuses task id %j before running anything", async (task) => {
    const res = await companion("/__purser/jobs", { kind: "attack", task });
    expect(res.status).toBe(400);
  });

  it("refuses unknown jobs", async () => {
    expect((await companion("/__purser/jobs", { kind: "rm -rf /" })).status).toBe(400);
  });

  it("uses the same task-id rule as the proposer", () => expect(SAFE_TASK_ID.source).toBe(TYPES_TASK_ID.source));
});

describe("records and output hygiene", () => {
  it("refuses a symlinked records file and skips a partial trailing line", () => {
    const dir = mkdtempSync(join(tmpdir(), "purser-comp-"));
    const real = join(dir, "real.jsonl");
    writeFileSync(real, '{"a":1}\n{"b":2}\n{"partial":');
    expect(readRecordLines(real)).toEqual(['{"a":1}', '{"b":2}']);
    const link = join(dir, "link.jsonl");
    symlinkSync(real, link);
    expect(() => readRecordLines(link)).toThrow(/regular file/);
    expect(readRecordLines(join(dir, "missing.jsonl"))).toEqual([]);
  });

  it("redacts key material and strips terminal escapes from job output", () => {
    // Fake key material, assembled at runtime so the repo's own secret scanner doesn't flag the fixture.
    const key = `ed25519:${"3".repeat(88)}`;
    const apiKey = ["sk", "abcdefghijklmnopqrstuv"].join("-");
    expect(cleanLine(`key=${key} \u001b[31mred\u001b[0m ${apiKey}`)).toBe("key=[redacted] red [redacted]");
  });
});

describe("production bundle", () => {
  it("contains no secret value, no token meta and no sourcemaps", () => {
    const dist = resolve(appDir, "dist");
    if (!existsSync(dist)) return; // built by `pnpm --filter @purser/app build` (CI runs it first)
    const files = readdirSync(dist, { recursive: true, withFileTypes: true }).filter((f) => f.isFile());
    expect(files.some((f) => f.name.endsWith(".map"))).toBe(false);
    const text = files.map((f) => readFileSync(join(f.parentPath, f.name), "utf8")).join("\n");
    expect(text).not.toMatch(/name="purser-token"\s+content=/); // the selector string is fine; an injected token is not
    expect(text).not.toMatch(/ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/);
    const secretValues: string[] = [];
    for (const f of [".env", ".env.testnet"]) {
      const p = resolve(repoRoot, f);
      if (!existsSync(p)) continue;
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const m = /^([A-Z0-9_]*(KEY|SECRET|PRIVATE)[A-Z0-9_]*)=(\S{12,})/.exec(line.trim());
        if (m) secretValues.push(m[3]!.replace(/^"|"$/g, ""));
      }
    }
    for (const v of secretValues) expect(text.includes(v)).toBe(false);
  });
});
