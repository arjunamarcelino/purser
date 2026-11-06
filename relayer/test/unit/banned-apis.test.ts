import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// The relayer holds no EVM key and never builds, prices or signs a transaction: the contract does. Any of
// these would re-introduce relayer-side pricing, preparation, simulation or signing.
const BANNED = new RegExp(
  [
    "getGasPrice",
    "estimateMaxPriorityFeePerGas",
    "getFeeHistory",
    "estimateFeesPerGas",
    "estimateGas",
    "prepareTransactionRequest",
    "sendTransaction\\b",
    "signTransaction",
    "signMessage",
    "signTypedData",
    "privateKeyToAccount",
    "mnemonicToAccount",
    "hdKeyToAccount",
    "createWalletClient",
    "walletClient",
    "writeContract",
    "simulateContract",
    "eth_gasPrice",
    "eth_maxPriorityFeePerGas",
    "eth_feeHistory",
    "eth_estimateGas",
    "eth_sendTransaction",
    "eth_signTransaction",
    "eth_sign\\b",
    "eth_call",
  ].join("|"),
);
const SRC = join(import.meta.dirname, "../../src");

/** Every file under `dir`, recursively. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}
const files = walk(SRC);

// The adapter's whole surface, spelled out. Anything else is a new capability that needs a deliberate review.
const ALLOWED_VIEM_IMPORTS = new Set(["createPublicClient", "http", "keccak256", "parseTransaction", "recoverTransactionAddress", "Hex", "TransactionSerialized"]);
const ALLOWED_CLIENT_CALLS = new Set(["getChainId", "getTransactionReceipt", "getBlock", "getTransactionCount", "getCode", "getBalance", "sendRawTransaction"]);

describe("banned viem surface", () => {
  it("walks every file under src/ (recursively), not just the top level", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(files.some((f) => relative(SRC, f) === "evm.ts")).toBe(true);
  });

  it("src/ uses none of the fee-estimation, preparation, simulation or signing APIs", () => {
    for (const f of files) expect(readFileSync(f, "utf8"), relative(SRC, f)).not.toMatch(BANNED);
  });

  it("the pattern really catches each banned API (it cannot pass by construction)", () => {
    for (const name of [
      "getGasPrice", "estimateMaxPriorityFeePerGas", "getFeeHistory", "eth_gasPrice", "eth_maxPriorityFeePerGas", "estimateFeesPerGas",
      "prepareTransactionRequest", "sendTransaction(", "walletClient", "estimateGas", "signTransaction", "privateKeyToAccount", "createWalletClient",
      "writeContract", "simulateContract", "eth_call", "signMessage",
    ]) {
      expect(`client.${name}()`, name).toMatch(BANNED);
    }
    expect("sendRawTransaction").not.toMatch(BANNED);
    expect("getTransactionReceipt getBlock getTransactionCount getCode getBalance getChainId").not.toMatch(BANNED);
  });

  it("only the allow-listed viem imports are used", () => {
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"(viem(?:\/[^"]*)?)"/g)) {
        expect(m[2], `${relative(SRC, f)}: only the root "viem" module`).toBe("viem");
        for (const raw of (m[1] ?? "").split(",")) {
          const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0] ?? "";
          if (name !== "") expect(ALLOWED_VIEM_IMPORTS.has(name), `${relative(SRC, f)} imports ${name} from viem`).toBe(true);
        }
      }
      expect(text, relative(SRC, f)).not.toMatch(/from\s+"viem\/(accounts|actions|chains)/);
    }
  });

  it("the adapter calls only the allow-listed client methods", () => {
    const adapter = readFileSync(join(SRC, "evm.ts"), "utf8");
    const calls = new Set([...adapter.matchAll(/this\.#client\.(\w+)\(/g)].map((m) => m[1] as string));
    expect(calls.size).toBeGreaterThan(0);
    for (const c of calls) expect(ALLOWED_CLIENT_CALLS.has(c), `this.#client.${c}`).toBe(true);
  });
});
