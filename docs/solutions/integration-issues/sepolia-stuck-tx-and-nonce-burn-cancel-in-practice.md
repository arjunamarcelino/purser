---
title: "Making a Sepolia transaction genuinely stuck and cancelling it with a nonce-burn: what the nodes actually did"
category: integration-issues
date: 2026-11-06
tags: [sepolia, eip-1559, nonce-burn, replacement-transaction, finality, relayer, rpc, purser]
module: relayer/src/{worker,evm}.ts, scripts/evm-testnet.sh, contract/src/evm_tx.rs
symptom: "To demonstrate reclaim you need an unminable original and a cancel that replaces it. The plan assumed 'price the original below the base fee, then cancel at +12.5%'. The contract prices originals AT the fee ceiling, so a valid cancel did not exist until the owner raised the ceiling."
root_cause: "A cancel must be at least ceil(1.125 x original) on both fee fields and at most the ceiling. With the original at the ceiling, no value satisfies both. Sepolia's base fee is tiny, so only a deliberately tiny fee cap is unminable."
status: resolved
verified: true
---

# What happened on real nodes (2026-11-06, two runs)

## Make the original unminable

- Sepolia base fee was about 18 wei and flat. A **1 wei** max fee is below it.
- Both public RPCs (publicnode, Tenderly) answered the broadcast with an underpriced error. The original **never entered any
  mempool**; `eth_getTransactionByHash` returned null on both runs. The relayer re-broadcast every 60-72 s and got the
  same answer each time. Treat "Underpriced" as pending-and-unresolved, not as failure, and not as proof of non-landing.
- Fee bump rounding matters at wei scale: a floored `x * 9 / 8` leaves 3 wei at 3 wei, which fails geth's 10 % replacement
  rule on both fields. Use ceiling division on **both** `maxFeePerGas` and `maxPriorityFeePerGas`.

## The demo order that works

1. Owner `set-ceiling 1 1` (max fee 1 wei, tip 1 wei). 2. Propose: the original is signed at that price and cannot mine.
3. Relayer `mark_unknown` after the 5-minute floor; the reservation stays held. 4. Owner `set-ceiling 2000000000 1000000000`.
5. `request_cancel` at those fees (>= 1.125x the original, <= the new ceiling). 6. The cancel mines within seconds.
7. The relayer attests it only at `finalized` (evidence only). 8. Owner `confirm-release`.

Lowering the ceilings later re-strands an `Unknown` commitment, and the owner's raise also raises the fee burn for later originals.
Pricing the original at a fraction of the ceiling would remove the raise step (a design option, deferred as todo 035).

## Observations worth keeping

- The cancel was accepted by the first RPC and **pending** on the second right after broadcast; it mined in the next blocks
  (effective gas price about 1.000000015 to 1.000000022 gwei).
- Cancel receipts reported **`gasUsed` 12000**, status success, for a 0-value self-send. A plain self-send normally costs 21000.
  Unexplained, recorded as observed; do not hard-code 21000 as the receipt's gas for a cancel.
- `finalized` took about 14 to 15 minutes after broadcast (14m43s and 13m52s). The earlier 19-minute reading was the lag
  of `finalized` behind `latest`. Attest only when receipt block <= finalized block **and** the re-fetched block hash equals
  the receipt's hash.
- Second RPC choice: `sepolia.gateway.tenderly.co` and `1rpc.io/sepolia` supported the `finalized` tag; `sepolia.drpc.org`
  returned no chain id and no finalized block; `rpc.sepolia.org` returned nothing. Probe `eth_chainId` and
  `eth_getBlockByNumber('finalized')` before relying on a provider.
- The lane address's finalized nonce after payment 1, the cancel of payment 2 and the cancel of payment 3 was 3: nonces 0, 1, 2 consumed.

## Related

- [`mpc-signer-err-is-not-proof-of-no-signature`](../security-issues/mpc-signer-err-is-not-proof-of-no-signature.md)
- [`near-api-js-7-rate-limited-public-rpc-board-freeze.md`](near-api-js-7-rate-limited-public-rpc-board-freeze.md)
- `README.md` "Live evidence", `docs/EVM-PROBES.md`
