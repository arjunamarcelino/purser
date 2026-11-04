.PHONY: build build-release test fmt lint \
        contract-build contract-build-release contract-test contract-fmt contract-lint \
        deploy-testnet demo metrics hooks

# Aggregate targets — expand to also run TS services (app/proposer/indexer) as they land.
build: contract-build
build-release: contract-build-release
test: contract-test
fmt: contract-fmt
lint: contract-lint

# Contract (Rust / near-sdk). Never pass --all-features: it enables the test-only `fault-injection`
# feature. Shipped wasm is guarded by scripts/check-wasm-clean.sh.
contract-build: ; cd contract && cargo near build non-reproducible-wasm
contract-build-release: ; cd contract && cargo near build reproducible-wasm   # verifiable; needs Docker + clean git tree
contract-test: ; cd contract && cargo test
contract-fmt: ; cd contract && cargo fmt --all
contract-lint: ; cd contract && cargo clippy --all-targets -- -D warnings

# Ops (stubs until their prompts)
deploy-testnet: ; @echo "TODO (Prompt 10): build + deploy to testnet"
demo: ; @echo "TODO (Prompt 10): run the 7-case demo"
metrics: ; @echo "TODO (Prompt 13): measure + write docs/METRICS.md"
hooks: ; cp scripts/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit && echo "pre-commit hook installed"
