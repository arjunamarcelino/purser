---
title: "Vite dev server blanks the page with '504 (Outdated Optimize Dep)' for react-dom mid-session"
category: ui-bugs
date: 2026-11-05
tags: [vite, 8, optimizeDeps, dependency-prebundling, react-dom, react-19, 504, outdated-optimize-dep, blank-page, dev-server, near-connect, near-api-js]
module: app dev server (app/vite.config.ts)
symptom: "The board went blank during a session. Console: `GET /node_modules/.vite/deps/react-dom_client.js?v=… 504 (Outdated Optimize Dep)`. A hard reload sometimes fixed it and sometimes didn't; restarting `make board` fixed it until the next time."
root_cause: "Vite discovered a new bare import (a React entry, or near-connect/near-api-js loaded lazily) after the first pre-bundle, re-optimized, and changed the dep hash. Modules the open page had already requested with the old `?v=` hash now return 504, so React never mounts."
status: resolved
verified: true
---

# Vite "504 Outdated Optimize Dep" blanks the board

**One-line:** list every heavy or lazily imported dependency in `optimizeDeps.include`, so Vite
pre-bundles them all at startup and never re-optimizes mid-session. Shipped in PR #7.

## Symptom

A blank page with no React error. In the network tab, `react-dom_client.js?v=<old hash>` → **504
Outdated Optimize Dep**. It happened most after the first wallet connect, because that path pulls
in near-connect and near-api-js for the first time.

## Fix (`app/vite.config.ts`)

```ts
// Pre-bundle every React entry the app imports, so the dev server never has to discover one mid-
// session (a late discovery serves "504 Outdated Optimize Dep" and blanks the page until restart).
optimizeDeps: { include: ["react", "react-dom", "react-dom/client", "react/jsx-dev-runtime", "@hot-labs/near-connect", "near-api-js"] },
```

After a change to this list, restart the dev server once. Vite then rebuilds `node_modules/.vite`
with a stable hash.

## Prevention

- When you add a dependency that is imported lazily (`await import(...)`, or a component behind a
  route or a button), add it to `optimizeDeps.include` too.
- If a blank dev page shows a 504 on `.vite/deps`, it's this bug. Restart the dev server, then add
  the dependency to the list.
- This affects the dev server only. `vite build` is unaffected.

## Related

- `docs/solutions/integration-issues/near-api-js-7-rate-limited-public-rpc-board-freeze.md` (the other "board went blank or froze" cause)
