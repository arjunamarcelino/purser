.PHONY: build build-release test fmt lint \
        contract-build contract-build-release contract-test contract-fmt contract-lint prove \
        ts-install ts-lint ts-test ts-test-sandbox types-gen crew board \
        indexer-poll indexer-serve indexer-counts \
        deploy-testnet demo metrics audit hooks evm-spike relayer

# Aggregate targets: the contract plus the TS workspace (packages/*, proposer).
build: contract-build
build-release: contract-build-release
test: contract-test ts-test
fmt: contract-fmt
lint: contract-lint ts-lint audit

# Contract (Rust / near-sdk). --all-features fails by design (build.rs gates the test-only
# `fault-injection` feature); shipped wasm is guarded by scripts/check-wasm-clean.sh.
contract-build: ; cd contract && cargo near build non-reproducible-wasm && ../scripts/check-wasm-clean.sh target/near/purser_contract.wasm
contract-build-release: ; cd contract && cargo near build reproducible-wasm && ../scripts/check-wasm-clean.sh target/near/purser_contract.wasm   # verifiable; needs Docker + clean git tree
contract-test: ; cd contract && cargo test
contract-fmt: ; cd contract && cargo fmt --all
contract-lint: ; cd contract && cargo clippy --all-targets -- -D warnings

# Security evidence: the property tests + the named attack cases, with race-proof heights printed.
prove: ; cd contract && cargo test --test properties --test attacks -- --nocapture --test-threads=4

# STRETCH spike (docs/EVM-SPIKE.md): size + gas of building and hashing an EIP-1559 tx in-contract. Local/sandbox only.
evm-spike: ; scripts/evm-spike.sh

# TypeScript workspace (pnpm). Node runs .ts directly; `tsc` is the only type check.
ts-install: ; pnpm install --frozen-lockfile
ts-lint: ts-install ; pnpm -r --workspace-concurrency=1 run typecheck
ts-test: ts-install ; pnpm --filter @purser/app build && pnpm -r run test   # app build first: its test scans dist/ for secrets
# Regenerate packages/types/src/generated.ts from a fresh ABI (CI fails on any drift).
types-gen: contract-build ts-install ; pnpm --filter @purser/types run gen
# The proposer on a local chain: crew integration tests + the model-independence property test.
# The sandbox binary is nearcore 2.14.0, sha256-pinned (scripts/sandbox-bin.sh).
ts-test-sandbox: contract-build ts-install
	NEAR_SANDBOX_BIN_PATH="$$(scripts/sandbox-bin.sh)" pnpm --filter @purser/proposer run test:sandbox
	NEAR_SANDBOX_BIN_PATH="$$(scripts/sandbox-bin.sh)" pnpm --filter @purser/indexer run test:sandbox

# The EVM relayer loop (Sepolia; reads EVM_PURSER_CONTRACT_ID, RELAYER_*, EVM_RPC_URL* from .env/.env.testnet). Stateless: restart freely.
relayer: ts-install ; pnpm --filter @purser/relayer run relay

# The operator board (http://127.0.0.1:5173), with the localhost companion for the demo buttons.
board: ts-install ; pnpm --filter @purser/app dev

# The off-chain cache (derived, non-authoritative; reads PURSER_CONTRACT_ID/NEAR_NETWORK from .env.testnet).
# Poller and API are separate processes: the poller is the only DB writer, the API opens it read-only.
indexer-poll: ts-install ; pnpm --filter @purser/indexer run poll
indexer-serve: ts-install ; pnpm --filter @purser/indexer run serve
indexer-counts: ts-install ; pnpm --filter @purser/indexer run counts

# Run the proposer crew: make crew [NETWORK=sandbox|testnet] [SCENARIO=demo|legit|race|rogue] [MODEL=near-ai|scripted]
NETWORK ?= sandbox
SCENARIO ?= demo
crew: contract-build ts-install
	NEAR_SANDBOX_BIN_PATH="$$(scripts/sandbox-bin.sh)" pnpm --filter @purser/proposer run crew \
	  --network $(NETWORK) --scenario $(SCENARIO) $(if $(MODEL),--model $(MODEL))

# Ops. Testnet only. `make deploy-testnet demo` is the one-command path (see README "Try it").
# deploy-testnet needs OPERATOR_ACCOUNT_ID=<you>.testnet and near-cli-rs; demo replays outcomes 1-6 live + 7 in the sandbox.
deploy-testnet: contract-build ts-install ; scripts/deploy-testnet.sh
demo: ; scripts/demo.sh
# Measured evidence (docs/METRICS.md): repeats the attack suite N times (default 10) plus the measuring harness.
# `make metrics QUICK=1` is a 3-run smoke that writes docs/METRICS.quick.md and never the published report.
metrics: ; scripts/metrics.sh

# Static security audit (TRD S1-S4, S7, S8) over contract/src, plus its seeded-violation self-test.
audit: ; scripts/audit-security.sh && scripts/audit-security-selftest.sh && node scripts/check-readme.mjs
hooks: ; cp scripts/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit && echo "pre-commit hook installed"
