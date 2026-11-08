# Purser EVM path: live testnet evidence

Moved out of the README to keep it scannable. Every reference below is a transaction on NEAR testnet or Sepolia
that you can open; nothing here is mainnet. The trust model and limits of the EVM path are in the README section
"EVM path (stretch)".

## Live evidence (NEAR testnet + Sepolia)

Contract `purser2.arjuna-purser.testnet`, relayer `relayer2.arjuna-purser.testnet`, delegate
`evmscout.arjuna-purser.testnet`, lane address `0x7f6f3d4b8c67acd84e05df8fc74bb115154e64ac`.

| Step | Reference |
|---|---|
| Payment 1 (settled): NEAR `propose_payment` | [testnet tx](https://testnet.nearblocks.io/txns/523rR74zoyjFDKCKeeWNXUPTvKKmw8SBbunVoPuCj915) |
| Payment 1: Sepolia transfer (nonce 0, block 12071752) | [Sepolia tx](https://sepolia.etherscan.io/tx/0xbf264ff1f43e37336d09f92304785047f67af9f9bedefc32e5ed93e9b818eb12) |
| Payment 1: `attest_external` (Confirmed) | [testnet tx](https://testnet.nearblocks.io/txns/6G9HeGbTD4LGyYDBtTj7uhcMCquJzhgpacX2GraxC91y) |
| Payment 2 (stuck, cancelled, released): `set_evm_cfg`, fee ceiling set to 1 wei | [testnet tx](https://testnet.nearblocks.io/txns/5qx3BdfwR2LTKQFYcVLvphGp8f33EVhvZh4tntHizb2b) |
| Payment 2: `propose_payment` (nonce 1, unminable at that fee, rejected by both RPCs, never mined) | [testnet tx](https://testnet.nearblocks.io/txns/2n8eifrbKzgahkxK5yoWwK6TzgEHEejqbgY2yu6NR5iE) |
| Payment 2: original hash (never on Sepolia) | `0x8434936e9abcadb5d36aad62156c58589dc49ad6f7d3851321d6a0cfa1203b84` |
| Payment 2: `set_evm_cfg`, fee ceiling raised to 2 gwei | [testnet tx](https://testnet.nearblocks.io/txns/2kiFJK6yvSMbLWgYSLXQq5sW4zYaEtaCvrfifJPAbiPy) |
| Payment 2: cancel (0-value self-send, nonce 1, block 12073381) | [Sepolia tx](https://sepolia.etherscan.io/tx/0x4455c91e7861588aa5663d25ca729fb277cdded585fcb11cd952a5723e34aa46) |
| Payment 2: owner `confirm_release` (Unknown to Cancelled) | [testnet tx](https://testnet.nearblocks.io/txns/J36miiF5cmmPpUiQGNZucdi62L7dWgTmqoBCEZzTUFDV) |

Payments 1 and 2 ran on the first deployed wasm (code hash `398d9ed6…364dd`). Code review then changed the
contract (a retryable cancel slot, idempotency set on `mark_unknown` from `Reserved`, tests), so `purser2` was
upgraded in place to code hash `9d46e69d…a44b` (state kept; no storage layout change) and the stuck-cancel-release
path was run again as payment 3. The `mark_unknown` and `request_cancel` hashes of payment 2 were not captured.

| Step (payment 3, on the fixed code) | Reference |
|---|---|
| `set_evm_cfg`, fee ceiling set to 1 wei | [testnet tx](https://testnet.nearblocks.io/txns/3XkG41Zu23DiT5K1rSHperxBW5mxnbNYPQqqc6HivoGs) |
| `propose_payment` (commitment 2, nonce 2, unminable, rejected by both RPCs on every retry, never mined) | [testnet tx](https://testnet.nearblocks.io/txns/7q9VXWcMUDSeMqUUNJ7wkU9623SaPT2zB1PkuaCHcj91) |
| Original hash (never on Sepolia) | `0x5d8f4b3c2c4ea28339639bd76fc030b5e6c86df552ae2dfaf899eb3335105e2e` |
| Relayer `mark_unknown` (Signed to Unknown; reservation held) | [testnet tx](https://testnet.nearblocks.io/txns/ZJmD1LkfbMPHpbQkzQ1NAxkVu35T8G3PTUcVZY8fRtK) |
| `set_evm_cfg`, fee ceiling raised to 2 gwei / 1 gwei | [testnet tx](https://testnet.nearblocks.io/txns/GJ4MsCu8APedg8dKbeBVKH1tEiSTajATAa6cm3Qo52xe) |
| `request_cancel` | [testnet tx](https://testnet.nearblocks.io/txns/5JA75B9unGETX6pVSLiqbdAi5sZGg6XqNFVmnUME2bHG) |
| Cancel (0-value self-send, nonce 2, block 12074022) | [Sepolia tx](https://sepolia.etherscan.io/tx/0x4ab1bca17946f38ada9f9c277414b203447e8982f3e9d432ad512fc56ee96b35) |
| Relayer `attest_external` (cancel landed, finalized; evidence only, nothing released) | [testnet tx](https://testnet.nearblocks.io/txns/BkB7V6Z5pAb8k8iz7kTw2CD7NojWXH8tkFr7yNkywEdH) |
| Owner `confirm_release` (Unknown to Cancelled) | [testnet tx](https://testnet.nearblocks.io/txns/1RmTRskeFaeQFhK1hU5Hhv7MvVSSAeFoW4szz1ymd8B) |

Final state: commitment 0 Confirmed, commitments 1 and 2 Cancelled; completed 1e12, outstanding 0, the
invariant holds, lane nonce 3. While each stuck payment waited, the contract kept its reservation
(`outstanding` 1e12) and the cancel attestation released nothing; only the owner's `confirm_release` did.
Both cancel receipts report `gasUsed` 12000 with status success; that figure is unexplained and is reported
as observed (a plain 21000-gas self-send would normally report 21000).

To reproduce: `scripts/evm-testnet.sh deploy`, fund the printed Sepolia address from a faucet by hand,
`status`, `make relayer`, then `propose`. For the stuck path use `set-ceiling` to set a ceiling below the base
fee, `propose`, then raise the ceiling, ask the relayer for the cancel (`pnpm --filter @purser/relayer run cli
cancel <cid> ...`) and finish with `confirm-release <cid>`. The relayer needs `EVM_RPC_URL` (https; for
example `https://rpc.example.invalid`, a placeholder), optionally `EVM_RPC_URL_2`, `EVM_PURSER_CONTRACT_ID`,
`RELAYER_ACCOUNT_ID` and `RELAYER_PRIVATE_KEY`. The deploy script writes the last three into the gitignored
`.env.testnet`. Details: [`relayer/README.md`](relayer/README.md), `.env.example`.
