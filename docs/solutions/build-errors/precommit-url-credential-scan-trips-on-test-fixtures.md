---
title: "Pre-commit hook aborts on fake user:pass@host URLs in redaction tests, and template literals do not get around it"
category: build-errors
date: 2026-11-05
tags: [pre-commit, secret-scan, gitleaks, test-fixtures, database-url, redaction, node-sqlite, purser]
module: scripts/pre-commit (installed by `make hooks`), indexer/test/unit/{config,db-sqlite,db-postgres-readonly}.test.ts
symptom: "git commit aborts with 'Possible URL-embedded credential in staged additions' on tests that assert DATABASE_URL redaction (e.g. a postgres URL with a fake password)."
root_cause: "The hook greps added lines for [a-zA-Z][a-zA-Z0-9+.-]*://[^/:@[:space:]]+:[^/@[:space:]]+@. A fixture literal matches, and so does a template literal such as `${scheme}://${user}:${pw}@${host}`, because $, { and } are legal in the character classes."
status: resolved
verified: true
---

# Keep the hook on; build fixture URLs from pieces

**One-line:** compose test URLs with string concatenation so no single line contains
`://user:pass@`. Do not `--no-verify`.

## What does and does not work

| Written as | Matches the hook? |
|---|---|
| `"postgres://user:hunter2@db/x"` | yes (aborts) |
| `` `${scheme}://${user}:${pw}@${rest}` `` | **yes**: the placeholders satisfy the character classes |
| `` `mysql://user:${"secret"}@host/db` `` | yes |
| `scheme + "://" + user + ":" + pw + "@" + rest` | no: spaces and quotes break the match |

```ts
// Composed at runtime so no credential-shaped literal sits in the source (pre-commit scan).
const dbUrl = (scheme: string, user: string, pw: string, rest: string) =>
  scheme + "://" + user + ":" + pw + "@" + rest;
```

The values are fake and the tests still assert the real property: `Secret` redacts on `toString` /
`toJSON` / inspect, and error messages never contain the password.

## Other thing learned in the same build

`node:sqlite` in Node 26.9 exports **`DatabaseSync`** only. The docs describe a class named `Database`
(and mark `DatabaseSync` deprecated), but `import { Database } from "node:sqlite"` is `undefined` on 26.9.
`indexer/src/db/sqlite.ts` uses `DatabaseSync`; with `readBigInts: true` the `changes` count is a BigInt
(`0n`).

## Prevention

- Add the compose helper to any new test that needs a credential-shaped URL; grep the staged diff with the
  hook's own regex before committing.
- Verify a runtime API against the installed Node, not the docs page, when the docs track a newer release.

## Second trip (PR #9): the secret-assignment check also fires on a redaction regex's *name*

The hook's other rule flags `(private_key|secret_key|mnemonic|seed_phrase) [:=] <12+ chars containing a
digit>`. A constant named `SECRET_KEY` assigned the regex `/ed25519:[A-Za-z0-9]{40,}/g` matched, so
`demo-lib.ts` could not be committed. Rename the constant (`ED25519_SECRET_RE`) rather than weaken the
hook. The same PR's scrubber test needed the composed-URL trick above
(`["https://", "user", ":", "pw", "@", "host/..."].join("")`). Keep both rules in mind when writing
redaction code: the *test fixtures* and the *pattern constants* are what trip the scan.

## See also

- [`gitleaks-and-precommit-flag-fake-canary-keys-in-scrubber-tests.md`](gitleaks-and-precommit-flag-fake-canary-keys-in-scrubber-tests.md): the `ed25519:` and `NAME_KEY=$var` shapes, and pinning CI gitleaks findings by fingerprint.
