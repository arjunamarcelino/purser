// Verifying what a wallet hands back after an owner call. Pure (no connector), so it is unit-tested.

import { type RefusalCode, classifyRefusal } from "@purser/types";
import { config } from "../config.ts";

export type OwnerMethod = "revoke_delegate" | "add_delegate" | "set_recipient_allowlist" | "create_task";

export type OwnerOutcome =
  | { kind: "ok"; txHash: string; blockHash: string }
  | { kind: "refused"; code: RefusalCode | null; raw: string; txHash: string | null }
  | { kind: "rejected"; raw: string } // the user declined, or the wallet failed before sending
  | { kind: "unknown"; raw: string };

/** What a wallet hands back. Untrusted: any field may be missing, so all are optional/undefined-able. */
export type Outcome = {
  status?: { SuccessValue?: string | undefined; Failure?: unknown } | string | undefined;
  transaction?:
    | {
        hash?: string | undefined;
        signer_id?: string | undefined;
        receiver_id?: string | undefined;
        actions?: Array<{ FunctionCall?: { method_name?: string | undefined; args?: string | undefined } | undefined } | string> | undefined;
      }
    | undefined;
  transaction_outcome?: { block_hash?: string | undefined } | undefined;
};

function executionError(failure: unknown): string {
  const text = JSON.stringify(failure);
  const m = /"ExecutionError":"((?:[^"\\]|\\.)*)"/.exec(text);
  return m ? JSON.parse(`"${m[1]}"`) : text;
}

/** Canonical JSON (sorted keys) so the requested and the signed args compare by value. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

function decodeArgs(b64: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
  } catch {
    return undefined;
  }
}

/** The outcome must PROVE it is the transaction we asked for: final, our contract, expected signer, exact method and args. */
// A wallet can hand back any transaction: a pasted hash of an earlier owner call must never read as "Revoke: done".
export function checkOutcome(outcome: Outcome, method: OwnerMethod, args: Record<string, unknown>, expectedSigner: string): OwnerOutcome {
  const tx = outcome.transaction;
  const status = outcome.status;
  if (!tx || typeof status !== "object" || status === null) return { kind: "unknown", raw: "the wallet returned no final outcome: check the explorer" };
  if (tx.receiver_id !== config.contractId) return { kind: "unknown", raw: `transaction is for ${tx.receiver_id ?? "?"}, not ${config.contractId}` };
  if (tx.signer_id !== expectedSigner) return { kind: "unknown", raw: `transaction was signed by ${tx.signer_id ?? "?"}, expected ${expectedSigner}` };
  const actions = tx.actions ?? [];
  const call = actions.length === 1 && typeof actions[0] === "object" ? actions[0].FunctionCall : undefined;
  if (!call || call.method_name !== method) return { kind: "unknown", raw: `transaction calls ${call?.method_name ?? "something else"}, not ${method}` };
  if (call.args === undefined || canonical(decodeArgs(call.args)) !== canonical(args)) return { kind: "unknown", raw: "transaction arguments differ from what you approved" };
  if ("Failure" in status && status.Failure !== undefined) {
    const raw = executionError(status.Failure);
    return { kind: "refused", code: classifyRefusal(raw)?.code ?? null, raw, txHash: tx.hash ?? null };
  }
  if (!("SuccessValue" in status)) return { kind: "unknown", raw: "transaction outcome is not final yet: check the explorer" };
  return { kind: "ok", txHash: tx.hash ?? "", blockHash: outcome.transaction_outcome?.block_hash ?? "" };
}

