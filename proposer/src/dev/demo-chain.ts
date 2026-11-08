// The chain helpers shared by the two testnet demo drivers: demo.ts (one full run) and demo-shots.ts
// (one shot per command). Owner calls go through near-cli-rs and the operator's keychain; delegate
// calls use the function-call keys. Every transaction is re-read from the chain and bound to its
// expected signer, receiver and method before it is reported.

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { JsonRpcProvider } from "near-api-js";
import { toRequestId } from "@purser/types";
import { PERSONA_IDS, type Config, type PersonaId, assertChainId } from "../config.ts";
import type { Merchants } from "../personas.ts";
import { DelegateSender, type PurserViewer, type SendResult, parseU64Safe, retryRateLimited } from "../purser-client.ts";
import { type DemoArgs, describeSpawn, explorerUrl, formatUnits, parseTxId, unitsToYocto } from "./demo-lib.ts";

/** Where a run stands, for the failure report: the task, the last finished step and every landed tx. */
export interface DemoRun {
  task: string;
  step: string;
  txs: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function demoChain(o: { cfg: Config; provider: JsonRpcProvider; viewer: PurserViewer; contract: string; operator: string; task: string; cap: bigint; run: DemoRun; scrubber: (s: string) => string }) {
  const { cfg, provider, viewer, contract, operator, task, cap, run, scrubber } = o;
  const step = (name: string) => {
    run.step = name;
  };
  const rpcChain = async () => assertChainId("testnet", await viewer.chainId());
  const sender = (p: PersonaId) => {
    const d = cfg.delegates[p]!;
    return new DelegateSender({ provider, contractId: contract, accountId: d.accountId, fcKey: d.fcKey });
  };
  const account = (p: PersonaId) => cfg.delegates[p]!.accountId;

  const verify = async (hash: string, signer: string, method: string, expect: "success" | "failure") => {
    step(`verify ${method} ${hash}`);
    const res = await retryRateLimited(() => provider.viewTransactionStatus({ txHash: hash, accountId: signer, waitUntil: "EXECUTED" }));
    const tx = res.transaction as { signer_id: string; receiver_id: string; actions: Array<{ FunctionCall?: { method_name: string } }> };
    const got = tx.actions[0]?.FunctionCall?.method_name;
    if (tx.signer_id !== signer || tx.receiver_id !== contract || got !== method) {
      throw new Error(`tx ${hash} is ${tx.signer_id} -> ${tx.receiver_id}.${got}, expected ${signer} -> ${contract}.${method}`);
    }
    const ok = typeof res.status === "object" && "SuccessValue" in res.status;
    if (ok !== (expect === "success")) throw new Error(`tx ${hash} ${ok ? "succeeded" : "failed"}; expected ${expect}`);
    const block = await retryRateLimited(() => provider.viewBlock({ blockId: res.transaction_outcome.block_hash }));
    if (!run.txs.includes(hash)) run.txs.push(hash);
    return { res, height: Number(block.header.height) };
  };
  /** Re-read a tx from the chain and bind it to what we meant to send; returns its block height. */
  const bind = async (hash: string, signer: string, method: string, expect: "success" | "failure"): Promise<number> => (await verify(hash, signer, method, expect)).height;
  /** As bind, plus the last block any of its receipts executed in: state reads must wait for that one. */
  const bindDetail = async (hash: string, signer: string, method: string, expect: "success" | "failure"): Promise<{ height: number; settled: number }> => {
    const { res, height } = await verify(hash, signer, method, expect);
    let settled = height;
    for (const blockHash of new Set(res.receipts_outcome.map((r) => r.block_hash))) {
      const block = await retryRateLimited(() => provider.viewBlock({ blockId: blockHash }));
      settled = Math.max(settled, Number(block.header.height));
    }
    return { height, settled };
  };
  const ref = (hash: string | null) => (hash ? `tx ${hash}\n        ${explorerUrl(hash)}` : "no tx hash recovered (not verified on chain)");

  /** An owner call through near-cli-rs; the hash comes from its stderr, then is verified on chain. */
  const owner = async (method: string, args: unknown): Promise<string> => {
    await rpcChain();
    step(`owner ${method}`);
    const r = spawnSync(
      "near",
      ["contract", "call-function", "as-transaction", contract, method, "json-args", JSON.stringify(args), "prepaid-gas", "30 Tgas", "attached-deposit", "0 NEAR", "sign-as", operator, "network-config", "testnet", "sign-with-keychain", "send"],
      { encoding: "utf8", timeout: 120_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } },
    );
    const stderr = r.stderr ?? "";
    const hash = parseTxId(stderr);
    const why = describeSpawn(r);
    if (why || !hash) {
      const tail = scrubber(stderr).split("\n").slice(-12).join("\n");
      throw new Error(`near ${method} failed: ${why ?? "no transaction id in near output (the call may still have landed; check the owner account)"}${tail ? `\n${tail}` : ""}`);
    }
    await bind(hash, operator, method, "success");
    return hash;
  };

  const taskView = async () => {
    const t = await viewer.view("get_task", { task_id: task });
    if (!t) throw new Error(`no such task ${task}`);
    return t;
  };
  const u = (n: bigint) => unitsToYocto(cap, n);
  /** A view at FINAL finality, read only once the final head has reached `minHeight` (the block of the tx just bound). */
  const finalView = async (method: "remaining_budget" | "invariant", minHeight: number): Promise<unknown> => {
    for (let i = 0; ; i++) {
      const head = await retryRateLimited(() => provider.viewBlock({ finality: "final" }));
      if (Number(head.header.height) >= minHeight) break;
      if (i >= 40) throw new Error(`final head never reached block ${minHeight}`);
      await sleep(1000);
    }
    const raw = await retryRateLimited(() =>
      provider.callFunctionRaw({ contractId: contract, method, args: new TextEncoder().encode(JSON.stringify({ task_id: task })), blockQuery: { finality: "final" } }),
    );
    return parseU64Safe(new TextDecoder().decode(Uint8Array.from(raw.result)));
  };
  const remainingAt = async (minHeight: number) => BigInt(String(await finalView("remaining_budget", minHeight)).replace(/"/g, ""));
  const readInvariant = async (minHeight: number) => {
    const v = (await finalView("invariant", minHeight)) as { completed: string; outstanding: string; cap: string; holds: boolean; frozen?: boolean } | null;
    return v && { holds: v.holds, completed: BigInt(v.completed), outstanding: BigInt(v.outstanding), cap: BigInt(v.cap), frozen: v.frozen };
  };
  const show = (y: bigint) => formatUnits(y, cap);

  const args = (to: string, units: bigint, memo: string, requestId = toRequestId(randomUUID())): DemoArgs => ({
    task,
    intent: { chain: "NearNative", recipient: to, amount: u(units).toString(), token: "NearNative", memo },
    request_id: requestId,
  });
  const send = (p: PersonaId, a: DemoArgs) => sender(p).proposeRaw(JSON.stringify(a));
  // Only the kind (and code) is printed, never raw error text: it can carry the RPC URL.
  const refusal = (r: SendResult) =>
    r.kind === "refused" ? r.code : r.kind === "success" ? "success" : r.kind === "unknown" ? "unknown (send state unknown; resending the same request_id is idempotent)" : r.kind;
  const hashOf = (r: SendResult) => ("txHash" in r ? r.txHash : null);
  /** Bind a send's tx to the chain (success or failure as the result says); returns its block height, null without a hash. */
  const bindResult = async (p: PersonaId, r: SendResult): Promise<number | null> => {
    const hash = hashOf(r);
    return hash ? bind(hash, account(p), "propose_payment", r.kind === "success" ? "success" : "failure") : null;
  };
  const bindResultDetail = async (p: PersonaId, r: SendResult): Promise<{ height: number; settled: number } | null> => {
    const hash = hashOf(r);
    return hash ? bindDetail(hash, account(p), "propose_payment", r.kind === "success" ? "success" : "failure") : null;
  };

  /** Owner setup of a fresh task: cap, the three delegates and the recipient allowlist. */
  const createTask = async (say: (line?: string) => void, capNear: string, m: Merchants) => {
    if ((await viewer.view("get_task", { task_id: task })) !== null) throw new Error(`task ${task} already exists; use a new RUN_ID`);
    say("\nsetup (owner)");
    say(`  create_task cap=${capNear} NEAR crew_cap=3 token=NearNative\n        ${ref(await owner("create_task", { task_id: task, cap: cap.toString(), token: "NearNative", crew_cap: 3 }))}`);
    step("setup done: task created");
    for (const p of PERSONA_IDS) {
      const h = await owner("add_delegate", { task_id: task, account_id: account(p), derivation_path: `purser/${task}/${p}` });
      say(`  add_delegate ${account(p)}\n        ${ref(h)}`);
    }
    say(`  set_recipient_allowlist data, compute, procure\n        ${ref(await owner("set_recipient_allowlist", { task_id: task, recipients: [m.data, m.compute, m.procurement] }))}`);
    const token = (await taskView()).token;
    if (JSON.stringify(token) !== JSON.stringify("NearNative")) throw new Error("task token is not NearNative");
  };

  return { step, rpcChain, account, ref, bind, bindDetail, owner, taskView, u, finalView, remainingAt, readInvariant, show, args, send, refusal, hashOf, bindResult, bindResultDetail, createTask };
}
