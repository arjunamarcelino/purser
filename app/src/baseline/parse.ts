// Reads a finished baseline job from the companion's event stream. The driver prints exactly one
// `BASELINE {json}` line on full success; anything else is not a result, so nothing over-cap is shown.

import { NEAR_ACCOUNT_ID, NEAR_TX_HASH } from "@purser/types";

export interface BaselineLane {
  hash: string;
  to: string;
  read: number;
  included: number;
}
export interface BaselineResult {
  sawUnits: number;
  capUnits: number;
  spentUnits: number;
  overUnits: number;
  a: BaselineLane;
  b: BaselineLane;
}
export interface JobStream {
  done: boolean;
  code: number | null;
  lines: string[];
}

export function readStream(ndjson: string): JobStream {
  const out: JobStream = { done: false, code: null, lines: [] };
  for (const raw of ndjson.split("\n")) {
    if (!raw) continue;
    try {
      const msg = JSON.parse(raw) as { line?: unknown; done?: unknown; code?: unknown };
      if (msg.done === true) {
        out.done = true;
        out.code = typeof msg.code === "number" ? msg.code : null;
      } else if (typeof msg.line === "string") {
        out.lines.push(msg.line);
      }
    } catch {
      /* a cut-off line is not an event */
    }
  }
  return out;
}

const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function lane(v: unknown): BaselineLane | null {
  const l = v as Partial<BaselineLane> | null;
  if (typeof l !== "object" || l === null) return null;
  if (typeof l.hash !== "string" || !NEAR_TX_HASH.test(l.hash)) return null;
  if (typeof l.to !== "string" || !NEAR_ACCOUNT_ID.test(l.to)) return null;
  return count(l.read) && count(l.included) ? { hash: l.hash, to: l.to, read: l.read, included: l.included } : null;
}

/** The single, well-formed result line of the job, or null. */
export function parseResult(lines: readonly string[]): BaselineResult | null {
  const found = lines.filter((l) => l.startsWith("BASELINE "));
  if (found.length !== 1) return null;
  let v: Partial<BaselineResult>;
  try {
    v = JSON.parse(found[0]!.slice("BASELINE ".length)) as Partial<BaselineResult>;
  } catch {
    return null;
  }
  const a = lane(v.a);
  const b = lane(v.b);
  if (!a || !b || !count(v.sawUnits) || !count(v.capUnits) || !count(v.spentUnits) || !count(v.overUnits)) return null;
  if (a.hash === b.hash || v.spentUnits - v.capUnits !== v.overUnits) return null;
  return { sawUnits: v.sawUnits, capUnits: v.capUnits, spentUnits: v.spentUnits, overUnits: v.overUnits, a, b };
}
