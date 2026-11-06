---
title: "Live board froze on fastnear's free testnet RPC: near-api-js 7 `retries` is an attempt count and 429 is never retried"
category: integration-issues
date: 2026-11-05
tags: [near-api-js, 7.4, JsonRpcProvider, retries, rate-limit, 429, fastnear, public-rpc, polling, backoff, abort, finality, blockId, consistency, dashboard, proposer, purser]
module: app data layer (app/src/data/sources.ts, useBoard.ts) + proposer reads (proposer/src/purser-client.ts)
symptom: "The operator board stopped updating ('synced 40s ago' and climbing) or showed 'NOT TESTNET' after a burst of view calls; setting retries: 0 to fail fast made EVERY call fail without a network request; the attack demo died at startup with a 429 from the proposer's first reads."
root_cause: "(1) The free fastnear testnet RPC rate-limits bursts with HTTP 429. (2) near-api-js 7.4's JsonRpcProvider retries only 500/503/408, never 429, and its `retries` option is the number of ATTEMPTS, so 0 means zero sends. (3) The poll fired 4+ views at once with no timeout or backoff, so one 429 or a hung request froze the poll chain."
status: resolved
verified: true
---

# Board froze on a rate-limited public RPC (near-api-js 7)

**One-line:** make one attempt per call with a timeout, back off on failure, pin one final block
per poll, and never show stale data as green. The proposer retries rate-limited *reads* only.
Shipped in PR #7 (`56fd431`, `f39dcbb`).

## Symptoms

- "synced Ns ago" kept climbing while the invariant line stayed green on old data.
- The chain-id check failed once on a 429 and the top bar said **NOT TESTNET** permanently.
- After `retries: 0` was set to fail fast, nothing loaded at all, and the network tab showed no requests.
- `make board` → **Run attack demo** exited immediately: the proposer's startup `get_task` /
  `list_delegates` reads hit a 429.

## What did NOT work

- **`retries: 0`.** In near-api-js 7.4 this is the attempt count, so the provider never sends.
- **Relying on the provider's built-in retry for 429.** It retries 500/503/408 only.
- **A fixed `setInterval` poll.** Slow responses overlap, the bursts grow, and the rate limit gets worse.
- **Retrying owner/delegate *writes* on 429.** A send may have landed. The proposer resolves
  uncertain sends through its journal and `get_idempotency`, not by blind retry.

## Solution

### Board (`app/src/data/sources.ts`, `useBoard.ts`)

```ts
// One attempt per call (near-api-js's `retries` is the ATTEMPT count — 0 would never send).
this.#provider = new JsonRpcProvider({ url: rpcUrl }, { retries: 1 });
// Every call races a 10 s timeout and the poll's AbortSignal.
const raw = await withTimeout(this.#provider.callFunctionRaw({ /* … */ blockQuery: blockId === undefined ? { finality: "final" } : { blockId } }), signal);
```

- **One block per poll.** Read `viewBlock({ finality: "final" })` once, then run every view with
  `blockQuery: { blockId }`. Budget, crew, manifest and the invariant line then describe the same
  state. Heights only move forward: a response from an older block is dropped.
- **A setTimeout chain, not an interval.** The next poll is scheduled after the current one settles.
  The interval is 4 s normally, with exponential backoff up to 30 s on failure. A 429 shows as
  "RPC rate limit — backing off".
- **Abort on change.** A task switch or unmount aborts the in-flight poll. A late response for an
  old generation is ignored.
- **Stale is never green.** Past the staleness threshold, the invariant line drops to neutral
  ("stale"). A failed refresh keeps the last good state rather than clearing the board. The board
  resets only on a task switch.
- **The chain-id check retries with backoff** instead of latching "NOT TESTNET" after one failure.

### Proposer (`proposer/src/purser-client.ts`)

```ts
export async function retryRateLimited<T>(read: () => Promise<T>, attempts = 6, baseMs = 1000): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await read(); }
    catch (err) {
      const msg = err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? "")}` : String(err);
      if (i >= attempts - 1 || !RATE_LIMITED.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
}
```

The wrapper covers view calls only. Writes are not wrapped, as explained under "What did NOT work".

## Prevention

- Before you set a near-api-js provider option, read what it means in the installed version.
  `retries` doesn't mean "extra attempts".
- Assume any free public RPC returns 429 under a dashboard's burst. Test with throttling (or a stub
  that returns 429) before a live demo.
- For any live status indicator, define what "stale" looks like and make sure it can't be green.
- Set `NEAR_RPC_URL` to a keyed RPC for demos if the free tier remains a problem.

## Related

- `docs/solutions/integration-issues/near-sandbox-race-proof-and-mocked-vm-harness.md`
- `app/README.md` › What's on the board
- Follow-up: the proposer's optimistic read can record `Reserved` for a payment that settles moments later.
