// The frozen refusal wire contract (see ../README.md and contract/src/error.rs, pinned there by
// `msg_constants_are_frozen`). A refusal is a contract panic whose message is EXACTLY one of
// these strings; near-sdk surfaces it as "Smart contract panicked: <message>".

export type RetryClass = "wait" | "terminal" | "terminal_for_amount" | "retry_later";

export const REFUSALS = {
  in_flight: { message: "in-flight", retry: "wait" },
  already_failed: { message: "already failed", retry: "terminal" },
  request_id_reused: { message: "request_id reused with a different request", retry: "terminal" },
  exceeds_task_budget: { message: "exceeds task budget", retry: "terminal_for_amount" },
  task_frozen: { message: "task frozen", retry: "terminal" },
  delegate_not_authorized: { message: "delegate not authorized", retry: "terminal" },
  recipient_not_allowlisted: { message: "recipient not allowlisted", retry: "terminal" },
  invalid_recipient: { message: "invalid recipient", retry: "terminal" },
  amount_must_be_positive: { message: "amount must be positive", retry: "terminal" },
  unsupported_chain: { message: "unsupported chain", retry: "terminal" },
  unsupported_token: { message: "unsupported token", retry: "terminal" },
  memo_too_long: { message: "memo too long", retry: "terminal" },
  invalid_request_id: { message: "invalid request_id", retry: "terminal" },
  invalid_task_id: { message: "invalid task_id", retry: "terminal" },
  no_such_task: { message: "no such task", retry: "terminal" },
  reconcile_too_early: { message: "reconcile too early", retry: "retry_later" },
  not_reconcilable: { message: "not reconcilable", retry: "terminal" },
  no_such_commitment: { message: "no such commitment", retry: "terminal" },
  only_owner: { message: "only owner", retry: "terminal" },
} as const satisfies Record<string, { message: string; retry: RetryClass }>;

export type RefusalCode = keyof typeof REFUSALS;

const PANIC_PREFIX = "Smart contract panicked: ";
const byMessage = new Map<string, RefusalCode>(
  (Object.keys(REFUSALS) as RefusalCode[]).map((code) => [REFUSALS[code].message, code]),
);

/**
 * Classify a contract panic. Accepts the bare message or near-sdk's
 * "Smart contract panicked: <message>" form and matches the message EXACTLY — never by
 * substring, so an unrelated failure (gas, serde, a future message) is never mistaken for a
 * refusal. Returns null for anything that is not a frozen refusal.
 */
export function classifyRefusal(raw: string): { code: RefusalCode; retry: RetryClass } | null {
  const message = raw.startsWith(PANIC_PREFIX) ? raw.slice(PANIC_PREFIX.length) : raw;
  const code = byMessage.get(message);
  return code === undefined ? null : { code, retry: REFUSALS[code].retry };
}
