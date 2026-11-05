// Lossless parsing of contract view JSON. Pure (browser + Node).

import { U64_BIGINT_FIELDS } from "./generated.ts";

const bigintFields = new Set<string>(U64_BIGINT_FIELDS);

/**
 * JSON.parse that keeps u64 precision: block timestamps (~1.7e18 > 2^53) become bigint, read from
 * the exact source text; any other unsafe integer throws rather than silently rounding.
 */
export function parseU64Safe(text: string): unknown {
  const reviver = (key: string, value: unknown, ctx?: { source?: string }) => {
    if (typeof value !== "number" || !Number.isInteger(value)) return value;
    if (bigintFields.has(key) && ctx?.source !== undefined) return BigInt(ctx.source);
    if (!Number.isSafeInteger(value)) throw new RangeError(`unsafe integer in field "${key}"`);
    return value;
  };
  return JSON.parse(text, reviver as (k: string, v: unknown) => unknown);
}

/** NEAR named account id (implicit ids — 64-hex / 0x-eth — are accepted as plain strings elsewhere). */
export const NEAR_ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** Task ids the tooling accepts: safe as a single argv element and in `purser/<task>/<persona>` paths. */
export const SAFE_TASK_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** A NEAR transaction hash (base58 of 32 bytes). */
export const NEAR_TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
