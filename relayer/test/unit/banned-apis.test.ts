import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The relayer holds no EVM key and never builds, prices or signs a transaction: the contract does.
const BANNED = /estimateFeesPerGas|estimateGas|prepareTransactionRequest|sendTransaction\b|signTransaction|privateKeyToAccount|createWalletClient|eth_sendTransaction|eth_signTransaction/;
const SRC = join(import.meta.dirname, "../../src");

describe("banned viem surface", () => {
  it("src/ uses none of the fee-estimation, preparation or signing APIs", () => {
    for (const f of readdirSync(SRC)) expect(readFileSync(join(SRC, f), "utf8"), f).not.toMatch(BANNED);
  });
});
