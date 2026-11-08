---
title: "Every cached history row was dropped by the app: the API sends commitment_id as a number, the validator required a string"
category: integration-issues
date: 2026-11-05
tags: [contract-test, fixtures, json, bigint, validation, indexer, app, api-contract, cross-package, purser]
module: app/src/data/cache.ts (validateRow) vs indexer/src/db/core.ts + types.ts (CommitmentRow)
symptom: "Against the real API the 'On-chain history (cached)' panel would be empty and show 'N invalid rows ignored'. 129 app tests and 14 API tests passed."
root_cause: "CommitmentRow.commitment_id is a number and serializes as a JSON number; the app's validateRow did clean(raw.commitment_id, DIGITS), which returns null for non-strings. app/test/cache.test.ts used a hand-written fixture with commitment_id \"7\", and api.test.ts never fed its output to the app parser, so the two sides agreed with themselves and not with each other."
status: resolved
verified: true
---

# Two sides tested against their own assumptions

**One-line:** the validator fails closed, so nothing unsafe leaked, but the feature was dead on arrival.
Found by code review of the diff, not by a test. Fixed in `e709a5e` (PR #8) by accepting a safe
non-negative integer number or a digit string, with a regression test built from real output.

## Why the tests could not see it

- The API side tested "what I serialize" with a stub repo.
- The app side tested "what I parse" with a fixture the same author typed by hand.
- Nothing connected the two. A mismatch between independently-correct halves is invisible to both.

## Fix

```ts
// app/src/data/cache.ts: accept what the API actually sends
const id = typeof raw.commitment_id === "number"
  ? (Number.isSafeInteger(raw.commitment_id) && raw.commitment_id >= 0 ? String(raw.commitment_id) : null)
  : clean(raw.commitment_id, DIGITS);
```

Regression test: a fixture copied from live output
(`curl -s 'http://127.0.0.1:5174/__indexer/tasks/board-1/history?limit=2'`: number `commitment_id`,
string `as_of_height`) runs through the real `parseHistory` and keeps its row with 0 dropped; also
rejects `-1`, `1.5`, `2^53`, `NaN`, `"x1"`.

## Prevention

- Cross-package JSON contracts get one fixture generated from the producer's real output (or a shared
  type plus a golden file), consumed by both the producer test and the consumer test.
- Numbers vs strings: the repo convention is yocto amounts and u64 heights/timestamps as **strings**;
  `commitment_id` is the lone small-integer exception (`u64`, always a safe integer, see
  `toCommitmentId`). Document exceptions next to the type.
- "Fails closed" is good for safety but turns a contract bug into a silent empty panel. Surface the
  dropped-row count in the UI (it did: "N invalid rows ignored"), and treat a nonzero count against a
  healthy producer as a bug in a smoke test.

## Related

- `docs/solutions/integration-issues/near-native-verifiable-payload-hash.md` (independent-oracle
  testing for a contract between languages)
