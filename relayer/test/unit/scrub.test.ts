import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError, Secret, loadConfig } from "../../src/config.ts";
import { describeError, errorText, stderrLogger } from "../../src/log.ts";
import { Relayer } from "../../src/worker.ts";
import { FakeChain, FakeNear } from "./fakes.ts";
import { startRpcStub } from "./rpc-stub.ts";

const CANARY_URL_KEY = "CANARYKEY0123456789abcdef";
const CANARY_URL = `https://sepolia.rpc.example.invalid/v3/${CANARY_URL_KEY}`;
const CANARY_NEAR_KEY = ["ed25519", "5Jm8hxW6RZQ3bVYh2m9oPqNnTt4s7uXwKcLdEeFfGgHhJjKkMmNnPpQqRrSsTtUuVvWwXxYyZz11AAbbCCddEE"].join(":");

const ENV = {
  NEAR_NETWORK: "testnet",
  EVM_PURSER_CONTRACT_ID: "purser.example.testnet",
  RELAYER_ACCOUNT_ID: "relayer.example.testnet",
  RELAYER_PRIVATE_KEY: CANARY_NEAR_KEY,
  EVM_RPC_URL: CANARY_URL,
};

afterEach(() => vi.restoreAllMocks());

function captureStderr(): string[] {
  const written: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return written;
}

describe("secret hygiene", () => {
  it("config never prints the RPC URL or the key through any implicit conversion", () => {
    const cfg = loadConfig(ENV);
    for (const text of [JSON.stringify(cfg), inspect(cfg, { depth: 5 }), String(cfg.evmRpcUrls[0]), `${cfg.relayerKey}`]) {
      expect(text).not.toContain(CANARY_URL_KEY);
      expect(text).not.toContain(CANARY_NEAR_KEY);
    }
    expect(cfg.evmRpcUrls[0]?.reveal()).toBe(CANARY_URL);
    expect(cfg.evmRpcUrls[0]).toBeInstanceOf(Secret);
  });

  it("config errors never echo a value", () => {
    for (const bad of [{ EVM_RPC_URL: `http://x.invalid/${CANARY_URL_KEY}` }, { RELAYER_PRIVATE_KEY: `bad-${CANARY_URL_KEY}` }, { NEAR_NETWORK: "mainnet" }]) {
      try {
        loadConfig({ ...ENV, ...bad });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as Error).message).not.toContain(CANARY_URL_KEY);
      }
    }
  });

  it("refuses non-https EVM URLs, mainnet, relayer == operator, duplicate URLs", () => {
    expect(() => loadConfig({ ...ENV, EVM_RPC_URL: "http://rpc.example.invalid" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...ENV, NEAR_NETWORK: "mainnet" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...ENV, OPERATOR_ACCOUNT_ID: ENV.RELAYER_ACCOUNT_ID })).toThrow(ConfigError);
    expect(() => loadConfig({ ...ENV, EVM_RPC_URL_2: ENV.EVM_RPC_URL })).toThrow(ConfigError);
  });

  it("RELAYER_ALLOW_SINGLE_RPC_EVIDENCE is off unless exactly 1; anything else is refused", () => {
    expect(loadConfig(ENV).allowSingleRpcEvidence).toBe(false);
    expect(loadConfig({ ...ENV, RELAYER_ALLOW_SINGLE_RPC_EVIDENCE: "" }).allowSingleRpcEvidence).toBe(false);
    expect(loadConfig({ ...ENV, RELAYER_ALLOW_SINGLE_RPC_EVIDENCE: "0" }).allowSingleRpcEvidence).toBe(false);
    expect(loadConfig({ ...ENV, RELAYER_ALLOW_SINGLE_RPC_EVIDENCE: "1" }).allowSingleRpcEvidence).toBe(true);
    expect(() => loadConfig({ ...ENV, RELAYER_ALLOW_SINGLE_RPC_EVIDENCE: "yes" })).toThrow(ConfigError);
  });

  it("describeError returns a class and nothing else", () => {
    const err = Object.assign(new Error(`HTTP request failed.\n\nStatus: 429\nURL: ${CANARY_URL}`), { cause: new Error(`fetch failed ${CANARY_URL}`) });
    expect(describeError(err)).toBe("rate_limited");
    expect(describeError(new Error(`ECONNREFUSED ${CANARY_URL}`))).toBe("network");
    expect(describeError("whatever")).toBe("unknown");
  });

  it("a full run through the REAL viem adapter, whose own errors embed the canary URL, writes neither the URL nor the key to stderr", async () => {
    const written = captureStderr();
    const chain = new FakeChain();
    const near = new FakeNear();
    await near.addSigned(0, { maxFee: 100n });
    await near.addSigned(1, { maxFee: 100n });
    let failing = false;
    const stub = await startRpcStub(chain, { path: `/v3/${CANARY_URL_KEY}`, fail: () => (failing ? 500 : null) });
    try {
      const client = stub.client("provider#1");
      // Prove the premise: the adapter's own error text really carries the URL and its key.
      failing = true;
      const raw = await client.getFinalized().then(() => "", (e: unknown) => errorText(e));
      expect(raw).toContain(CANARY_URL_KEY);
      failing = false;

      const relayer = new Relayer({ near, evm: [client], log: stderrLogger });
      near.failCommitmentOnce.add(1);
      await relayer.tick();
      failing = true; // every read now fails inside viem, with the URL in its error
      await relayer.tick();
      near.failReadsWith = new Error(`HTTP request failed.\n\nStatus: 429\nURL: ${CANARY_URL}\nDetails: ${CANARY_NEAR_KEY}`, { cause: new Error(CANARY_URL) });
      await relayer.tick(); // scan failure is logged by class, not thrown
      near.failReadsWith = null;
      failing = false;
      chain.finalizeAll();
      await relayer.tick();
      await relayer.tick();
    } finally {
      await stub.close();
    }

    const out = written.join("");
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain(CANARY_URL_KEY);
    expect(out).not.toContain("CANARY");
    expect(out).not.toContain(CANARY_NEAR_KEY);
    expect(out).not.toContain("127.0.0.1");
    expect(out).toContain("http_error"); // the real adapter's 500 was classified, not printed
    expect(out).toContain("rate_limited");
  });

  it("run() logs a failing tick by class only", async () => {
    const written = captureStderr();
    const near = new FakeNear();
    near.getEvmCfg = async () => {
      throw new Error(`Status: 429 URL: ${CANARY_URL}`);
    };
    const relayer = new Relayer({ near, evm: [new FakeChain().client("provider#1")], log: stderrLogger });
    await relayer.run(new AbortController().signal, { pollMs: 1000, once: true });
    const out = written.join("");
    expect(out).toContain('"class":"rate_limited"');
    expect(out).not.toContain(CANARY_URL_KEY);
  });
});
