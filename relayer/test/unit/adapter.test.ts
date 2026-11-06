import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ViemEvmClient } from "../../src/evm.ts";

type Handler = (method: string, params: unknown[], call: number) => { status?: number; result?: unknown; error?: { code: number; message: string } };

let server: Server | undefined;
let requests = 0;

async function stub(handler: Handler): Promise<string> {
  requests = 0;
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      requests += 1;
      const rpc = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      const out = handler(rpc.method, rpc.params, requests);
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out.status && out.status !== 200 ? { error: "limited" } : { jsonrpc: "2.0", id: rpc.id, ...(out.error ? { error: out.error } : { result: out.result ?? null }) }));
    });
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

const RAW = "0x02f8" as const;

describe("ViemEvmClient against a local stub", () => {
  it("retries a 429 on a READ with backoff, then succeeds", async () => {
    const url = await stub((m, _p, call) => (call === 1 ? { status: 429 } : { result: "0xaa36a7" }));
    const sleeps: number[] = [];
    const c = new ViemEvmClient({ url, label: "provider#1", retry: { sleep: async (ms) => void sleeps.push(ms), random: () => 0 } });
    expect(await c.chainId()).toBe(11155111n);
    expect(requests).toBe(2);
    expect(sleeps).toHaveLength(1);
  });

  it("never retries a SEND on 429: one request, outcome Unknown", async () => {
    const url = await stub(() => ({ status: 429 }));
    const c = new ViemEvmClient({ url, label: "provider#1", retry: { sleep: async () => {} } });
    expect(await c.sendRaw(RAW)).toEqual({ kind: "Unknown" });
    expect(requests).toBe(1);
  });

  it("classifies 'already known' and 'nonce too low' broadcast errors", async () => {
    let msg = "already known";
    const url = await stub(() => ({ error: { code: -32000, message: msg } }));
    const c = new ViemEvmClient({ url, label: "provider#1" });
    expect(await c.sendRaw(RAW)).toEqual({ kind: "Pending" });
    msg = "nonce too low: next nonce 3, tx nonce 1";
    expect(await c.sendRaw(RAW)).toEqual({ kind: "Landed" });
    msg = "replacement transaction underpriced";
    expect(await c.sendRaw(RAW)).toEqual({ kind: "Underpriced" });
  });

  it("returns the hash on acceptance", async () => {
    const hash = `0x${"ab".repeat(32)}`;
    const url = await stub(() => ({ result: hash }));
    expect(await new ViemEvmClient({ url, label: "provider#1" }).sendRaw(RAW)).toEqual({ kind: "Accepted", hash });
  });

  it("maps a null receipt to null and a mined one to the narrow shape", async () => {
    let receipt: unknown = null;
    const url = await stub(() => ({ result: receipt }));
    const c = new ViemEvmClient({ url, label: "provider#1" });
    expect(await c.getReceipt(`0x${"11".repeat(32)}`)).toBeNull();
    receipt = {
      transactionHash: `0x${"11".repeat(32)}`, transactionIndex: "0x0", blockHash: `0x${"22".repeat(32)}`, blockNumber: "0x64",
      from: `0x${"33".repeat(20)}`, to: `0x${"44".repeat(20)}`, cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x1",
      contractAddress: null, logs: [], logsBloom: `0x${"00".repeat(256)}`, status: "0x0", type: "0x2",
    };
    expect(await c.getReceipt(`0x${"11".repeat(32)}`)).toEqual({ status: "reverted", blockNumber: 100n, blockHash: `0x${"22".repeat(32)}` });
  });

  it("reads the finalized head and an empty code as an EOA", async () => {
    const url = await stub((m) => (m === "eth_getCode" ? { result: "0x" } : { result: { number: "0x5", hash: `0x${"55".repeat(32)}`, parentHash: `0x${"00".repeat(32)}`, timestamp: "0x1", transactions: [], uncles: [], gasLimit: "0x1", gasUsed: "0x0", miner: `0x${"00".repeat(20)}`, nonce: "0x0000000000000000", difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", logsBloom: `0x${"00".repeat(256)}`, mixHash: `0x${"00".repeat(32)}`, receiptsRoot: `0x${"00".repeat(32)}`, sha3Uncles: `0x${"00".repeat(32)}`, size: "0x1", stateRoot: `0x${"00".repeat(32)}`, transactionsRoot: `0x${"00".repeat(32)}` } }));
    const c = new ViemEvmClient({ url, label: "provider#1" });
    expect(await c.getFinalized()).toEqual({ number: 5n, hash: `0x${"55".repeat(32)}` });
    expect(await c.getCode(`0x${"44".repeat(20)}`)).toBe("0x");
  });
});
