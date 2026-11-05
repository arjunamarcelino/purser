import { describe, expect, it } from "vitest";
import { NearChainReader, TokenBucket, UnknownBlockError, retryRateLimited, withTimeout, type RpcProvider } from "../src/index.ts";

const noSleep = async () => {};
const signal = () => new AbortController().signal;
const enc = (v: unknown) => Array.from(new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v)));

function fake(over: Partial<RpcProvider>): RpcProvider {
  return {
    callFunctionRaw: async () => ({ result: enc(null) }),
    viewBlock: async () => ({ header: { height: 10, hash: "h" } }),
    viewNodeStatus: async () => ({ chain_id: "testnet" }),
    ...over,
  };
}
const reader = (provider: RpcProvider, extra: object = {}) =>
  new NearChainReader({ rpcUrl: "http://x", contractId: "c.testnet", provider, sleep: noSleep, random: () => 0, ...extra });

describe("retryRateLimited", () => {
  it("retries 429 then succeeds, with exponential backoff", async () => {
    const waits: number[] = [];
    let n = 0;
    const out = await retryRateLimited(
      async () => {
        if (++n < 3) throw new Error("HTTP 429 Too Many Requests");
        return "ok";
      },
      { sleep: async (ms) => void waits.push(ms), random: () => 0 },
    );
    expect(out).toBe("ok");
    expect(waits).toEqual([1000, 2000]);
  });

  it("throws the last error once attempts are exhausted", async () => {
    let n = 0;
    await expect(
      retryRateLimited(async () => { n++; throw new Error("rate limit exceeded"); }, { attempts: 3, sleep: noSleep }),
    ).rejects.toThrow(/rate limit/);
    expect(n).toBe(3);
  });

  it("does not retry other errors", async () => {
    let n = 0;
    await expect(retryRateLimited(async () => { n++; throw new Error("boom"); }, { sleep: noSleep })).rejects.toThrow("boom");
    expect(n).toBe(1);
  });

  it("stops when aborted during backoff", async () => {
    const ac = new AbortController();
    await expect(
      retryRateLimited(async () => { throw new Error("429"); }, {
        signal: ac.signal,
        sleep: async () => { ac.abort(new Error("stop")); ac.signal.throwIfAborted(); },
      }),
    ).rejects.toThrow("stop");
  });
});

describe("withTimeout", () => {
  it("rejects after the timeout", async () => {
    await expect(withTimeout(new Promise(() => {}), signal(), 15)).rejects.toThrow("timed out");
  });
  it("rejects on abort", async () => {
    const ac = new AbortController();
    const p = withTimeout(new Promise(() => {}), ac.signal, 10_000);
    ac.abort(new Error("gone"));
    await expect(p).rejects.toThrow("gone");
  });
});

describe("TokenBucket", () => {
  it("allows a burst, then paces at the configured rate", async () => {
    let t = 0;
    const slept: number[] = [];
    const bucket = new TokenBucket({ ratePerSec: 4, burst: 4, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
    for (let i = 0; i < 4; i++) await bucket.take();
    expect(slept).toEqual([]);
    await bucket.take();
    await bucket.take();
    expect(slept).toEqual([250, 250]);
  });
});

describe("NearChainReader", () => {
  it("decodes a u64 timestamp above 2^53 as bigint", async () => {
    const reader_ = reader(fake({ callFunctionRaw: async () => ({ result: enc('{"created_at":1700000000123456789,"cap":"5"}') }) }));
    const out = (await reader_.view("get_task", { task_id: "t" }, 10n, signal())) as { created_at: bigint };
    expect(out.created_at).toBe(1700000000123456789n);
  });

  it("pins the requested block height", async () => {
    let seen: unknown;
    const r = reader(fake({ callFunctionRaw: async (a) => { seen = a.blockQuery; return { result: enc([]) }; } }));
    await r.view("list_task_ids", { from_index: 0, limit: 100 }, 12345n, signal());
    expect(seen).toEqual({ blockId: 12345 });
  });

  it("retries a 429 on a view and then succeeds", async () => {
    let n = 0;
    const r = reader(fake({ callFunctionRaw: async () => { if (++n === 1) throw new Error("429 Too Many Requests"); return { result: enc(true) }; } }));
    expect(await r.view("is_delegate_authorized", { task_id: "t", account_id: "a.testnet" }, 1n, signal())).toBe(true);
    expect(n).toBe(2);
  });

  it("maps UNKNOWN_BLOCK to a typed error", async () => {
    const r = reader(fake({ callFunctionRaw: async () => { throw Object.assign(new Error("block missing"), { type: "UNKNOWN_BLOCK" }); } }));
    await expect(r.view("version", {}, 1n, signal())).rejects.toBeInstanceOf(UnknownBlockError);
  });

  it("times out a hung provider", async () => {
    const r = reader(fake({ callFunctionRaw: () => new Promise(() => {}) }), { timeoutMs: 15 });
    await expect(r.view("version", {}, 1n, signal())).rejects.toThrow("timed out");
  });

  it("does not call the provider when already aborted", async () => {
    let n = 0;
    const r = reader(fake({ callFunctionRaw: async () => { n++; return { result: enc(1) }; } }));
    const ac = new AbortController();
    ac.abort(new Error("stop"));
    await expect(r.view("version", {}, 1n, ac.signal)).rejects.toThrow("stop");
    expect(n).toBe(0);
  });

  it("reads the final block and chain id", async () => {
    const r = reader(fake({}));
    expect(await r.finalBlock(signal())).toEqual({ height: 10n, hash: "h" });
    expect(await r.chainId(signal())).toBe("testnet");
  });
});
