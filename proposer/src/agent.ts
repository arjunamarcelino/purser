// One persona, one decision: resume-or-decide → journal → propose → settle → record.
//
// runPersona never rejects for an expected outcome (refusal, decline, model or network failure):
// those are values, so a concurrent `Promise.all` over the crew always yields every outcome.
// It throws only for programmer/config errors.

import { randomUUID } from "node:crypto";
import {
  type CommitmentId,
  type PaymentIntent,
  ProposalRecord,
  type ReservationState,
  type RequestId,
  toCommitmentId,
  toRequestId,
} from "@purser/types";
import { appendEvidence, evaluate, type Pins } from "./attestation.ts";
import type { Network } from "./config.ts";
import { toPaymentIntent } from "./intent.ts";
import type { Journal, JournalEntry } from "./journal.ts";
import type { Logger } from "./log.ts";
import type { ModelResult, ProposeFn } from "./model.ts";
import type { Offer, Persona } from "./personas.ts";
import { type ChainOutcome, type PurserViewer, type SendResult, type Sender, hex } from "./purser-client.ts";

export interface CrewContext {
  network: Network;
  contractId: string;
  task: string;
  viewer: PurserViewer;
  log: Logger;
  pins: readonly Pins[];
  evidencePath: string | null;
  logContent: boolean;
  /** Bounded wait for an in-flight or unknown request to resolve (ms). */
  pollBudgetMs?: number;
}

export interface PersonaRuntime {
  persona: Persona;
  sender: Sender;
  journal: Journal;
  model: ProposeFn;
  offers: Offer[];
  goal?: string;
}

export type AgentOutcome =
  | { kind: "declined"; rationale: string }
  | { kind: "model_error"; reason: string }
  | { kind: "blocked_by_open_entry"; requestId: string }
  | ChainOutcome;

export interface PersonaResult {
  outcome: AgentOutcome;
  record: ProposalRecord;
  resumed: boolean;
}

const YOCTO = 10n ** 24n;
export const yoctoToNear = (y: string | bigint): string => {
  const v = BigInt(y);
  const frac = (v % YOCTO).toString().padStart(24, "0").replace(/0+$/, "");
  return `${v / YOCTO}${frac ? `.${frac}` : ""}`;
};

type IdemPoll = { kind: "committed"; cid: CommitmentId } | { kind: "failed" } | { kind: "pending" } | { kind: "none" };

async function pollIdempotency(ctx: CrewContext, accountId: string, requestId: string): Promise<IdemPoll> {
  const deadline = Date.now() + (ctx.pollBudgetMs ?? 30_000);
  let wait = 500;
  for (;;) {
    const s = await ctx.viewer.view("get_idempotency", { account_id: accountId, request_id: requestId });
    if (s === null) return { kind: "none" };
    if (s === "Failed") return { kind: "failed" };
    if (s !== "Pending") return { kind: "committed", cid: toCommitmentId(s.Committed.commitment_id) };
    if (Date.now() + wait > deadline) return { kind: "pending" };
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(wait * 1.5, 4_000);
  }
}

async function readCommitment(ctx: CrewContext, cid: CommitmentId): Promise<{ state: ReservationState; payloadHash: string | null }> {
  const c = await ctx.viewer.view("get_commitment", { commitment_id: cid });
  if (c === null) throw new Error(`commitment ${cid} not found after the contract returned it`);
  return { state: c.state, payloadHash: hex(c.payload_hash) };
}

/**
 * Drive one journaled request to an outcome. Sends the journaled bytes; on an uncertain result
 * consults get_idempotency instead of guessing, and resends the SAME bytes at most once when the
 * chain shows no trace of the request.
 */
async function settle(ctx: CrewContext, rt: PersonaRuntime, entry: JournalEntry): Promise<ChainOutcome> {
  const accountId = rt.sender.accountId;
  let sent: SendResult = await rt.sender.proposeRaw(entry.args_json);
  for (let resends = 0; ; resends++) {
    if (sent.kind === "success") {
      const c = await readCommitment(ctx, sent.cid);
      return { kind: "admitted", cid: sent.cid, state: c.state, txHash: sent.txHash, payloadHash: c.payloadHash };
    }
    const uncertain = sent.kind === "unknown" || sent.kind === "unclassified" || (sent.kind === "refused" && sent.code === "in_flight");
    if (!uncertain) return sent;

    const idem = await pollIdempotency(ctx, accountId, entry.request_id);
    if (idem.kind === "committed") {
      const c = await readCommitment(ctx, idem.cid);
      return { kind: "replayed", cid: idem.cid, state: c.state, txHash: null, payloadHash: c.payloadHash };
    }
    if (idem.kind === "failed") return { kind: "refused", code: "already_failed", retry: "terminal", raw: "get_idempotency: Failed", txHash: null };
    if (idem.kind === "pending") return { kind: "unknown", raw: `still in flight after ${ctx.pollBudgetMs ?? 30_000} ms` };
    // No trace on chain. A failure that executed (unclassified) had no effect: terminal. An unknown
    // send may simply not have landed: resend the same bytes once.
    if (sent.kind === "unclassified") return sent;
    if (resends >= 1) return sent;
    sent = await rt.sender.proposeRaw(entry.args_json);
  }
}

/** Outcomes that end a journal entry. `unknown` stays open and is resumed by the next run. */
const isTerminal = (o: ChainOutcome) => o.kind !== "unknown";

function recordFor(ctx: CrewContext, rt: PersonaRuntime, decisionId: string, requestId: string | null, intent: PaymentIntent | null, outcome: AgentOutcome, startedAt: number): ProposalRecord {
  const chain = "cid" in outcome ? outcome : null;
  const detail =
    outcome.kind === "declined" ? outcome.rationale
    : outcome.kind === "model_error" ? outcome.reason
    : outcome.kind === "blocked_by_open_entry" ? `unresolved request ${outcome.requestId}`
    : "raw" in outcome ? outcome.raw
    : null;
  return ProposalRecord.parse({
    schema_version: 1,
    decision_id: decisionId,
    persona: rt.persona.id,
    account_id: rt.sender.accountId,
    network: ctx.network,
    contract_id: ctx.contractId,
    task: ctx.task,
    request_id: requestId,
    outcome: outcome.kind,
    recipient: intent?.recipient ?? null,
    amount_yocto: intent?.amount ?? null,
    commitment_id: chain?.cid ?? null,
    state: chain?.state ?? null,
    refusal_code: outcome.kind === "refused" ? outcome.code : null,
    detail,
    tx_hash: "txHash" in outcome ? outcome.txHash : null,
    payload_hash: chain?.payloadHash ?? null,
    latency_ms: Date.now() - startedAt,
    at: new Date().toISOString(),
  });
}

function logOutcome(ctx: CrewContext, r: ProposalRecord) {
  ctx.log({
    event: "outcome",
    decision_id: r.decision_id,
    persona: r.persona,
    request_id: r.request_id,
    outcome: r.outcome,
    commitment_id: r.commitment_id,
    state: r.state,
    refusal_code: r.refusal_code,
    tx_hash: r.tx_hash,
    detail: r.detail,
  });
}

async function finishEntry(ctx: CrewContext, rt: PersonaRuntime, entry: JournalEntry, outcome: ChainOutcome) {
  if (isTerminal(outcome)) {
    await rt.journal.resolve(entry, outcome.kind);
    ctx.log({ event: "journal", decision_id: entry.decision_id, request_id: entry.request_id, status: "resolved", outcome: outcome.kind });
  } else {
    ctx.log({ event: "journal", decision_id: entry.decision_id, request_id: entry.request_id, status: "open", outcome: outcome.kind });
  }
}

async function recordEvidence(ctx: CrewContext, rt: PersonaRuntime, decisionId: string, requestId: string | null, m: ModelResult, outcome: AgentOutcome, verification: Promise<unknown> | undefined) {
  if (m.meta.chatId === null) return; // scripted model: no inference happened
  const chain = "cid" in outcome ? outcome : null;
  let result: Parameters<typeof evaluate>[1];
  if (verification === undefined) result = { unavailable: m.meta.unverifiedReason ?? "verification_unavailable" };
  else {
    try {
      result = { result: (await verification) as never };
    } catch (error) {
      result = { error };
    }
  }
  const evidence = evaluate(
    { decisionId, persona: rt.persona.id, accountId: rt.sender.accountId, requestId, commitmentId: chain?.cid ?? null, payloadHash: chain?.payloadHash ?? null, model: m.meta.model, chatId: m.meta.chatId },
    result,
    ctx.pins,
  );
  if (ctx.evidencePath) appendEvidence(ctx.evidencePath, evidence);
  ctx.log({ event: "attestation", decision_id: decisionId, verified: evidence.verified, reasons: evidence.reasons, digest: evidence.digest });
}

export async function runPersona(ctx: CrewContext, rt: PersonaRuntime): Promise<PersonaResult> {
  const startedAt = Date.now();

  // 1. An unresolved request blocks a new decision: resume it with its journaled bytes.
  const open = rt.journal.openEntry(ctx.task);
  if (open) {
    ctx.log({ event: "resume", persona: rt.persona.id, request_id: open.request_id });
    const intent = (JSON.parse(open.args_json) as { intent: PaymentIntent }).intent;
    const outcome = await settle(ctx, rt, open);
    await finishEntry(ctx, rt, open, outcome);
    const shown: AgentOutcome = outcome.kind === "unknown" ? { kind: "blocked_by_open_entry", requestId: open.request_id } : outcome;
    const record = recordFor(ctx, rt, open.decision_id, open.request_id, intent, shown, startedAt);
    logOutcome(ctx, record);
    return { outcome: shown, record, resumed: true };
  }

  // 2. Decide. Public, read-only state goes to the model as context; it has no bearing on safety.
  const decisionId = randomUUID();
  const done = (outcome: AgentOutcome, requestId: string | null = null, intent: PaymentIntent | null = null): PersonaResult => {
    const record = recordFor(ctx, rt, decisionId, requestId, intent, outcome, startedAt);
    logOutcome(ctx, record);
    return { outcome, record, resumed: false };
  };
  let taskToken: PaymentIntent["token"];
  let remaining: string;
  let cap: string;
  try {
    const t = await ctx.viewer.view("get_task", { task_id: ctx.task });
    if (t === null) throw new Error(`no such task: ${ctx.task}`);
    taskToken = t.token;
    cap = t.cap;
    remaining = await ctx.viewer.view("remaining_budget", { task_id: ctx.task });
  } catch (err) {
    return done({ kind: "model_error", reason: `could not read task state: ${err instanceof Error ? err.message : String(err)}` });
  }

  const m = await rt.model({ persona: rt.persona, goal: rt.goal ?? rt.persona.goal, remainingNear: yoctoToNear(remaining), capNear: yoctoToNear(cap), offers: rt.offers });
  // Start verification right away: signature records on the gateway expire.
  const verification = m.meta.verify?.();
  verification?.catch(() => {}); // awaited (and its error recorded) in recordEvidence
  if (ctx.logContent) ctx.log({ event: "content", decision_id: decisionId, prompt: m.meta.prompt, completion: m.meta.completion });

  if (!m.ok) {
    const outcome: AgentOutcome = { kind: "model_error", reason: `${m.reason}: ${m.detail}` };
    await recordEvidence(ctx, rt, decisionId, null, m, outcome, verification);
    return done(outcome);
  }
  ctx.log({ event: "decision", decision_id: decisionId, persona: rt.persona.id, action: m.decision.action, rationale: m.decision.rationale, prompt_sha256: m.meta.promptSha256, completion_sha256: m.meta.completionSha256, chat_id: m.meta.chatId });
  if (m.decision.action === "decline") {
    const outcome: AgentOutcome = { kind: "declined", rationale: m.decision.rationale };
    await recordEvidence(ctx, rt, decisionId, null, m, outcome, verification);
    return done(outcome);
  }
  const intent = toPaymentIntent(m.decision, taskToken);
  if (!intent.ok) {
    const outcome: AgentOutcome = { kind: "model_error", reason: `schema: ${intent.reason}` };
    await recordEvidence(ctx, rt, decisionId, null, m, outcome, verification);
    return done(outcome);
  }

  // 3. One decision → one request_id, journaled with the exact bytes BEFORE sending.
  const requestId: RequestId = toRequestId(randomUUID());
  const argsJson = JSON.stringify({ task: ctx.task, intent: intent.value, request_id: requestId });
  const entry = await rt.journal.begin(ctx.task, decisionId, requestId, argsJson);
  ctx.log({ event: "journal", decision_id: decisionId, request_id: requestId, status: "pending" });

  let outcome: ChainOutcome;
  try {
    outcome = await settle(ctx, rt, entry);
  } catch (err) {
    // An unexpected failure mid-settlement: leave the entry open so the next run resolves it.
    outcome = { kind: "unknown", raw: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
  await finishEntry(ctx, rt, entry, outcome);
  await recordEvidence(ctx, rt, decisionId, requestId, m, outcome, verification);
  return done(outcome, requestId, intent.value);
}
