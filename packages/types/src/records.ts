// Off-chain record schemas shared by the proposer (writer), and the demo, metrics, indexer and
// dashboard (readers). Every reader must validate with these schemas: the files are written by
// an UNTRUSTED process, so their contents are self-asserted claims, never authority.

import { z } from "zod";
import { REFUSALS, type RefusalCode } from "./refusals.ts";

const refusalCodes = Object.keys(REFUSALS) as [RefusalCode, ...RefusalCode[]];
const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const decimal = z.string().regex(/^[0-9]+$/);

/** One line of `crew --json` output: what a persona decided and what the contract did with it. */
export const ProposalRecord = z.strictObject({
  schema_version: z.literal(1),
  decision_id: z.uuid(),
  persona: z.string(),
  account_id: z.string(),
  network: z.enum(["sandbox", "testnet"]),
  contract_id: z.string(),
  task: z.string(),
  request_id: z.uuid().nullable(),
  outcome: z.enum([
    "admitted",
    "replayed",
    "refused",
    "rejected_by_protocol",
    "unclassified",
    "unknown",
    "declined",
    "model_error",
    "blocked_by_open_entry",
  ]),
  recipient: z.string().nullable(),
  amount_yocto: decimal.nullable(),
  commitment_id: z.number().int().nonnegative().nullable(),
  state: z.enum(["Reserved", "Signed", "Confirmed", "Unknown", "Failed", "Cancelled"]).nullable(),
  refusal_code: z.enum(refusalCodes).nullable(),
  detail: z.string().nullable(),
  tx_hash: z.string().nullable(),
  payload_hash: hex32.nullable(),
  latency_ms: z.number().nonnegative(),
  at: z.iso.datetime(),
});
export type ProposalRecord = z.infer<typeof ProposalRecord>;

const check = z.enum(["pass", "fail", "unavailable", "not_exposed"]);

/**
 * Attestation evidence for one completion. Only a digest of the public signature and report is
 * kept, never a raw quote or token. `verified` is true only when every required check passed.
 */
export const Evidence = z.strictObject({
  schema_version: z.literal(1),
  decision_id: z.uuid(),
  persona: z.string(),
  account_id: z.string(),
  request_id: z.uuid().nullable(),
  commitment_id: z.number().int().nonnegative().nullable(),
  payload_hash: hex32.nullable(),
  provider: z.literal("near-ai-cloud"),
  model: z.string(),
  chat_id: z.string(),
  signature_kind: z.enum(["provider_tee", "gateway"]).nullable(),
  signing_address: z.string().nullable(),
  checks: z.strictObject({
    sdk_verification: check,
    provider_tee_signature: check,
    canonical_model: check,
    pinned_measurements: check,
    nvidia_gpu: check,
    tcb_up_to_date: check,
  }),
  verified: z.boolean(),
  reasons: z.array(z.string()),
  digest: hex32,
  verified_at: z.iso.datetime(),
});
export type Evidence = z.infer<typeof Evidence>;
