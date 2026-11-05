#!/usr/bin/env node
// demo — replays outcomes 1-6 of docs/PURSER-DEMO-SCRIPT.md on NEAR TESTNET with real tx refs.
// Outcome 7 (timeout) is a labeled sandbox replay run by scripts/demo.sh, not here.
//
//   RUN_ID=<id> OPERATOR_ACCOUNT_ID=<op>.testnet node --env-file=../.env.testnet src/dev/demo.ts
//
// One fresh task per run (`demo-<RUN_ID>`, cap = DEMO_CAP_NEAR, default 1 NEAR = 100 units, 1 unit =
// cap/100): revocation is permanent, so a task cannot be replayed. Owner calls go through near-cli-rs
// and the operator's keychain (the operator key never leaves it); delegate calls use the function-call
// keys from .env.testnet. Every transaction is re-read from the chain and bound to its expected
// signer, receiver and method before it is reported. Exit 1 if any assertion fails.

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { JsonRpcProvider } from "near-api-js";
import { toRequestId } from "@purser/types";
import { PERSONA_IDS, type PersonaId, assertAccountId, assertChainId, loadConfig } from "../config.ts";
import { DelegateSender, PurserViewer, type SendResult, assertProposeOnlyKey, retryRateLimited } from "../purser-client.ts";
import { assertRunId, explorerUrl, parseTxId, scrub, taskIdFor, unitsToYocto, capNearToYocto } from "./demo-lib.ts";

const say = (line = "") => process.stdout.write(`${scrub(line)}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Outcome {
  n: number;
  name: string;
  pass: boolean;
  detail: string;
}
const outcomes: Outcome[] = [];
const record = (n: number, name: string, pass: boolean, detail: string) => {
  outcomes.push({ n, name, pass, detail });
  say(`  ${pass ? "PASS" : "FAIL"}  ${detail}`);
};

async function main(): Promise<number> {
  if (process.env.NEAR_NETWORK && process.env.NEAR_NETWORK !== "testnet") throw new Error("demo runs on testnet only (never mainnet)");
  const cfg = loadConfig({ ...process.env, NEAR_NETWORK: "testnet" });
  const runId = assertRunId(process.env.RUN_ID ?? "");
  const operator = assertAccountId(process.env.OPERATOR_ACCOUNT_ID ?? "", "testnet", "OPERATOR_ACCOUNT_ID");
  const capNear = process.env.DEMO_CAP_NEAR ?? "1";
  const cap = capNearToYocto(capNear);
  if (!cfg.rpcUrl || !cfg.contractId || !cfg.merchants) throw new Error("run scripts/deploy-testnet.sh first (.env.testnet is incomplete)");
  const contract = cfg.contractId;
  if (contract !== `purser.${operator}`) throw new Error(`PURSER_CONTRACT_ID ${contract} is not purser.${operator}`);
  const task = taskIdFor(runId);
  const m = cfg.merchants;

  const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
  const viewer = new PurserViewer(provider, contract);
  const rpcChain = async () => assertChainId("testnet", await viewer.chainId());
  await rpcChain();
  for (const p of PERSONA_IDS) {
    const d = cfg.delegates[p];
    if (!d) throw new Error(`.env.testnet has no key for ${p}`);
    await assertProposeOnlyKey(provider, d.accountId, d.fcKey, contract);
  }
  const sender = (p: PersonaId) => {
    const d = cfg.delegates[p]!;
    return new DelegateSender({ provider, contractId: contract, accountId: d.accountId, fcKey: d.fcKey });
  };
  const account = (p: PersonaId) => cfg.delegates[p]!.accountId;

  say(`Purser testnet demo — contract ${contract}`);
  say(`run ${runId}, task ${task}, cap ${capNear} NEAR = 100 units (1 unit = ${capNear}/100 NEAR)`);

  /** Re-read a tx from the chain and bind it to what we meant to send; returns its block height. */
  const bind = async (hash: string, signer: string, method: string, expect: "success" | "failure"): Promise<number> => {
    const res = await retryRateLimited(() => provider.viewTransactionStatus({ txHash: hash, accountId: signer, waitUntil: "EXECUTED" }));
    const tx = res.transaction as { signer_id: string; receiver_id: string; actions: Array<{ FunctionCall?: { method_name: string } }> };
    const got = tx.actions[0]?.FunctionCall?.method_name;
    if (tx.signer_id !== signer || tx.receiver_id !== contract || got !== method) {
      throw new Error(`tx ${hash} is ${tx.signer_id} -> ${tx.receiver_id}.${got}, expected ${signer} -> ${contract}.${method}`);
    }
    const ok = typeof res.status === "object" && "SuccessValue" in res.status;
    if (ok !== (expect === "success")) throw new Error(`tx ${hash} ${ok ? "succeeded" : "failed"}; expected ${expect}`);
    const block = await retryRateLimited(() => provider.viewBlock({ blockId: res.transaction_outcome.block_hash }));
    return Number(block.header.height);
  };
  const ref = (hash: string | null) => (hash ? `tx ${hash}\n        ${explorerUrl(hash)}` : "no tx (refused before inclusion)");

  /** An owner call through near-cli-rs; the hash comes from its stderr, then is verified on chain. */
  const owner = async (method: string, args: unknown): Promise<string> => {
    await rpcChain();
    const r = spawnSync(
      "near",
      ["contract", "call-function", "as-transaction", contract, method, "json-args", JSON.stringify(args), "prepaid-gas", "30 Tgas", "attached-deposit", "0 NEAR", "sign-as", operator, "network-config", "testnet", "sign-with-keychain", "send"],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } },
    );
    const hash = parseTxId(r.stderr);
    if (r.status !== 0 || !hash) throw new Error(`near ${method} failed:\n${scrub(r.stderr).split("\n").slice(-12).join("\n")}`);
    await bind(hash, operator, method, "success");
    return hash;
  };

  const taskView = async () => {
    const t = await viewer.view("get_task", { task_id: task });
    if (!t) throw new Error(`no such task ${task}`);
    return t;
  };
  const remaining = async () => BigInt(await viewer.view("remaining_budget", { task_id: task }));
  const unitsLeft = async () => (((await remaining()) * 100n) / cap).toString(); // exact: amounts are whole multiples of a unit
  const u = (n: bigint) => unitsToYocto(cap, n);

  const args = (to: string, units: bigint, memo: string, requestId = toRequestId(randomUUID())) => ({
    task,
    intent: { chain: "NearNative", recipient: to, amount: u(units).toString(), token: "NearNative", memo },
    request_id: requestId,
  });
  const send = (p: PersonaId, a: ReturnType<typeof args>) => sender(p).proposeRaw(JSON.stringify(a));
  const refusal = (r: SendResult) => (r.kind === "refused" ? r.code : r.kind === "success" ? "success" : `${r.kind}: ${"raw" in r ? r.raw.slice(0, 200) : ""}`);
  const hashOf = (r: SendResult) => ("txHash" in r ? r.txHash : null);

  // ---- setup (owner) --------------------------------------------------------------------
  if ((await viewer.view("get_task", { task_id: task })) !== null) throw new Error(`task ${task} already exists; use a new RUN_ID`);
  say("\nsetup (owner)");
  say(`  create_task cap=${capNear} NEAR crew_cap=3 token=NearNative\n        ${ref(await owner("create_task", { task_id: task, cap: cap.toString(), token: "NearNative", crew_cap: 3 }))}`);
  for (const p of PERSONA_IDS) {
    const h = await owner("add_delegate", { task_id: task, account_id: account(p), derivation_path: `purser/${task}/${p}` });
    say(`  add_delegate ${account(p)}\n        ${ref(h)}`);
  }
  say(`  set_recipient_allowlist data, compute, procure\n        ${ref(await owner("set_recipient_allowlist", { task_id: task, recipients: [m.data, m.compute, m.procurement] }))}`);
  const token = (await taskView()).token;
  if (JSON.stringify(token) !== JSON.stringify("NearNative")) throw new Error("task token is not NearNative");

  // ---- 1. two legitimate purchases of 30 ----------------------------------------------
  say("\n1. legitimate spend — Remaining 100 -> 70 -> 40");
  const legit: Array<[PersonaId, string, string, string]> = [["scout", m.data, "weather dataset", "70"], ["forge", m.compute, "gpu hours", "40"]];
  let legitOk = true;
  for (const [p, to, memo, want] of legit) {
    const r = await send(p, args(to, 30n, memo));
    if (r.kind !== "success") {
      legitOk = false;
      say(`  ${p}: ${refusal(r)}`);
      continue;
    }
    await bind(r.txHash, account(p), "propose_payment", "success");
    const left = await unitsLeft();
    legitOk &&= left === want;
    say(`  ${p} pays 30 -> ${to}   Remaining ${left}\n        ${ref(r.txHash)}`);
  }
  record(1, "legit spend", legitOk, `two purchases of 30; Remaining ${await unitsLeft()} (expected 40)`);

  // ---- 2. concurrent over-budget: 3 x 30 against 40 ------------------------------------
  say("\n2. concurrent over-budget — three agents fire 30 each against 40 left");
  const before = await unitsLeft();
  if (before !== "40") throw new Error(`race needs exactly 40 units left, found ${before}`);
  const raceArgs = PERSONA_IDS.map((p) => ({ p, a: args(m.data, 30n, `race-${p}`) }));
  const results = await Promise.all(raceArgs.map(({ p, a }) => send(p, a))); // three keys, started together
  let admitted = 0;
  const heights: number[] = [];
  let winner: { p: PersonaId; a: ReturnType<typeof args> } | null = null;
  let refusedOne: { p: PersonaId; a: ReturnType<typeof args> } | null = null;
  for (const [i, r] of results.entries()) {
    const { p, a } = raceArgs[i]!;
    const hash = hashOf(r);
    const h = hash ? await bind(hash, account(p), "propose_payment", r.kind === "success" ? "success" : "failure") : null;
    if (h !== null) heights.push(h);
    if (r.kind === "success") {
      admitted++;
      winner = { p, a };
    } else if (r.kind === "refused" && r.code === "exceeds_task_budget") refusedOne ??= { p, a };
    say(`  ${p.padEnd(5)} ${r.kind === "success" ? "ADMITTED" : `REFUSED (${refusal(r)})`}  block ${h ?? "-"}\n        ${ref(hash)}`);
  }
  const refusedOk = results.filter((r) => r.kind === "refused" && r.code === "exceeds_task_budget").length;
  const after = await unitsLeft();
  say(`  blocks: ${heights.join(", ")} (${new Set(heights).size === 1 ? "same block" : "different blocks: concurrency not proven by height"})`);
  record(2, "concurrent over-budget", admitted === 1 && refusedOk === 2 && after === "10", `${admitted} admitted, ${refusedOk} refused (exceeds task budget); Remaining ${before} -> ${after} (expected 10)`);

  // ---- 3. same request_id again -> no duplicate ------------------------------------------
  say("\n3. retry with the same request_id — no second spend");
  let retryOk = false;
  if (winner && refusedOne) {
    const again = await send(winner.p, winner.a);
    const againRefused = await send(refusedOne.p, refusedOne.a);
    const first = results[raceArgs.findIndex((x) => x.a === winner!.a)]!;
    const sameCid = again.kind === "success" && first.kind === "success" && again.cid === first.cid;
    retryOk = sameCid && againRefused.kind !== "success" && (await unitsLeft()) === "10";
    say(`  winner's request resent: ${again.kind === "success" ? `same commitment ${again.cid}` : refusal(again)}   refused request resent: ${refusal(againRefused)}`);
  }
  record(3, "retry, no duplicate", retryOk, `same request_id returned the original result; Remaining still ${await unitsLeft()}`);

  // ---- 4. tampered recipient --------------------------------------------------------------
  say("\n4. tampered recipient — the contract builds the payload and checks the allowlist");
  const rogue = await send("scout", args(m.attacker, 5n, "redirect"));
  // An allowlisted recipient on purpose: the refusal must come from the idempotency check, not the allowlist.
  const swapped = winner ? await send(winner.p, { ...winner.a, intent: { ...winner.a.intent, recipient: m.compute } }) : null;
  say(`  non-allowlisted recipient: ${refusal(rogue)}\n        ${ref(hashOf(rogue))}`);
  say(`  settled request_id reused with another recipient: ${swapped ? refusal(swapped) : "skipped"}\n        ${ref(swapped ? hashOf(swapped) : null)}`);
  record(4, "tampered recipient", rogue.kind === "refused" && rogue.code === "recipient_not_allowlisted" && swapped?.kind === "refused" && swapped.code === "request_id_reused", `rejected: ${refusal(rogue)} / ${swapped ? refusal(swapped) : "-"}`);

  // ---- 5. revoke Buyer ----------------------------------------------------------------------
  say("\n5. revoke Buyer — no new authorizations");
  const rev = await owner("revoke_delegate", { task_id: task, account_id: account("buyer") });
  say(`  revoke_delegate ${account("buyer")}\n        ${ref(rev)}`);
  const stillAuthorized = await viewer.view("is_delegate_authorized", { task_id: task, account_id: account("buyer") });
  const blocked = await send("buyer", args(m.procurement, 5n, "font pack"));
  say(`  Buyer proposes after revoke: ${refusal(blocked)}\n        ${ref(hashOf(blocked))}`);
  record(5, "revoked delegate", stillAuthorized === false && blocked.kind === "refused" && blocked.code === "delegate_not_authorized", `Buyer ${refusal(blocked)}; revocation stops new authorizations only, never an issued payment`);

  // ---- 6. final accounting -------------------------------------------------------------------
  say("\n6. final accounting");
  let inv = await viewer.view("invariant", { task_id: task });
  for (let i = 0; i < 15 && inv && BigInt(inv.outstanding) !== 0n; i++) {
    await sleep(2000); // settlement callbacks land a block or two after the propose receipts
    inv = await viewer.view("invariant", { task_id: task });
  }
  if (!inv) throw new Error("invariant view returned nothing");
  const [completed, outstanding, capChain] = [BigInt(inv.completed), BigInt(inv.outstanding), BigInt(inv.cap)];
  const toU = (y: bigint) => ((y * 100n) / capChain).toString();
  say(`  completed ${toU(completed)} + outstanding ${toU(outstanding)} = ${toU(completed + outstanding)} <= cap 100 units   ${inv.holds ? "✓" : "✗ VIOLATED"}`);
  say(`  Remaining ${await unitsLeft()}, frozen=${inv.frozen}`);
  record(6, "invariant", inv.holds === true && completed + outstanding <= capChain && capChain === cap, `completed + outstanding <= cap, from the contract's own verdict`);

  say("\nsummary (live on testnet)");
  for (const o of outcomes) say(`  ${o.pass ? "PASS" : "FAIL"}  ${o.n}. ${o.name}`);
  const failed = outcomes.filter((o) => !o.pass).length;
  say(failed === 0 ? `\n6 of 6 live outcomes verified on chain (task ${task}).` : `\n${failed} live outcome(s) FAILED.`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`demo: ${scrub(err instanceof Error ? err.message : String(err))}\n`);
    process.exit(2);
  },
);
