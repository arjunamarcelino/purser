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
- Release evidence (a landed cancel, a reverted original) needs a second, independent RPC to agree when `EVM_RPC_URL_2` is set; otherwise it logs `single_rpc_evidence` and acts on one RPC.
- Broadcast outcomes: "already known" and "nonce too low" lead to receipt checks, never to failure; unclassified errors are `Unknown` and resolved by receipt/nonce lookup.
- If the sender's nonce is consumed at `finalized` but neither the original nor the cancel has a receipt, it logs `anomaly` and stops acting on that commitment (pruned RPCs can cause false positives; investigate by hand).
- `mark_unknown` is sent only when NEAR time (block timestamp) minus `signed_at_ns` reaches the contract's `min_unknown_age_ns` (a `Reserved` commitment: `reserved_ambiguous_min_age_ns`).

## Environment

| Variable | Meaning |
|---|---|
| `EVM_RPC_URL` | Sepolia JSON-RPC, https only. Wrapped as a secret (provider URLs embed API keys). |
| `EVM_RPC_URL_2` | Optional second independent Sepolia RPC for release evidence. |
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

`make test` runs the network-free unit project: broadcast-error fixtures per client, the `decide` reducer, a canary URL/key scrub test, the bigint round trip, a fake-chain sim (instant-mine happy path; stuck, `mark_unknown`, cancel, cancel attested), and the viem adapter against a local HTTP stub.
