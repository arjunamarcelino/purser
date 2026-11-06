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
  // S8 (state-growth limits; contract/src/error.rs). A payment under the task's minimum can succeed with a
  // larger amount; a task past its commitment limit refuses everything until the owner raises it.
  payment_below_minimum: { message: "payment below minimum", retry: "terminal_for_amount" },
  task_commitment_limit_reached: { message: "task commitment limit reached", retry: "terminal" },
  // EVM payment path (Prompt 12; contract/src/error.rs). "retry_later" = a condition an operator or the
  // passage of time clears; "wait" = another commitment holds the lane.
  evm_value_below_minimum: { message: "evm value below minimum", retry: "terminal" },
  invalid_evm_fee: { message: "invalid evm fee", retry: "terminal" },
  sighash_out_of_range: { message: "sighash out of range", retry: "terminal" },
  evm_lane_not_seeded: { message: "evm lane not seeded", retry: "retry_later" },
  evm_lane_busy: { message: "evm lane busy", retry: "wait" },
  nonce_seed_refused: { message: "nonce seed refused", retry: "terminal" },
  evm_not_configured: { message: "evm not configured", retry: "terminal" },
  invalid_evm_config: { message: "invalid evm config", retry: "terminal" },
  task_must_have_no_delegates: { message: "task must have no delegates", retry: "terminal" },
  not_an_evm_task: { message: "not an evm task", retry: "terminal" },
  derived_key_not_cached: { message: "derived key not cached", retry: "retry_later" },
  derived_key_already_cached: { message: "derived key already cached", retry: "terminal" },
  insufficient_prepaid_gas: { message: "insufficient prepaid gas", retry: "retry_later" },
  insufficient_contract_balance: { message: "insufficient contract balance", retry: "retry_later" },
  derivation_path_in_use: { message: "derivation path in use", retry: "terminal" },
  only_owner_or_relayer: { message: "only owner or relayer", retry: "terminal" },
  not_an_evm_commitment: { message: "not an evm commitment", retry: "terminal" },
  reconcile_not_allowed_for_evm: { message: "reconcile not allowed for evm", retry: "terminal" },
  relayer_must_not_be_owner: { message: "relayer must not be owner", retry: "terminal" },
  relayer_change_blocked: { message: "relayer change blocked", retry: "retry_later" },
  too_early_to_mark_unknown: { message: "too early to mark unknown", retry: "retry_later" },
  unknown_tx_hash: { message: "unknown tx hash", retry: "terminal" },
  invalid_tx_hash: { message: "invalid tx hash", retry: "terminal" },
  cancel_already_requested: { message: "cancel already requested", retry: "terminal" },
  not_cancellable: { message: "not cancellable", retry: "terminal" },
  no_release_evidence: { message: "no release evidence", retry: "retry_later" },
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
