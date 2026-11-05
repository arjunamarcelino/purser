// Attestation evidence for one completion. Evidence, never authority: the contract never reads it.
//
// The official @nearai/inference-sdk is the ONLY verifier (Intel TDX quote, nonce/report_data
// binding, NVIDIA NRAS, byte-exact response signature). This module adds policy over the facts
// the SDK verified, and `verified` is true only when every check passes:
//   - the response was signed inside the model's TEE (provider_tee, not the gateway),
//   - by the canonical model id we requested,
//   - on a deployment whose measurements match the values pinned in attestation-pins.json,
//   - with verified NVIDIA GPU evidence and an UpToDate Intel TCB.
// What a pass means, precisely: the completion was signed by a key that, at `verified_at`, was
// bound to a TDX + GPU report matching our pinned measurements (pinned on first observation).

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { VerifiedCompletionResult } from "@nearai/inference-sdk/node";
import { Evidence } from "@purser/types";

export interface Pins {
  model: string;
  compose_hash: string;
  os_image_hash: string;
}

type Check = Evidence["checks"][keyof Evidence["checks"]];

export const DEFAULT_PINS_PATH = resolve(import.meta.dirname, "../attestation-pins.json");

export function loadPins(path = DEFAULT_PINS_PATH): Pins[] {
  const file = JSON.parse(readFileSync(path, "utf8")) as { models: Pins[] };
  return file.models;
}

/** sha256 over length-prefixed fields, so no two field lists share an encoding. */
function digestOf(fields: readonly string[]): string {
  const h = createHash("sha256");
  for (const f of fields) {
    const b = Buffer.from(f, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    h.update(len).update(b);
  }
  return h.digest("hex");
}

export interface EvidenceContext {
  decisionId: string;
  persona: string;
  accountId: string;
  requestId: string | null;
  commitmentId: number | null;
  payloadHash: string | null;
  model: string; // the canonical id we requested
  chatId: string;
}

/** Turn an SDK verification outcome into an Evidence record. Never throws. */
export function evaluate(
  ctx: EvidenceContext,
  outcome: { result: VerifiedCompletionResult } | { error: unknown } | { unavailable: string },
  pins: readonly Pins[],
  now = new Date(),
): Evidence {
  const reasons: string[] = [];
  const checks: Evidence["checks"] = {
    sdk_verification: "unavailable",
    provider_tee_signature: "unavailable",
    canonical_model: "unavailable",
    pinned_measurements: "unavailable",
    nvidia_gpu: "unavailable",
    tcb_up_to_date: "unavailable",
  };
  let signatureKind: Evidence["signature_kind"] = null;
  let signingAddress: string | null = null;
  const digestFields: string[] = [ctx.model, ctx.chatId];

  if ("unavailable" in outcome) {
    reasons.push(outcome.unavailable);
  } else if ("error" in outcome) {
    checks.sdk_verification = "fail";
    const e = outcome.error;
    reasons.push(`sdk_verification_failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  } else {
    const r = outcome.result;
    checks.sdk_verification = "pass";
    signatureKind = r.signatureKind;
    signingAddress = r.signature.signer.signingAddress;
    digestFields.push(r.signature.signedText, r.signature.signature, signingAddress);
    const pass = (ok: boolean, reason: string): Check => {
      if (!ok) reasons.push(reason);
      return ok ? "pass" : "fail";
    };
    checks.provider_tee_signature = pass(r.signatureKind === "provider_tee", "gateway_signature");
    if (r.signatureKind === "provider_tee") {
      const a = r.attestation;
      const m = a.deployment.runtimeMeasurements;
      digestFields.push(m.composeHash ?? "", m.osImageHash ?? "", a.tcbStatus, a.gpuEvidence);
      checks.canonical_model = pass(r.signature.signedText.startsWith(`${ctx.model}:`), "model_not_canonical");
      const pin = pins.find((p) => p.model === ctx.model);
      if (pin === undefined) {
        reasons.push("no_pinned_measurements_for_model");
      } else {
        checks.pinned_measurements = pass(m.composeHash === pin.compose_hash && m.osImageHash === pin.os_image_hash, "measurement_changed");
      }
      checks.nvidia_gpu = pass(a.gpuEvidence === "verified", "nvidia_evidence_missing");
      checks.tcb_up_to_date = pass(a.tcbStatus === "UpToDate", `tcb_${a.tcbStatus}`);
    }
  }

  const verified = Object.values(checks).every((c) => c === "pass");
  return Evidence.parse({
    schema_version: 1,
    decision_id: ctx.decisionId,
    persona: ctx.persona,
    account_id: ctx.accountId,
    request_id: ctx.requestId,
    commitment_id: ctx.commitmentId,
    payload_hash: ctx.payloadHash,
    provider: "near-ai-cloud",
    model: ctx.model,
    chat_id: ctx.chatId,
    signature_kind: signatureKind,
    signing_address: signingAddress,
    checks,
    verified,
    reasons,
    digest: digestOf(digestFields),
    verified_at: now.toISOString(),
  });
}

/** Append one record (JSONL, 0600). Holds digests and check results only, never raw evidence. */
export function appendEvidence(path: string, e: Evidence): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(e)}\n`, { mode: 0o600 });
}
