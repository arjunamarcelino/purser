---
title: "Extracting verdict logic into pure functions passed 88 unit tests and still failed the live run: the tests copied the same wrong constant"
category: logic-errors
date: 2026-11-05
tags: [testing, refactor, pure-functions, live-run, demo, units, purser]
module: proposer/src/dev/demo-lib.ts (judgeRace, judgeRetry, judgeInvariant), proposer/test/unit/demo-lib.test.ts
symptom: "Live demo: outcomes 2 and 3 FAIL with 'Remaining after the race was 30000000000000000000000, expected 3000000000000000000000' while the chain was correct (one admitted, two refused, final Remaining 10 units)."
root_cause: "A review todo asked for the pass/fail predicates to move out of main() into pure functions with tests. The extraction compared the post-race Remaining to 1 unit (`after !== unit`) where the story's end state is 10 units (40 -> 10). The unit tests were written from the function, passing `U` as `after`, so they asserted the same wrong value and stayed green."
status: resolved
verified: true
---

# A test derived from the code under test cannot catch that code's constant

**One-line:** when you extract a predicate, take the expected values from the spec (here DEMO-SCRIPT:
100 -> 70 -> 40 -> 10), not from the old inline code or the new function.

## Fix

- `judgeRace`: `after` must equal `10n * unit`; `judgeRetry` is called with `u(10n)`.
- Regression case that would have failed before: the old 1-unit value must make `judgeRace` fail.

```ts
// The story's end state is 10 units, not 1: the earlier 1-unit expectation must fail.
expect(judgeRace([win(5), ref(5, "t2"), ref(5, "t3")], 40n * U, U, U).pass).toBe(false);
```

## Prevention

- Re-run the **live** path after any refactor of verdict logic that "was only typechecked". The resolver
  agent said exactly that ("the live paths were only typechecked, never run"), and the live run found it.
- Prefer expected values spelled in the spec's own numbers (`40n * U`, `10n * U`) over a shared named
  constant that both the code and the test import.
- The same run is why the demo prints the observed value in every failure reason: the 10x gap was visible
  in the first failing line.

## Same family, second instance: a count hard-coded in a script (2026-11-06)

`scripts/evm-spike.sh` required `test result: ok. 2 passed` from the sandbox run. A parallel fix added a third
test and the script failed its own guard on a fully green run. A guard should assert the invariant ("at least one
test ran and 0 failed", `test result: ok\. [1-9][0-9]* passed; 0 failed`), not today's number. When fixes are
split across agents, each owning different files, the cross-file expectations (counts, names, markers) are
exactly what drifts: run the whole path once centrally before committing.
