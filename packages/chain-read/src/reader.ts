// View-only reads at a pinned block. Nothing in this package can sign or send.

import { JsonRpcProvider } from "near-api-js";
import { parseU64Safe, type PurserViews } from "@purser/types";
import { retryRateLimited, withTimeout, type Sleep } from "./retry.ts";
import { TokenBucket } from "./token-bucket.ts";

export interface ChainReader {
  chainId(signal: AbortSignal): Promise<string>;
  /** The latest final block; every view of a pass is then read at this height. */
  finalBlock(signal: AbortSignal): Promise<{ height: bigint; hash: string }>;
  /** Raw decoded JSON (u64 timestamps as bigint); the caller validates the shape. */
  view<M extends keyof PurserViews>(method: M, args: PurserViews[M]["args"], blockHeight: bigint, signal: AbortSignal): Promise<unknown>;
}

/** The pinned block is no longer served (pruned, or the node is on another fork): re-pin, do not fail the pass. */
export class UnknownBlockError extends Error {
  readonly kind = "unknown_block" as const;
}

/** The slice of JsonRpcProvider this package uses, so tests can fake it. */
export interface RpcProvider {
  callFunctionRaw(args: {
    contractId: string;
    method: string;
    args: Uint8Array;
    blockQuery: { blockId: number } | { finality: "final" };
  }): Promise<{ result: ArrayLike<number> }>;
  viewBlock(blockQuery: { finality: "final" }): Promise<{ header: { height: number; hash: string } }>;
  viewNodeStatus(): Promise<{ chain_id: string }>;
}

export interface NearChainReaderOptions {
  rpcUrl: string;
  contractId: string;
  provider?: RpcProvider;
  bucket?: TokenBucket;
  sleep?: Sleep;
  random?: () => number;
  timeoutMs?: number;
}

const UNKNOWN_BLOCK = /UNKNOWN_BLOCK|UnknownBlock/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isUnknownBlock(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const typed = err as { type?: unknown; cause?: unknown };
  return UNKNOWN_BLOCK.test(`${err.name} ${err.message} ${String(typed.type ?? "")} ${String(typed.cause ?? "")}`);
}

export class NearChainReader implements ChainReader {
  readonly #provider: RpcProvider;
  readonly #contractId: string;
  readonly #bucket: TokenBucket;
  readonly #sleep: Sleep | undefined;
  readonly #random: (() => number) | undefined;
  readonly #timeoutMs: number;

  constructor(opts: NearChainReaderOptions) {
    // `retries` is the ATTEMPT count in near-api-js 7 (0 sends nothing). Its own loop backs off for
    // minutes without a timeout, so it gets one attempt and retryRateLimited does the retrying.
    this.#provider = opts.provider ?? new JsonRpcProvider({ url: opts.rpcUrl }, { retries: 1 });
    this.#contractId = opts.contractId;
    this.#bucket = opts.bucket ?? new TokenBucket();
    this.#sleep = opts.sleep;
    this.#random = opts.random;
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
  }

  #call<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    return retryRateLimited(
      async () => {
        await this.#bucket.take(signal);
        return withTimeout(fn(), signal, this.#timeoutMs);
      },
      { signal, ...(this.#sleep && { sleep: this.#sleep }), ...(this.#random && { random: this.#random }) },
    );
  }

  async chainId(signal: AbortSignal): Promise<string> {
    return (await this.#call(signal, () => this.#provider.viewNodeStatus())).chain_id;
  }

  async finalBlock(signal: AbortSignal): Promise<{ height: bigint; hash: string }> {
    const { header } = await this.#call(signal, () => this.#provider.viewBlock({ finality: "final" }));
    return { height: BigInt(header.height), hash: header.hash };
  }

  async view<M extends keyof PurserViews>(method: M, args: PurserViews[M]["args"], blockHeight: bigint, signal: AbortSignal): Promise<unknown> {
    try {
      const raw = await this.#call(signal, () =>
        this.#provider.callFunctionRaw({
          contractId: this.#contractId,
          method,
          args: encoder.encode(JSON.stringify(args)),
          blockQuery: { blockId: Number(blockHeight) },
        }),
      );
      return parseU64Safe(decoder.decode(Uint8Array.from(raw.result)));
    } catch (err) {
      if (isUnknownBlock(err)) throw new UnknownBlockError(`block ${blockHeight} is not available`, { cause: err });
      throw err;
    }
  }
}
