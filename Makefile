.PHONY: build test fmt lint deploy-testnet demo metrics hooks

build: ; cd contract && cargo near build non-reproducible-wasm
test: ; cd contract && cargo test
fmt: ; cd contract && cargo fmt --all
lint: ; cd contract && cargo clippy --all-targets -- -D warnings
deploy-testnet: ; @echo "TODO (Prompt 10): build + deploy to testnet"
demo: ; @echo "TODO (Prompt 10): run the 7-case demo"
metrics: ; @echo "TODO (Prompt 13): measure + write docs/METRICS.md"
hooks: ; cp scripts/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit && echo "pre-commit hook installed"
