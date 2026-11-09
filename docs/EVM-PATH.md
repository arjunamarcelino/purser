# EVM path (Sepolia)

The optional cross-chain path: one NEAR contract governs a payment on Sepolia through NEAR Chain Signatures. Testnets only. To run it, see [EVM-TESTNET-RUNBOOK.md](EVM-TESTNET-RUNBOOK.md).

One governed EVM payment path: the contract builds an EIP-1559 transfer from the stored intent, reserves
budget, asks the NEAR MPC signer (`v1.signer-prod.testnet`, near/mpc 3.18.0) to sign it, and checks the
signature recovers to the lane's cached derived key. A separate relayer broadcasts to Sepolia and reports
what happened. Sepolia only, never mainnet (chain id 11155111 is the only one the contract accepts, and the
relayer checks `eth_chainId` on every RPC).

**Built and proven on real testnets:** a real payment signed through the live MPC signer, broadcast to
Sepolia, and attested at `finalized`; and a stuck payment recovered by nonce-burn cancel and an owner release,
leaving the invariant intact. The contract tests for the same paths run against a mock signer in the
sandbox (with gas budgets); the live runs below used the real one.

### Trust model: the relayer is a named assumption

The contract cannot read Sepolia, so the relayer is the only party that tells it what happened there. What a
lying or compromised relayer can and cannot do:

| Attack | Possible? | Bound |
|---|---|---|
| Report a false "original landed" | Yes | Budget is burned (over-counted) for one lane; no theft; conservative direction |
| Report a false "cancel landed" / "reverted" | Can only record evidence; cannot release budget | Release needs the **owner's** `confirm_release` after the owner checks Sepolia |
| Refuse to report / go offline | Yes | Reservation stays locked (honest, by design); owner can inspect and act |
| Attest a hash the contract did not sign | No | The contract matches reports against hashes it signed |
| Cause an immediate double spend alone | No | Needs the owner key too (two-key release) |

**Two-key release.** The relayer attests; only the owner's `confirm_release` frees budget. If the owner
confirms a release on a false claim, the original can still land afterwards: that is overspend of up to one
in-flight value per lane. The contract records the spend if it is later attested, emits a contradiction, and
freezes the task; freezing is the only recovery, and it is permanent for that task. Anyone can broadcast the
original at any time from the public `get_signed_tx` view, so a strategy must assume it may land before a
cancel is final. `owner != relayer` is a setup check.

**Every callback `Err` goes to `Unknown`, never to released.** A failed signer callback is not proof that no
signature exists: the MPC nodes' `respond` transaction carries the signature in public args even when the
caller's yield timed out. So a commitment whose sign callback fails stays reserved until it is resolved with
Sepolia evidence.

### Honest limits

- **Cap is value, not gas.** Gas is paid in ETH from the derived address and sits outside the cap. The fee
  ceiling and `min_value` (both owner-set) and the dedicated task's cap bound the exposure.
- **One in-flight payment per derived address (lane).** The relayer attests only at Sepolia `finalized`,
  which lags head by about 19 minutes (observed 14 to 15 minutes from broadcast to attestation on both live runs), so throughput is about one payment per 15 minutes per delegate.
- **Safe finality never changes state.** Only `Finalized` attestations move a commitment.
- **EOA recipients only in v1.** A 21000-gas send to a contract can revert. A reverted receipt is attested
  `success=false`, moves nothing, and releases only through the owner. The relayer warns when `eth_getCode(to)`
  is non-empty.
- **No EVM recipient allowlist in v1.** Exposure is bounded by the task cap, `min_value` and the fee ceiling.
- **`derivation_path` is still public** in `list_delegates` in v1 (the derived address is public anyway).
- **A single cancel.** Escalation is roadmap. A cancel that is itself stuck leaves the commitment `Unknown`
  with its budget locked.
- **Late originals after a cancel are not watched.** The relayer does not watch `Cancelled` commitments for a
  late original. The contract has the edge (`Cancelled -> Confirmed` records the spend and freezes the task if
  over cap) and it is tested in the sandbox, but it was not demonstrated live.
- **Size.** The default no-ABI wasm grew 248,081 to 353,741 bytes (+105,660, +42.6%); the deployed wasm with its
  embedded ABI is about 366 KB.
- Gas figures (`docs/EVM-PROBES.md`) come from a sandbox with a mock signer; the real signer's yield/resume
  cost is not in that table.

Live transaction references for both stuck-payment runs are in [`docs/EVM-EVIDENCE.md`](EVM-EVIDENCE.md).
