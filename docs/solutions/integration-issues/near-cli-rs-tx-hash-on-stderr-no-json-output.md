---
title: "near-cli-rs 0.30.1 has no JSON output: the tx hash is a line on stderr, so parse it and verify it on chain"
category: integration-issues
date: 2026-11-05
tags: [near-cli-rs, tx-hash, stderr, owner-call, demo, keychain, purser]
module: proposer/src/dev/demo-lib.ts (parseTxId), proposer/src/dev/demo.ts (owner), scripts/deploy-testnet.sh (near_quiet)
symptom: "A script that needs the transaction hash of an owner call (create_task, revoke_delegate, ...) gets nothing on stdout from `near contract call-function ... send`; there is no --json flag."
root_cause: "near-cli-rs prints its whole transcript (unsigned tx, signature, 'Transaction ID: <hash>', explorer URL, logs) to stderr and leaves stdout empty. `near --help` offers --quiet and --teach-me only."
status: resolved
verified: true
---

# Parse `Transaction ID:` from stderr, then re-read the tx from the chain

**Verified** with one real owner call on testnet (`set_recipient_allowlist`): stdout empty, exit 0, and on
stderr `Transaction ID: <44-char base58>` followed by an explorer URL on the old
`explorer.testnet.near.org` host (use nearblocks links of your own).

## What works

```ts
// proposer/src/dev/demo-lib.ts: only a hash-shaped token is accepted
const m = /Transaction ID:\s*(\S+)/.exec(stderr);
return m && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(m[1]) ? m[1] : null;
```

Run `near` with `spawnSync` and an argument array (no shell), a scrubbed env (`PATH` and `HOME` only),
a timeout, and `sign-with-keychain`, so the operator's full-access key never leaves the keychain and never
enters a TypeScript process or `.env.testnet`.

## Do not trust the parse alone

A parsed hash is only text. After every owner call, `viewTransactionStatus({ txHash, accountId: operator,
waitUntil: "EXECUTED" })` and assert `signer_id`, `receiver_id`, `actions[0].FunctionCall.method_name` and
`status.SuccessValue` before reporting it. If stderr has no hash, treat the call as having possibly landed
(do not retry blindly; read state first).

## Lookup by hash

`near tx-status` from the docs does not exist in 0.30.1. Use `near transaction view-status <hash>
network-config testnet`, or the RPC `tx` method with `wait_until`.

## Related

[[wallet-outcome-pasted-tx-hash-false-kill-switch-success]]: the same "a hash is not proof" rule, applied
to wallet results.
