import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Commitment, ProposalRecord } from "@purser/types";
import { InvariantLine, Manifest } from "../src/components/panels.tsx";
import { lineHealth } from "../src/lib/semantics.ts";

const N = 10n ** 24n;
const NOW = Date.UTC(2026, 10, 5, 12);
const ns = (ms: number) => BigInt(ms) * 1_000_000n;
const commitment = (id: number, state: Commitment["state"], who = "scout.op.testnet"): Commitment => ({
  id,
  state,
  task: "board-1",
  delegate: who,
  intent: { chain: "NearNative", recipient: "data.op.testnet", amount: (30n * N).toString(), token: "NearNative", memo: null },
  reserved_amount: (30n * N).toString(),
  request_id: `r${id}`,
  created_at: ns(NOW - 120_000),
  updated_at: ns(NOW - 120_000),
});
const record = (o: Partial<ProposalRecord>): ProposalRecord => ({
  schema_version: 1, decision_id: "8f0e6a1c-1d2b-4c3d-9e4f-5a6b7c8d9e0f", persona: "buyer", account_id: "buyer.op.testnet", network: "testnet",
  contract_id: "purser.op.testnet", task: "board-1", request_id: "2f1d9c3e-8b7a-4e6d-9c5b-4a3f2e1d0c9b", outcome: "refused", recipient: "data.op.testnet",
  amount_yocto: (30n * N).toString(), commitment_id: null, state: null, refusal_code: "exceeds_task_budget", detail: null,
  tx_hash: "5dRpkX87653fAYGwh3cnAy8F4YSNCqhviDKBc2vcjhyw", payload_hash: null, latency_ms: 1, at: new Date(NOW).toISOString(), ...o,
});
const persona = (a: string) => a.split(".")[0]!;

describe("Manifest", () => {
  it("groups chain state, links payment txs from records, and labels refusals amber with text", () => {
    render(
      <Manifest
        commitments={[commitment(1, "Confirmed"), commitment(2, "Reserved", "forge.op.testnet")]}
        records={[
          record({ outcome: "admitted", commitment_id: 1, state: "Confirmed", refusal_code: null, account_id: "scout.op.testnet", persona: "scout", tx_hash: "7LCgg1qhqojfUcqV3mTbagLBs2kLx8oGM2AcFdoidwXD" }),
          record({}),
        ]}
        personaOf={persona}
        delegateIds={new Set(["scout.op.testnet", "forge.op.testnet", "buyer.op.testnet"])}
        now={NOW}
      />,
    );
    const payments = screen.getByRole("list", { name: /payments/i });
    expect(within(payments).getByText(/CONFIRMED/)).toBeTruthy();
    expect(within(payments).getByRole("link").getAttribute("href")).toBe("https://testnet.nearblocks.io/txns/7LCgg1qhqojfUcqV3mTbagLBs2kLx8oGM2AcFdoidwXD");
    expect(within(screen.getByRole("list", { name: /holds/i })).getByText(/RESERVED/)).toBeTruthy();
    const refused = screen.getByRole("list", { name: /refused/i });
    expect(within(refused).getByText("REFUSED — exceeds task budget").closest(".badge")?.className).toContain("tone-warn");
    expect(within(refused).getByText(/reported by proposer/)).toBeTruthy();
  });

  it("ignores records from accounts that are not on-chain delegates of the task", () => {
    render(<Manifest commitments={[]} records={[record({ account_id: "mallory.testnet" })]} personaOf={persona} delegateIds={new Set(["buyer.op.testnet"])} now={NOW} />);
    expect(screen.getByText("No refusals recorded.")).toBeTruthy();
  });
});

describe("InvariantLine", () => {
  it("speaks the contract's verdict, and never shows green on stale data", () => {
    const healthy = lineHealth({ cap: 100n * N, completed: 90n * N, outstanding: 0n, holds: true, frozen: false }, { hasUnknown: false, syncedAt: NOW, now: NOW });
    const { rerender } = render(<InvariantLine health={healthy} completed={90n * N} outstanding={0n} cap={100n * N} />);
    const line = screen.getByRole("status");
    expect(line.getAttribute("aria-label")).toBe("invariant healthy: 90 of 100 NEAR used (90 percent)");
    expect(line.className).toContain("tone-ok");
    const stale = lineHealth({ cap: 100n * N, completed: 90n * N, outstanding: 0n, holds: true, frozen: false }, { hasUnknown: false, syncedAt: NOW - 60_000, now: NOW });
    rerender(<InvariantLine health={stale} completed={90n * N} outstanding={0n} cap={100n * N} />);
    expect(screen.getByRole("status").className).toContain("tone-dim");
  });
});
