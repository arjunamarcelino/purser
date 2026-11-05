import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { purserCompanion } from "./companion/plugin.ts";

const repoRoot = resolve(import.meta.dirname, "..");

// Exactly these keys may reach the browser. The repo's env files also hold function-call keys and the
// NEAR AI API key, so they are parsed here by hand — never passed through loadEnv/define wholesale.
const EXPOSED = ["PURSER_CONTRACT_ID", "NEAR_NETWORK", "NEAR_RPC_URL", "INDEXER_ENABLED"] as const;
function readExposedEnv(): Record<(typeof EXPOSED)[number], string> {
  const out: Record<string, string> = {};
  for (const file of [".env", ".env.testnet"]) {
    const path = resolve(repoRoot, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (!m || !(EXPOSED as readonly string[]).includes(m[1]!)) continue;
      const value = m[2]!.replace(/\s+#.*$/, "").trim().replace(/^"(.*)"$/, "$1");
      if (value) out[m[1]!] = value; // later files win: .env.testnet (written by deploy) overrides .env
    }
  }
  for (const k of EXPOSED) if (process.env[k]) out[k] = process.env[k]!;
  return {
    PURSER_CONTRACT_ID: out.PURSER_CONTRACT_ID ?? "",
    NEAR_NETWORK: out.NEAR_NETWORK ?? "testnet",
    NEAR_RPC_URL: out.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com",
    INDEXER_ENABLED: out.INDEXER_ENABLED ?? "",
  };
}

const env = readExposedEnv();
const PORT = 5173;
// Same-origin proxy to the local read API (never a host URL in the bundle). Only the port is configurable.
const indexerPort = /^\d{2,5}$/.test(process.env.INDEXER_PORT ?? "") ? process.env.INDEXER_PORT : "8787";
// changeOrigin rewrites Host to the target so the API's DNS-rebinding allowlist (Host must be its own
// 127.0.0.1:<port>) passes; Vite has already vetted the browser's Host (allowedHosts) before proxying.
const indexerProxy = {
  "/__indexer": { target: `http://127.0.0.1:${indexerPort}`, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/__indexer/, "") },
};

export default defineConfig({
  plugins: [react(), purserCompanion({ repoRoot, contractId: env.PURSER_CONTRACT_ID })],
  envDir: import.meta.dirname, // app/ only: no VITE_* from the repo root can leak in
  define: {
    __PURSER_CONFIG__: JSON.stringify({ contractId: env.PURSER_CONTRACT_ID, network: env.NEAR_NETWORK, rpcUrl: env.NEAR_RPC_URL, indexerEnabled: /^(1|true)$/i.test(env.INDEXER_ENABLED) }),
  },
  server: {
    host: "127.0.0.1",
    port: PORT,
    strictPort: true,
    proxy: indexerProxy,
    cors: false, // Vite's default lets any localhost origin read responses (incl. the page's token)
    headers: {
      "X-Frame-Options": "DENY", // a framing parent could inject a wallet through near-connect's postMessage path
      "Content-Security-Policy": "frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      // A page that opens the board must not keep a handle to it (near-connect accepts injected
      // wallets by postMessage); popups the board opens itself (Meteor) still work.
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    },
    fs: {
      strict: true,
      allow: [import.meta.dirname, resolve(repoRoot, "packages/types/src"), resolve(repoRoot, "node_modules/.pnpm")],
      deny: [".env", ".env.*", "**/.near-keys/**", "**/*.key", "**/*.pem", "**/*.crt", "**/out/**", "**/.git/**"],
    },
  },
  // Pre-bundle every React entry the app imports, so the dev server never has to discover one mid-
  // session (a late discovery serves "504 Outdated Optimize Dep" and blanks the page until restart).
  optimizeDeps: { include: ["react", "react-dom", "react-dom/client", "react/jsx-dev-runtime", "@hot-labs/near-connect", "near-api-js"] },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true, proxy: indexerProxy },
  build: { sourcemap: false, target: "es2022" },
});
