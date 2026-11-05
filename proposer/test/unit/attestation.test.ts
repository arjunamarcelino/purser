import { describe, expect, it } from "vitest";
import { evaluate, type Pins } from "../../src/attestation.ts";

const MODEL = "z-ai/glm-5.3-flash";
const pins: Pins[] = [{ model: MODEL, compose_hash: "c".repeat(64), os_image_hash: "o".repeat(64) }];
const ctx = { decisionId: "8f0e6a1c-1d2b-4c3d-9e4f-5a6b7c8d9e0f", persona: "scout", accountId: "scout.sandbox", requestId: null, commitmentId: null, payloadHash: null, model: MODEL, chatId: "chatcmpl-1" };

// Shaped like the SDK's VerifiedModelCompletionResult (facts the SDK already verified).
function teeResult(over: { kind?: "provider_tee" | "gateway"; text?: string; compose?: string; tcb?: string; gpu?: "verified" | "not_provided" } = {}) {
  return {
    result: {
      id: "chatcmpl-1",
      signatureKind: over.kind ?? "provider_tee",
      signature: { kind: over.kind ?? "provider_tee", signer: { signingAlgo: "ecdsa", signingAddress: "0xabc" }, signedText: over.text ?? `${MODEL}:aa:bb`, signature: "0xsig" },
      attestation: {
        tcbStatus: over.tcb ?? "UpToDate",
        gpuEvidence: over.gpu ?? "verified",
        deployment: { appCompose: "{}", runtimeMeasurements: { composeHash: over.compose ?? "c".repeat(64), osImageHash: "o".repeat(64) } },
      },
    } as never,
  };
}

describe("attestation policy over SDK-verified facts", () => {
  it("is verified only when every check passes", () => {
    const e = evaluate(ctx, teeResult(), pins);
    expect(e.verified).toBe(true);
    expect(Object.values(e.checks).every((c) => c === "pass")).toBe(true);
    expect(e.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["a gateway signature", { kind: "gateway" as const }, "gateway_signature"],
    ["a non-canonical model", { text: "glm-latest:aa:bb" }, "model_not_canonical"],
    ["changed measurements", { compose: "d".repeat(64) }, "measurement_changed"],
    ["missing NVIDIA evidence", { gpu: "not_provided" as const }, "nvidia_evidence_missing"],
    ["an out-of-date TCB", { tcb: "OutOfDate" }, "tcb_OutOfDate"],
  ])("is NOT verified with %s", (_name, over, reason) => {
    const e = evaluate(ctx, teeResult(over), pins);
    expect(e.verified).toBe(false);
    expect(e.reasons).toContain(reason);
  });

  it("is NOT verified when the SDK fails or verification is unavailable", () => {
    expect(evaluate(ctx, { error: Object.assign(new Error("quote invalid"), { name: "VerificationError" }) }, pins)).toMatchObject({
      verified: false,
      checks: { sdk_verification: "fail" },
    });
    expect(evaluate(ctx, { unavailable: "attestation preflight failed" }, pins)).toMatchObject({ verified: false, reasons: ["attestation preflight failed"] });
  });

  it("is NOT verified without pins for the model", () => {
    expect(evaluate(ctx, teeResult(), []).reasons).toContain("no_pinned_measurements_for_model");
  });
});
