import { setTimeout as delay } from "node:timers/promises";

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Abortable sleep; rejects with the signal's reason so a shutdown is not mistaken for a retryable failure. */
export const defaultSleep: Sleep = (ms, signal) => delay(ms, undefined, signal === undefined ? {} : { signal });

const RATE_LIMITED = /\b429\b|rate limit/i;

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  sleep?: Sleep;
  /** Returns [0,1); injectable so backoff is deterministic in tests. */
  random?: () => number;
  signal?: AbortSignal;
}

function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return `${err.message} ${String((err as { cause?: unknown }).cause ?? "")}`;
}

/**
 * Retry a READ when the RPC rate-limits it (public endpoints answer 429; near-api-js only retries
 * 500/503/408). Reads are idempotent, so this is always safe; it must never wrap a send.
 */
export async function retryRateLimited<T>(read: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { attempts = 6, baseMs = 1000, sleep = defaultSleep, random = Math.random, signal } = opts;
  for (let i = 0; ; i++) {
    signal?.throwIfAborted();
    try {
      return await read();
    } catch (err) {
      if (i >= attempts - 1 || !RATE_LIMITED.test(describe(err))) throw err;
      const backoff = baseMs * 2 ** i;
      // Jitter keeps concurrent workers from re-hitting a limited node in lockstep.
      await sleep(backoff + random() * (backoff / 4), signal);
    }
  }
}

/** A provider call that gives up after `ms` or when `signal` aborts (near-api-js takes no signal). */
export function withTimeout<T>(p: Promise<T>, signal: AbortSignal, ms = 10_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => reject(new Error("RPC timed out")), ms);
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  });
}
