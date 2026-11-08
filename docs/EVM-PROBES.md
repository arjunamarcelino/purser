# EVM path: Phase 0 probes (2026-11-06, read-only)

Everything here is a read-only call: NEAR testnet views and Sepolia JSON-RPC reads. No transactions, no signing.

## 1. v1.signer-prod.testnet views (`https://test.rpc.fastnear.com`, finality `final`)

```sh
view() { # method, args-json
  a=$(printf '%s' "$2" | base64 | tr -d '\n')
  curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d \
   "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",
     \"account_id\":\"v1.signer-prod.testnet\",\"method_name\":\"$1\",\"args_base64\":\"$a\"}}"
}   # result.result is a byte array of the JSON answer
view version '{}'
view config '{}'
view public_key '{"domain_id":0}'
view derived_public_key '{"path":"x","predecessor":"purser.arjuna-purser.testnet","domain_id":0}'
```

| View | Answer |
|---|---|
| `version` | `"3.18.0"` |
| `config` | `sign_call_gas_attachment_requirement_tera_gas` 15, `return_signature_and_clean_state_on_success_call_tera_gas` 7, `fail_on_timeout_tera_gas` 2, `key_event_timeout_blocks` 150 (a keygen/resharing setting, not the sign yield timeout) |
| `public_key({"domain_id":0})` | `secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3` |
| `derived_public_key(x, purser.arjuna-purser.testnet, 0)` | `secp256k1:67756ZjiVxANYvYhQagGaWj2APpo1C1UMq2ebVWoy3GMU3zmYaM9ho6DNyDxRjo1Uzo2UDMkmeutgZFKQhgpnd1W` |

Four calls with 2 s sleeps: no 429 from fastnear.

## 2. Independent derivation: MATCHES the view

`tweak = SHA3-256("near-mpc-recovery v0.1.0 epsilon derivation:" + predecessor + "," + path)`, `derived = root + tweak*G`,
done in scratch with `@noble/curves` 2.4.0 + `@noble/hashes` 2.4.0 + `bs58` (`npm install --ignore-scripts`), no code from near/mpc.

- tweak (hex): `601cf0af933f644cd9c4ebf85a89d98ea1e2ff31a12e4991eabcf4cf6f12ac18` (< n, so the mod-n reduction is a no-op here)
- computed derived key: `secp256k1:67756Zji...Uzo2UDMkmeutgZFKQhgpnd1W`, **byte-identical to the signer's view: yes**
- derived EVM address (last 20 bytes of keccak256 of the 64-byte key): `0x0f3798297b9500b6c63ecc6c8101a7d6fae81e02`
  (Sepolia: nonce 0 at `finalized`, i.e. an unused address)

The same vector is asserted in the mock-signer's host tests (`derivation_matches_the_real_signer_vector`,
`evm_address_of_the_real_vector`), using the real root public key above as input.

## 3. Sepolia (`https://ethereum-sepolia-rpc.publicnode.com`, anonymous)

```sh
U=https://ethereum-sepolia-rpc.publicnode.com
rpc() { curl -s $U -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"; }
rpc eth_chainId '[]'
rpc eth_getBlockByNumber '["finalized",false]'
rpc eth_getBlockByNumber '["latest",false]'
rpc eth_feeHistory '["0xa","latest",[10,50,90]]'
rpc eth_maxPriorityFeePerGas '[]'
rpc eth_getTransactionCount '["0x0f3798297b9500b6c63ecc6c8101a7d6fae81e02","finalized"]'
```

- `eth_chainId` = `0xaa36a7` (11155111). OK.
- **`finalized` tag is supported** (both for `eth_getBlockByNumber` and `eth_getTransactionCount`).
- Finalized lag at probe time: latest `0xb8319a`, finalized `0xb8313c` = **94 blocks, 1164 s (about 19.4 min)** behind. Budget 20-25 min for time-to-`finalized`.
- Fees (10 blocks): **base fee 18 wei (0x12) and flat across the window**; gas used ratio 0.31-0.41. Priority-fee rewards per block (p10/p50/p90):
  mostly `0xf4240` (1,000,000 wei = 0.001 gwei) / `0x3b9ac9ee` (999,999,982 wei, about 1 gwei), p10 occasionally as low as 3-4 wei, one block p10 at 0x2faf080 (50 mwei).
  `eth_maxPriorityFeePerGas` = `0x3` (3 wei). Blob base fee 1-2 wei.
- 429 behavior: 25 back-to-back `eth_blockNumber` calls: all HTTP 200, no 429 seen. Limits not found; the plan should still keep the backoff.

## Surprises and plan implications

1. **Wei-scale fees make the 12.5% bump rounding load-bearing.** With base fee 18 wei and a 3 wei priority suggestion, `ceil(x * 1.125)` must be on integers
   and checked against the 10% both-fields rule: 3 wei -> 4 wei (+33%), 18 -> 21. A naive `x * 9 / 8` floor would give 3 -> 3 and fail replacement. Use ceil division, and
   test tiny values (1, 2, 3, 8, 9, 18).
2. Choose `maxPriorityFeePerGas` from `eth_feeHistory`/`eth_maxPriorityFeePerGas` with a floor (for example 1 gwei) so a payment does not stall on a 3 wei tip;
   Sepolia blocks are cheap, so a 1 gwei tip costs ~21k gwei = 0.000021 ETH per transfer.
3. `config.key_event_timeout_blocks` (150) is NOT the sign yield timeout; the plan's "~200-block timeout, unverified" stays unverified by these probes.
4. Dependency finding for the contract (not a probe): `env::ecrecover` is behind near-sdk's `unstable` feature. The contract's `Cargo.toml` currently carries
   `features = ["unstable"]` in the working tree; the CI lock-step `pin()` regex only matched the string form `near-sdk = "=x"`, so it was widened to read the first
   `near-sdk` line in either form.
5. Nothing contradicts the plan's Verified facts: signer version, 15 Tgas requirement, 7 Tgas yield callback, derivation formula, test vector and EVM address derivation all confirmed.

## Measured gas and size

Method: `contract/tests/evm.rs::the_gas_budgets_hold_with_headroom_and_are_measured`. near-workspaces sandbox, the production wasm plus the
mock signer. `gas_burnt` is read per receipt, and each receipt is picked by a marker (a NEP-297 event in its logs, its executor account, or
"the receipt whose child is the signer's sign receipt"), never by position; the test fails if a marker matches zero or several receipts.
Both crews are created by the same `evm_setup`, so account names have the same shape.

| Receipt | gas_burnt |
|---|---|
| `propose_payment`, EVM arm (synchronous part up to the sign promise) | 3.75 Tgas |
| mock signer `sign` (synchronous mock, k256 compiled to wasm) | 12.07 Tgas |
| `on_signed`, `Ok` (one `ecrecover`, store, event) | 3.00 Tgas |
| `on_signed`, `Err` -> Unknown | 2.52 Tgas |
| `request_cancel` (synchronous part) | 2.74 Tgas |
| `on_cancel_signed`, `Ok` | 2.44 Tgas |
| `attest_external` (Original, success, Finalized -> Confirmed) | 2.91 Tgas |
| `attest_external` (recovery signature: two `ecrecover` plus tx hashing, `Unknown` -> `Confirmed`) | 3.27 Tgas |
| `cache_derived_key` (synchronous part) | 2.56 Tgas |
| mock signer `derived_public_key` (mock view, not the real signer) | 9.10 Tgas |
| `on_derived_key` (base58/key parse, cache, lane) | 1.91 Tgas |

Caveat for the signer row: the REAL signer yields and resumes, so this mock under-measures it, and the 12 Tgas is the mock's k256 cost, not the
MPC network's. What the real signer needs is known from its live config, not from this table: >= 15 Tgas prepaid, of which it reserves 7 Tgas for
its yield callback (plus about 2 Tgas of its own). The real signer's gas is recorded below.

### Real signer gas, from live txs

Read-only `tx` RPC (`https://test.rpc.fastnear.com`, `wait_until: FINAL`), `gas_burnt` summed per receipt by executor and method, 2026-11-06. Contract
`purser2.arjuna-purser.testnet`, signer `v1.signer-prod.testnet`. The relayer-side `attest_external` was never run live with a recovery
signature (the live demo never lost a signature), so that row exists only in the sandbox table above.

| Receipt (executor : method) | propose tx `523rR74z...` | propose tx `2n8eifrb...` | `cache_derived_key` tx `86MVT2NV...` |
|---|---|---|---|
| purser2 : `propose_payment` (sync part, to the sign promise) | 3.935 Tgas | 3.942 Tgas | |
| signer : `sign` (yield) | 4.273 Tgas | 4.272 Tgas | |
| signer : `return_signature_and_clean_state_on_success` (resume) | 3.463 Tgas | 3.463 Tgas | |
| purser2 : `on_signed` (Ok: `ecrecover`, store, event) | 3.144 Tgas | 3.155 Tgas | |
| purser2 : `cache_derived_key` (sync part) | | | 2.578 Tgas |
| signer : `derived_public_key` | | | 5.372 Tgas |
| purser2 : `on_derived_key` | | | 1.966 Tgas |
| signer round trip (sign + resume) | 7.736 Tgas | 7.735 Tgas | |
| whole tx, incl. 0.32 Tgas tx conversion and the refund receipts (0.223 each) | 16.03 Tgas | 16.04 Tgas | 10.90 Tgas |

Transactions: `523rR74zoyjFDKCKeeWNXUPTvKKmw8SBbunVoPuCj915` and `2n8eifrbKzgahkxK5yoWwK6TzgEHEejqbgY2yu6NR5iE` (`propose_payment` by
`evmscout.arjuna-purser.testnet`), `86MVT2NVN4VTXp1DQ49QWwbmdRMemgskHX4cah68Zgxb` (`cache_derived_key` by `arjuna-purser.testnet`).
`on_cancel_signed` runs the same code shape as `on_signed` and was not run live. The recorded `gas_burnt` is what the receipts consumed, not what
was attached, so it can be compared directly with the constants.

| Constant | Value | Real burn | Headroom | Verdict |
|---|---|---|---|---|
| `SIGN_GAS` | 50 Tgas | 7.74 Tgas (sign + resume) | 6.5x | kept; the signer demands >= 15 attached |
| `ON_SIGNED_GAS` | 30 Tgas | 3.15 Tgas | 9.5x | kept |
| `EVM_MIN_PREPAID` | 100 Tgas | `2 x 3.94 + 50 + 30 = 87.9` | fits | kept |
| `KEY_VIEW_GAS` | 15 Tgas | 5.37 Tgas | 2.8x | kept (above the 2x floor) |
| `KEY_CALLBACK_GAS` | 10 Tgas | 1.97 Tgas | 5.1x | kept |

Every constant already had at least 2x headroom over the live numbers, so none changed; the code comments no longer say PROVISIONAL and now cite
these measurements. The gas test asserts the 2x floor against these live numbers (as constants with this table as their source).

### Recommended constants (all kept as they are; none needs a change)

| Constant | Value | Measured floor | Headroom | Why |
|---|---|---|---|---|
| `ON_SIGNED_GAS` (also `on_cancel_signed`) | 30 Tgas | 3.00 Tgas | 10x | Could drop to 15 Tgas (5x), but unused attached gas is refunded and a callback that runs out of gas after the signer answered strands the commitment in `Reserved` until the 1 h `mark_unknown`. The saving is not worth that tail risk. |
| `SIGN_GAS` | 50 Tgas | 7.74 Tgas on the live signer (see above) | 6.5x; 3.3x the signer's 15 Tgas minimum | Real signer: 15 Tgas floor, 7 + 2 Tgas reserved for its yield callback. |
| `EVM_MIN_PREPAID` | 100 Tgas | needs `2 x 3.75 + 50 + 30 = 87.5` | 1.14x on the whole sum, 2x on the synchronous part | The prepaid gas has to fund both attached budgets plus the call's own execution. |

`the_gas_budgets_hold_with_headroom_and_are_measured` fails if `on_signed` or `on_cancel_signed` burn more than half of `ON_SIGNED_GAS`, if
`2 x propose_sync + SIGN_GAS + ON_SIGNED_GAS` (or the same for `request_cancel`) exceeds `EVM_MIN_PREPAID`, or if any of `SIGN_GAS`, `ON_SIGNED_GAS`, `KEY_VIEW_GAS`, `KEY_CALLBACK_GAS` falls below twice the live-measured burn above. Lowering a constant therefore needs a re-measurement, not just an edit.

### Wasm size

Default no-ABI wasm: 248,081 bytes before the EVM path (spike era, `docs/EVM-SPIKE.md`), 353,741 bytes now (+105,660, +42.6%). Profiling
had to be done by ablation because `cargo near build` strips function names (no twiggy / wasm-opt / wasm-tools here): the pre-optimisation
wasm has 2,019 functions averaging about 200 bytes, no function above 6 KB.

| Experiment (size-only builds into a scratch target dir) | Result |
|---|---|
| `serde_json::Value` + `json!` -> typed structs for the two signer callbacks | +1.7 KB (typed Deserialize derives cost more than `Value`, which near-sdk already links) |
| `near_sdk::PublicKey` / bs58 parse of the signer's key stubbed out | -3.5 KB |
| drop the `unstable` near-sdk feature (stub `env::ecrecover`) | -0.6 KB |

No single contributor above about 4 KB: the growth is the new surface (18 new exports with their JSON/Borsh glue, 10 new event
variants, 4 new store collections, the view DTOs, the encoder and fee math), spread across the long tail. No low-risk fix was applied; the
cheap candidates cost more than they save or change the callback totality that the host tests pin.
