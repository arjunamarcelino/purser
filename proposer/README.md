# proposer

The crew's "brain": three AI personas — **Scout** (research/data), **Forge** (compute) and
**Buyer** (procurement) — that turn a goal into a structured `PaymentIntent` with a model on
[NEAR AI Cloud](https://docs.near.ai) and submit it with the contract's `propose_payment`.
They share one task budget.

## Untrusted by design

The proposer is **outside the trust boundary**. It suggests; the contract decides.

- **Its only authority is one function-call key per persona**, scoped on chain to
  `receiver = purser contract, methods = [propose_payment]`, with a gas-only allowance. The key cannot
  call any other method, attach a deposit, or move the delegate account's funds
  (`test/sandbox/crew.sandbox.test.ts`, "the proposer's key has no authority…"). The account's
  full-access key never leaves the operator's near-cli keychain.
- **No client-side policy.** The proposer checks only that the model's output can be encoded as a
  `PaymentIntent`. It never pre-checks budget, allowlist, memo length or amount — those checks
  live in the contract, and a rogue proposal must reach the contract to be refused there. The
  chain and token come from the task, never from the model.
- **An over-budget AI proposal is refused by the contract.** Attack case 2 runs through this
  path: three personas propose 30 at once against 40 of headroom, and exactly one is admitted.
  A compromised model proposing 500 against a 100 cap, or paying a non-allowlisted account, is
  refused. A property test feeds arbitrary model output in concurrent bursts and checks the cap,
  the allowlist and the money flow after every run (`model-independence.sandbox.test.ts`).
- **Residual risk, stated plainly.** The contract stops anything *outside* budget and allowlist,
  whatever the model does. Inside policy, a prompt-injected model can still choose the wrong
  allowlisted merchant or spend the remaining budget, and the memo it writes is public on chain
  (an injected vendor offer could ask for the task goal to be leaked there). Vendor offers are
  delimited as untrusted data in the prompt, which is hygiene, not a defense.
- **Revocation is honest.** Revoking a delegate is two steps — delete its function-call key, and
  owner `revoke_delegate` — and blocks new proposals. It cannot recall a payment already made.

## Exactly-once retries

Each decision gets one `request_id` (UUID), written to a local journal **with the exact call
bytes before sending** (`out/journal/`, 0600, one file per network/contract/account, one process
per file). Retries resend those bytes. While a request is unresolved the persona makes no new
decision — the next run resumes it — so a crash or a lost response can never turn one need into
two payments. A refusal is final: the contract keeps no record of a refused request, so resending
its id later could be admitted once budget frees up.

## Attestation (evidence, not authority)

Status (2026-11-05): **available.** NEAR AI Cloud returns an Intel TDX quote plus NVIDIA GPU
evidence for `z-ai/glm-5.3-flash`, bound to the request nonce. The live end-to-end check of a
completion's signature is pending account credits (`402 no_limit_configured`).

The official [`@nearai/inference-sdk`](https://docs.near.ai/cloud/inference-sdk/javascript) is the
only verifier. Each completion gets an `Evidence` record (`out/evidence.jsonl`, digest and check
results only, never a raw quote). It is `verified: true` only when **all** of these hold:

| Check | Fails as |
|---|---|
| The SDK verified the TDX quote, nonce binding, NVIDIA evidence and the byte-exact response signature | `sdk_verification_failed` |
| The response was signed inside the model's TEE, not by the gateway | `gateway_signature` |
| It names the canonical model we requested (no alias) | `model_not_canonical` |
| Compose and OS image hashes match `attestation-pins.json` | `measurement_changed` |
| NVIDIA GPU evidence was present and verified | `nvidia_evidence_missing` |
| Intel TCB status is `UpToDate` | `tcb_<status>` |

What `verified: true` means, precisely: *the completion was signed by a key that, at
`verified_at`, was bound to a TDX + GPU report matching our pinned measurements.* Limits:

- the measurements are pinned on first observation (trust on first use), not independently audited;
- the request nonce proves the report is fresh; the completion is linked to it only through the
  signing key, which every instance of the model shares;
- NEAR's own docs describe the gateway-to-model chain of trust as not yet complete;
- the gateway sees prompts in plaintext unless E2EE is enabled;
- TEEs assume no physical attacker: the 2025 memory-bus attacks (TEE.fail, WireTap, Battering RAM)
  extracted TDX attestation keys;
- attestation says *where* inference ran, not that a proposal is safe. The contract never reads it.

If verification is unavailable, the proposer still runs and records `verified: false` with the
reason. It never reports a verification that did not happen.

## Run it

```bash
make crew                                  # local chain, all scenarios (sha256-pinned nearcore 2.14)
make crew SCENARIO=race MODEL=scripted     # one scenario, no model calls
make ts-test-sandbox                       # the chain tests
OPERATOR_ACCOUNT_ID=<you>.testnet make deploy-testnet   # testnet: contract, tasks, crew, keys → .env.testnet
make crew NETWORK=testnet                  # the crew against testnet
```

`--json` (via `pnpm --filter @purser/proposer crew -- --json …`) prints one `ProposalRecord` per
line for scripts; `--verbose` adds structured logs on stderr. Prompts and completions are logged
as hashes unless `PROPOSER_LOG_CONTENT=1`.

Scenarios: `legit` (each persona pursues its goal), `race` (attack case 2), `rogue` (compromised
model, plus a live prompt-injection run when a real model is configured), `demo` (all three).
Amounts are in budget units (cap / 100), so the story reads the same on a 100 NEAR sandbox task
and a 2 NEAR testnet task. The exit code is non-zero if the chain shows anything the contract
should have refused.

## Configuration

Environment only (`.env` / `.env.testnet`, both gitignored); see the root `.env.example`.
`NEAR_AI_CLOUD_API_KEY` enables the real model; without it the scenarios use scripted models.
`NEAR_AI_MODEL` must be the canonical id of a NEAR TEE (`providerType: vllm`) model — aliases and
third-party "Incognito" models only get gateway signatures.

Contract types come from `@purser/types` (generated from the ABI); refusals are matched exactly
against its frozen table.
