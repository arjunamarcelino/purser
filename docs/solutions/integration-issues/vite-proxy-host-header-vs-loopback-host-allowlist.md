---
title: "Indexer API returned 403 forbidden_host through the Vite proxy: the proxy forwards the browser's Host header"
category: integration-issues
date: 2026-11-05
tags: [vite, proxy, changeOrigin, host-header, dns-rebinding, allowedHosts, localhost, indexer, api, purser]
module: app/vite.config.ts (indexerProxy) + indexer/src/api.ts (Host allowlist)
symptom: "curl http://127.0.0.1:8787/status returned 200, but curl http://127.0.0.1:5174/__indexer/status (same API through the Vite dev proxy) returned 403 {\"error\":\"forbidden_host\"}. All unit tests were green."
root_cause: "http-proxy keeps the incoming Host header unless changeOrigin is true. The browser's Host (127.0.0.1:5174) reached the API, whose DNS-rebinding allowlist only accepts its own host:port (127.0.0.1:8787). The API test used a stub repo and direct requests, so the proxy hop was never exercised."
status: resolved
verified: true
---

# Vite proxy forwards Host; the API's rebinding allowlist rejects it

**One-line:** set `changeOrigin: true` on the `/__indexer` proxy so the API sees its own Host. Vite has
already vetted the browser's Host (`server.allowedHosts`) before it proxies, so both hops stay guarded.
Fixed in `3f54ab7` (PR #8).

## Symptom

The read API's Host check (403 for any Host that is not `127.0.0.1:<port>` / `localhost:<port>`,
the defence against DNS rebinding) worked directly but blocked every request coming through the
board's same-origin proxy. The plan had said `changeOrigin: false` and "test that the allowlist still
passes through the proxy"; that test was never written, and 14 API tests plus 129 app tests passed.

## What found it

Only an end-to-end curl through the running stack, before any browser was involved:

```sh
curl -i http://127.0.0.1:5174/__indexer/status                          # was 403, now 200
curl -s -H "Host: evil.example:5174" http://127.0.0.1:5174/__indexer/status   # Vite itself: "Blocked request"
```

The second line is the check that matters: a forged Host is still stopped, by Vite on the first hop.

## Fix

```ts
// app/vite.config.ts
const indexerProxy = {
  "/__indexer": { target: `http://127.0.0.1:${indexerPort}`, changeOrigin: true,
                  rewrite: (p: string) => p.replace(/^\/__indexer/, "") },
};
```

Same object is used for `server.proxy` and `preview.proxy`. Do **not** loosen the API's allowlist to
accept the Vite port: that would make the API's protection depend on whichever dev server fronts it.

## Prevention

- Any security check keyed on a request header (Host, Origin) needs one test through the real
  intermediary (proxy, tunnel), not just direct requests. A stub-repo unit test cannot see it.
- When a plan says "test X still passes through Y", turn it into a checklist item that blocks the PR.
- Smoke the live stack with curl through every hop before opening a browser: it is faster and shows the
  status code.

## Related

- `docs/solutions/security-issues/wallet-outcome-pasted-tx-hash-false-kill-switch-success.md` (same
  "verify at the boundary, not by assumption" posture)
- `docs/solutions/ui-bugs/vite-504-outdated-optimize-dep-blank-page.md` (other Vite dev-server gotcha)
