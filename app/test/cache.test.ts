import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WrongIndexerError, cacheAgeMs, parseHistory, parseStatus, validateRow } from "../src/data/cache.ts";

const HASH = "5dRpkX87653fAYGwh3cnAy8F4YSNCqhviDKBc2vcjhyw";
const good = (o: Record<string, unknown> = {}) => ({
  task_id: "board-1", commitment_id: "7", delegate: "scout.op.testnet", recipient: "data.op.testnet", reserved_amount: "30000000000000000000000000",
  actual_spent: null, state: "Completed", request_id: "2f1d9c3e-8b7a-4e6d-9c5b-4a3f2e1d0c9b", payload_hash: null, near_tx: HASH, evm_tx: null, tx_status: "resolved", as_of_height: "123456", ...o,
});
const own = { network: "testnet", contractId: "purser.op.testnet" };

describe("cache validation", () => {
  it("accepts a well-formed row", () => {
    expect(validateRow(good(), "board-1")).toMatchObject({ commitmentId: "7", nearTx: HASH, asOfHeight: 123456 });
  });
  it.each([
    ["img onerror recipient", { recipient: "<img src=x onerror=alert(1)>" }],
    ["javascript: tx", { near_tx: "javascript:alert(1)" }],
    ["javascript: delegate", { delegate: "javascript:alert(1)" }],
    ["RTL override in delegate", { delegate: "scout.op.testnet‮" }],
    ["RTL override in state", { state: "Comp‮leted" }],
    ["amount above 2^53 as a number", { reserved_amount: 9007199254740993 }],
    ["amount with 40 digits", { reserved_amount: "1".repeat(40) }],
    ["negative amount", { reserved_amount: "-5" }],
    ["unknown tx_status", { tx_status: "ok" }],
    ["other task", { task_id: "other" }],
    ["bad request id", { request_id: "<script>" }],
  ])("drops %s", (_n, o) => {
    expect(validateRow(good(o as Record<string, unknown>), "board-1")).toBeNull();
  });
  it("keeps >2^53 yocto amounts exact as strings", () => {
    expect(validateRow(good({ reserved_amount: "9007199254740993123" }), "board-1")?.reservedAmount).toBe("9007199254740993123");
  });
  it("counts dropped rows and never throws on junk", () => {
    const h = parseHistory({ rows: [good(), { x: 1 }, null, good({ recipient: "<b>" })], next: null }, "board-1");
    expect(h.rows).toHaveLength(1);
    expect(h.dropped).toBe(3);
    expect(() => parseHistory({}, "board-1")).toThrow();
  });
});

describe("cache status", () => {
  const body = { network: "testnet", contract_id: "purser.op.testnet", server_time: "2026-11-05T12:00:30Z", last_pass_at: "2026-11-05T12:00:00Z", last_complete_height: "99", schema_version: 1 };
  it("parses and computes a server-clock age", () => {
    const s = parseStatus(body, own);
    expect(s.asOfHeight).toBe(99);
    expect(cacheAgeMs(s, 1_000, 6_000)).toBe(35_000); // 30 s at receipt + 5 s elapsed
  });
  it("rejects another network or contract as a wrong indexer", () => {
    expect(() => parseStatus({ ...body, network: "mainnet" }, own)).toThrow(WrongIndexerError);
    expect(() => parseStatus({ ...body, contract_id: "evil.testnet" }, own)).toThrow(WrongIndexerError);
  });
});

describe("cache isolation", () => {
  it("no owner-action, release, wallet or kill-switch code imports the cache sources", () => {
    const root = resolve(import.meta.dirname, "../src");
    const guarded = ["components/owner.tsx", "components/DemoControls.tsx", ...readdirSync(resolve(root, "wallet")).map((f) => `wallet/${f}`)];
    for (const f of guarded) {
      const text = readFileSync(resolve(root, f), "utf8");
      expect(text, f).not.toMatch(/data\/(cache|useCache)|IndexerClient|CachedCommitment/);
    }
  });
  it("renders cache strings without dangerouslySetInnerHTML", () => {
    const text = readFileSync(resolve(import.meta.dirname, "../src/components/panels.tsx"), "utf8");
    expect(text).not.toMatch(/dangerouslySetInnerHTML/);
  });
});

describe("real API shape", () => {
  // Copied from live /history output: commitment_id is a JSON number, as_of_height a string.
  const live = {
    rows: [
      { commitment_id: 11, delegate: "scout.arjuna-purser.testnet", recipient: "data.arjuna-purser.testnet", reserved_amount: "60000000000000000000000", actual_spent: "60000000000000000000000", state: "Confirmed", request_id: "d113caf5-888d-44dd-86cd-cea5b87da415", payload_hash: "bb8b7f10455fde53966f32dbc7352721a2dc0ca063a70b82366cfb647353bcee", near_tx: null, evm_tx: null, tx_status: "pending", task_id: "board-1", as_of_height: "276354090" },
    ],
    next: "YzE6MTE",
  };
  it("parseHistory keeps rows whose commitment_id is a number", () => {
    const h = parseHistory(live, "board-1");
    expect(h.dropped).toBe(0);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ commitmentId: "11", asOfHeight: 276354090 });
  });
  it("still accepts a string id and rejects unsafe or negative numeric ids", () => {
    expect(validateRow(good({ commitment_id: "7" }), "board-1")?.commitmentId).toBe("7");
    for (const id of [-1, 1.5, 2 ** 53, Number.NaN, "x1"]) expect(validateRow(good({ commitment_id: id }), "board-1")).toBeNull();
  });
});
