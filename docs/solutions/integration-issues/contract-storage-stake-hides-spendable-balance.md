---
title: "propose_payment fails with LackBalanceForStateActionError: a contract's total balance is not what it can pay out"
category: integration-issues
date: 2026-11-05
tags: [near, testnet, storage-stake, balance, demo, preflight, LackBalanceForStateActionError, purser]
module: scripts/demo.sh, proposer/src/dev/testnet-ops.ts (can-fund), proposer/src/dev/demo.ts
symptom: "Every propose_payment on a funded-looking contract comes back unclassified: 'LackBalanceForStateActionError: Account purser.<op>.testnet lacks balance 161507408125583600000000 yoctoNear for state'. The demo's own preflight (balance >= cap + 1) had passed."
root_cause: "NEAR locks 10^19 yocto per byte of storage_usage as stake. Purser's 256 KB wasm alone locks ~2.6 NEAR, so a contract showing 2.85 NEAR had ~0.3 NEAR spendable. A payout that would dip into the locked stake fails the whole transfer. The preflight read view_account.amount (total), not amount minus storage_usage * 10^19."
status: resolved
verified: true
---

# Preflight on spendable balance, not total balance

**One-line:** `spendable = amount - storage_usage * 10^19`. Check that before any run that pays out of the
contract, and print the exact top-up command when it is short.

## Symptom

`scripts/demo.sh` created the task and delegates fine (owner txs only cost gas) and then both legitimate
purchases failed as `unclassified` with the state-stake error above. The classifier hid the cause until
the driver printed the raw error text (`refusal()` in `demo.ts` now shows kind plus a short raw tail for
anything that is not a frozen refusal).

## Root cause

- `view_account` returns `amount` (total), `locked` (validator stake) and `storage_usage` (bytes).
- The account must always keep `storage_usage * 10^19` yocto. Only the rest can leave.
- The deployed wasm (256506 bytes) alone is ~2.565 NEAR. Tasks, delegates and commitments add more.
- Each demo run pays 90 of the cap's 100 units out to the operator's own merchant sub-accounts, so a run
  needs about `0.9 x cap + 0.05` NEAR spendable (task storage and slack).

## Fix

`testnet-ops.ts can-fund <rpc> <account> <cap-near>` computes spendable and prints `yes` or
`no: <account> has X NEAR spendable, a run needs Y`. `demo.sh` dies on `no` with the top-up command:

```sh
near tokens <op>.testnet send-near purser.<op>.testnet '0.5 NEAR' network-config testnet sign-with-keychain send
```

`DEMO_CAP_NEAR` accepts a decimal (e.g. `0.3`) so a thin wallet can still run the story: the units are
cap/100, so 30 units is 0.09 NEAR.

## Prevention

- Any preflight that says "has enough NEAR to pay" must subtract the storage stake.
- `deploy-testnet.sh` funds a fresh contract with `3 x CAP_NEAR + 2`; with the wasm's 2.6 NEAR stake that
  leaves little headroom for repeated demo runs, which is why the README documents the top-up.
- Related: [[near-api-js-7-rate-limited-public-rpc-board-freeze]] (the other thing that makes testnet runs
  flaky), and the unclassified-vs-refused rule in `proposer/src/purser-client.ts` (`classifySendError`).
