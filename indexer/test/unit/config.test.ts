import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseDatabaseUrl } from "../../src/config.ts";

// Composed at runtime so no credential-shaped literal sits in the source (pre-commit scan).
const dbUrl = (scheme: string, user: string, pw: string, rest: string) => scheme + "://" + user + ":" + pw + "@" + rest;

const base = { NEAR_NETWORK: "testnet", PURSER_CONTRACT_ID: "purser.arjuna-purser.testnet" };

describe("parseDatabaseUrl", () => {
  it.each([
    ["sqlite://./rel.db", "./rel.db"],
    ["sqlite:///abs/x.db", "/abs/x.db"],
    ["sqlite::memory:", ":memory:"],
  ])("sqlite %s", (url, path) => expect(parseDatabaseUrl(url)).toEqual({ kind: "sqlite", path }));

  it("keeps postgres urls whole", () => {
    expect(parseDatabaseUrl(dbUrl("postgresql", "u", "p", "h/db"))).toEqual({ kind: "postgres", url: dbUrl("postgresql", "u", "p", "h/db") });
  });
  it("rejects other schemes", () => expect(() => parseDatabaseUrl("mysql://x")).toThrow(ConfigError));
});

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({ network: "testnet", rpcUrl: "https://test.rpc.fastnear.com", pollIntervalMs: 15_000, passBudgetMs: 45_000, apiHost: "127.0.0.1", apiPort: 8787 });
    expect(c.databaseUrl.reveal()).toBe("sqlite://./purser-indexer.db");
  });

  it("redacts DATABASE_URL everywhere", () => {
    const c = loadConfig({ ...base, DATABASE_URL: dbUrl("postgres", "user", "hunter2", "db/x") });
    const shown = [String(c.databaseUrl), JSON.stringify(c), inspect(c), `${c.databaseUrl}`].join(" ");
    expect(shown).not.toContain("hunter2");
    expect(c.databaseUrl.reveal()).toContain("hunter2");
  });

  it("does not echo a bad DATABASE_URL", () => {
    try {
      loadConfig({ ...base, DATABASE_URL: dbUrl("mysql", "user", "hunter2", "db/x") });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).not.toContain("hunter2");
    }
  });

  it("refuses mainnet and a missing network", () => {
    expect(() => loadConfig({ ...base, NEAR_NETWORK: "mainnet" })).toThrow(ConfigError);
    expect(() => loadConfig({ PURSER_CONTRACT_ID: "a.testnet" })).toThrow(ConfigError);
  });

  it("refuses non-.testnet contracts on testnet and implicit accounts", () => {
    expect(() => loadConfig({ ...base, PURSER_CONTRACT_ID: "purser.near" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, PURSER_CONTRACT_ID: "a".repeat(64) })).toThrow(ConfigError);
  });

  it("requires https RPC except sandbox/localhost", () => {
    expect(() => loadConfig({ ...base, NEAR_RPC_URL: "http://rpc.example.com" })).toThrow(ConfigError);
    expect(loadConfig({ ...base, NEAR_RPC_URL: "http://127.0.0.1:3030" }).rpcUrl).toBe("http://127.0.0.1:3030");
    expect(loadConfig({ NEAR_NETWORK: "sandbox", PURSER_CONTRACT_ID: "purser.test.near", NEAR_RPC_URL: "http://localhost:3030" }).rpcUrl).toBe("http://localhost:3030");
  });

  it.each(["0.0.0.0", "192.168.1.5", "example.com", "::"])("refuses non-loopback API_HOST %s", (host) => {
    expect(() => loadConfig({ ...base, API_HOST: host })).toThrow(/loopback/);
  });
  it.each(["127.0.0.1", "localhost", "::1"])("accepts loopback API_HOST %s", (host) => {
    expect(loadConfig({ ...base, API_HOST: host }).apiHost).toBe(host);
  });

  it("validates numeric vars", () => {
    expect(() => loadConfig({ ...base, API_PORT: "70000" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, POLL_INTERVAL_MS: "abc" })).toThrow(ConfigError);
    expect(loadConfig({ ...base, API_PORT: "9000" }).apiPort).toBe(9000);
  });
});
