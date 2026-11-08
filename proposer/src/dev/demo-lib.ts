// Pure helpers for the testnet demo driver (demo.ts): input validation, near-cli output parsing,
// explorer links and output scrubbing. No I/O here, so they are unit-tested.

import { formatUnits, unitsToYocto } from "@purser/types";

export { formatUnits, unitsToYocto };

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

/** The demo cap in NEAR (up to 3 decimals, e.g. "1" or "0.5") as exact yocto. */
export function capNearToYocto(near: string): bigint {
  if (!/^(0|[1-9][0-9]{0,3})(\.[0-9]{1,3})?$/.test(near)) throw new Error("DEMO_CAP_NEAR must be a NEAR amount with up to 3 decimals (e.g. 1 or 0.5)");
  const [whole = "0", frac = ""] = near.split(".");
  const yocto = BigInt(whole) * 10n ** 24n + BigInt(frac.padEnd(24, "0"));
  if (yocto === 0n) throw new Error("DEMO_CAP_NEAR must be greater than zero");
  return yocto;
}

// ---- the recording shots (demo-shots.ts) ------------------------------------------------------------

/** The propose_payment arguments of one demo request, stored so a shot can resend the exact request. */
export interface DemoArgs {
  task: string;
  intent: { chain: string; recipient: string; amount: string; token: string; memo: string };
  request_id: string;
}

const PERSONAS = ["scout", "forge", "buyer"] as const;
type Persona = (typeof PERSONAS)[number];

/** What later shots need from earlier processes. Holds no keys. */
export interface DemoSession {
  contract: string;
  task: string;
  winner?: { persona: Persona; args: DemoArgs; cid: number };
  refused?: { persona: Persona; args: DemoArgs };
}

const isArgs = (v: unknown): v is DemoArgs => {
  const a = v as DemoArgs | null;
  return typeof a?.task === "string" && typeof a.request_id === "string" && ["chain", "recipient", "amount", "token", "memo"].every((k) => typeof (a.intent as unknown as Record<string, unknown> | undefined)?.[k] === "string");
};
const isPersona = (v: unknown): v is Persona => PERSONAS.includes(v as Persona);

/** A session file is local but hand-editable: anything malformed means "run setup", never a half-valid resend. */
export function parseSession(raw: string): DemoSession {
  const bad = new Error("the demo session file is malformed: run ./scripts/demo.sh setup for a new take");
  let s: DemoSession;
  try {
    s = JSON.parse(raw) as DemoSession;
  } catch {
    throw bad;
  }
  if (typeof s?.contract !== "string" || typeof s.task !== "string") throw bad;
  if (s.winner !== undefined && !(isPersona(s.winner.persona) && isArgs(s.winner.args) && Number.isSafeInteger(s.winner.cid))) throw bad;
  if (s.refused !== undefined && !(isPersona(s.refused.persona) && isArgs(s.refused.args))) throw bad;
  return s;
}

/** The fields of a SendResult a record needs (structural, so this file stays free of the RPC client). */
export interface SendOutcome {
  kind: string;
  cid?: number;
  code?: string;
  txHash?: string | null;
}

/** A ProposalRecord for one send. `detail` stays null: raw error text can carry the RPC URL. */
export function shotRecord(i: { decisionId: string; persona: Persona; accountId: string; contract: string; args: DemoArgs; result: SendOutcome; latencyMs: number; at: string }) {
  const { result: r, args } = i;
  return {
    schema_version: 1 as const,
    decision_id: i.decisionId,
    persona: i.persona,
    account_id: i.accountId,
    network: "testnet" as const,
    contract_id: i.contract,
    task: args.task,
    request_id: args.request_id,
    outcome: r.kind === "success" ? "admitted" : r.kind,
    recipient: args.intent.recipient,
    amount_yocto: args.intent.amount,
    commitment_id: r.kind === "success" ? (r.cid ?? null) : null,
    state: null,
    refusal_code: r.kind === "refused" ? (r.code ?? null) : null,
    detail: null,
    tx_hash: r.txHash ?? null,
    payload_hash: null,
    latency_ms: i.latencyMs,
    at: i.at,
  };
}

// ---- the naive baseline (naive-baseline.ts) --------------------------------------------------------

export interface BaselineLane {
  hash: string;
  to: string;
  /** The block the agent's balance read was served from. */
  read: number;
  /** The block its transfer was included in. */
  included: number;
  /** The Transfer deposit re-read from the chain. */
  deposit: bigint;
  /** Whether the chain reports the transfer succeeded. */
  ok: boolean;
}

export interface BaselineResult {
  sawUnits: number;
  capUnits: number;
  spentUnits: number;
  overUnits: number;
  a: { hash: string; to: string; read: number; included: number };
  b: { hash: string; to: string; read: number; included: number };
}

/** Whole units an agent sees left: cap minus what left since the anchor; a late gas refund cannot lift it past the cap. */
export function baselineSeenUnits(anchor: bigint, read: bigint, cap: bigint, unit: bigint): number {
  const left = cap - (anchor - read);
  const clamped = left > cap ? cap : left < 0n ? 0n : left;
  return Number(clamped / unit);
}

/** The double-spend is claimed only with two distinct verified transfers, reads that preceded both, and a matching independent oracle. */
export function judgeBaseline(a: BaselineLane, b: BaselineLane, i: { spend: bigint; unit: bigint; capUnits: number; sawUnits: number; merchantDelta: bigint }): Verdict & { result: BaselineResult | null } {
  const reasons: string[] = [];
  for (const [name, l] of [["A", a], ["B", b]] as const) {
    if (!BASE58_HASH.test(l.hash)) reasons.push(`agent ${name} has no valid tx hash`);
    if (!l.ok) reasons.push(`agent ${name}'s transfer did not succeed`);
    if (l.deposit !== i.spend) reasons.push(`agent ${name} transferred ${l.deposit}, expected ${i.spend}`);
  }
  if (a.hash === b.hash) reasons.push("both agents report the same transaction");
  if (a.read >= b.included) reasons.push(`agent A read at ${a.read}, not before B's transfer at ${b.included}`);
  if (b.read >= a.included) reasons.push(`agent B read at ${b.read}, not before A's transfer at ${a.included}`);
  const expected = i.spend * 2n;
  if (i.merchantDelta !== expected) reasons.push(`merchants received ${i.merchantDelta} yocto, expected ${expected}`);
  const spentUnits = Number(expected / i.unit);
  if (spentUnits <= i.capUnits) reasons.push(`spent ${spentUnits} units does not exceed the cap of ${i.capUnits}`);
  if (reasons.length > 0) return { pass: false, reasons, result: null };
  const lane = (l: BaselineLane) => ({ hash: l.hash, to: l.to, read: l.read, included: l.included });
  return { pass: true, reasons, result: { sawUnits: i.sawUnits, capUnits: i.capUnits, spentUnits, overUnits: spentUnits - i.capUnits, a: lane(a), b: lane(b) } };
}

/** The one line the baseline page reads. The companion truncates lines at 500 characters. */
export function formatBaselineLine(r: BaselineResult): string {
  const line = `BASELINE ${JSON.stringify(r)}`;
  if (line.length >= 500) throw new Error("baseline result line is too long");
  return line;
}
