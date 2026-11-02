# Purser — on-chain spending controller for AI agent crews

**One budget. Many agents. Nothing overspent.**

A NEAR smart contract that lets a crew of AI agents draw from one shared, capped
budget and enforces `completed + outstanding ≤ cap` across concurrency, retries,
timeouts, and revocation. The AI only proposes; the contract enforces.

**Tracks:** security (primary) · swarms · agents

**Status:** scaffold. Specs live in `docs/`; build steps in `docs/PURSER-BUILD-PROMPTS.md`.

## Develop

| Command | What it does |
|---|---|
| `make build` | `cargo near build` → wasm + ABI in `contract/target/near/` |
| `make test`  | contract unit + integration tests |
| `make lint`  | `cargo clippy --all-targets -- -D warnings` |
| `make fmt`   | `cargo fmt` |
| `make hooks` | install the pre-commit secret-scan hook |

### Toolchain

- Rust (via rustup) with the `wasm32-unknown-unknown` target
- [`cargo-near`](https://github.com/near/cargo-near) and [`near-cli-rs`](https://github.com/near/near-cli-rs)

Target network: **NEAR testnet** only.
