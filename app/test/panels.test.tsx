import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CachedCommitment } from "../src/data/cache.ts";
import type { Commitment, ProposalRecord } from "@purser/types";
import { budgetBar } from "../src/components/ascii.tsx";
import { CachedHistory, InvariantLine, Manifest } from "../src/components/panels.tsx";
import { amountDisplay } from "../src/lib/format.ts";
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
  request_id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
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
          record({ outcome: "admitted", commitment_id: 1, request_id: "00000000-0000-4000-8000-000000000001", state: "Confirmed", refusal_code: null, account_id: "scout.op.testnet", persona: "scout", tx_hash: "7LCgg1qhqojfUcqV3mTbagLBs2kLx8oGM2AcFdoidwXD" }),
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
    expect(within(refused).getByText("REFUSED: exceeds task budget").closest(".badge")?.className).toContain("tone-warn");
    expect(within(refused).getByText("reported by proposer")).toBeTruthy();
  });

  it("gives each decision its own row, even when a re-run reuses a request_id", () => {
    const a = record({ refusal_code: "request_id_reused", decision_id: "11111111-1d2b-4c3d-9e4f-5a6b7c8d9e0f" });
    const b = record({ refusal_code: "request_id_reused", decision_id: "22222222-1d2b-4c3d-9e4f-5a6b7c8d9e0f" });
    render(<Manifest commitments={[]} records={[a, b]} personaOf={persona} delegateIds={new Set(["buyer.op.testnet"])} now={NOW} />);
    expect(within(screen.getByRole("list", { name: /refused/i })).getAllByText("REJECTED: request_id reused with a different request")).toHaveLength(2);
  });

  it("shows amounts in units when given a unit display", () => {
    render(<Manifest commitments={[commitment(1, "Confirmed")]} records={[]} personaOf={persona} delegateIds={new Set()} now={NOW} money={amountDisplay(100n * N, true)} />);
    expect(within(screen.getByRole("list", { name: /payments/i })).getByText("30")).toBeTruthy();
  });

  it("never attaches a record's tx link to a commitment it does not exactly match", () => {
    const spoof = record({ outcome: "admitted", commitment_id: 1, state: "Confirmed", refusal_code: null, account_id: "buyer.op.testnet", tx_hash: "7LCgg1qhqojfUcqV3mTbagLBs2kLx8oGM2AcFdoidwXD" });
    render(<Manifest commitments={[commitment(1, "Confirmed")]} records={[spoof]} personaOf={persona} delegateIds={new Set(["scout.op.testnet", "buyer.op.testnet"])} now={NOW} />);
    const payments = screen.getByRole("list", { name: /payments/i });
    expect(within(payments).queryByRole("link")).toBeNull();
    expect(within(payments).getByText("no tx record")).toBeTruthy();
  });

  it("ignores records from accounts that are not on-chain delegates of the task", () => {
    render(<Manifest commitments={[]} records={[record({ account_id: "mallory.testnet" })]} personaOf={persona} delegateIds={new Set(["buyer.op.testnet"])} now={NOW} />);
    expect(screen.getByText("No refusals recorded.")).toBeTruthy();
  });
});

describe("budgetBar", () => {
  it("draws completed, held and free cells to the exact width", () => {
    expect(budgetBar(60n, 30n, 100n, 10)).toBe("[######===.]");
    expect(budgetBar(0n, 0n, 100n, 10)).toBe("[..........]");
  });
  it("shows no free cell when nothing is left, however the amounts round", () => {
    expect(budgetBar(15n, 85n, 100n, 10)).toBe("[#=========]");
    expect(budgetBar(33n, 67n, 100n, 10)).toBe("[###=======]");
  });
  it("keeps a free cell while some budget is left", () => {
    expect(budgetBar(1n, 995n, 1000n, 10)).toBe("[#========.]");
  });
  it("never hides a small hold, and never runs past the bar", () => {
    expect(budgetBar(0n, 1n, 1000n, 10)).toBe("[=.........]");
    expect(budgetBar(100n, 100n, 100n, 10)).toBe("[##########]");
  });
  it("draws an empty bar when the cap is zero", () => {
    expect(budgetBar(0n, 0n, 0n, 4)).toBe("[....]");
  });
});

describe("InvariantLine", () => {
  it("speaks the contract's verdict, and never shows green on stale data", () => {
    const healthy = lineHealth({ cap: 100n * N, completed: 90n * N, outstanding: 0n, holds: true, frozen: false }, { hasUnknown: false, syncedAt: NOW, now: NOW });
    const { rerender } = render(<InvariantLine health={healthy} completed={90n * N} outstanding={0n} cap={100n * N} />);
    const line = screen.getByRole("status");
    expect(within(line).getByText("invariant healthy: 90 of 100 NEAR used (90 percent)")).toBeTruthy();
    expect(line.className).toContain("tone-ok");
    const stale = lineHealth({ cap: 100n * N, completed: 90n * N, outstanding: 0n, holds: true, frozen: false }, { hasUnknown: false, syncedAt: NOW - 60_000, now: NOW });
    rerender(<InvariantLine health={stale} completed={90n * N} outstanding={0n} cap={100n * N} />);
    expect(screen.getByRole("status").className).toContain("tone-dim");
  });

  it("shows no numbers before the contract's first reading", () => {
    const unread = lineHealth(null, { hasUnknown: false, syncedAt: null, now: NOW });
    render(<InvariantLine health={unread} completed={null} outstanding={null} cap={null} />);
    expect(screen.getByRole("status").textContent).not.toMatch(/cap 0/);
    expect(screen.getByText("waiting for the contract's first reading")).toBeTruthy();
  });
});

describe("CachedHistory", () => {
  const row = (o: Partial<CachedCommitment> = {}): CachedCommitment => ({
    taskId: "board-1", commitmentId: "11", delegate: "scout.op.testnet", recipient: "data.op.testnet", reservedAmount: (30n * N).toString(),
    actualSpent: null, state: "Confirmed", requestId: null, nearTx: null, txStatus: "pending", asOfHeight: 100, ...o,
  });
  const HASH = "5dRpkX87653fAYGwh3cnAy8F4YSNCqhviDKBc2vcjhyw";
  const show = (r: CachedCommitment, offline = false, tx: string | null = null) =>
    render(<CachedHistory rows={[r]} dropped={0} boardBlock={100} personaOf={persona} recordTx={() => tx} offline={offline} />);

  it("labels a proposer-asserted hash visibly as unverified", () => {
    show(row(), false, HASH);
    expect(screen.getByText(/proposer-reported, unverified/)).toBeTruthy();
  });
  it("gives an indexer-resolved hash the plain link with no caveat", () => {
    show(row({ txStatus: "resolved", nearTx: HASH }));
    expect(screen.queryByText(/unverified/)).toBeNull();
  });
  it("marks stale rows when offline", () => {
    show(row(), true);
    expect(screen.getByText(/offline: showing last known/)).toBeTruthy();
  });
  it("shows no offline marker while online", () => {
    show(row());
    expect(screen.queryByText(/offline/)).toBeNull();
  });
});
