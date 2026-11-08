// @vitest-environment node
// The comparison page must not exist in a production build. A fresh build into a temp dir, so a stale
// dist/ cannot pass this.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { afterAll, expect, it, vi } from "vitest";

const appDir = resolve(import.meta.dirname, "..");
const outDir = mkdtempSync(join(tmpdir(), "purser-prod-"));
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(outDir, { recursive: true, force: true });
});

it("a production build contains none of the comparison page", async () => {
  vi.stubEnv("NODE_ENV", "production"); // vitest's "test" would make vite compile the dev branch in
  await build({ mode: "production", configFile: resolve(appDir, "vite.config.ts"), root: appDir, logLevel: "silent", build: { outDir, emptyOutDir: true } });
  const files = readdirSync(outDir, { recursive: true, withFileTypes: true }).filter((f) => f.isFile() && /\.(js|css|html)$/.test(f.name));
  expect(files.length).toBeGreaterThan(0);
  const text = files.map((f) => readFileSync(join(f.parentPath, f.name), "utf8")).join("\n");
  for (const marker of ["NO RESERVATION", "Fire 60", "double-spend", "naive-banner", "naive-baseline", "BaselinePage", 'get("baseline")'] as const) {
    expect(text.includes(marker), marker).toBe(false);
  }
  expect(text).not.toMatch(/kind\s*[:=]+\s*["'`]baseline["'`]/);
}, 120_000);
