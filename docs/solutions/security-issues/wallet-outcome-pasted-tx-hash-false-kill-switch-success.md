---
title: "Wallet outcome is not proof: a pasted NEAR CLI tx hash made the kill-switch say 'Revoke — done'"
category: security-issues
date: 2026-11-05
tags: [near-connect, hot-labs, near-cli-wallet, wallet-outcome, signAndSendTransaction, kill-switch, revoke, tx-hash, final-execution-outcome, untrusted-input, dashboard, react, purser]
module: app owner actions (app/src/wallet/outcome.ts, components/owner.tsx)
symptom: "With the NEAR CLI wallet the owner runs `near ... send` in a terminal and pastes the tx hash back. Pasting the hash of an EARLIER owner transaction (e.g. add_delegate) made the board toast 'Revoke — done' while the delegate stayed active. A missing or still-pending outcome also counted as success."
root_cause: "The board treated 'the wallet returned without throwing, signer and receiver look right' as 'the transaction we asked for succeeded'. A wallet's return value is untrusted input: the CLI wallet fetches whatever hash you paste, so it can be any final transaction by the same owner to the same contract."
status: resolved
verified: true
---

# Wallet outcome is not proof: a pasted tx hash made the kill-switch say "Revoke — done"

**One-line:** an owner action is "done" only if the returned outcome proves it is *exactly* the
transaction the board asked for, and that it is final and successful. Shipped in PR #7 (`206b3dd`).

## Symptom (found by the security review, reproduced live)

1. Click **Revoke** on Scout. The NEAR CLI wallet shows the `near contract call-function ... revoke_delegate` command.
2. Instead of running it, paste the hash of an older `add_delegate` transaction from the same owner.
3. The board toasts **Revoke — done**, but Scout is still ACTIVE on chain. For a kill-switch, this is
   the worst possible failure: the operator thinks the agent is stopped.

The same code path also returned "ok" when `status` was missing, or was a string such as `"Started"`
(not final yet).

## What did NOT work

- **Checking `signer_id` and `receiver_id` only.** A replayed owner transaction passes both.
- **Trusting the wallet not to throw.** near-connect's CLI executor resolves with whatever
  `FinalExecutionOutcome` the pasted hash returns. "Did not throw" means only "a transaction exists".
- **Waiting for the next poll to show the revoke.** The poll is the real source of truth, but the
  toast had already said "done". A false "done" is the bug, even if the crew panel later corrects it.

## Solution: `checkOutcome` (pure and unit-tested)

```ts
// app/src/wallet/outcome.ts
export function checkOutcome(outcome: Outcome, method: OwnerMethod, args: Record<string, unknown>, expectedSigner: string): OwnerOutcome {
  const tx = outcome.transaction;
  const status = outcome.status;
  if (!tx || typeof status !== "object" || status === null) return { kind: "unknown", raw: "the wallet returned no final outcome — check the explorer" };
  if (tx.receiver_id !== config.contractId) return { kind: "unknown", raw: `transaction is for ${tx.receiver_id ?? "?"}, not ${config.contractId}` };
  if (tx.signer_id !== expectedSigner) return { kind: "unknown", raw: `transaction was signed by ${tx.signer_id ?? "?"}, expected ${expectedSigner}` };
  const actions = tx.actions ?? [];
  const call = actions.length === 1 && typeof actions[0] === "object" ? actions[0].FunctionCall : undefined;
  if (!call || call.method_name !== method) return { kind: "unknown", raw: `transaction calls ${call?.method_name ?? "something else"}, not ${method}` };
  if (call.args === undefined || canonical(decodeArgs(call.args)) !== canonical(args)) return { kind: "unknown", raw: "transaction arguments differ from what you approved" };
  if ("Failure" in status && status.Failure !== undefined) { /* -> refused, code via classifyRefusal */ }
  if (!("SuccessValue" in status)) return { kind: "unknown", raw: "transaction outcome is not final yet — check the explorer" };
  return { kind: "ok", txHash: tx.hash ?? "", blockHash: outcome.transaction_outcome?.block_hash ?? "" };
}
```

How each rule maps to a result:

| Check | Fails as |
|---|---|
| `transaction` present, `status` is an object | `unknown`: no final outcome |
| `receiver_id === config.contractId` | `unknown` |
| `signer_id ===` the connected owner | `unknown` |
| exactly one `FunctionCall`, `method_name === method` | `unknown`: wrong method (the pasted add_delegate case) |
| base64 args decode and canonically equal the requested args (sorted keys) | `unknown`: a revoke of a different delegate |
| `status.Failure` | `refused` (amber), code from `classifyRefusal`, e.g. `only_owner` |
| no `SuccessValue` | `unknown`: not final |

`unknown` renders as a neutral "check the explorer" toast, never as success. The crew panel still
reflects only the polled chain state.

**Type note:** under `exactOptionalPropertyTypes`, near-connect's outcome type isn't assignable to a
strict local type. The local `Outcome` type therefore declares every field `?: T | undefined`. That
is correct anyway, because the value is untrusted.

## Prevention

- Treat every wallet return value like request input: validate its shape, then bind it to the
  request (method, args, signer, receiver) before you show success.
- Show "done" only for *final* success. "Sent" and "unknown" are separate UI states.
- Keep the check pure, outside the connector, so it can be unit-tested.
  `app/test/owner-outcome.test.ts` covers the pasted wrong-method hash, a different delegate's args,
  a wrong signer, a wrong receiver, two actions, a missing or string status, Failure → refused, and the happy path.
- The same "bind to the exact request" rule applies to manifest tx links. A link attaches only to
  the commitment that matches `request_id`, delegate, amount and recipient (`6256091`).

## Related

- `docs/solutions/security-issues/owner-reconcile-contradicted-by-late-settlement-callback.md`: the
  contract-side version of the same rule (an attestation is not proof; the chain is).
- `app/README.md` › Wallets (testnet)
- PR #7 security review: High, "false kill-switch success"
