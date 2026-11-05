.PHONY: build build-release test fmt lint \
        contract-build contract-build-release contract-test contract-fmt contract-lint prove \
        ts-install ts-lint ts-test types-gen \
        deploy-testnet demo metrics hooks

# Aggregate targets: the contract plus the TS workspace (packages/*, proposer).
build: contract-build
build-release: contract-build-release
test: contract-test ts-test
fmt: contract-fmt
lint: contract-lint ts-lint

# Contract (Rust / near-sdk). --all-features fails by design (build.rs gates the test-only
# `fault-injection` feature); shipped wasm is guarded by scripts/check-wasm-clean.sh.
contract-build: ; cd contract && cargo near build non-reproducible-wasm
contract-build-release: ; cd contract && cargo near build reproducible-wasm && ../scripts/check-wasm-clean.sh target/near/purser_contract.wasm   # verifiable; needs Docker + clean git tree
contract-test: ; cd contract && cargo test
contract-fmt: ; cd contract && cargo fmt --all
contract-lint: ; cd contract && cargo clippy --all-targets -- -D warnings

# Security evidence: the property tests + the named attack cases, with race-proof heights printed.
prove: ; cd contract && cargo test --test properties --test attacks -- --nocapture --test-threads=4

# TypeScript workspace (pnpm). Node runs .ts directly; `tsc` is the only type check.
ts-install: ; pnpm install --frozen-lockfile
ts-lint: ts-install ; pnpm -r --workspace-concurrency=1 run typecheck
ts-test: ts-install ; pnpm -r run test
# Regenerate packages/types/src/generated.ts from a fresh ABI (CI fails on any drift).
types-gen: contract-build ts-install ; pnpm --filter @purser/types run gen

# Ops (stubs until their prompts)
deploy-testnet: ; @echo "TODO (Prompt 10): build + deploy to testnet (must run scripts/check-wasm-clean.sh on the wasm first)"
demo: ; @echo "TODO (Prompt 10): run the 7-case demo"
metrics: ; @echo "TODO (Prompt 13): measure + write docs/METRICS.md"
hooks: ; cp scripts/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit && echo "pre-commit hook installed"
