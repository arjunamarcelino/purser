// The model behind a persona. Untrusted: whatever it returns is only a proposal.
//
// Two implementations share one signature:
//   - nearAiModel: NEAR AI Cloud through the official @nearai/inference-sdk client, which verifies
//     the TEE attestation before sending and keeps the exact bytes for response verification;
//   - scriptedModel: deterministic output for CI and for the "compromised model" scenarios. The
//     safety proof must never depend on a real model misbehaving on cue.

import { createHash } from "node:crypto";
import { InferenceClient } from "@nearai/inference-sdk/node";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { Secret } from "./config.ts";
import { ProposedIntentWire, parseDecision, type ProposedDecision } from "./intent.ts";
import { buildMessages, type PromptInput } from "./personas.ts";

export type ModelErrorReason = "schema" | "refusal" | "length" | "http";

export interface ModelMeta {
  model: string;
  chatId: string | null;
  promptSha256: string;
  completionSha256: string;
  prompt: string;
  completion: string;
  /** Verify this completion's attestation (NEAR AI Cloud only). */
  verify?: () => Promise<unknown>;
  /** Why the verified transport was not used, if it was not. */
  unverifiedReason?: string;
}

export type ModelResult =
  | { ok: true; decision: ProposedDecision; meta: ModelMeta }
  | { ok: false; reason: ModelErrorReason; detail: string; meta: ModelMeta };

export type ProposeFn = (input: PromptInput) => Promise<ModelResult>;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const RESPONSE_FORMAT = zodResponseFormat(ProposedIntentWire, "proposed_intent");

function metaFor(model: string, prompt: string, completion: string, chatId: string | null): ModelMeta {
  return { model, chatId, prompt, completion, promptSha256: sha256(prompt), completionSha256: sha256(completion) };
}

/** Deterministic model: returns `script(input)` as if the model had said it. */
export function scriptedModel(script: (input: PromptInput) => unknown): ProposeFn {
  return async (input) => {
    const { system, user } = buildMessages(input);
    const prompt = `${system}\n\n${user}`;
    const out = script(input);
    const completion = JSON.stringify(out);
    const meta = metaFor("scripted", prompt, completion, null);
    const parsed = parseDecision(out);
    return parsed.ok ? { ok: true, decision: parsed.value, meta } : { ok: false, reason: "schema", detail: parsed.reason, meta };
  };
}

type Completion = OpenAI.Chat.Completions.ChatCompletion;
type CompletionCreate = (body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming) => Promise<Completion>;

export interface NearAiOptions {
  baseUrl: string;
  apiKey: Secret;
  model: string;
}

/**
 * NEAR AI Cloud model. Requests are non-streaming, temperature 0, and sent with
 * `x-no-aliasing: true` to the canonical model id — streams and aliases get only a gateway
 * signature. If the SDK's attestation preflight fails, the call falls back to a plain client
 * (the proposer is untrusted either way) and the evidence will say so.
 */
export function nearAiModel(opts: NearAiOptions): ProposeFn {
  const headers = { "x-no-aliasing": "true" };
  const verified = new InferenceClient({ apiKey: opts.apiKey.reveal(), baseUrl: opts.baseUrl, signingAlgo: "ecdsa", headers });
  const plain = new OpenAI({ apiKey: opts.apiKey.reveal(), baseURL: opts.baseUrl, defaultHeaders: headers, maxRetries: 1, timeout: 60_000 });

  const send = async (
    body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<{ c: Completion; verify?: () => Promise<unknown>; unverifiedReason?: string }> => {
    try {
      const c = await (verified.chat.completions.create as unknown as CompletionCreate)(body);
      return { c, verify: () => verified.verifyResponse(c.id) };
    } catch (err) {
      const name = err instanceof Error ? err.name : "Error";
      if (name !== "VerificationError") throw err;
      const c = await plain.chat.completions.create(body);
      return { c, unverifiedReason: `attestation preflight failed: ${err instanceof Error ? err.message : name}` };
    }
  };

  return async (input) => {
    const { system, user } = buildMessages(input);
    const prompt = `${system}\n\n${user}`;
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    let last: ModelResult | undefined;
    // One re-ask on a schema miss; never "repair" fields by guessing.
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Awaited<ReturnType<typeof send>>;
      try {
        res = await send({ model: opts.model, messages, temperature: 0, stream: false, response_format: RESPONSE_FORMAT });
      } catch (err) {
        const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        return { ok: false, reason: "http", detail, meta: metaFor(opts.model, prompt, "", null) };
      }
      const choice = res.c.choices[0];
      const content = choice?.message.content ?? "";
      const meta: ModelMeta = { ...metaFor(res.c.model ?? opts.model, prompt, content, res.c.id ?? null) };
      if (res.verify) meta.verify = res.verify;
      if (res.unverifiedReason) meta.unverifiedReason = res.unverifiedReason;
      if (choice?.message.refusal) return { ok: false, reason: "refusal", detail: choice.message.refusal, meta };
      if (choice?.finish_reason === "length") return { ok: false, reason: "length", detail: "completion truncated", meta };
      let json: unknown;
      try {
        json = JSON.parse(content);
      } catch {
        json = undefined;
      }
      const parsed = parseDecision(json);
      if (parsed.ok) return { ok: true, decision: parsed.value, meta };
      last = { ok: false, reason: "schema", detail: parsed.reason, meta };
      messages.push({ role: "assistant", content }, { role: "user", content: "That reply did not match the required JSON schema. Reply again with only the JSON object." });
    }
    return last as ModelResult;
  };
}
