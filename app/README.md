# app: the operator board

One screen that makes Purser's invariant visible and gives the owner the kill-switch.

```bash
make board          # http://127.0.0.1:5173/?task=<task-id>
```

It reads `PURSER_CONTRACT_ID`, `NEAR_NETWORK` (must be `testnet`) and `NEAR_RPC_URL` from the repo's
`.env` / `.env.testnet` (written by `scripts/deploy-testnet.sh`). Only those three keys reach the
browser, and the app refuses to load unless the RPC itself reports `chain_id: testnet`.

## What's on the board

| Region | Source | Meaning |
|---|---|---|
| Budget | `get_task`, `remaining_budget` | Remaining / cap, completed · outstanding |
| Crew | `list_delegates` | `*` = active, `o` = revoked; **Revoke** (owner only) |
| Manifest: Holds | `list_commitments` | Reserved / Signed (neutral), Unknown (amber: reservation retained) |
| Manifest: Payments | `list_commitments` + proposer records | Confirmed (green) with an explorer tx link |
| Manifest: Refused | proposer records | REFUSED / BLOCKED / REJECTED (amber, never red), labelled *reported by proposer* |
| Status line | **`invariant(task_id)`**, the contract's own verdict | green = healthy · amber = holds pending proof · **red only if the contract reports a violation** · dim = stale/unavailable (never green on old data) |

Every view in one poll is read at the same final block, so the invariant and the ledger never disagree
on screen.

Refusals leave nothing on chain (a panic rolls back state and logs), and the contract stores no tx hash.
REFUSED rows and payment tx links therefore come from the proposer's own `ProposalRecord`s
(`proposer/out/records.jsonl`). The board treats them as untrusted: it validates them, keeps only those
from on-chain delegates of the task, and labels them. Prompt 9's indexer replaces this source behind
the same interface.

## Owner actions (the kill-switch)

Connect the task owner's wallet to revoke a delegate, add one, set the allowlist or create a task.
Every action shows exactly what will be signed (network, contract, method, arguments, deposit,
signer) before the wallet opens. The receiver is always the configured contract.

**Revocation is honest.** It blocks new proposals from that delegate immediately. It cannot recall a
payment or signature already made, and holds already reserved stay until settled. It is also
**permanent for that task**: the contract refuses to re-add a revoked delegate.

### Wallets (testnet)

The board uses [`@hot-labs/near-connect`](https://docs.near.org/web3-apps/tutorials/wallet-login),
the connector NEAR's docs currently teach. The prompt named `@near-wallet-selector`; we chose
near-connect deliberately (no duplicate NEAR SDK, no React 18 pin, no polyfills). It loads a
**vendored manifest** (`src/wallet/manifest.ts`) with two wallets, each executor pinned to a commit:

- **NEAR CLI** (recommended for the owner). It shows the `near` command for the transaction; you run
  it in your terminal, where the key lives in your OS keychain, and paste the tx hash back. The widget
  verifies the hash on chain. No key ever enters the browser.
- **Meteor** (browser extension, testnet supported).

The top bar has two buttons. **Connect wallet** opens near-connect's picker with both wallets.
**NEAR CLI** skips the picker and goes straight to the CLI flow.

MyNearWallet isn't offered: near-connect doesn't list it for testnet. Intear is omitted because its
executor can't be pinned. Wallet storage never registers near-connect "debug wallets", and the page
refuses to be framed.

## Demo controls (localhost companion)

**Run attack demo** runs `crew --scenario attack --task=<task>` (race + rogue) against testnet, and
**Run tests** runs `make prove`. Both stream into the console. They exist only under `vite dev`: a
dev-server plugin (`companion/plugin.ts`) that

- answers only `127.0.0.1` / `localhost` on this port, same-Origin, `Sec-Fetch-Site: same-origin`, JSON
  POST, with a per-process token from the page;
- runs three fixed commands (no shell) with at most one validated argument, a minimal environment, a
  10-minute limit, one job at a time, and a cooldown after any run that spends testnet NEAR;
- redacts key-like strings and terminal escapes from output;
- keeps jobs independent of the browser: reloading re-attaches to the running job, and nothing is
  started twice.

A production build (`pnpm --filter @purser/app build`) contains no runner and works read-only.

## Demo recording views (dev server only)

- `?units=1` shows amounts in units of cap/100, with the scale always labelled. Display only: reads and the
  invariant verdict are unchanged. Without it, or when the cap does not divide by 100, the board shows NEAR.
- `?baseline=1` opens the comparison page: a deliberately unsafe budget for the demo's comparison shot, labelled
  as such on every state. It sends real testnet transfers from a throwaway account and is not part of Purser.
  It is compiled out of production builds (a test builds fresh and checks).

## History cache (indexer)

Optional, display-only. The board can show an "On-chain history (cached)" list and a second footer segment
(`history cache Ns · block M`, amber past 60 s, never green; `history offline` when unreachable) from the
off-chain indexer. It never touches the chain-read path, the invariant line or any owner action.

```bash
make indexer-poll              # fill the cache from the chain
make indexer-serve             # read API on 127.0.0.1:8787 (override with INDEXER_PORT)
INDEXER_ENABLED=1 make board   # the dashboard reads it through the same-origin /__indexer proxy
```

Vite proxies `/__indexer` (dev and `preview`) to `127.0.0.1:$INDEXER_PORT`; the bundle holds only the boolean
`INDEXER_ENABLED`, never a host. Every field is validated at the boundary (invalid rows are dropped and
counted), rendered as text only, and a `/status` for another network or contract is rejected as "wrong
indexer". A production build has no proxy, so the panel shows "history offline" unless you route
`/__indexer` yourself.

## Development

```bash
pnpm --filter @purser/app test        # contrast (AA, both bands), semantics, panels, companion security (real dev server)
pnpm --filter @purser/app typecheck
pnpm --filter @purser/app build
```

The dev server serves nothing from `.env*`, `.near-keys/`, `out/` or `*.key`. A test probes those paths
over `/@fs` (plain, `?raw`, `?import`, `?url`) against a running server.
