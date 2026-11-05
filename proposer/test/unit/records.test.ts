import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendRecord } from "../../src/records.ts";

const base = {
  schema_version: 1 as const,
  decision_id: "8f0e6a1c-1d2b-4c3d-9e4f-5a6b7c8d9e0f",
  persona: "scout" as const,
  account_id: "scout.op.testnet",
  network: "testnet" as const,
  contract_id: "purser.op.testnet",
  task: "board-1",
  request_id: "2f1d9c3e-8b7a-4e6d-9c5b-4a3f2e1d0c9b",
  outcome: "refused" as const,
  recipient: "data.op.testnet",
  amount_yocto: "300000000000000000000000",
  commitment_id: null,
  state: null,
  refusal_code: "exceeds_task_budget" as const,
  detail: "exceeds task budget",
  tx_hash: "5dRpkX87653fAYGwh3cnAy8F4YSNCqhviDKBc2vcjhyw",
  payload_hash: null,
  latency_ms: 812,
  at: "2026-11-05T12:00:00.000Z",
};

describe("appendRecord", () => {
  it("appends validated records to an owner-only JSONL file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "purser-rec-")), "out", "records.jsonl");
    appendRecord(path, base);
    appendRecord(path, { ...base, outcome: "admitted", commitment_id: 4, state: "Confirmed", refusal_code: null });
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ outcome: "admitted", commitment_id: 4 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses records that would mislead a reader (bad tx hash, bad account)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "purser-rec-")), "records.jsonl");
    expect(() => appendRecord(path, { ...base, tx_hash: "javascript:alert(1)" })).toThrow();
    expect(() => appendRecord(path, { ...base, account_id: "Not An Account" })).toThrow();
  });
});
