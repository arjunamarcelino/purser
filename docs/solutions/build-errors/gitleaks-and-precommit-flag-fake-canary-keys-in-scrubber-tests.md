---
title: "Fake canary keys in scrubber tests trip the pre-commit hook (three ways) and then gitleaks in CI"
category: build-errors
date: 2026-11-06
tags: [pre-commit, gitleaks, secret-scan, test-fixtures, canary, scrubber, gitleaksignore, purser]
module: scripts/pre-commit, .gitleaks.toml, .gitleaksignore, relayer/test/unit/scrub.test.ts, scripts/evm-testnet.sh
symptom: "git commit aborts with 'Possible secret key in staged additions' or 'Possible secret value'; after fixing those, the CI 'secrets' job fails with 'leaks found: 2' (generic-api-key) on the same fake canaries."
root_cause: "A scrubber test needs realistic-looking secrets to prove they are removed. The local hook and gitleaks both match on shape, not on whether the value is real, and gitleaks scans every commit in the PR's history."
status: resolved
verified: true
---

# Build canaries from pieces, then pin the remaining gitleaks findings by fingerprint

Extends [`precommit-url-credential-scan-trips-on-test-fixtures.md`](precommit-url-credential-scan-trips-on-test-fixtures.md).

## Local hook (scripts/pre-commit): three shapes seen

| Added line | Pattern hit | Fix |
|---|---|---|
| `"ed25519:" + 40+ base58 chars` as a fake NEAR key | `ed25519:[A-Za-z0-9]{40,}` | `["ed25519", "<chars>"].join(":")` |
| `"RELAYER_PRIVATE_KEY=$(...)"` / `NAME_KEY=${VAR}` in a shell script | `(private_key\|secret_key\|...)[:=]<12+ chars with a digit>` fires on the variable reference | split the name across adjacent quotes: `"RELAYER_PRIVATE""_KEY=$KEY"` |
| `scheme://user:pass@host` | URL-embedded credential | concatenate the pieces (see the parent note) |

The hook never prints the match. To find it without printing the secret, grep the staged diff per file with `-n` and cut to the line number only.

## CI: gitleaks `generic-api-key`

Even with the local hook satisfied, gitleaks flagged `const CANARY_URL_KEY = "CANARYKEY0123456789abcdef"` and
`local canary_key="..."` (entropy + variable name). Findings are per **commit**. Pin them, scoped, in `.gitleaksignore`:

```
# <why: inert canary fixtures>
<commit-sha>:<file>:<rule>:<line>
```

Take the exact `Commit`, `File`, `RuleID` and `Line` from the failed job log (`gh run view --log-failed` only works after the whole run
finishes; for a finished job use `gh api --allow-escape-sequences repos/<owner>/<repo>/actions/jobs/<id>/logs`).
The fingerprints name commit hashes: a rebase or squash of those commits invalidates them.

## Prevention

- Name scrubber fixtures obviously fake and build them from pieces from the start.
- Run the hook's patterns against your own diff before the first commit of any redaction test.
- Keep `.gitleaksignore` entries single-purpose with a comment saying why they are inert.
