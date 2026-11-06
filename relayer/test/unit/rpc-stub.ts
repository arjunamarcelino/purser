// A local JSON-RPC server in front of a FakeChain, so the sims can run the REAL ViemEvmClient (request
// building, response parsing, error shapes and the URL inside viem's errors) instead of an in-memory fake.
// Per-server `ViewOpts` make one "RPC" disagree with another; `fail` makes it answer with an HTTP error.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ViemEvmClient, type Hex } from "../../src/evm.ts";
import { FakeChain, type ViewOpts } from "./fakes.ts";

export interface StubOptions {
  view?: ViewOpts;
  /** Answer this method with the given HTTP status instead of a result (e.g. 500 to provoke a viem error). */
  fail?: (method: string) => number | null;
  /** Path appended to the URL (viem puts the whole URL, path included, in its error messages). */
  path?: string;
}

const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
const ZERO32 = `0x${"00".repeat(32)}`;

const blockJson = (number: bigint, hash: Hex) => ({
  number: hex(number), hash, parentHash: ZERO32, timestamp: "0x1", transactions: [], uncles: [], gasLimit: "0x1", gasUsed: "0x0",
  miner: `0x${"00".repeat(20)}`, nonce: "0x0000000000000000", difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x",
  logsBloom: `0x${"00".repeat(256)}`, mixHash: ZERO32, receiptsRoot: ZERO32, sha3Uncles: ZERO32, size: "0x1", stateRoot: ZERO32, transactionsRoot: ZERO32,
});

export interface RpcStub {
  url: string;
  close(): Promise<void>;
  /** A real ViemEvmClient pointed at this server. */
  client(label: string): ViemEvmClient;
}

export async function startRpcStub(chain: FakeChain, opts: StubOptions = {}): Promise<RpcStub> {
  const view = chain.client("stub", opts.view ?? {});
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      void (async () => {
        const rpc = JSON.parse(body) as { id: number; method: string; params: unknown[] };
        const status = opts.fail?.(rpc.method) ?? null;
        if (status !== null) {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "failed" }));
          return;
        }
        const reply = (result: unknown) => res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
        const error = (message: string) => res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message } }));
        res.writeHead(200, { "content-type": "application/json" });
        try {
          const [p0, p1] = rpc.params as [string, string];
          switch (rpc.method) {
            case "eth_chainId":
              return reply("0xaa36a7");
            case "eth_getTransactionReceipt": {
              const r = await view.getReceipt(p0 as Hex);
              if (r === null) return reply(null);
              return reply({
                transactionHash: p0, transactionIndex: "0x0", blockHash: r.blockHash, blockNumber: hex(r.blockNumber), from: `0x${"33".repeat(20)}`, to: `0x${"44".repeat(20)}`,
                cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null, logs: [], logsBloom: `0x${"00".repeat(256)}`,
                status: r.status === "success" ? "0x1" : "0x0", type: "0x2",
              });
            }
            case "eth_getBlockByNumber": {
              const b = p0 === "finalized" ? await view.getFinalized() : await view.getBlock(BigInt(p0));
              return reply(b === null ? null : blockJson(b.number, b.hash));
            }
            case "eth_getTransactionCount":
              return reply(hex(await view.getNonce(p0 as Hex, p1 === "finalized" ? "finalized" : "latest")));
            case "eth_getCode":
              return reply(await view.getCode(p0 as Hex));
            case "eth_getBalance":
              return reply(hex(await view.getBalance(p0 as Hex)));
            case "eth_sendRawTransaction": {
              const out = await view.sendRaw(p0 as Hex);
              if (out.kind === "Accepted") return reply(out.hash);
              return error({ Pending: "already known", Landed: "nonce too low", Underpriced: "replacement transaction underpriced", Rejected: "insufficient funds", Unknown: "boom" }[out.kind]);
            }
            default:
              return error(`method ${rpc.method} not supported by the stub`);
          }
        } catch (err) {
          return error((err as Error).message);
        }
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${opts.path ?? "/"}`;
  return {
    url,
    close: () => new Promise<void>((r) => server.close(() => r())),
    client: (label) => new ViemEvmClient({ url, label, retry: { sleep: async () => {}, random: () => 0 } }),
  };
}
