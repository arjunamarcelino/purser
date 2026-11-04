# Purser — on-chain spending controller for AI agent crews

**One budget. Many agents. Nothing overspent.**

A NEAR smart contract that lets a crew of AI agents draw from one shared, capped
budget and enforces `completed + outstanding ≤ cap` across concurrency, retries,
timeouts, and revocation. The AI only proposes; the contract enforces.

**Tracks:** security (primary) · swarms · agents

**Status:** scaffold. Specs live in `docs/`; build steps in `docs/PURSER-BUILD-PROMPTS.md`.

## Authorization & honest revocation

**Auth model (MVP): registry + predecessor.** The owner registers delegate agents per
task; each agent authorizes from its own NEAR account. A caller is authorized only if it
is a registered, **active** delegate of the task — the contract issues no access keys, so
the budget guarantee is a property of the contract code, never of key mechanics. (The
function-call-key path is a documented, deferred option; see the operator gate in
`docs/BUILD-START-VERIFICATION.md`.)

**Revocation is honest.** `revoke_delegate` marks a crew member inactive, which blocks all
**future** authorizations immediately (the next proposal is refused) and reports whether it
actually changed state. It **cannot** un-issue or recall a signature/transaction already
produced — no on-chain mechanism can — and it does **not** release that delegate's
already-reserved (`outstanding`) budget, which stays reserved until settled or failed by the
normal lifecycle (no reclaim on silence). The dashboard greys out a revoked agent and marks
new proposals BLOCKED, with a caption noting already-issued signatures cannot be recalled.

## Develop

| Command | What it does |
|---|---|
| `make build` | `cargo near build` → wasm + ABI in `contract/target/near/` |
| `make test`  | contract unit + integration tests |
| `make lint`  | `cargo clippy --all-targets -- -D warnings` |
| `make fmt`   | `cargo fmt` |
| `make hooks` | install the pre-commit secret-scan hook |
| `make prove` | the security evidence: property tests + the named attack cases |

Never build or test with `--all-features`: it turns on the test-only `fault-injection` feature.
`scripts/check-wasm-clean.sh <wasm>` refuses a fault build (CI runs it on the shipped artifact).

## Security evidence

`make prove` runs, on every interleaving it can generate and on a real sandbox chain:

- **Property tests** (`contract/tests/properties.rs`). Thousands of random operation sequences over
  the pure accounting core and over the real contract entrypoints (callbacks delivered out of
  order or lost, retries, revocation, owner reconcile). After **every** step they check the
  contract against an independent model: `completed + outstanding ≤ cap`, one authorization per
  request, the money that left never exceeds what is accounted, and nothing is released
  without proof.
- **Attack suite** (`contract/tests/attacks.rs`). One named test per demo case (legit spend,
  concurrent over-budget, retry, in-flight retry, tampered recipient, revocation, timeout).
  The concurrency cases put every proposal into **one block** and prove from on-chain receipt
  heights that each admission ran before the first settlement, so the race was actually exercised.

**Operational notes.** A commitment whose settlement callback was lost stays reserved until the
owner reconciles it with the observed outcome, and `reconcile` refuses until the commitment is
10 minutes old so it can never race a callback that is still in flight. Never deploy Purser on
the owner's own account: `#[private]` callbacks would then accept the owner as the caller.

### Toolchain

- Rust (via rustup) with the `wasm32-unknown-unknown` target
- [`cargo-near`](https://github.com/near/cargo-near) and [`near-cli-rs`](https://github.com/near/near-cli-rs)

Target network: **NEAR testnet** only.
