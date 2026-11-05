// Structured JSON-lines logging to stderr (stdout is reserved for `--json` records).
// Events are a closed union: no arbitrary objects (signers, accounts, clients) can be logged.

import type { RefusalCode } from "@purser/types";

export type LogEvent =
  | { event: "config"; network: string; contract_id: string | null; task: string | null; model: string; personas: string[] }
  | { event: "decision"; decision_id: string; persona: string; action: "propose" | "decline"; rationale: string; prompt_sha256: string; completion_sha256: string; chat_id: string | null }
  | { event: "content"; decision_id: string; prompt: string; completion: string }
  | { event: "journal"; decision_id: string; request_id: string; status: "pending" | "resolved" | "open"; outcome?: string }
  | { event: "resume"; persona: string; request_id: string }
  | { event: "outcome"; decision_id: string; persona: string; request_id: string | null; outcome: string; commitment_id: number | null; state: string | null; refusal_code: RefusalCode | null; tx_hash: string | null; detail: string | null }
  | { event: "attestation"; decision_id: string; verified: boolean; reasons: string[]; digest: string }
  | { event: "warn"; message: string };

// JSON.stringify escapes C0 controls (incl. ESC) but not C1 (0x80-0x9f), and model output is
// attacker-influenced; strip both before anything reaches a terminal.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
export const sanitizeForTerminal = (s: string): string => s.replace(CONTROL, "");

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return sanitizeForTerminal(value);
  return value;
}

export type Logger = (e: LogEvent) => void;

export const stderrLogger: Logger = (e) => {
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), ...e }, replacer)}\n`);
};

export const silentLogger: Logger = () => {};

/** JSON with bigint support; never throws on a bigint. */
export const toJson = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));
