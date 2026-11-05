import { describe, expect, it } from "vitest";
import { checkOutcome, type Outcome } from "../src/wallet/outcome.ts";

const OWNER = "owner.op.testnet";
const revokeArgs = { task_id: "board-1", account_id: "buyer.op.testnet" };
const b64 = (v: unknown) => btoa(JSON.stringify(v));
const tx = (method: string, args: unknown, o: Partial<NonNullable<Outcome["transaction"]>> = {}): Outcome => ({
  status: { SuccessValue: "" },
  transaction: { hash: "GiYrZkQKwi2BCNkwHcMh68XVLvzTM2a31vRCok2Wnfh3", signer_id: OWNER, receiver_id: "purser.op.testnet", actions: [{ FunctionCall: { method_name: method, args: b64(args) } }], ...o },
  transaction_outcome: { block_hash: "B" },
});

describe("owner outcome verification (the kill-switch must never falsely report success)", () => {
  it("accepts exactly the requested call, args compared by value", () => {
    expect(checkOutcome(tx("revoke_delegate", { account_id: "buyer.op.testnet", task_id: "board-1" }), "revoke_delegate", revokeArgs, OWNER).kind).toBe("ok");
  });

  it("refuses a pasted hash of a DIFFERENT owner call (e.g. an earlier add_delegate)", () => {
    const out = checkOutcome(tx("add_delegate", { task_id: "board-1", account_id: "buyer.op.testnet", derivation_path: "p" }), "revoke_delegate", revokeArgs, OWNER);
    expect(out).toMatchObject({ kind: "unknown" });
  });

  it("refuses the right method with different args (another delegate)", () => {
    expect(checkOutcome(tx("revoke_delegate", { ...revokeArgs, account_id: "scout.op.testnet" }), "revoke_delegate", revokeArgs, OWNER).kind).toBe("unknown");
  });

  it.each([
    ["no transaction", { status: { SuccessValue: "" } }],
    ["no status (not final)", { ...tx("revoke_delegate", revokeArgs), status: undefined }],
    ["a pending status", { ...tx("revoke_delegate", revokeArgs), status: "Started" }],
    ["another receiver", tx("revoke_delegate", revokeArgs, { receiver_id: "evil.testnet" })],
    ["another signer", tx("revoke_delegate", revokeArgs, { signer_id: "mallory.testnet" })],
    ["missing receiver/signer", tx("revoke_delegate", revokeArgs, { receiver_id: undefined, signer_id: undefined })],
    ["two actions", tx("revoke_delegate", revokeArgs, { actions: [{ FunctionCall: { method_name: "revoke_delegate", args: b64(revokeArgs) } }, "CreateAccount"] })],
  ] as const)("reports %s as unknown, never ok", (_name, outcome) => {
    expect(checkOutcome(outcome as Outcome, "revoke_delegate", revokeArgs, OWNER).kind).toBe("unknown");
  });

  it("reports a contract panic as a refusal with its code", () => {
    const out = checkOutcome({ ...tx("revoke_delegate", revokeArgs), status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: only owner" } } } } } }, "revoke_delegate", revokeArgs, OWNER);
    expect(out).toMatchObject({ kind: "refused", code: "only_owner" });
  });
});
