// What the model may say, and how it becomes a PaymentIntent.
//
// SHAPE VALIDATION ONLY. Nothing here checks budget, allowlist, memo length or amount > 0 —
// those are the contract's job, and a rogue intent must reach the contract to be refused there.
// We only reject what cannot be encoded as a PaymentIntent at all.

import { z } from "zod";
import { U128_MAX, type PaymentIntent, type TokenSpec, type YoctoString, yoctoFromBigint } from "@purser/types";

/**
 * The schema sent to the model (OpenAI strict json_schema: every field required, nullable
 * instead of optional, no extra keys). Deliberately minimal — guided decoding may ignore
 * `pattern`/`maxLength` — with the strict checks applied locally in `parseDecision`.
 * `rationale` comes first: key order steers generation, so the model reasons before it commits.
 */
export const ProposedIntentWire = z.strictObject({
  rationale: z.string(),
  action: z.enum(["propose", "decline"]),
  recipient: z.string().nullable(),
  amount_near: z.string().nullable(),
  memo: z.string().nullable(),
});
export type ProposedIntentWire = z.infer<typeof ProposedIntentWire>;

export type ProposedDecision =
  | { action: "decline"; rationale: string }
  | { action: "propose"; recipient: string; amountNear: string; memo: string | null; rationale: string };

export type ShapeResult<T> = { ok: true; value: T } | { ok: false; reason: string };

const NEAR_DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]{1,24})?$/;
const YOCTO_PER_NEAR = 10n ** 24n;

/** Exact decimal NEAR → yoctoNEAR. No floats: "1.5" is 1.5e24 yocto, exactly. */
export function nearToYocto(amount: string): ShapeResult<YoctoString> {
  if (!NEAR_DECIMAL.test(amount)) return { ok: false, reason: "amount_near is not a plain decimal (e.g. 12 or 0.5)" };
  const [whole = "0", frac = ""] = amount.split(".");
  const yocto = BigInt(whole) * YOCTO_PER_NEAR + BigInt(frac.padEnd(24, "0"));
  if (yocto > U128_MAX) return { ok: false, reason: "amount_near exceeds u128" };
  return { ok: true, value: yoctoFromBigint(yocto) };
}

/** yoctoNEAR → exact decimal NEAR ("1.5", "30"). */
export function yoctoToNear(y: string | bigint): string {
  const v = BigInt(y);
  const frac = (v % YOCTO_PER_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return `${v / YOCTO_PER_NEAR}${frac ? `.${frac}` : ""}`;
}

/** Validate the model's raw output into a decision. Accepts the parsed JSON object. */
export function parseDecision(raw: unknown): ShapeResult<ProposedDecision> {
  const wire = ProposedIntentWire.safeParse(raw);
  if (!wire.success) return { ok: false, reason: "output does not match the intent schema" };
  const w = wire.data;
  if (w.action === "decline") return { ok: true, value: { action: "decline", rationale: w.rationale } };
  if (w.recipient === null || w.recipient === "") return { ok: false, reason: "propose without a recipient" };
  if (w.amount_near === null) return { ok: false, reason: "propose without an amount" };
  return {
    ok: true,
    value: { action: "propose", recipient: w.recipient, amountNear: w.amount_near.trim(), memo: w.memo, rationale: w.rationale },
  };
}

/**
 * Build the PaymentIntent the contract receives. The chain and token come from the TASK, never
 * from the model; the model only fills recipient, amount and memo.
 */
export function toPaymentIntent(
  d: Extract<ProposedDecision, { action: "propose" }>,
  taskToken: TokenSpec,
): ShapeResult<PaymentIntent> {
  const amount = nearToYocto(d.amountNear);
  if (!amount.ok) return amount;
  return {
    ok: true,
    value: { chain: "NearNative", recipient: d.recipient, amount: amount.value, token: taskToken, memo: d.memo },
  };
}
