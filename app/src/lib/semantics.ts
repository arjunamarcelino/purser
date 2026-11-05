// What each state MEANS on the board (DESIGN-BRIEF §3, APP-FLOW §14). Every state has a text label
// and an icon as well as a tone, so nothing relies on color alone.
//
// The one rule that matters most: red ("alarm") appears ONLY when the contract itself reports the
// invariant does not hold. Refusals, blocks and rejections are amber — the system working.

import type { RefusalCode, ReservationState } from "@purser/types";

export type Tone = "ok" | "warn" | "alarm" | "brass" | "neutral" | "dim";
export type IconName = "check" | "clock" | "slash" | "key" | "alert" | "coins" | "minus";

export interface Badge {
  label: string;
  tone: Tone;
  icon: IconName;
  /** Screen-reader wording. */
  description: string;
}

export const stateBadge: Record<ReservationState, Badge> = {
  Reserved: { label: "RESERVED", tone: "brass", icon: "clock", description: "reserved, awaiting settlement" },
  Signed: { label: "SIGNED", tone: "brass", icon: "clock", description: "signature obtained, awaiting proof of outcome" },
  Confirmed: { label: "CONFIRMED", tone: "ok", icon: "check", description: "confirmed: payment proven and spent" },
  Unknown: { label: "UNKNOWN", tone: "warn", icon: "clock", description: "outcome unknown: reservation retained until proof" },
  Failed: { label: "FAILED", tone: "dim", icon: "minus", description: "failed before signature: reservation released" },
  Cancelled: { label: "CANCELLED", tone: "dim", icon: "minus", description: "cancelled with proof: reservation released" },
};

/** Refusals as the brief words them: REFUSED / BLOCKED / REJECTED, always amber. */
export function refusalBadge(code: RefusalCode | null): Badge {
  switch (code) {
    case "exceeds_task_budget":
      return { label: "REFUSED — exceeds task budget", tone: "warn", icon: "slash", description: "refused: exceeds task budget" };
    case "delegate_not_authorized":
      return { label: "BLOCKED — delegate revoked", tone: "warn", icon: "slash", description: "blocked: delegate not authorized or revoked" };
    case "recipient_not_allowlisted":
      return { label: "REJECTED — recipient not allowlisted", tone: "warn", icon: "slash", description: "rejected: recipient not on the allowlist" };
    case "invalid_recipient":
      return { label: "REJECTED — invalid recipient", tone: "warn", icon: "slash", description: "rejected: invalid recipient" };
    case "task_frozen":
      return { label: "BLOCKED — task frozen", tone: "warn", icon: "slash", description: "blocked: task frozen" };
    case null:
      return { label: "REFUSED", tone: "warn", icon: "slash", description: "refused" };
    default:
      return { label: `REFUSED — ${code.replaceAll("_", " ")}`, tone: "warn", icon: "slash", description: `refused: ${code.replaceAll("_", " ")}` };
  }
}

export type ManifestGroup = "holds" | "payments" | "released";
export const groupOf = (s: ReservationState): ManifestGroup =>
  s === "Confirmed" ? "payments" : s === "Failed" || s === "Cancelled" ? "released" : "holds";

export interface InvariantFacts {
  cap: bigint;
  completed: bigint;
  outstanding: bigint;
  holds: boolean;
  frozen: boolean;
}

export interface LineHealth {
  tone: "ok" | "warn" | "alarm" | "dim";
  icon: IconName;
  label: string;
}

export const STALE_AFTER_MS = 30_000;
/** Holds this large relative to the cap make the line amber: healthy, but a lot is awaiting proof. */
export const PENDING_HEAVY_FRACTION = 4n; // outstanding ≥ cap / 4

/**
 * The status line. Never green on stale or missing data; red only on the contract's own verdict.
 */
export function lineHealth(inv: InvariantFacts | null, opts: { hasUnknown: boolean; syncedAt: number | null; now: number }): LineHealth {
  if (inv === null || opts.syncedAt === null || opts.now - opts.syncedAt > STALE_AFTER_MS) {
    return { tone: "dim", icon: "clock", label: "STATE UNAVAILABLE" };
  }
  if (!inv.holds) return { tone: "alarm", icon: "alert", label: inv.frozen ? "INVARIANT VIOLATED — TASK FROZEN" : "INVARIANT VIOLATED" };
  if (opts.hasUnknown || (inv.cap > 0n && inv.outstanding * PENDING_HEAVY_FRACTION >= inv.cap)) {
    return { tone: "warn", icon: "clock", label: "HEALTHY — HOLDS PENDING PROOF" };
  }
  return { tone: "ok", icon: "check", label: "INVARIANT HEALTHY" };
}
