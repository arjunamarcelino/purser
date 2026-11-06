// Structured JSON-lines logging to stderr through a CLOSED event union. Nothing here accepts an
// arbitrary object, an Error, or a URL: viem and near-api-js errors embed the request URL (and with
// it the provider API key) in their message/cause/details, so errors are logged by CLASS only.

export type ErrorClass =
  | "rate_limited"
  | "timeout"
  | "network"
  | "http_error"
  | "rpc_error"
  | "invalid_response"
  | "aborted"
  | "near_rejected"
  | "unknown";

export type WarnCode =
  | "single_rpc_evidence"
  | "evidence_needs_second_rpc"
  | "nonce_unconfirmed"
  | "recipient_is_contract"
  | "recipient_unknown"
  | "balance_low"
  | "evidence_rpcs_disagree"
  | "reorg_guard"
  | "awaiting_owner_confirm_release"
  | "nonce_burned_by_other"
  | "read_failed"
  | "cursor_stalled";

export type LogEvent =
  | { event: "config"; network: string; contract_id: string; relayer: string; providers: number; evidence: "single_rpc_withheld" | "single_rpc_opt_in" | "dual_rpc"; finality: "finalized" }
  | { event: "startup_ok"; chain_id: bigint }
  | { event: "tick"; active: number; scanned_to: number }
  | { event: "broadcast"; cid: number; kind: "original" | "cancel"; hash: string; rpc: string; outcome: string }
  | { event: "mined"; cid: number; kind: "original" | "cancel"; hash: string; success: boolean; block: bigint; finalized: boolean }
  | { event: "attested"; cid: number; kind: "original" | "cancel"; hash: string; success: boolean; block: bigint; result: "sent" | "refused" | "unknown" }
  | { event: "mark_unknown"; cid: number; result: "sent" | "refused" | "unknown" }
  | { event: "cancel_requested"; cid: number; max_fee: bigint; tip: bigint; result: "sent" | "refused" | "unknown"; on_chain: boolean }
  | { event: "anomaly"; cid: number; reason: "invalid_raw" | "hash_mismatch" | "both_landed" | "nonce_consumed_no_receipt" | "wrong_chain" }
  | { event: "anomaly_cleared"; cid: number; reason: "invalid_raw" | "hash_mismatch" | "both_landed" | "nonce_consumed_no_receipt" | "wrong_chain" }
  | { event: "warn"; code: WarnCode; cid: number | null; rpc?: string; detail?: string }
  | { event: "error"; where: string; class: ErrorClass; rpc?: string }
  | { event: "status"; cid: number; state: string; nonce: bigint; original: string | null; cancel: string | null; evidence: string | null; explorer: string | null };

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value.replace(CONTROL, "");
  return value;
}

export type Logger = (e: LogEvent) => void;

export const stderrLogger: Logger = (e) => {
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), ...e }, replacer)}\n`);
};

export const silentLogger: Logger = () => {};

/** The label used in every log line instead of a URL/host: `provider#1` is the first configured URL. */
export const providerLabel = (index: number): string => `provider#${index + 1}`;

const RATE = /\b429\b|rate.?limit|too many requests/i;
const TIMEOUT = /timed? ?out|timeout|ETIMEDOUT|AbortError/i;
const NETWORK = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|socket|network/i;
const HTTP = /\bHTTP request failed|Status: \d{3}|\b5\d\d\b/i;
const INVALID = /invalid|unexpected|parse|malformed|not found|could not be found/i;

/** Walk the error and its causes, joining every string field. NEVER log the result; it carries the URL. */
export function errorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur !== undefined && cur !== null; i++) {
    if (typeof cur === "string") {
      parts.push(cur);
      break;
    }
    if (typeof cur !== "object") break;
    const e = cur as { name?: unknown; message?: unknown; shortMessage?: unknown; details?: unknown; cause?: unknown };
    for (const f of [e.name, e.message, e.shortMessage, e.details]) if (typeof f === "string") parts.push(f);
    cur = e.cause;
  }
  return parts.join(" | ");
}

/** Reduce any error to a class label. The only thing an error contributes to a log line. */
export function describeError(err: unknown): ErrorClass {
  const text = errorText(err);
  if (err instanceof Error && err.name === "AbortError") return "aborted";
  if (RATE.test(text)) return "rate_limited";
  if (TIMEOUT.test(text)) return "timeout";
  if (NETWORK.test(text)) return "network";
  if (/RpcRequestError|RPC Request failed|JsonRpc|rpc/i.test(text) && !HTTP.test(text)) return "rpc_error";
  if (HTTP.test(text)) return "http_error";
  if (INVALID.test(text)) return "invalid_response";
  return "unknown";
}

/** Top-level crash handlers: log the class only, then exit non-zero. */
export function installCrashHandlers(log: Logger): void {
  const crash = (where: string) => (err: unknown) => {
    log({ event: "error", where, class: describeError(err) });
    process.exit(1);
  };
  process.on("uncaughtException", crash("uncaughtException"));
  process.on("unhandledRejection", crash("unhandledRejection"));
}
