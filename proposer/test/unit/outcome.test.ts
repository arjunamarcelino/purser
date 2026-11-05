import { describe, expect, it } from "vitest";
import { classifySendError, parseU64Safe } from "../../src/purser-client.ts";

class HostGuestPanicError extends Error {
  readonly panicMessage: string;
  constructor(panicMessage: string) {
    super(`Smart contract panicked: ${panicMessage}`);
    this.panicMessage = panicMessage;
  }
}
class ContractExecutionError extends Error {
  transactionResult = { transaction: { hash: "TxHash111" } };
}
class AccessKeyMethodNameMismatchActionError extends Error {}
class TransactionTimeoutError extends Error {}

describe("classifySendError", () => {
  it("maps an exact frozen panic to a refusal with its retry class", () => {
    expect(classifySendError(new HostGuestPanicError("exceeds task budget"))).toMatchObject({ kind: "refused", code: "exceeds_task_budget", retry: "terminal_for_amount" });
    expect(classifySendError(new ContractExecutionError("Smart contract panicked: recipient not allowlisted"))).toMatchObject({
      kind: "refused",
      code: "recipient_not_allowlisted",
      txHash: "TxHash111",
    });
  });

  it("never passes a non-frozen failure off as a refusal", () => {
    expect(classifySendError(new HostGuestPanicError("exceeds task budget (soon)"))).toMatchObject({ kind: "unclassified" });
    expect(classifySendError(new ContractExecutionError("Exceeded the prepaid gas."))).toMatchObject({ kind: "unclassified", txHash: "TxHash111" });
  });

  it("reports function-call-key violations as protocol rejections", () => {
    expect(classifySendError(new AccessKeyMethodNameMismatchActionError("method not allowed"))).toMatchObject({
      kind: "rejected_by_protocol",
      errorClass: "AccessKeyMethodNameMismatchActionError",
    });
  });

  it("treats lost or timed-out sends as unknown (resolve via get_idempotency, never assume)", () => {
    expect(classifySendError(new TypeError("fetch failed"))).toMatchObject({ kind: "unknown" });
    expect(classifySendError(new TransactionTimeoutError("timeout"))).toMatchObject({ kind: "unknown" });
    expect(classifySendError(Object.assign(new Error("send timed out"), { name: "TimeoutError" }))).toMatchObject({ kind: "unknown" });
  });
});

describe("parseU64Safe", () => {
  it("keeps nanosecond timestamps exact as bigint", () => {
    const v = parseU64Safe('{"created_at":1762300000123456789,"id":3}') as { created_at: bigint; id: number };
    expect(v.created_at).toBe(1762300000123456789n);
    expect(v.id).toBe(3);
    const plain = JSON.parse('{"created_at":1762300000123456789}') as { created_at: number };
    expect(BigInt(plain.created_at)).not.toBe(1762300000123456789n); // what a plain JSON.parse does
  });

  it("refuses any other integer that would lose precision", () => {
    expect(() => parseU64Safe('{"commitment_id":9007199254740993}')).toThrow(RangeError);
  });
});
