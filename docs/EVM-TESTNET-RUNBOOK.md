# EVM path: testnet runbook (NEAR testnet + Sepolia only)

`scripts/evm-testnet.sh` stands up a FRESH contract (`purser2.<operator>`) beside the existing demo contract and never touches
`purser.<operator>`, `PURSER_CONTRACT_ID` or `make board`.

| Step | Command | Spends |
|---|---|---|
| Deploy + configure + cache lane key + seed nonce | `scripts/evm-testnet.sh deploy` | ~6.5 NEAR from the operator (3.67 NEAR is locked storage stake for the 366 KB wasm) |
| Fund the printed Sepolia address | faucet (by hand) | ~0.002 Sepolia ETH |
| Check readiness | `scripts/evm-testnet.sh status` | nothing |
| Run the relayer | `make relayer` (needs `EVM_RPC_URL`, see below) | NEAR gas for attestations |
| One payment as the delegate | `scripts/evm-testnet.sh propose [--value-wei N] [--to 0x..]` | value + fee on Sepolia |
| Change the fee ceilings (owner) | `scripts/evm-testnet.sh set-ceiling <maxFeeWei> <tipWei>` | NEAR gas |
| Release an Unknown commitment (owner) | `scripts/evm-testnet.sh confirm-release <cid>` | NEAR gas |

Idempotent: each step reads chain state and skips what is done. A failure prints the NEAR tx hashes that landed (also appended to
`.near-keys/evm-txs.log`). Writes are never retried blindly; reads back off on 429.

## What actually ran (2026-11-06)

Accounts: contract `purser2.arjuna-purser.testnet`, relayer `relayer2`, delegate `evmscout`; lane address
`0x7f6f3d4b8c67acd84e05df8fc74bb115154e64ac`.

1. **Payment 1, settled.** `propose`, then the relayer broadcast the contract-signed transaction and attested it at `finalized`.
   NEAR propose https://testnet.nearblocks.io/txns/523rR74zoyjFDKCKeeWNXUPTvKKmw8SBbunVoPuCj915 ;
   Sepolia https://sepolia.etherscan.io/tx/0xbf264ff1f43e37336d09f92304785047f67af9f9bedefc32e5ed93e9b818eb12 (nonce 0, block 12071752) ;
   `attest_external` https://testnet.nearblocks.io/txns/6G9HeGbTD4LGyYDBtTj7uhcMCquJzhgpacX2GraxC91y .
2. **Payment 2, stuck, cancelled, released.** To make a payment that cannot mine, the fee ceiling was set to 1 wei
   (`set-ceiling`; https://testnet.nearblocks.io/txns/5qx3BdfwR2LTKQFYcVLvphGp8f33EVhvZh4tntHizb2b), then `propose` (nonce 1;
   https://testnet.nearblocks.io/txns/2n8eifrbKzgahkxK5yoWwK6TzgEHEejqbgY2yu6NR5iE). Both RPCs rejected the transaction; it never mined
   (original hash `0x8434936e9abcadb5d36aad62156c58589dc49ad6f7d3851321d6a0cfa1203b84`). The ceiling was raised to 2 gwei
   (https://testnet.nearblocks.io/txns/2kiFJK6yvSMbLWgYSLXQq5sW4zYaEtaCvrfifJPAbiPy). The commitment went `Unknown` (`mark_unknown`),
   one cancel was requested (`request_cancel`) and broadcast: a 0-value self-send at nonce 1, block 12073381
   https://sepolia.etherscan.io/tx/0x4455c91e7861588aa5663d25ca729fb277cdded585fcb11cd952a5723e34aa46
   (`gasUsed` 12000, unexplained; receipt status success). The owner then ran `confirm-release`
   https://testnet.nearblocks.io/txns/J36miiF5cmmPpUiQGNZucdi62L7dWgTmqoBCEZzTUFDV .
   **The NEAR tx hashes of `mark_unknown` and `request_cancel` were not captured.**
3. **Final state.** Commitment 0 Confirmed, commitment 1 Cancelled; completed 1e12, outstanding 0, invariant holds, lane nonce 2.

Not run live: a late original landing after a cancel (the contract's `Cancelled -> Confirmed` edge is sandbox-tested only).

3. **Redeploy, then payment 3 (the same stuck-cancel-release path on the fixed code).** Code review changed the contract
   (retryable cancel slot, idempotency on `mark_unknown` from `Reserved`), so `purser2` was upgraded in place with
   `near contract deploy ... without-init-call` (no layout change; state kept). Immediately before: `scripts/check-wasm-clean.sh`
   on the wasm; after: the on-chain code hash equals the local wasm sha256 (`9d46e69d...a44b`; the first deploy was `398d9ed6...364dd`).
   Then: `set-ceiling 1 1` https://testnet.nearblocks.io/txns/3XkG41Zu23DiT5K1rSHperxBW5mxnbNYPQqqc6HivoGs ;
   `propose` (commitment 2, nonce 2, unminable) https://testnet.nearblocks.io/txns/7q9VXWcMUDSeMqUUNJ7wkU9623SaPT2zB1PkuaCHcj91
   (original `0x5d8f4b3c2c4ea28339639bd76fc030b5e6c86df552ae2dfaf899eb3335105e2e`, never on Sepolia) ;
   relayer `mark_unknown` https://testnet.nearblocks.io/txns/ZJmD1LkfbMPHpbQkzQ1NAxkVu35T8G3PTUcVZY8fRtK ;
   `set-ceiling 2000000000 1000000000` https://testnet.nearblocks.io/txns/GJ4MsCu8APedg8dKbeBVKH1tEiSTajATAa6cm3Qo52xe ;
   `request_cancel` https://testnet.nearblocks.io/txns/5JA75B9unGETX6pVSLiqbdAi5sZGg6XqNFVmnUME2bHG ;
   Sepolia cancel (nonce 2, block 12074022) https://sepolia.etherscan.io/tx/0x4ab1bca17946f38ada9f9c277414b203447e8982f3e9d432ad512fc56ee96b35 ;
   relayer `attest_external` (evidence only) https://testnet.nearblocks.io/txns/BkB7V6Z5pAb8k8iz7kTw2CD7NojWXH8tkFr7yNkywEdH ;
   owner `confirm-release 2` https://testnet.nearblocks.io/txns/1RmTRskeFaeQFhK1hU5Hhv7MvVSSAeFoW4szz1ymd8B .
   The first `confirm-release` attempt died on a transient NEAR RPC outage before sending anything; the retry landed. Final:
   commitments 1 and 2 `Cancelled`, `outstanding` 0, lane nonce 3.

Notes for the next run: `gh` flips to the `-orb` account between commands, so `gh auth switch -u arjunamarcelino` and the `gh`/`git push`
must be in the same command; the CI `secrets` job pins fake canary findings in `.gitleaksignore`
(see `docs/solutions/build-errors/gitleaks-and-precommit-flag-fake-canary-keys-in-scrubber-tests.md`).

## Environment

`.env.testnet` gets (merged, other lines kept): `EVM_PURSER_CONTRACT_ID`, `RELAYER_ACCOUNT_ID`, `RELAYER_PRIVATE_KEY`,
`EVM_DELEGATE_ACCOUNT_ID`, `EVM_DELEGATE_FC_PRIVATE_KEY`, `EVM_TASK_ID`, `EVM_DERIVATION_PATH`. The relayer key is a
function-call key limited to `attest_external, mark_unknown, request_cancel` on the EVM contract; the delegate key to `propose_payment`.
`scripts/deploy-testnet.sh` preserves `EVM_*` and `RELAYER_*` lines when it rewrites the file.

For `make relayer` also set `EVM_RPC_URL` (https only; a placeholder looks like `https://rpc.example.invalid`) and, optionally, `EVM_RPC_URL_2`
(a second independent Sepolia RPC; with it, release evidence needs both to agree). Values go in `.env` or `.env.testnet`, never in docs or git.

Verification built in: wasm gate re-run right before deploy and on-chain code hash compared after; the cached lane key is compared with the
signer's `derived_public_key` view and the Sepolia address is recomputed independently (in-script keccak256, self-tested against the
derivation vector in EVM-PROBES.md); the nonce is read from Sepolia `finalized` and refused when `pending` differs.
