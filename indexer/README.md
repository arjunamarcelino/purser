# indexer

A **derived, rebuildable mirror** of the Purser contract: an event poller plus a thin SQLite/Postgres
cache, and a read-only localhost API that feeds the dashboard's history panel and its
"history cache Ns · block M" indicator. **The contract is the only source of truth.**
No cache row authorizes or releases funds; the board's budget and reservation numbers never come from here.

```
chain (one pinned final block H) ──views──▶ poller ──1 txn per task──▶ DB ◀── serve (read-only) ◀── /__indexer proxy ◀── app
```

## Run

```sh
# .env.testnet provides PURSER_CONTRACT_ID / NEAR_NETWORK; DATABASE_URL defaults to sqlite://./purser-indexer.db
make indexer-poll          # loop: one pass every 15s (default mode) (single writer; lockfile next to the sqlite DB)
make indexer-serve         # GET API on 127.0.0.1:8787
make indexer-counts        # row count per table + canonical dump sha256
INDEXER_ENABLED=1 make board
```

One pass: `pnpm --filter @purser/indexer run poll --once`.
Rebuild from empty: delete the DB (or `rebuild --network N --contract C --yes`) and poll again; the canonical dump is identical.

## Rules (BACKEND-SCHEMA §2.3, §4)

- The poller imports only view calls (`packages/chain-read`): no signer, no function-call path. A test greps for it.
- `serve` opens the DB read-only and exposes GET/HEAD only; wrong `Host` → 403; never sends CORS headers
  (the app reaches it same-origin through the Vite proxy).
- Secrets live in env, never the DB. `DATABASE_URL` is redacted in logs. `attestation` stores `token_digest` only
  and `relayer_job` is created but unused until Prompt 12.
- The cache is eventually consistent. Every payment row links to the on-chain tx (or says why it can't yet).
  A frozen/contradicted reconcile is followed, never inferred: `frozen` comes from the `invariant` view.
- Commitments are read by id (`get_commitment`, sequential from 0, never deleted), not by `list_commitments`,
  which rescans the whole ledger per call.

## Deviations from the §2.2 DDL (confirmed)

`UNIQUE(task_id, delegate, request_id)` instead of `UNIQUE(request_id)` (the contract keys idempotency per delegate);
`delegate_snapshot` keyed `(task_id, account_id)` and upserted; `commitment_event` is a one-row-per-commitment state mirror;
extra columns `frozen`, `crew_cap`, `payload_hash`, `tx_status`, `as_of_height`, `missing_since_height`.

## Config

`DATABASE_URL` (`sqlite://./x.db`, `sqlite:///abs/x.db`, `sqlite::memory:`, or `postgres://…`), `NEAR_NETWORK` (sandbox|testnet),
`NEAR_RPC_URL`, `PURSER_CONTRACT_ID`, `POLL_INTERVAL_MS` (15000), `POLL_PASS_BUDGET_MS` (45000), `API_HOST` (loopback only), `API_PORT` (8787).

Types come from `packages/types` (generated from the ABI); do not hand-mirror them.
