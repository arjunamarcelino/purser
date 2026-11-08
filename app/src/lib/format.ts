// Display formatting. Amounts stay bigint/decimal strings end to end — never floats.

import { formatUnits, unitsToYocto } from "@purser/types";

const YOCTO = 10n ** 24n;

/** yoctoNEAR → decimal NEAR, trimmed to `maxDecimals` (rounded down: never overstate money). */
export function formatNear(yocto: string | bigint, maxDecimals = 4): string {
  const v = BigInt(yocto);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / YOCTO;
  let frac = (abs % YOCTO).toString().padStart(24, "0").slice(0, maxDecimals).replace(/0+$/, "");
  if (frac === "" && abs % YOCTO !== 0n && whole === 0n) frac = "0".repeat(maxDecimals - 1) + "1"; // tiny but non-zero
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

/** How the board writes an amount. Display only: chain reads and the invariant verdict never pass through it. */
export interface AmountDisplay {
  readonly unit: "NEAR" | "units";
  readonly fmt: (yocto: string | bigint) => string;
  /** For a count-up frame: unit mode shows whole units only, so an in-between value never flickers as "87.3412~". */
  readonly frame: (yocto: bigint) => string;
  /** Always shown in unit mode, so the scale of a round number is never hidden. */
  readonly note: string | null;
}

export const nearDisplay: AmountDisplay = { unit: "NEAR", fmt: (y) => formatNear(y), frame: (y) => formatNear(y), note: null };

/** Units of cap/100 when asked for and the cap divides evenly; NEAR otherwise. */
export function amountDisplay(cap: bigint, wantUnits: boolean): AmountDisplay {
  if (!wantUnits || cap <= 0n || cap % 100n !== 0n) return nearDisplay;
  const unit = unitsToYocto(cap, 1n);
  return { unit: "units", fmt: (y) => formatUnits(BigInt(y), cap), frame: (y) => (y / unit).toString(), note: `units · 1 unit = ${formatNear(unit, 24)} NEAR` };
}

/** "7LCgg1…oidwXD" for hashes; account ids stay whole (they are how humans recognise agents). */
export const shortHash = (h: string) => (h.length > 14 ? `${h.slice(0, 6)}…${h.slice(-6)}` : h);

// Bidi overrides, zero-width and other invisible/control characters can make an attacker-chosen
// string (a memo, a refusal detail, a recipient) render as something else. Strip them, then cap.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f­؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￰-￸]/g;

export function safeText(s: string | null | undefined, max = 120): string {
  if (!s) return "";
  const clean = s.replace(INVISIBLE, "");
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Block timestamp (ns, bigint) → local time "14:03:22". */
export function formatTime(ns: bigint | string | number): string {
  const ms = Number(BigInt(ns) / 1_000_000n);
  return new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
}

export function ago(fromMs: number | null, nowMs: number): string {
  if (fromMs === null) return "never";
  const s = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ${s % 60}s ago`;
}
