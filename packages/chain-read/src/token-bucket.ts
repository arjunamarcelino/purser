import { defaultSleep, type Sleep } from "./retry.ts";

export interface TokenBucketOptions {
  ratePerSec?: number;
  burst?: number;
  /** Monotonic milliseconds. */
  now?: () => number;
  sleep?: Sleep;
}

/**
 * One global limiter shared by every worker, so concurrency never multiplies the request rate
 * against a public RPC. Waiters are served in arrival order.
 */
export class TokenBucket {
  readonly #rate: number;
  readonly #burst: number;
  readonly #now: () => number;
  readonly #sleep: Sleep;
  #tokens: number;
  #last: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(opts: TokenBucketOptions = {}) {
    this.#rate = opts.ratePerSec ?? 4;
    this.#burst = opts.burst ?? 4;
    this.#now = opts.now ?? (() => performance.now());
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#tokens = this.#burst;
    this.#last = this.#now();
  }

  take(signal?: AbortSignal): Promise<void> {
    const run = this.#queue.then(() => this.#acquire(signal));
    // A failed (aborted) waiter must not poison the queue for the next one.
    this.#queue = run.catch(() => {});
    return run;
  }

  async #acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      const t = this.#now();
      this.#tokens = Math.min(this.#burst, this.#tokens + ((t - this.#last) / 1000) * this.#rate);
      this.#last = t;
      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      await this.#sleep(Math.ceil(((1 - this.#tokens) / this.#rate) * 1000), signal);
    }
  }
}
