---
title: "Cannot delete the old demo contract ('state is large is temporarily banned') and cannot deploy over its old Borsh layout: use a fresh operator sub-account"
category: integration-issues
date: 2026-11-06
tags: [near, testnet, delete-account, borsh, state-layout, redeploy, deploy-testnet, operator, purser]
module: scripts/deploy-testnet.sh, scripts/demo.sh, .env.testnet
symptom: "To run the live demo on the new wasm, `near account delete-account purser.<op>.testnet beneficiary <op>.testnet ...` failed with 'Delete account <...> whose state is large is temporarily banned' (283.8 KB used). deploy-testnet.sh also refuses to deploy over different code unless ALLOW_STATE_BREAKING_REDEPLOY=1."
root_cause: "The old demo contract held the pre-EVM Borsh layout, which the new wasm cannot read (the EVM path appended six fields; there is no migrate method), and the protocol temporarily bans deleting accounts with large state, so neither upgrading in place nor recreating the account was possible."
status: resolved
verified: true
---

# Route around it: a new operator, a new contract, nothing existing touched

1. Create a fresh operator sub-account: `near account create-account fund-myself demo.<op>.testnet '9 NEAR'
   autogenerate-new-keypair save-to-keychain sign-as <op>.testnet network-config testnet sign-with-keychain send`.
2. `OPERATOR_ACCOUNT_ID=demo.<op>.testnet CAP_NEAR=1 scripts/deploy-testnet.sh` (accounts, contract, three tasks,
   function-call keys). **It rewrites `.env.testnet`**; copy it to a 0600 backup first.
3. `DEMO_CAP_NEAR=1 ./scripts/demo.sh`. After deploy the contract had 0.265 NEAR spendable (the wasm locks ~2.6 NEAR as
   stake), below a `DEMO_CAP_NEAR=0.5` run's need, so demo.sh stopped and printed the exact top-up command
   (`near tokens ... send-near purser.demo... '1 NEAR'`). See `contract-storage-stake-hides-spendable-balance.md`.

## Do not reach for the override

`ALLOW_STATE_BREAKING_REDEPLOY=1` swaps code over existing state "with the layout NOT verified". An attempt to use it
here was (rightly) denied by the permission classifier; it was also unnecessary, because the deployed code hash
already equalled the wasm being deployed (see the wasm-hash doc: a comment-only edit had briefly changed it).
Check `code-matches` / `shasum` first; if the hash matches there is nothing to deploy.

## Prevention

- Check the deployed code hash against the freshly built wasm BEFORE any redeploy decision.
- Treat the demo account as disposable: a layout change means a new account, so keep operator ids in `.env.testnet`
  only and never hard-code `purser.<op>.testnet` in docs.
- The README says the live demo ran on the new operator; old transaction links remain valid on the explorer.
