#!/usr/bin/env node
// Generate the EIP-1559 sighash reference vectors for the EVM feasibility spike.
//
//   node scripts/evm-spike-vectors.mjs --tools <dir> [--out contract/tests/fixtures/evm-spike-vectors.json]
//
// <dir> is a SCRATCH directory holding `npm install --ignore-scripts --save-exact viem chainsig.js`
// (versions are written into the output). Nothing here is a repo dependency, and nothing touches
// a network: chainsig.js' EVM adapter only calls `getChainId()` when gas, both fee fields and the
// nonce are supplied, so a stub client is enough.
//
// Each vector's `sighash` comes from the REAL chainsig.js `prepareTransactionForSigning`
// (viem.serializeTransaction -> keccak256), and is asserted equal to viem used directly.

import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { tools: { type: "string" }, out: { type: "string", default: "contract/tests/fixtures/evm-spike-vectors.json" } } });
if (!values.tools) throw new Error("usage: evm-spike-vectors.mjs --tools <scratch dir with viem + chainsig.js>");
const req = createRequire(join(resolve(values.tools), "package.json"));
const viem = req("viem");
const { chainAdapters } = req("chainsig.js");
const version = (name) => JSON.parse(readFileSync(join(resolve(values.tools), "node_modules", name, "package.json"), "utf8")).version;

const SEPOLIA = 11155111n;
const U64 = (1n << 64n) - 1n;
// viem takes chainId and nonce as JS numbers, so the reference path stops at 2^53 - 1 for those two fields.
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const U128 = (1n << 128n) - 1n;
const addr = (byte) => `0x${byte.toString(16).padStart(2, "0").repeat(20)}`;

// Named edge cases around the integer boundaries (0, <0x80, 0x80, 0xff, 0x100) and the u64/u128 limits.
const named = [
  ["typical Sepolia transfer", { chainId: SEPOLIA, nonce: 7n, maxPriorityFeePerGas: 1_500_000_000n, maxFeePerGas: 30_000_000_000n, gas: 21000n, to: addr(0x11), value: 10n ** 16n }],
  ["zero nonce and zero value", { chainId: SEPOLIA, nonce: 0n, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gas: 21000n, to: addr(0x22), value: 0n }],
  ["all small values", { chainId: SEPOLIA, nonce: 1n, maxPriorityFeePerGas: 1n, maxFeePerGas: 1n, gas: 1n, to: addr(0x33), value: 1n }],
  ["nonce 127 (last single-byte)", { chainId: SEPOLIA, nonce: 127n, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gas: 21000n, to: addr(0x44), value: 127n }],
  ["nonce 128 (first prefixed)", { chainId: SEPOLIA, nonce: 128n, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gas: 21000n, to: addr(0x55), value: 128n }],
  ["255 / 256 boundary", { chainId: SEPOLIA, nonce: 255n, maxPriorityFeePerGas: 255n, maxFeePerGas: 256n, gas: 256n, to: addr(0x66), value: 256n }],
  ["zero fees", { chainId: SEPOLIA, nonce: 3n, maxPriorityFeePerGas: 0n, maxFeePerGas: 0n, gas: 21000n, to: addr(0x77), value: 5n }],
  ["Ethereum mainnet chain id", { chainId: 1n, nonce: 9n, maxPriorityFeePerGas: 2_000_000_000n, maxFeePerGas: 50_000_000_000n, gas: 21000n, to: addr(0x88), value: 10n ** 18n }],
  ["max safe-integer nonce and chain id, max u64 gas", { chainId: SAFE, nonce: SAFE, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gas: U64, to: addr(0x99), value: 1n }],
  ["max u128 fees and value", { chainId: SEPOLIA, nonce: 1n, maxPriorityFeePerGas: U128, maxFeePerGas: U128, gas: 21000n, to: addr(0xaa), value: U128 }],
  ["to has leading zero bytes", { chainId: SEPOLIA, nonce: 2n, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gas: 21000n, to: "0x0000000000000000000000000000000000000001", value: 1n }],
  ["to has trailing zero bytes", { chainId: SEPOLIA, nonce: 2n, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gas: 21000n, to: "0x1000000000000000000000000000000000000000", value: 1n }],
];

// Deterministic pseudo-random vectors (xorshift64*), so regeneration is reproducible.
let state = 0x9e3779b97f4a7c15n;
const next = () => {
  state ^= state >> 12n;
  state ^= (state << 25n) & U64;
  state ^= state >> 27n;
  return (state * 0x2545f4914f6cdd1dn) & U64;
};
const bits = (maxBits) => next() >> BigInt(64 - Math.min(64, Math.max(1, Number(next() % BigInt(maxBits)) + 1)));
const big = (maxBits) => (maxBits <= 64 ? bits(maxBits) : (bits(64) << 64n | next()) >> BigInt(128 - maxBits));
const randomAddr = () => `0x${[...Array(20)].map(() => Number(next() & 0xffn).toString(16).padStart(2, "0")).join("")}`;
// viem (rightly) rejects a tip above the fee cap, so the tip is the smaller of two draws.
const random = [...Array(24)].map((_, i) => {
  const a = big(100);
  const b = big(120);
  const [tip, cap] = a <= b ? [a, b] : [b, a];
  return [`random ${i + 1}`, { chainId: bits(40) + 1n, nonce: bits(48), maxPriorityFeePerGas: tip, maxFeePerGas: cap, gas: bits(32), to: randomAddr(), value: big(125) }];
});

// The real chainsig.js adapter, with a stub client: with gas, both fees and nonce supplied, it only
// calls getChainId().
// A zero fee is falsy in the adapter, so it asks the client for fees; the stub answers with the vector's own.
const current = { tx: null };
const adapter = new chainAdapters.evm.EVM({
  publicClient: {
    getChainId: async () => current.tx.chainId,
    estimateFeesPerGas: async () => ({ maxFeePerGas: current.tx.maxFeePerGas, maxPriorityFeePerGas: current.tx.maxPriorityFeePerGas }),
  },
  contract: {},
});

const vectors = [];
for (const [name, tx] of [...named, ...random]) {
  current.tx = tx;
  const { transaction, hashesToSign } = await adapter.prepareTransactionForSigning({ from: addr(0xee), ...tx });
  const sighash = viem.bytesToHex(Uint8Array.from(hashesToSign[0]));
  // Same thing with viem directly: the adapter is not trusted blindly.
  const serialized = viem.serializeTransaction({ type: "eip1559", chainId: Number(tx.chainId), nonce: Number(tx.nonce), maxPriorityFeePerGas: tx.maxPriorityFeePerGas, maxFeePerGas: tx.maxFeePerGas, gas: tx.gas, to: tx.to, value: tx.value });
  if (viem.keccak256(serialized) !== sighash) throw new Error(`${name}: chainsig.js adapter and viem disagree`);
  if (transaction.type !== "eip1559") throw new Error(`${name}: not an EIP-1559 transaction`);
  if (!serialized.startsWith("0x02")) throw new Error(`${name}: missing the 0x02 type byte`);
  vectors.push({
    name,
    chain_id: tx.chainId.toString(),
    nonce: tx.nonce.toString(),
    max_priority_fee_per_gas: tx.maxPriorityFeePerGas.toString(),
    max_fee_per_gas: tx.maxFeePerGas.toString(),
    gas_limit: tx.gas.toString(),
    to: tx.to,
    value: tx.value.toString(),
    unsigned_serialized: serialized, // 0x02 || rlp([...])
    sighash,
  });
}

const out = {
  generator: "scripts/evm-spike-vectors.mjs",
  tools: { viem: version("viem"), "chainsig.js": version("chainsig.js") },
  note: "sighash = chainsig.js EVM prepareTransactionForSigning (viem.serializeTransaction -> keccak256); data is empty and the access list is empty in every vector; chain_id and nonce are limited to 2^53-1 by viem's JS-number API (full u64 is covered by the Rust property test against the rlp crate)",
  vectors,
};
writeFileSync(values.out, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${vectors.length} vectors to ${values.out} (viem ${out.tools.viem}, chainsig.js ${out.tools["chainsig.js"]})`);
