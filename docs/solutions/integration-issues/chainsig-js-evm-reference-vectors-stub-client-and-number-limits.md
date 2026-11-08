---
title: "Generating EVM sighash reference vectors from the real chainsig.js adapter: stub the client, mind the JS-number limits"
category: integration-issues
date: 2026-11-06
tags: [chainsig.js, viem, eip-1559, test-vectors, rlp, keccak, stub, javascript-number, purser]
module: scripts/evm-spike-vectors.mjs, contract/tests/fixtures/evm-spike-vectors.json
symptom: "Writing reference vectors for the contract's EIP-1559 sighash failed three ways: viem rejected `maxPriorityFeePerGas > maxFeePerGas`, a `u64::MAX` chain id/nonce threw `IntegerOutOfRangeError`, and the chainsig.js adapter called `estimateFeesPerGas()` (an RPC) only for the zero-fee vector."
root_cause: "chainsig.js `EVM.prepareTransactionForSigning` = `attachGasAndNonce` -> `viem.serializeTransaction` -> `keccak256`. `attachGasAndNonce` uses truthiness (`t.maxFeePerGas && t.maxPriorityFeePerGas`), so a `0n` fee is falsy and triggers an RPC fallback. viem takes `chainId` and `nonce` as JS numbers (limit 2^53 - 1), and validates the tip against the cap."
status: resolved
verified: true
---

# The adapter is usable offline with a stub, and it is the right oracle

The hash the relayer will sign is exactly what the real adapter computes, so generate vectors from it, not from
a re-implementation.

```js
const { chainAdapters } = require("chainsig.js");        // resolved only from the scratch --tools dir
const adapter = new chainAdapters.evm.EVM({
  publicClient: {
    getChainId: async () => current.tx.chainId,           // the only call when gas, fees and nonce are supplied
    estimateFeesPerGas: async () => ({ ...current.tx fees }), // a 0n fee is falsy => the adapter asks the client
  },
  contract: {},
});
const { hashesToSign } = await adapter.prepareTransactionForSigning({ from, chainId, nonce, gas, maxFeePerGas, maxPriorityFeePerGas, to, value });
```

Also assert it equals `keccak256(viem.serializeTransaction({ type: "eip1559", ... }))` used directly, and that the
serialization starts with `0x02`.

## Limits to design around

- `chainId` and `nonce` are JS numbers in viem: the reference path stops at 2^53 - 1 for those two fields. Use
  `Number.MAX_SAFE_INTEGER` in the vectors and cover the full `u64` range with a property test against the
  parity `rlp` crate instead.
- viem refuses `tip > cap`. The contract's encoder does not, so the vectors are all valid transactions and the
  encoder's lack of validation must be stated (and enforced by the caller) separately.
- `gas`, fees and `value` are `bigint`, so `u64`/`u128` maxima are fine there.

## Tooling hygiene

- Install in a scratch directory: `npm install --ignore-scripts --save-exact viem@x chainsig.js@y`; nothing enters
  `pnpm-workspace`. Resolve packages only from `<tools>/node_modules` (the script fails otherwise) and record
  the loaded versions plus `package.json` hashes in the fixture header.
- Generate deterministic pseudo-random vectors (xorshift64*) so regeneration is reproducible.
- Vector sizes 33-84 bytes cover both RLP list-header forms (short <= 55, long above).
