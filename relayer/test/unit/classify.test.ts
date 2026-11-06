import { describe, expect, it } from "vitest";
import { classifyBroadcastError, type BroadcastClass } from "../../src/evm.ts";

// Messages as each execution client words them (JSON-RPC error.message, possibly wrapped by viem).
const FIXTURES: Array<[client: string, message: string, expected: BroadcastClass]> = [
  ["geth", "already known", "Pending"],
  ["geth", "nonce too low: next nonce 7, tx nonce 3", "Landed"],
  ["geth", "replacement transaction underpriced", "Underpriced"],
  ["geth", "transaction underpriced: tip needed 1000000, tip permitted 1", "Underpriced"],
  ["geth", "insufficient funds for gas * price + value: balance 0, tx cost 21000, overshot 21000", "Rejected"],
  ["geth", "intrinsic gas too low: have 20999, want 21000", "Rejected"],
  ["erigon", "ALREADY_EXISTS: already known", "Pending"],
  ["erigon", "nonce too low", "Landed"],
  ["erigon", "INSUFFICIENT_FUNDS: insufficient funds", "Rejected"],
  ["nethermind", "AlreadyKnown", "Pending"],
  ["nethermind", "OldNonce, Nonce too low", "Landed"],
  ["nethermind", "ReplacementNotAllowed, Replacement not allowed", "Underpriced"],
  ["nethermind", "InsufficientFunds", "Rejected"],
  ["besu", "Known transaction", "Pending"],
  ["besu", "NONCE_TOO_LOW", "Landed"],
  ["besu", "REPLACEMENT_UNDERPRICED", "Underpriced"],
  ["reth", "already known", "Pending"],
  ["reth", "nonce too low", "Landed"],
  ["reth", "insufficient funds for gas * price + value", "Rejected"],
  ["any", "internal error", "Unknown"],
  ["any", "", "Unknown"],
  ["any", "HTTP request failed. Status: 502", "Unknown"],
];

describe("classifyBroadcastError", () => {
  for (const [client, message, expected] of FIXTURES) {
    it(`${client}: ${JSON.stringify(message)} -> ${expected}`, () => {
      expect(classifyBroadcastError(new Error(message))).toBe(expected);
    });
  }

  it("reads viem-style wrapped errors (details/shortMessage/cause)", () => {
    const inner = Object.assign(new Error("RPC Request failed."), { details: "nonce too low: next nonce 4" });
    const outer = Object.assign(new Error("boom"), { cause: inner });
    expect(classifyBroadcastError(outer)).toBe("Landed");
  });

  it("never classifies an unrecognised failure as a definite rejection", () => {
    for (const m of ["timeout", "socket hang up", "execution reverted", "weird"]) expect(classifyBroadcastError(new Error(m))).toBe("Unknown");
    expect(classifyBroadcastError(undefined)).toBe("Unknown");
  });

  it("prefers the replacement text over generic words", () => {
    expect(classifyBroadcastError(new Error("replacement transaction underpriced: nonce too low? already known"))).toBe("Underpriced");
  });
});
