import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ConfigError, Secret, assertAccountId, assertChainId, loadConfig } from "../../src/config.ts";

const KEY = `ed25519:${"3".repeat(88)}`;
const base = { NEAR_NETWORK: "testnet" };

describe("Secret", () => {
  it("never renders its value implicitly", () => {
    const s = new Secret("fixture-supersecretvalue");
    for (const shown of [String(s), `${s}`, JSON.stringify({ s }), inspect(s), inspect({ s })]) {
      expect(shown).not.toContain("supersecret");
    }
    expect(s.reveal()).toBe("fixture-supersecretvalue");
  });
});

describe("loadConfig", () => {
  it("refuses mainnet and unknown networks", () => {
    expect(() => loadConfig({ NEAR_NETWORK: "mainnet" })).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it("requires .testnet accounts on testnet and refuses implicit accounts", () => {
    expect(() => loadConfig({ ...base, PURSER_CONTRACT_ID: "purser.near" })).toThrow(/testnet only/);
    expect(() => assertAccountId("a".repeat(64), "testnet", "x")).toThrow(/implicit/);
    expect(() => assertAccountId("0x52908400098527886e0f7030069857d2e4169ee7", "sandbox", "x")).toThrow(/implicit/);
    expect(assertAccountId("purser.alice.testnet", "testnet", "x")).toBe("purser.alice.testnet");
  });

  it("loads delegate credentials as Secrets and never echoes a bad key", () => {
    const cfg = loadConfig({ ...base, PROPOSER_SCOUT_ACCOUNT_ID: "scout.alice.testnet", PROPOSER_SCOUT_FC_PRIVATE_KEY: KEY });
    expect(cfg.delegates.scout?.fcKey).toBeInstanceOf(Secret);
    expect(JSON.stringify(cfg)).not.toContain(KEY);
    const bad = "ed25519:not-base58-and-secret";
    try {
      loadConfig({ ...base, PROPOSER_SCOUT_ACCOUNT_ID: "scout.alice.testnet", PROPOSER_SCOUT_FC_PRIVATE_KEY: bad });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain("not-base58-and-secret");
    }
  });

  it("requires account id and key together", () => {
    expect(() => loadConfig({ ...base, PROPOSER_FORGE_ACCOUNT_ID: "forge.alice.testnet" })).toThrow(/together/);
  });

  it("defaults the NEAR AI base URL and canonical model", () => {
    const cfg = loadConfig(base);
    expect(cfg.nearAi).toMatchObject({ baseUrl: "https://cloud-api.near.ai/v1", model: "z-ai/glm-5.3-flash", apiKey: undefined });
    expect(cfg.rpcUrl).toBe("https://test.rpc.fastnear.com");
  });
});

describe("assertChainId (what the RPC node reports, not the URL)", () => {
  it("accepts only the configured network", () => {
    expect(() => assertChainId("testnet", "testnet")).not.toThrow();
    expect(() => assertChainId("testnet", "mainnet")).toThrow(/refusing/);
    expect(() => assertChainId("sandbox", "mainnet")).toThrow(/refusing/);
    expect(() => assertChainId("sandbox", "testnet")).toThrow(/refusing/);
    expect(() => assertChainId("sandbox", "test-chain-k1EY5")).not.toThrow(); // what near-sandbox 2.14 reports
  });
});
