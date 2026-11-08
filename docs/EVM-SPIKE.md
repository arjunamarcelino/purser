# EVM sighash feasibility spike

**Verdict: GO.** Purser can construct an EIP-1559 transaction, RLP-encode it and hash it **inside the
contract** well within NEAR size and gas limits. Every criterion that was fixed before measuring is met,
most by a wide margin. This answers one question only (see [What GO does not establish](#what-go-does-not-establish));
it does not mean the external-chain path is built or that the cross-chain claim is proven.

| | |
|---|---|
| Date | 2026-11-05 |
| Plan | `docs/plans/2026-11-05-feat-evm-sighash-feasibility-spike-plan.md` |
| Reproduce | `make evm-spike` (local + sandbox only, no network, no testnet) |
| Toolchain | rustc 1.95.0 (pinned), near-sdk 5.30.0, cargo-near 0.22.0, nearcore 2.14.0 sandbox (sha256-pinned by `scripts/sandbox-bin.sh`) |
| Reference | chainsig.js 1.1.16 (EVM `prepareTransactionForSigning`), viem 2.57.16 |

## Result against the pre-set criteria

The thresholds were written down before any measurement (plan, "Decision criteria").

| Criterion | GO if | Measured | |
|---|---|---|---|
| Correctness | sighash equals the chainsig.js/viem reference on every vector | **36 / 36** vectors, in the wasm (sandbox) and on the host; looped rounds N = 2, 3, 10 match an independent reference | ✅ |
| Sighash cost | ≤ 1 Tgas per hash | **0.0233 Tgas** (23.3 Ggas) per hash, 43× under the limit | ✅ |
| Load tax | sighash + extra load gas on `propose_payment` and on the callback stay inside their budgets with ≥ 50% headroom | `propose_payment` **+0.00273 Tgas** (3.055 → 3.058 of 50 Tgas); `on_near_settled` **+0.00271 Tgas** (2.080 → 2.082 of 10 Tgas). Headroom stays 94% and 79% | ✅ |
| Size | raw delta ≤ 25 KB | **+2,462 bytes (+0.99%)**, +1,097 gzipped | ✅ |
| Shipped wasm | default build and default ABI unchanged | **byte-identical** wasm (`89163ed6…`) and ABI (`893038c6…`) | ✅ |

Storage stake for the added 2,462 bytes is about 0.025 NEAR (10^19 yocto per byte). The load tax works out
to about 1.1 Mgas per added wasm byte, paid by every call to every method; it is negligible here.

## What was built

`contract/src/evm_spike.rs`, compiled **only** with the off-by-default `evm-spike` feature:

- `encode_unsigned` builds `0x02 ‖ rlp([chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas,
  gas_limit, to, value, data, access_list])` with `data` empty (`0x80`) and `access_list` empty (`0xc0`):
  exactly the native-transfer shape a payment needs. About 40 lines of RLP.
- `sighash` is `env::keccak256_array` of those bytes. **keccak256 is a NEAR host function**: it adds no wasm
  bytes, and on the runtime's published costs (≈ 5.9 Ggas base + 21.5 Mgas per byte) hashing a ≈ 90-byte
  payload is ≈ 8 Ggas of the measured 23.3 Ggas per iteration; the rest is the encoder and allocation.
- One raw `extern "C"` export (`evm_spike_sighash`), `wasm32` only, so a sandbox test can
  read gas. They are not `#[near]` methods: they take a fixed 96-byte binary input, are stateless, accept no
  deposit and make no promise.

Nothing in `propose_payment`, `open_reservation`, `payload_scheme()` or the `Chain::Evm` rejection changed.
`sighash` is `pub(crate)`, so nothing outside the crate can ask for a signable digest over caller-supplied
fields.

## How it was checked

**Correctness (three independent oracles).**

1. 36 vectors generated with the **real chainsig.js EVM adapter** (`prepareTransactionForSigning` =
   `viem.serializeTransaction` → `keccak256`), asserted equal to viem used directly. 12 named edge cases
   (zero, 127/128, 255/256, max safe-integer chain id and nonce, max u64 gas, max u128 fees and value, leading
   and trailing zero bytes in `to`, Sepolia and mainnet chain ids) and 24 deterministic pseudo-random ones.
   The encoded transactions run 33–84 bytes (list payloads of 32–82 bytes), so both list-header forms are
   exercised. The viem vectors are all valid transactions: none has a tip above the fee cap, a zero chain id,
   a zero gas limit or a zero `to` (viem rejects the first; the others are valid encodings but not valid
   payments). The `rlp`/`sha3` tests do cover the zero cases as encodings.
2. The parity `rlp` crate (`=0.6.1`) for the bytes and `sha3` (`=0.10.8`) for the hash: integer boundaries
   across the full `u64`/`u128` range and a 2,000-case property test.
3. The wasm itself, in the sandbox, against the same vectors.

**Gas.** Sandbox, receipt-level `gas_burnt` (not `total_gas_burnt`, which also counts the tx-to-receipt
conversion and refunds). The loop makes every round a different input (nonce increments, previous digest
folded into `value`, `black_box`) so the optimizer cannot hoist it.

| N | receipt gas (Tgas) |
|---|---|
| 1 | 1.217528 |
| 10 | 1.426352 |
| 100 | 3.514591 |
| 1000 | 24.501836 |

Slope (per hash): 0.023202 (10→100), 0.023319 (100→1000), 0.023308 (1→1000) Tgas: linear to within 0.5%, so
the loop was not folded. The fixed cost is 1.194 Tgas (the fit's intercept: receipt, contract load, input
parsing, the marker log), about 51 times the cost of one hash, so almost none of a single call is hashing. N = 1000 (24.8 Tgas total) fits a 300 Tgas transaction.

**Load tax.** The same `propose_payment` flow on the default wasm and on the spike wasm with the feature
unused, under **identical fixed account names** (`purser.test.near`, …). Random dev-account names first made
the figure noisy: events embed account ids and logs are charged per byte, so name length leaked into the
difference. With fixed names the tax is exact and identical in every round.

| | default | evm-spike | delta |
|---|---|---|---|
| `propose_payment` receipt | 3.055 Tgas | 3.058 Tgas | +2,729,564,138 gas |
| `on_near_settled` receipt | 2.080 Tgas | 2.082 Tgas | +2,711,463,506 gas |

**Isolation.**

- `build.rs` refuses `evm-spike` without `PURSER_ALLOW_EVM_SPIKE=1`, refuses it together with
  `fault-injection`, and `--all-features` fails by design.
- `scripts/check-wasm-clean.sh` refuses any wasm containing the spike marker or the export name
  `evm_spike_sighash`; `make evm-spike` proves it rejects the spike wasm and accepts the default one. A test
  keeps the marker in the script equal to the one in the source.
- Spike builds use `--no-abi` and their own target directory. Even with ABI generation **on** and the feature
  **on**, the generated ABI equals the default ABI apart from `metadata.wasm_hash`, with no occurrence of
  `evm_spike`, so `packages/types/src/generated.ts` and the `types-drift` job cannot see the spike.

## Size by implementation

Same toolchain, same `cargo near build non-reproducible-wasm --no-abi`, frozen `Cargo.lock`. Baseline: default
build, no ABI, **248,081 bytes** (97,359 gzipped). Variants b–d are scratch builds outside the repo, size only.

| Variant | raw bytes | delta | gz bytes |
|---|---|---|---|
| **a. hand-rolled RLP + host keccak (the spike)** | **250,543** | **+2,462 (+0.99%)** | 98,453 |
| c. hand-rolled RLP + `tiny-keccak` 2.0.2 (pure-Rust keccak) | 253,227 | +5,146 (+2.07%) | 99,938 |
| b. `rlp` 0.6.1 crate + host keccak | 255,603 | +7,522 (+3.03%) | 100,519 |
| d. `alloy-consensus` 2.5.0 `TxEip1559::signature_hash` (`default-features = false`) | 260,830 | +12,749 (+5.14%) | 102,414 |

Every route fits the 25 KB limit, including the heaviest. `alloy-consensus` compiled to `wasm32` with default
features off, which was not a given. Variants b–d were not gas-tested and variant d's digest was not
cross-checked; only variant a is the measured design.

## Decision left to the maintainers

The task said to prefer audited crates **if they fit**. They do (b: +7.5 KB, d: +12.7 KB). The spike did not
choose between them:

- **Hand-rolled (a)** is the smallest, has no new runtime dependency, and for this fixed nine-field shape is
  ≈ 40 lines. Its risk is a subtle encoding bug, which is what the three oracles above are for. Keep the
  vectors and the `rlp`/`sha3` dev-dependency oracles permanently if this is adopted.
- **An audited crate** removes that risk class at +5 to +10 KB over (a) and adds a dependency tree to the
  contract's supply chain, which matters for a custody contract.

## What GO does not establish

The spike proves construct-and-hash. A real EVM path still needs, each a separate piece of work:

- **Where `nonce` and fees come from.** The contract cannot read another chain, so nonce and fee fields need
  an attested source (the relayer, already a named trust assumption). They must be bounds-checked and bound
  into the stored `payload_hash`. **The encoder validates nothing:** it will happily hash `max_priority_fee >
  max_fee` (viem refuses that), `chain_id = 0`, `gas_limit = 0` or `to = 0x0…0`. Those checks belong to the
  caller that builds the transaction from the stored intent, and must exist before any digest is signed.
- **The never-blind-sign boundary.** The measurement harness takes raw fields as input on purpose. A real
  integration must take `to`, `value` and `chain_id` only from the stored intent, hash only the output of the
  contract's own encoder, refuse any `data`, access list or zero `to`, store the digest with the commitment,
  and verify the MPC signature recovers to the key it signed with ("recovery alone proves nothing", TRD §6).
- **Nonce-burn cancellation:** a second construction (same-nonce 0-value self-send, higher fee) plus attested
  outcome states.
- **`Chain::Evm` itself:** recipient normalization (EIP-55), `same_request` semantics, and a token model beyond
  NEAR-native units. The code still rejects `Chain::Evm`.
- **Field widths.** The spike bounds fees and value at `u128`; real EVM fields are 256-bit.
- **The real `sign` call:** its gas, deposit and the `v1.signer-prod.testnet` interface (TRD §6 flags this as
  unverified) are a separate measurement.
- **Gas figures are from the pinned sandbox,** not from testnet, and from a local non-reproducible build. The
  reproducible Docker build uses a different rustc image (1.96), so exact byte counts may differ slightly.
- **`CALLBACK_GAS` (10 Tgas)** is unchanged. The measured callback burns about 2.08 Tgas, so the note asking to
  re-measure it after RLP/keccak lands is answered for this encoder: the tax is 0.003 Tgas.

## Status update 2026-11-06

The governed EVM path was built after this spike (plan: `docs/plans/2026-11-06-feat-evm-governed-payment-path-plan.md`;
probes and gas: `docs/EVM-PROBES.md`; live runs: `docs/EVM-TESTNET-RUNBOOK.md` and the root `README.md`). Against the list in
"What GO does not establish":

| Item | Status |
|---|---|
| Nonce and fee sourcing | Done. Nonce comes from the contract's lane (seeded once by the owner from Sepolia `finalized`); fees come from owner-set ceilings; both are validated before any digest is signed and stored with the commitment. |
| Never-blind-sign boundary | Done. `to`, `value` and `chain_id` come only from the stored intent; `data` is empty, access list empty, `gas_limit` 21000, zero `to` refused. The only `sign` call site is the in-contract builder. |
| Signature verification | Done. The signature is accepted only if `ecrecover(sighash)` equals the derived key cached from the signer's `derived_public_key` view. |
| Nonce-burn cancellation | Done: same nonce, 0-value self-send, fee at least 12.5% higher on both fields, attested outcome, owner `confirm_release`. Run live once (payment 2 in the README). One cancel only; escalation is roadmap. |
| `Chain::Evm` itself | Done for recipients as 20-byte addresses (EIP-55 insensitive) and wei values. EOA recipients only; no EVM allowlist in v1. |
| The real `sign` call | Interface verified against near/mpc 3.18.0 source and live views (wrapped `request` args, 1 yoctoNEAR, 15 Tgas minimum), and the call ran live on `v1.signer-prod.testnet`. Real-signer gas, read from the live transactions: `sign` 4.27 Tgas, resume 3.46 Tgas, `on_signed` 3.15 Tgas, `propose_payment` synchronous part 3.94 Tgas (table in `EVM-PROBES.md`, "Real signer gas, from live txs"). The sandbox mock under-measures the signer because it answers synchronously. |
| Gas figures | Re-measured in the sandbox with the production wasm and a mock signer (`EVM-PROBES.md`). Still not testnet-measured. |
| Default wasm byte-identical | No longer true, on purpose. The no-ABI default build is 353,741 bytes (was 248,081; +105,660, +42.6%); the deployed wasm with ABI is about 366 KB. `scripts/evm-spike.sh`'s identity assertion no longer applies. |

Still open or not established:

- **Field widths.** Value and fees are still bounded at `u128`, not 256 bits.
- **Gas of the real signer's yield/resume** and the signer's yield timeout (about 200 blocks, never verified).
- **Contract recipients and ERC-20 tokens.** Not supported; a send to a contract can revert, and reverts release only through the owner.
- **Cancel escalation, a late-original watcher and an EVM recipient allowlist** are not built.
- **Mainnet.** Sepolia only, by design.
- The reproducible Docker build's byte counts were not compared with the local builds.

## Things the spike found that are worth keeping

- **chainsig.js / viem take `chainId` and `nonce` as JavaScript numbers.** The reference path cannot represent
  values above 2^53 − 1 for those two fields, so the vectors stop there; the full `u64` range is covered by
  the `rlp`-crate property test instead.
- **A zero fee is falsy in the chainsig.js adapter,** which then calls `estimateFeesPerGas()`. The vector
  generator stubs that call with the vector's own fees, so no RPC is involved.
- **The shipped build embeds the compressed ABI** (8,425 bytes of the 256,506), so a `--no-abi` build is not
  comparable to the shipped wasm. Compare like with like.
- **"Byte-identical" is fragile.** An innocent two-line `mod` insertion near the top of `lib.rs` changed 11 bytes
  of the data section: panic locations embed line numbers. The spike module is declared **last** in `lib.rs`
  for that reason, which keeps the default wasm and ABI byte-identical. The NEP-330 metadata also records the
  exact build command, so the comparison must use the identical command line.
- **Gas comparisons need identical account names:** event logs embed account ids and are charged per byte.
- **An unquoted `awk 'BEGIN{…,…}'` in a bash script is brace-expanded and hangs on stdin.** (Hit in
  `scripts/evm-spike.sh`; the same trap is already noted in `scripts/deploy-testnet.sh`.)

## Reproduce

```sh
make evm-spike          # host tests, sizes, wasm gate, sandbox gas and load tax
# vectors (scratch tool dir; nothing here is a repo dependency):
npm install --ignore-scripts --save-exact viem@2.57.16 chainsig.js@1.1.16   # in a scratch dir
node scripts/evm-spike-vectors.mjs --tools <scratch dir>
```

Variants b–d: copy `contract/` (with its `Cargo.lock`) to a scratch directory, swap the encoder or keccak as
described in the table, and build with the same `cargo near build non-reproducible-wasm --features evm-spike
--no-abi`.
