# @purser/relayer

The stateless relayer of the governed EVM payment path. The Purser contract signs Sepolia transactions itself (NEAR Chain Signatures) and is the work queue; the relayer only
1. validates and **broadcasts** the contract-signed raw transaction (`get_signed_tx`),
2. reports what **finalized** on Sepolia (`attest_external`),
3. marks a stale `Signed` commitment `Unknown` (`mark_unknown`),
4. on an operator's trigger, asks for the single nonce-burn cancel (`request_cancel`) and broadcasts it.

**No EVM private key exists in the relayer.** `RELAYER_PRIVATE_KEY` is its NEAR function-call key, which startup refuses unless it is restricted to those three methods on this contract. No SQLite, no journal: a restart re-derives everything from contract views. Sepolia only; it refuses any other chain id (checked with `eth_chainId` on every URL) and any non-testnet NEAR network.

## Trust assumption (named)

The relayer is the only party that tells the contract what happened on Sepolia. The contract cannot read EVM state, so a **lying or compromised relayer** is bounded as follows:

| Attack | Possible? | Bound |
|---|---|---|
| Report a false "original landed" | Yes | Budget is burned (over-counted) for one lane; no theft; conservative direction |
| Report a false "cancel landed" / "reverted" | Can only record evidence; cannot release budget | Release needs the **owner's** `confirm_release` after the owner checks Sepolia |
| Refuse to report / go offline | Yes | Reservation stays locked (honest, by design); owner can inspect and act |
| Attest a hash the contract did not sign | No | The contract matches reports against hashes it signed |
| Cause an immediate double spend alone | No | Needs the owner key too (two-key release) |

Residual: if the owner confirms a release on a false claim, the original can still land afterwards; the contract records the contradiction and freezes the task. Anyone can broadcast the original at any time from the public `get_signed_tx` view. EVM recipients are **EOA only** in v1 (a 21000-gas send to a contract reverts; the relayer warns when `eth_getCode(to)` is non-empty). Never mainnet.

## What it checks before acting

- It **validates, never re-encodes**: `keccak256(raw) == tx_hash`, the recovered signer is the lane address, chain id is 11155111, and nonce/`to`/`value` match the view. Anything else is logged as an `anomaly` and never broadcast.
- It attests only at **Finalized**: the receipt block is at or below the `finalized` head **and** the block hash re-fetched now equals the receipt's. `Safe` is never reported (it changes no contract state); there is no knob for it. Sepolia lags about 19 minutes behind head, so expect 20-25 minutes from broadcast to settlement.
- Release evidence (a landed cancel, a reverted original, with or without a cancel) is attested only when a second, independent RPC agrees: same status, same block hash, and that block at or below the second RPC's own `finalized` head. With only `EVM_RPC_URL` configured it is **not attested at all** (warn `evidence_needs_second_rpc`) unless the operator sets `RELAYER_ALLOW_SINGLE_RPC_EVIDENCE=1`, which makes the one provider a trusted witness. A success receipt needs no second RPC.
- Broadcast outcomes: "already known" and "nonce too low" lead to receipt checks, never to failure; unclassified errors are `Unknown` and resolved by receipt/nonce lookup.
- If the sender's nonce is consumed at `finalized` but neither the original nor the cancel has a receipt, it logs `anomaly` and stops acting on that commitment, but only once that is confirmed: every other configured RPC must say the same, or, with one RPC, the condition must hold on 3 consecutive ticks (`nonce_unconfirmed` counts the earlier ones). The stop is re-evaluated every tick and clears (`anomaly_cleared`) if the condition goes away, so a late receipt is still attested. A broadcast that returns a different hash than the contract signed is the one permanent stop.
- Reads are bounded: ids are discovered 4 at a time through `get_commitment` (a restart still reads each id once), then every live id costs one `get_signed_tx` per tick; terminal ids and lane addresses are never read again.
- `cancel` resolves an uncertain `request_cancel` by polling `get_signed_tx` at optimistic finality (the pinned final view lags a send), never by resending. Exit 0 = the cancel is on chain, 1 = refused, 3 = unresolved (run `status` before running it again).
- `mark_unknown` is sent only when NEAR time (block timestamp) minus `signed_at_ns` reaches the contract's `min_unknown_age_ns` (a `Reserved` commitment: `reserved_ambiguous_min_age_ns`).

## Not covered

- The relayer does not watch `Cancelled` commitments for a late original. The contract handles that case (the `Cancelled -> Confirmed` edge records the spend and freezes the task if it is over cap; sandbox-tested), but nothing here looks for it, and it was not demonstrated live.
- One in-flight payment per derived address, and attestation waits for `finalized`: about one payment per 15 minutes per delegate (observed 14 to 15 minutes from broadcast to attestation).
- A single cancel. If the cancel is itself stuck, the commitment stays `Unknown` with its budget locked; escalation is roadmap.
- A relayer that goes offline stalls reporting; it cannot release budget (only the owner's `confirm_release` does).
- Live runs against Sepolia and the real signer, with transaction references, are in the root `README.md` ("EVM path (stretch)").

## Environment

| Variable | Meaning |
|---|---|
| `EVM_RPC_URL` | Sepolia JSON-RPC, https only. Wrapped as a secret (provider URLs embed API keys). |
| `EVM_RPC_URL_2` | Second independent Sepolia RPC. Required for release evidence (cancel landed / original reverted) to be attested. |
| `RELAYER_ALLOW_SINGLE_RPC_EVIDENCE` | `1` to attest release evidence on the single configured RPC's word (logged at startup). Unset or `0`: withheld. |
| `EVM_PURSER_CONTRACT_ID` | The EVM-enabled Purser deployment (not the demo `PURSER_CONTRACT_ID`). |
| `RELAYER_ACCOUNT_ID` | Must equal the contract's `get_relayer`. |
| `RELAYER_PRIVATE_KEY` | The relayer's NEAR function-call key `ed25519:...`; only `attest_external`, `mark_unknown`, `request_cancel`. |
| `NEAR_NETWORK` | Must be `testnet`. |
| `NEAR_RPC_URL` | Default `https://test.rpc.fastnear.com`. |
| `OPERATOR_ACCOUNT_ID` | Optional; the relayer refuses to start if it equals `RELAYER_ACCOUNT_ID`. |
| `RELAYER_POLL_MS` | Optional poll interval, default 15000. |

The contract has no owner view; `set_relayer` already refuses `relayer == owner`, so the startup check is `get_relayer == RELAYER_ACCOUNT_ID` plus the optional operator comparison.

## Run

From the repo root (reads `.env` and `.env.testnet`):

```sh
make relayer                                          # the loop
pnpm --filter @purser/relayer run cli relay --once    # one pass
pnpm --filter @purser/relayer run cli status          # states + https://sepolia.etherscan.io/tx/<hash> links
pnpm --filter @purser/relayer run cli cancel <cid> --max-fee <wei> --tip <wei>
```

`cancel` only calls `request_cancel` (allowed once, from `Unknown`); the running loop then broadcasts the signed cancel and attests the result. The owner then runs `confirm_release`. Logs are JSON lines on stderr from a closed event set; errors are logged by class only and RPC URLs appear as `provider#N`.

## Tests

`make test` runs the network-free unit project: broadcast-error fixtures per client, the `decide` reducer, `verifyRaw` field tables, a canary URL/key scrub test driven through the real viem adapter, the bigint round trip, a fake-chain sim (instant-mine happy path; stuck, `mark_unknown`, cancel, cancel attested), adversarial sims through the real adapter against a local JSON-RPC stub (reverted receipt, two RPCs disagreeing, reorg guard, transient missing receipt), a view-call budget per tick, cancel resolution, and a recursive banned-API/allow-list scan of `src/`.
