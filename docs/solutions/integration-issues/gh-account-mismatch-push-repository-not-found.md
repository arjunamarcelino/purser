---
title: "`git push` → 'Repository not found' caused by a `gh` account mismatch"
category: integration-issues
date: 2026-11-03
tags: [git, github, gh-cli, auth, push, private-repo, credential-helper, 404, multi-account]
module: git / github remote
symptom: "`git push -u origin <branch>` fails with 'remote: Repository not found' / 'fatal: repository ... not found' even though the repo was cloned successfully before"
root_cause: "The active `gh` account (used as git's credential helper) was a different GitHub account than the one with access to the private repo; GitHub returns 404 (not 403) for a private repo the token can't see"
status: resolved
verified: true
---

# `git push` → "Repository not found" from a `gh` account mismatch

## Symptom

A push to an existing, previously-cloned private repo fails:

```
remote: Repository not found.
fatal: repository 'https://github.com/arjunamarcelino/purser.git/' not found
```

`origin` is set correctly and `origin/main` was fetched in the past (the clone worked), so the repo
clearly exists — yet the push 404s.

## Investigation (what was ruled out)

- **Repo exists.** `git branch -r` shows `origin/main` and `git rev-parse origin/main` resolves — the
  repo was reachable at clone time.
- **`gh` is authenticated** — `gh auth status` shows a logged-in account with `repo` scope.
- **But the authenticated account can't see the repo:**
  ```
  gh api repos/arjunamarcelino/purser  →  404 Not Found
  gh repo view arjunamarcelino/purser  →  "Could not resolve to a Repository ..."
  ```
  The active `gh` account was `arjunamarcelino-orb`, while the remote owner is `arjunamarcelino` —
  **two different GitHub accounts.** git-over-HTTPS uses `gh` as its credential helper
  (`credential.https://github.com.helper = !gh auth git-credential`), so it pushed with the wrong
  account's token.

## Root cause

GitHub returns **404 "Repository not found"** (not 403 Forbidden) when a token lacks access to a
**private** repo — this avoids leaking the existence of private repos. So an *auth/account* problem
masquerades as a *missing repo* problem. Here the machine had **two** `gh` accounts in the keyring,
and the active one (`arjunamarcelino-orb`) had no access to the private `arjunamarcelino/purser`.

## Solution (verified)

Switch `gh` to the account that owns / can access the repo, then push:

```bash
# see all stored accounts (there can be more than one)
gh auth status            # lists each account + which is Active

# switch the active account (no re-login if the token is already stored)
gh auth switch --user arjunamarcelino

# confirm access, then push
gh api repos/<owner>/<repo> --jq .full_name     # should NOT 404
git push -u origin <branch>                      # now succeeds
```

If the correct account is **not** already in the keyring, log in first (interactive):

```bash
gh auth login            # choose the account with repo access
```

In this session `gh auth switch --user arjunamarcelino` was enough — the account was already stored,
just not active — after which `git push` and `gh pr create --base main` both succeeded.

## Prevention

- When a push/clone 404s on a repo you *know* exists, suspect **auth/account**, not a deleted repo —
  especially for private repos where 404 == "no access".
- On multi-account machines, check `gh auth status` and confirm the **Active** account matches the
  remote's owner before pushing. Consider `gh auth switch` as the first diagnostic.
- `gh api repos/<owner>/<repo>` is a fast access probe: a 404 there (while the repo exists) pinpoints
  the account mismatch immediately.
- Because git uses `gh` as the HTTPS credential helper here, the *active* `gh` account is what
  authenticates pushes — switching `gh` accounts changes git's push identity too.
- **The switch does not reliably persist across shells/sessions.** Observed 2026-11-03: a fresh
  shell had the active account back on `arjunamarcelino-orb`, so **every** `git push` to this repo
  had to be preceded by `gh auth switch --user arjunamarcelino`. Treat the switch as a per-push
  step (or make it permanent — e.g. set `arjunamarcelino` as the default `gh` account, or set a
  repo-local `credential.https://github.com.username = arjunamarcelino`) so pushes stop 404-ing.
  Fast re-probe before pushing: `gh api repos/arjunamarcelino/purser --jq .full_name` (must not 404).

## Cross-references

- `git remote -v`, `gh auth status`, `gh auth switch`, `gh auth login`.
- Related: the repo's commits are authored by `arjunamarcelino <arjunamarcelino@gmail.com>`; pushes
  must use the `arjunamarcelino` GitHub account (not `arjunamarcelino-orb`).

> Note: this repo keeps `docs/` untracked (per the scaffold-only commit policy), so this solution
> file is uncommitted like the other `docs/solutions/` entries. Commit it if/when `docs/` is tracked.

## Recurrence (2026-11-05)

It came back mid-session: the active `gh` account silently flipped to `arjunamarcelino-orb` between two
pushes of the same branch (`git push` → "Repository not found"). The fix is unchanged
(`gh auth switch --user arjunamarcelino`). **Prevention:** check `gh auth status` (look for
`arjunamarcelino` with `Active account: true`) immediately before every push or `gh pr` command,
not just once per session.
