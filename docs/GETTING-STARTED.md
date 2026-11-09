# Getting started on NEAR testnet

Deploy your own Purser contract and agents, then run the demo. Testnet only: the scripts refuse any other network. To try Purser without a NEAR account, see [Try it](../README.md#try-it) in the README.

## 1. Install

- Rust 1.95 with the `wasm32-unknown-unknown` target
- [`cargo-near`](https://github.com/near/cargo-near)
- Node 26 and pnpm 10: `npm install -g pnpm@10` (Node 26 no longer ships corepack)
- [`near-cli-rs`](https://github.com/near/near-cli-rs) 0.30.1: `npm install -g near-cli-rs@0.30.1`

## 2. Fresh account

Create a testnet account and save its key to your OS keychain:

```bash
near account create-account sponsor-by-faucet-service <you>.testnet \
  autogenerate-new-keypair save-to-keychain network-config testnet create
```

A first deploy needs about 12 testnet NEAR with the default settings (`3 x CAP_NEAR + 6`, and `CAP_NEAR` defaults to 2). Most of it funds the contract and its sub-accounts.

## 3. Deploy

```bash
OPERATOR_ACCOUNT_ID=<you>.testnet make deploy-testnet
```

| You get | Details |
|---|---|
| Contract | `purser.<you>.testnet`, owned by `<you>.testnet` |
| Agents | `scout`, `forge` and `buyer`, each with a key that can call only `propose_payment` |
| Sample vendors | `data`, `compute`, `procure`, plus `attacker`, which is not allowlisted |
| Tasks | `demo-legit`, `demo-race`, `demo-rogue` |
| `.env.testnet` | Your contract ID and the agent keys. Keep it private; it is gitignored |

The script is safe to re-run: it skips whatever already exists.

## 4. Run the demo

```bash
./scripts/demo.sh
```

Each run creates a new task with 100 units:

| Outcome | What you see |
|---|---|
| 1. Legitimate purchases | Remaining budget 100 → 70 → 40 |
| 2. Three agents fire 30 each at 40 left | One admitted (40 → 10), two **refused** with `exceeds task budget`, with block heights |
| 3. The same `request_id` again | The original result, **no duplicate authorization** |
| 4. A non-allowlisted vendor, and a reused `request_id` with another vendor | Both **refused** (`recipient not allowlisted`, `request_id reused with a different request`) |
| 5. Revoke Buyer, then Buyer proposes | **Blocked** (`delegate not authorized`) |
| 6. The contract's own verdict | `completed + outstanding <= cap` |
| 7. Timeout on an issued payment | **Sandbox replay, not a testnet transaction:** the reservation is retained through silence, retry and revoke |

`RUN_ID` and `DEMO_CAP_NEAR` (default `1`, and `0.5` suits a thin wallet) are the only settings. A run pays 90 of the 100 units to your own sample vendors, so the contract needs about `0.9 x DEMO_CAP_NEAR + 0.05` NEAR spendable. Its wasm also locks about 2.6 NEAR as storage. The script stops early with the exact top-up command if it is short.

## 5. Open the board

```bash
make board
```

Open `http://127.0.0.1:5173/?task=<task-id>`. Connect your owner account with **NEAR CLI** to unlock **Owner tools** and **Revoke**.

## 6. Add your own agents and vendors

**Vendor:** in **Owner tools**, enter its NEAR account under **Allowlist recipients**. The list only grows. To remove a vendor, call `remove_recipient_allowlist` from the CLI.

**Agent:** the board registers an agent but does not create its account or key, so do that first:

```bash
# Create the account
near account create-account fund-myself nova.<you>.testnet '0.5 NEAR' \
  autogenerate-new-keypair save-to-keychain sign-as <you>.testnet \
  network-config testnet sign-with-keychain send

# Create a key file; this prints the public key
node proposer/src/dev/testnet-ops.ts keygen .near-keys/nova.key

# Limit that key to propose_payment
near account add-key nova.<you>.testnet grant-function-call-access \
  --allowance '0.25 NEAR' --contract-account-id purser.<you>.testnet \
  --function-names propose_payment \
  use-manually-provided-public-key <PUBLIC_KEY> \
  network-config testnet sign-with-keychain send
```

Then add it under **Add delegate** in **Owner tools**. A task's crew size is fixed by the **Crew cap** you set when creating it, and a persona name can't be reused within a task. Your agent's code then calls `propose_payment(task, intent, request_id)` with that key. Use a fresh `request_id` per payment, and repeat the same one only when retrying that exact payment.

## All commands

| Command | What it does |
|---|---|
| `make build` | Build the wasm and ABI into `contract/target/near/`. Never run bare `cargo build`: near-sdk blocks it |
| `make test` | Contract unit and integration tests, plus TypeScript unit tests |
| `make lint` | Clippy, TypeScript typecheck and the security audit |
| `make fmt` | `cargo fmt` |
| `make hooks` | Install the pre-commit secret scan |
| `make prove` | Property tests and the named attack cases |
| `make audit` | Static security audit (S1-S4, S7, S8), with a self-test proving it can fail |
| `make metrics` | Regenerate `docs/METRICS.md` from real runs (`QUICK=1` for a short run) |
| `make evm-spike` | The EVM go/no-go spike, local and sandbox only |
| `make relayer` | Run the Sepolia relayer ([README](../relayer/README.md)) |
| `make ts-test-sandbox` | The AI proposer on a local chain |
| `make crew` | Run the agents (`NETWORK=sandbox\|testnet`, `SCENARIO=demo\|legit\|race\|rogue`) |
| `make board` | The operator board at <http://127.0.0.1:5173> |
| `make landing` | The product page at <http://127.0.0.1:5180> |
| `make types-gen` | Regenerate `@purser/types` from the contract ABI |
| `make deploy-testnet` | Deploy to testnet and create the crew |
| `make demo` | The seven outcomes above |

To drive the Sepolia path, see [EVM-TESTNET-RUNBOOK.md](EVM-TESTNET-RUNBOOK.md).

## Troubleshooting

| Problem | Fix |
|---|---|
| `429` from the RPC | The public RPC is rate limiting you. Re-run, or set `NEAR_RPC_URL` to another https RPC |
| `this take is spent` | Each demo take needs a fresh task, because revocation is permanent. Run `./scripts/demo.sh setup` |
| The contract is short of funds | Top it up with the command the script prints |
| `pnpm not found` | `npm install -g pnpm@10` |
| The board shows no data | Run `make deploy-testnet` first, or set `PURSER_CONTRACT_ID` |
| A task shows a frozen state | Only a wrong owner attestation can freeze a task. See [LIMITS-AND-TRUST.md](LIMITS-AND-TRUST.md) |
