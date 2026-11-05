import { describe, expect, it } from "vitest";
import type { ChainReader } from "@purser/chain-read";
import { commitmentToRow, CommitmentSchema, readCommitment, readTask, taskToRow } from "../../src/chain.ts";
import { ChainShapeError } from "../../src/errors.ts";

const sig = new AbortController().signal;
const big = "340282366920938463463374607431768211455"; // u128 max

const wire = (over: Record<string, unknown> = {}) => ({
  id: 7,
  task: "t1",
  delegate: "scout.testnet",
  intent: { amount: big, chain: "NearNative", memo: null, recipient: "vendor.testnet", token: "NearNative" },
  request_id: "r-1",
  reserved_amount: big,
  state: "Confirmed",
  actual_spent: "5",
  near_tx: null,
  evm_tx: null,
  payload_hash: Array.from({ length: 32 }, (_, i) => i),
  payload_version: 1,
  created_at: 1700000000123456789n,
  updated_at: 1700000000123456790n,
  extra_future_field: true,
  ...over,
});

const readerOf = (value: unknown): ChainReader => ({
  chainId: async () => "testnet",
  finalBlock: async () => ({ height: 1n, hash: "h" }),
  view: async () => value,
});

describe("commitmentToRow", () => {
  it("maps fields, hex-encodes the hash and keeps >2^53 values exact", () => {
    const c = CommitmentSchema.parse(wire());
    const row = commitmentToRow(c);
    expect(row).toMatchObject({ commitment_id: 7, recipient: "vendor.testnet", reserved_amount: big, actual_spent: "5", tx_status: "pending", near_tx: null });
    expect(row.payload_hash).toBe("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  });

  it("is resolved only when near_tx is present; absent optionals become null", () => {
    const { actual_spent: _a, payload_hash: _p, evm_tx: _e, ...rest } = wire({ near_tx: "H".repeat(44) });
    const row = commitmentToRow(CommitmentSchema.parse(rest));
    expect(row).toMatchObject({ tx_status: "resolved", actual_spent: null, payload_hash: null, evm_tx: null });
  });

  it("preserves Unknown and never coerces it", () => {
    expect(commitmentToRow(CommitmentSchema.parse(wire({ state: "Unknown" }))).state).toBe("Unknown");
  });
});

describe("readCommitment / readTask", () => {
  it("throws ChainShapeError on an unknown ReservationState", async () => {
    await expect(readCommitment(readerOf(wire({ state: "Refunded" })), { commitment_id: 7 }, 1n, sig)).rejects.toBeInstanceOf(ChainShapeError);
  });

  it("does not echo the offending value", async () => {
    const err = await readCommitment(readerOf(wire({ state: "SECRET-VALUE" })), { commitment_id: 7 }, 1n, sig).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainShapeError);
    expect((err as Error).message).not.toContain("SECRET-VALUE");
  });

  it("rejects a numeric amount (would have lost precision)", async () => {
    await expect(readCommitment(readerOf(wire({ reserved_amount: 5 })), { commitment_id: 7 }, 1n, sig)).rejects.toBeInstanceOf(ChainShapeError);
  });

  it("passes null through", async () => {
    expect(await readCommitment(readerOf(null), { commitment_id: 99 }, 1n, sig)).toBeNull();
    expect(await readTask(readerOf(null), { task_id: "x" }, 1n, sig)).toBeNull();
  });
});

describe("taskToRow", () => {
  const task = {
    active_crew: 1, cap: big, completed: "1", created_at: 1700000000123456789n, crew_cap: 3, frozen: false,
    outstanding: "2", owner: "owner.testnet", token: { Nep141: { contract: "usdc.testnet" } },
  };

  it("formats the token and uses the invariant's frozen flag when given", async () => {
    const t = await readTask(readerOf(task), { task_id: "t1" }, 1n, sig);
    expect(t).not.toBeNull();
    expect(taskToRow(t!, "t1", true)).toEqual({
      task_id: "t1", owner: "owner.testnet", token: "Nep141:usdc.testnet", cap: big,
      completed_cached: "1", outstanding_cached: "2", crew_cap: 3, frozen: true,
    });
    expect(taskToRow({ ...t!, token: "NearNative" }, "t1").token).toBe("NearNative");
  });
});
