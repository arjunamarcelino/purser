---
title: "A bash script hung for an hour: an unquoted awk `BEGIN{printf ..., ...}` was brace-expanded and awk waited on stdin"
category: build-errors
date: 2026-11-06
tags: [bash, awk, brace-expansion, hang, set-e, pipelines, macos, bash-3.2, purser]
module: scripts/evm-spike.sh
symptom: "`make evm-spike | tail -60` produced no output and never finished. `ps` showed `bash scripts/evm-spike.sh` at 0% CPU with one child: `awk BEGINprintf \"%.2f\"`."
root_cause: "The size-delta line was `\"$(awk \"BEGIN{printf \\\"%.2f\\\", ($s-$b)*100/$b}\")\"` inside double quotes in a `printf` argument list. The unquoted-in-effect `{...,...}` was brace-expanded by bash, so awk received `BEGINprintf` and a stray argument instead of a program, treated the first as the program and sat reading stdin forever."
status: resolved
verified: true
---

# Quote awk programs in single quotes and pass values with -v

```bash
# hangs: bash brace-expands BEGIN{printf ..., ...} (a comma inside braces)
"$(awk "BEGIN{printf \"%.2f\", ($s-$b)*100/$b}")"

# works
pct="$(awk -v s="$s" -v b="$b" 'BEGIN { printf "%.2f", (s - b) * 100 / b }')"
```

This is the same trap `scripts/deploy-testnet.sh` already documents for JSON args (macOS bash 3.2 mangles
escaped quotes inside `"$(...)"` and brace-expands the commas). Rule: any program text containing `{` and `,`
goes in single quotes, never assembled inside double quotes.

## The second lesson: do not hide a long script's progress behind `| tail`

The host tests and both wasm builds had finished in the first minutes; the hang was at step 2's last line. Piping
the whole run through `| tail -60` buffered everything, so it looked like a slow build for an hour. For anything
that may take minutes, write to a file and read it (`> out.txt 2>&1`), or stream it; use `ps -o pid,ppid,stat,
etime,command` and look for a child at 0% CPU to find the stuck command.

## Prevention

- shellcheck does not flag this (it is valid bash); review any `$(awk ...)` for quote style.
- A script step that can block on stdin (awk, sed with a missing file, `cat`) should have `< /dev/null` or be
  written with `-v` and single quotes so a missing program fails fast instead of hanging.
- Scripts that check a result by a hard-coded count (`'2 passed'`) drift when a test is added; require "at
  least one passed and 0 failed" instead (see [[verdict-refactor-copied-the-wrong-constant-into-its-tests]]).
