---
title: "Adding a feature-gated `mod` near the top of lib.rs changed the default wasm by 11 bytes: panic locations embed line numbers"
category: build-errors
date: 2026-11-06
tags: [wasm, reproducibility, byte-identical, panic-location, line-numbers, cargo-near, no-abi, nep-330, purser]
module: contract/src/lib.rs, contract/src/evm_spike.rs, scripts/evm-spike.sh
symptom: "After adding `#[cfg(feature = \"evm-spike\")] mod evm_spike;` two lines from the top of lib.rs, the default-feature wasm kept its size (256,506 B) but its sha256 changed (89163ed6… -> dbe11707…), and the generated ABI changed too, in `metadata.wasm_hash` only. The feature was off, so nothing should have changed."
root_cause: "Rust embeds `file:line:col` panic locations (for expect/unwrap/index panics) in the wasm data section. Inserting two lines near the top shifted every later line by 2, so 11 single-byte line numbers in the data section changed (e.g. 0x5c -> 0x5e). The code, type, function, export and import sections were byte-identical."
status: resolved
verified: true
---

# Declare the feature-gated module LAST, and compare like with like

**One-line:** any source edit above a panic site changes the shipped wasm bytes. To keep a "default build is
unchanged" claim byte-for-byte, put new `#[cfg(feature = ...)] mod x;` lines at the END of `lib.rs`.

## How it was diagnosed

Same size, different hash, so do not guess: parse the sections and hash each.

```python
# per-section hashes of two wasm files (section id, custom-section name, length, sha256 prefix)
def leb(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1; r |= (x & 0x7f) << s; s += 7
        if not x & 0x80: return r, i
# walk: id = b[i]; size, i = leb(...); body = b[i:i+size]; hash(body)
```

Result: every section identical except the data section (id 11), same length, 11 bytes different. Printing
the surrounding text showed panic-location records, each line number up by exactly 2 (the two inserted
lines). The ABI JSON differed only in `metadata.wasm_hash`, which confirmed the methods were untouched.

## Fix

```rust
// lib.rs: LAST in the file, so no earlier line number shifts.
#[cfg(feature = "evm-spike")]
mod evm_spike;
```

After the move the default wasm (`89163ed6…`) and ABI (`893038c6…`) were byte-identical to the pre-change
build. A comment-only edit that keeps the line count is also safe; verify with `cmp`.

## Related traps found on the way

- **A `--no-abi` build is not comparable to the shipped one.** The shipped build embeds the compressed ABI as
  a custom section: 256,506 B shipped vs 248,081 B with `--no-abi` (8,425 B). Comparing a spike built with
  `--no-abi` against the shipped size made the spike look smaller than the baseline. Build the baseline the
  same way (`CARGO_TARGET_DIR=... cargo near build non-reproducible-wasm --no-abi`).
- cargo-near sets `NEP330_BUILD_INFO_BUILD_COMMAND` while building, so use the identical command line when
  comparing hashes (it was not the cause here: the hash still differed with the exact command).
- `cargo near build` has no target-dir flag; set `CARGO_TARGET_DIR` (the test harness does the same through
  `override_cargo_target_dir`) so an experimental build cannot overwrite `target/near/purser_contract*`.
- Copy `Cargo.lock` into any scratch copy of the crate. Without it a fresh resolution picked a newer
  `near-sys` than `near-sdk =5.30.0` expects and failed inside near-sdk with
  `cannot find function universal_state_init_to_account_id in crate sys`.

## Prevention

- Put the check in the reproduction script: `cmp` the default wasm and ABI against a build made before the
  change, and keep the section-diff snippet handy for when they differ.
- Treat "the default build is byte-identical" as a claim that needs a fresh build and a `cmp`, not as a
  consequence of the feature being off.
