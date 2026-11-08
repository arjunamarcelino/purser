#!/usr/bin/env bash
# Seeded-violation self-test for audit-security.sh: each fixture dir must fail naming its rule;
# the clean fixture must pass. Fixture dir name -> expected rule below.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIT="$HERE/audit-security.sh"
FIX="$HERE/audit-fixtures"
fail=0

check_fails() { # dir rule
  local out rc=0
  out="$("$AUDIT" "$FIX/$1" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then echo "FAIL $1: audit passed but should have failed"; fail=1
  elif ! printf '%s\n' "$out" | grep -q "VIOLATION $2:"; then
    echo "FAIL $1: exit $rc but did not name $2"; printf '%s\n' "$out"; fail=1
  else echo "ok   $1 -> $2"; fi
}

check_fails missing_private S3
check_fails missing_private_multiline S3
check_fails ungated_mut S2
check_fails promise_before_reserve S4
check_fails extra_sign_site S1
check_fails extra_sign_call S1
check_fails payable S8
check_fails secret_literal S7
check_fails near_bindgen_ungated S2
check_fails qualified_payable S8
check_fails dead_gate S2
check_fails promise_between_reserves S4
check_fails zero_near_impl S2

if "$AUDIT" "$FIX/clean" >/dev/null 2>&1; then echo "ok   clean passes"
else echo "FAIL clean: audit rejected the clean fixture"; "$AUDIT" "$FIX/clean" || true; fail=1; fi

[ "$fail" -eq 0 ] && echo "audit-security-selftest: OK" || { echo "audit-security-selftest: FAILED"; exit 1; }
