import { describe, expect, it } from "vitest";
import {
  AccessKeyMethodNameMismatchActionError,
  ContractExecutionError,
  HostGuestPanicError,
  InvalidTransactionError,
  TransactionTimeoutError,
} from "near-api-js/rpc-errors";
import { classifySendError, parseU64Safe } from "../../src/purser-client.ts";

// The real near-api-js classes, so the classifier is tested against what the SDK throws.
const BH = "BlockHash1111";
const panic = (msg: string) => new HostGuestPanicError(msg, BH, 1);
const executed = (msg: string) => Object.assign(new ContractExecutionError(msg, BH, 1), { transactionResult: { transaction: { hash: "TxHash111" } } });
// near-api-js's fetchJsonRpc throws these (not exported) after HTTP 408/5xx or exhausted retries.
class ProviderError extends Error {}
class TypedError extends Error {
  readonly type: string;
  constructor(message: string, type: string) {
    super(message);
    this.type = type;
  }
}

describe("classifySendError", () => {
  it("maps an exact frozen panic to a refusal with its retry class", () => {
    expect(classifySendError(panic("exceeds task budget"))).toMatchObject({ kind: "refused", code: "exceeds_task_budget", retry: "terminal_for_amount" });
    expect(classifySendError(executed("Smart contract panicked: recipient not allowlisted"))).toMatchObject({
      kind: "refused",
      code: "recipient_not_allowlisted",
      txHash: "TxHash111",
    });
  });

  it("never passes a non-frozen execution failure off as a refusal", () => {
    expect(classifySendError(panic("exceeds task budget (soon)"))).toMatchObject({ kind: "unclassified" });
    expect(classifySendError(executed("Exceeded the prepaid gas."))).toMatchObject({ kind: "unclassified", txHash: "TxHash111" });
  });

  it("reports transactions the node never accepted as protocol rejections", () => {
    expect(classifySendError(new AccessKeyMethodNameMismatchActionError("reconcile", 0, "Tx", BH))).toMatchObject({ kind: "rejected_by_protocol" });
    expect(classifySendError(new InvalidTransactionError())).toMatchObject({ kind: "rejected_by_protocol" });
  });

  it("treats every failure without proof of execution as unknown (resolve via get_idempotency, never assume)", () => {
    for (const err of [
      new TypeError("fetch failed"),
      new TransactionTimeoutError(),
      Object.assign(new Error("send timed out"), { name: "TimeoutError" }),
      new ProviderError("https://rpc Bad Gateway"),
      new ProviderError("Timeout error"),
      new TypedError("Exceeded 12 attempts for https://rpc.", "RetriesExceeded"),
      new SyntaxError("Unexpected end of JSON input"),
      "a thrown string",
    ]) {
      expect(classifySendError(err)).toMatchObject({ kind: "unknown" });
    }
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

describe("retryRateLimited", () => {
  it("retries a read that was rate-limited, then succeeds", async () => {
    const { retryRateLimited } = await import("../../src/purser-client.ts");
    let calls = 0;
    const v = await retryRateLimited(async () => {
      if (++calls < 3) throw new Error('{"code": -429, "message": "Rate limits exceeded."}');
      return "ok";
    }, 5, 1);
    expect(v).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry other failures, and gives up after the attempt budget", async () => {
    const { retryRateLimited } = await import("../../src/purser-client.ts");
    let calls = 0;
    await expect(retryRateLimited(async () => { calls++; throw new Error("no such task"); }, 5, 1)).rejects.toThrow("no such task");
    expect(calls).toBe(1);
    calls = 0;
    await expect(retryRateLimited(async () => { calls++; throw new Error("429 Too Many Requests"); }, 3, 1)).rejects.toThrow(/429/);
    expect(calls).toBe(3);
  });
});
