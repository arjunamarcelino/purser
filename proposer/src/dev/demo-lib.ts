// Pure helpers for the testnet demo driver (demo.ts): input validation, near-cli output parsing,
// explorer links and output scrubbing. No I/O here, so they are unit-tested.

export const RUN_ID = /^[a-z0-9-]{1,32}$/;
const BASE58_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const ED25519_SECRET_RE = /ed25519:[A-Za-z0-9]{40,}/g;

export function assertRunId(id: string): string {
  if (!RUN_ID.test(id)) throw new Error("RUN_ID must match ^[a-z0-9-]{1,32}$");
  return id;
}

/** Task id for one demo run. The run id is validated first, so it cannot widen the id. */
export const taskIdFor = (runId: string): string => `demo-${assertRunId(runId)}`;

/** near-cli-rs prints `Transaction ID: <hash>` on stderr after a send (no JSON flag exists). */
export function parseTxId(stderr: string | null | undefined): string | null {
  const m = /Transaction ID:\s*(\S+)/.exec(stderr ?? "");
  return m && BASE58_HASH.test(m[1]!) ? m[1]! : null;
}

/** A link is built only from a fixed host and a hash that looks like one. */
export function explorerUrl(txHash: string): string {
  if (!BASE58_HASH.test(txHash)) throw new Error("not a transaction hash");
  return `https://testnet.nearblocks.io/txns/${txHash}`;
}

/** Anything that looks like an ed25519 secret key never reaches the terminal. */
export const scrub = (s: string): string => s.replace(ED25519_SECRET_RE, "ed25519:[redacted]");

/** Fragments of an RPC URL that must never be printed: the URL, its userinfo, query values, long path segments. */
export function urlSecrets(rawUrl: string): string[] {
  const out = new Set<string>([rawUrl, rawUrl.replace(/\/+$/, "")]);
  try {
    const u = new URL(rawUrl);
    if (u.username) out.add(decodeURIComponent(u.username));
    if (u.password) out.add(decodeURIComponent(u.password));
    for (const v of u.searchParams.values()) if (v.length >= 4) out.add(v);
    for (const seg of u.pathname.split("/")) if (seg.length >= 16) out.add(seg);
  } catch {
    // not a parseable URL: the whole string is still redacted
  }
  return [...out].filter((x) => x.length >= 4);
}

/** A scrubber for one run: key-shaped strings plus every listed secret, longest first. */
export function makeScrubber(secrets: readonly string[]): (s: string) => string {
  const list = [...new Set(secrets.filter((x) => x.length >= 4))].sort((a, b) => b.length - a.length);
  return (s) => {
    let out = scrub(s);
    for (const secret of list) out = out.split(secret).join("[redacted]");
    return out;
  };
}

/** Why a spawned near-cli call failed, from a spawnSync result; never throws on null stderr. */
export function describeSpawn(r: { error?: Error; status: number | null; signal?: string | null; stderr?: string | null }, program = "near"): string | null {
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return `${program} was not found on PATH; install near-cli-rs`;
    if (code === "ETIMEDOUT") return `${program} timed out (keychain prompt or hung network?)`;
    return `${program} could not run: ${r.error.message}`;
  }
  if (r.signal) return `${program} was killed by ${r.signal} (timeout?)`;
  if (r.status !== 0) return `${program} exited with status ${r.status}`;
  return null;
}

// ---- verdicts: every pass/fail decision of outcomes 2, 3 and 6, pure so they can be tested ----------

export interface RaceResult {
  kind: string;
  code?: string;
  txHash: string | null;
  height: number | null;
}
export interface Verdict {
  pass: boolean;
  reasons: string[];
}
export interface RaceVerdict extends Verdict {
  admitted: number;
  refused: number;
  sameBlock: boolean;
}

/** Outcome 2: one winner, two budget refusals, all three bound on chain, exact remaining. */
export function judgeRace(results: readonly RaceResult[], before: bigint, after: bigint, unit: bigint): RaceVerdict {
  const reasons: string[] = [];
  if (results.length !== 3) reasons.push(`expected 3 racers, got ${results.length}`);
  const admitted = results.filter((r) => r.kind === "success").length;
  const refused = results.filter((r) => r.kind === "refused" && r.code === "exceeds_task_budget").length;
  results.forEach((r, i) => {
    if (!r.txHash) reasons.push(`racer ${i + 1} has no tx hash`);
    else if (r.height === null || !Number.isFinite(r.height)) reasons.push(`racer ${i + 1} has no block height`);
  });
  const heights = results.map((r) => r.height).filter((h): h is number => h !== null && Number.isFinite(h));
  const sameBlock = results.length === 3 && heights.length === 3 && new Set(heights).size === 1;
  if (admitted !== 1) reasons.push(`${admitted} admitted, expected 1`);
  if (refused !== 2) reasons.push(`${refused} refused with exceeds_task_budget, expected 2`);
  if (before !== 40n * unit) reasons.push(`Remaining before the race was ${before}, expected ${40n * unit}`);
  if (after !== 10n * unit) reasons.push(`Remaining after the race was ${after}, expected ${10n * unit} (10 units)`);
  return { pass: reasons.length === 0, reasons, admitted, refused, sameBlock };
}

export interface RetrySide {
  kind: string;
  code?: string;
  cid?: string;
  txHash?: string | null;
}

/** Outcome 3: the winner's resend returns the same commitment; the refused resend is a budget refusal; nothing moved. */
export function judgeRetry(first: RetrySide | undefined, again: RetrySide | undefined, againRefused: RetrySide | undefined, remaining: bigint, expected: bigint): Verdict {
  const reasons: string[] = [];
  if (!first || !again || !againRefused) return { pass: false, reasons: ["no winner and refused request to resend"] };
  if (first.kind !== "success") reasons.push("the original winner was not a success");
  if (again.kind !== "success") reasons.push(`winner resend was ${again.kind}, expected success`);
  else if (first.cid === undefined || again.cid !== first.cid) reasons.push("winner resend returned a different commitment");
  if (againRefused.kind !== "refused" || againRefused.code !== "exceeds_task_budget") {
    reasons.push(`refused resend was ${againRefused.kind}${againRefused.code ? `/${againRefused.code}` : ""}, expected refused/exceeds_task_budget`);
  }
  if (remaining !== expected) reasons.push(`Remaining ${remaining}, expected ${expected}`);
  return { pass: reasons.length === 0, reasons };
}

export interface InvariantView {
  holds: boolean;
  completed: bigint;
  outstanding: bigint;
  cap: bigint;
  frozen?: boolean | undefined;
}

/** Outcome 6: settled (outstanding 0), completed == 90 units, Remaining == 10 units, cap as created. */
export function judgeInvariant(inv: InvariantView | null, cap: bigint, remaining: bigint): Verdict {
  if (!inv) return { pass: false, reasons: ["invariant view returned nothing"] };
  const unit = unitsToYocto(cap, 1n);
  const reasons: string[] = [];
  if (inv.outstanding !== 0n) reasons.push(`settlement did not land in the poll window: outstanding ${inv.outstanding} yocto, expected 0`);
  if (inv.completed !== 90n * unit) reasons.push(`completed ${inv.completed} yocto, expected ${90n * unit} (90 units)`);
  if (remaining !== 10n * unit) reasons.push(`Remaining ${remaining} yocto, expected ${10n * unit} (10 units)`);
  if (inv.cap !== cap) reasons.push(`cap on chain ${inv.cap} differs from the created cap ${cap}`);
  if (inv.holds !== true) reasons.push("contract reports the invariant violated");
  if (inv.completed + inv.outstanding > inv.cap) reasons.push("completed + outstanding exceeds cap");
  return { pass: reasons.length === 0, reasons };
}

/** Exact units for display: "40", or "40.9" with the remainder shown, never truncated. */
export function formatUnits(yocto: bigint, cap: bigint): string {
  const unit = unitsToYocto(cap, 1n);
  const whole = yocto / unit;
  const rem = yocto % unit;
  if (rem === 0n) return whole.toString();
  const frac = ((rem * 10000n) / unit).toString().padStart(4, "0").replace(/0+$/, "");
  return `${whole}.${frac || "0000"}~`;
}

/** `units` budget units (1 unit = cap/100) as yocto. Exact integer math; cap must divide into 100 units. */
export function unitsToYocto(capYocto: bigint, units: bigint): bigint {
  if (capYocto <= 0n || capYocto % 100n !== 0n) throw new Error("cap must be a positive multiple of 100 yocto");
  return (capYocto / 100n) * units;
}

/** The demo cap in NEAR (up to 3 decimals, e.g. "1" or "0.5") as exact yocto. */
export function capNearToYocto(near: string): bigint {
  if (!/^(0|[1-9][0-9]{0,3})(\.[0-9]{1,3})?$/.test(near)) throw new Error("DEMO_CAP_NEAR must be a NEAR amount with up to 3 decimals (e.g. 1 or 0.5)");
  const [whole = "0", frac = ""] = near.split(".");
  const yocto = BigInt(whole) * 10n ** 24n + BigInt(frac.padEnd(24, "0"));
  if (yocto === 0n) throw new Error("DEMO_CAP_NEAR must be greater than zero");
  return yocto;
}
