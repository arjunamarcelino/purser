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
import { DelegateSender, PurserViewer, type SendResult, assertProposeOnlyKey, parseU64Safe, retryRateLimited } from "../purser-client.ts";
import {
  assertRunId,
  capNearToYocto,
  describeSpawn,
  explorerUrl,
  formatUnits,
  judgeInvariant,
  judgeRace,
  judgeRetry,
  makeScrubber,
  parseTxId,
  scrub,
  taskIdFor,
  unitsToYocto,
  urlSecrets,
} from "./demo-lib.ts";

// Rebuilt in main() once the RPC URL and delegate keys are known; until then only key-shaped strings are redacted.
let scrubber: (s: string) => string = scrub;
const say = (line = "") => process.stdout.write(`${scrubber(line)}\n`);
/** Where the run stands, for the failure report: the task, the last finished step and every landed tx. */
const run = { task: "", step: "start", txs: [] as string[] };
const step = (name: string) => {
  run.step = name;
};
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
  scrubber = makeScrubber([...(cfg.rpcUrl ? urlSecrets(cfg.rpcUrl) : []), ...Object.values(cfg.delegates).flatMap((d) => (d ? [d.fcKey.reveal()] : []))]);
  const runId = assertRunId(process.env.RUN_ID ?? "");
  const operator = assertAccountId(process.env.OPERATOR_ACCOUNT_ID ?? "", "testnet", "OPERATOR_ACCOUNT_ID");
  const capNear = process.env.DEMO_CAP_NEAR ?? "1";
  const cap = capNearToYocto(capNear);
  if (!cfg.rpcUrl || !cfg.contractId || !cfg.merchants) throw new Error("run scripts/deploy-testnet.sh first (.env.testnet is incomplete)");
  const contract = cfg.contractId;
  if (contract !== `purser.${operator}`) throw new Error(`PURSER_CONTRACT_ID ${contract} is not purser.${operator}`);
  const task = taskIdFor(runId);
  run.task = task;
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
    return Number(block.header.height);
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
  const show = (y: bigint) => formatUnits(y, cap);

  const args = (to: string, units: bigint, memo: string, requestId = toRequestId(randomUUID())) => ({
    task,
    intent: { chain: "NearNative", recipient: to, amount: u(units).toString(), token: "NearNative", memo },
    request_id: requestId,
  });
  const send = (p: PersonaId, a: ReturnType<typeof args>) => sender(p).proposeRaw(JSON.stringify(a));
  // Only the kind (and code) is printed, never raw error text: it can carry the RPC URL.
  const refusal = (r: SendResult) =>
    r.kind === "refused" ? r.code : r.kind === "success" ? "success" : r.kind === "unknown" ? "unknown (send state unknown; resending the same request_id is idempotent)" : r.kind;
  const hashOf = (r: SendResult) => ("txHash" in r ? r.txHash : null);
  /** Bind a send's tx to the chain (success or failure as the result says); returns its block height, null without a hash. */
  const bindResult = async (p: PersonaId, r: SendResult): Promise<number | null> => {
    const hash = hashOf(r);
    return hash ? bind(hash, account(p), "propose_payment", r.kind === "success" ? "success" : "failure") : null;
  };
  let tip = 0; // highest block height bound so far; views wait for the final head to reach it

  // ---- setup (owner) --------------------------------------------------------------------
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

  // ---- 1. two legitimate purchases of 30 ----------------------------------------------
  say("\n1. legitimate spend — Remaining 100 -> 70 -> 40");
  step("outcome 1");
  const legit: Array<[PersonaId, string, string, bigint]> = [["scout", m.data, "weather dataset", 70n], ["forge", m.compute, "gpu hours", 40n]];
  let legitOk = true;
  for (const [p, to, memo, want] of legit) {
    const r = await send(p, args(to, 30n, memo));
    if (r.kind !== "success") {
      legitOk = false;
      say(`  ${p}: ${refusal(r)}`);
      continue;
    }
    const h = await bind(r.txHash, account(p), "propose_payment", "success");
    tip = Math.max(tip, h);
    const left = await remainingAt(tip);
    legitOk &&= left === u(want);
    say(`  ${p} pays 30 -> ${to}   Remaining ${show(left)}${left === u(want) ? "" : ` (expected ${want})`}\n        ${ref(r.txHash)}`);
  }
  const left1 = await remainingAt(tip);
  record(1, "legit spend", legitOk && left1 === u(40n), `two purchases of 30; Remaining ${show(left1)} (expected 40)`);

  // ---- 2. concurrent over-budget: 3 x 30 against 40 ------------------------------------
  say("\n2. concurrent over-budget — three agents fire 30 each against 40 left");
  step("outcome 2");
  const before = await remainingAt(tip);
  if (before !== u(40n)) throw new Error(`race needs exactly 40 units left, found ${show(before)}`);
  const raceArgs = PERSONA_IDS.map((p) => ({ p, a: args(m.data, 30n, `race-${p}`) }));
  const results = await Promise.all(raceArgs.map(({ p, a }) => send(p, a))); // three keys, started together
  let winner: { p: PersonaId; a: ReturnType<typeof args> } | null = null;
  let refusedOne: { p: PersonaId; a: ReturnType<typeof args> } | null = null;
  const raceView: Array<{ kind: string; code?: string; txHash: string | null; height: number | null }> = [];
  for (const [i, r] of results.entries()) {
    const { p, a } = raceArgs[i]!;
    const hash = hashOf(r);
    const h = await bindResult(p, r);
    if (h !== null) tip = Math.max(tip, h);
    raceView.push({ kind: r.kind, ...(r.kind === "refused" ? { code: r.code } : {}), txHash: hash, height: h });
    if (r.kind === "success") winner = { p, a };
    else if (r.kind === "refused" && r.code === "exceeds_task_budget" && h !== null) refusedOne ??= { p, a };
    say(`  ${p.padEnd(5)} ${r.kind === "success" ? "ADMITTED" : `REFUSED (${refusal(r)})`}  block ${h ?? "-"}\n        ${ref(hash)}`);
  }
  const after = await remainingAt(tip);
  const race = judgeRace(raceView, before, after, u(1n));
  say(`  blocks: ${raceView.map((x) => x.height ?? "-").join(", ")} (${race.sameBlock ? "same block" : "not all in one block: concurrency not proven by height"})`);
  record(2, "concurrent over-budget", race.pass, race.pass ? `${race.admitted} admitted, ${race.refused} refused (exceeds task budget); Remaining ${show(before)} -> ${show(after)} (expected 10)` : race.reasons.join("; "));

  // ---- 3. same request_id again -> no duplicate ------------------------------------------
  say("\n3. retry with the same request_id — no second spend");
  step("outcome 3");
  let retry = judgeRetry(undefined, undefined, undefined, 0n, 0n);
  if (winner && refusedOne) {
    const again = await send(winner.p, winner.a);
    const againRefused = await send(refusedOne.p, refusedOne.a);
    for (const [p, r] of [[winner.p, again], [refusedOne.p, againRefused]] as const) {
      const h = await bindResult(p, r);
      if (h !== null) tip = Math.max(tip, h);
    }
    const first = results[raceArgs.findIndex((x) => x.a === winner!.a)]!;
    const side = (r: SendResult) => ({ kind: r.kind, ...(r.kind === "refused" ? { code: r.code } : {}), ...(r.kind === "success" ? { cid: String(r.cid) } : {}) });
    retry = judgeRetry(side(first), side(again), side(againRefused), await remainingAt(tip), u(10n));
    say(`  winner's request resent: ${again.kind === "success" ? `same commitment ${again.cid}` : refusal(again)}\n        ${ref(hashOf(again))}`);
    say(`  refused request resent: ${refusal(againRefused)}\n        ${ref(hashOf(againRefused))}`);
  }
  record(3, "retry, no duplicate", retry.pass, retry.pass ? `same request_id returned the original result; Remaining still ${show(u(10n))}` : retry.reasons.join("; "));

  // ---- 4. tampered recipient --------------------------------------------------------------
  say("\n4. tampered recipient — the contract builds the payload and checks the allowlist");
  step("outcome 4");
  const rogue = await send("scout", args(m.attacker, 5n, "redirect"));
  // An allowlisted recipient on purpose: the refusal must come from the idempotency check, not the allowlist.
  const swapped = winner ? await send(winner.p, { ...winner.a, intent: { ...winner.a.intent, recipient: m.compute } }) : null;
  await bindResult("scout", rogue);
  if (swapped && winner) await bindResult(winner.p, swapped);
  say(`  non-allowlisted recipient: ${refusal(rogue)}\n        ${ref(hashOf(rogue))}`);
  say(`  settled request_id reused with another recipient: ${swapped ? refusal(swapped) : "skipped"}\n        ${ref(swapped ? hashOf(swapped) : null)}`);
  const tamperOk =
    rogue.kind === "refused" && rogue.code === "recipient_not_allowlisted" && hashOf(rogue) !== null &&
    swapped?.kind === "refused" && swapped.code === "request_id_reused" && hashOf(swapped) !== null;
  record(4, "tampered recipient", tamperOk, `rejected: ${refusal(rogue)} / ${swapped ? refusal(swapped) : "-"}`);

  // ---- 5. revoke Buyer ----------------------------------------------------------------------
  say("\n5. revoke Buyer — no new authorizations");
  step("outcome 5");
  const rev = await owner("revoke_delegate", { task_id: task, account_id: account("buyer") });
  say(`  revoke_delegate ${account("buyer")}\n        ${ref(rev)}`);
  const stillAuthorized = await viewer.view("is_delegate_authorized", { task_id: task, account_id: account("buyer") });
  const blocked = await send("buyer", args(m.procurement, 5n, "font pack"));
  await bindResult("buyer", blocked);
  say(`  Buyer proposes after revoke: ${refusal(blocked)}\n        ${ref(hashOf(blocked))}`);
  record(5, "revoked delegate", stillAuthorized === false && blocked.kind === "refused" && blocked.code === "delegate_not_authorized" && hashOf(blocked) !== null, `Buyer ${refusal(blocked)}; revocation stops new authorizations only, never an issued payment`);

  // ---- 6. final accounting -------------------------------------------------------------------
  say("\n6. final accounting");
  step("outcome 6");
  const polls = Number(process.env.DEMO_SETTLE_POLLS ?? "30");
  const readInv = async () => {
    const v = (await finalView("invariant", tip)) as { completed: string; outstanding: string; cap: string; holds: boolean; frozen?: boolean } | null;
    return v && { holds: v.holds, completed: BigInt(v.completed), outstanding: BigInt(v.outstanding), cap: BigInt(v.cap), frozen: v.frozen };
  };
  let inv = await readInv();
  for (let i = 0; i < polls && inv && inv.outstanding !== 0n; i++) {
    await sleep(2000); // settlement callbacks land a block or two after the propose receipts
    inv = await readInv();
  }
  const finalLeft = await remainingAt(tip);
  if (inv) say(`  completed ${show(inv.completed)} + outstanding ${show(inv.outstanding)} = ${show(inv.completed + inv.outstanding)} <= cap 100 units   ${inv.holds ? "✓" : "✗ VIOLATED"}`);
  say(`  Remaining ${show(finalLeft)}, frozen=${inv?.frozen}`);
  const settled = judgeInvariant(inv, cap, finalLeft);
  record(6, "invariant", settled.pass, settled.pass ? "settled: outstanding 0, completed 90, Remaining 10; completed + outstanding <= cap" : settled.reasons.join("; "));

  step("summary");
  say("\nsummary (live on testnet)");
  for (const o of outcomes) say(`  ${o.pass ? "PASS" : "FAIL"}  ${o.n}. ${o.name}`);
  const failed = outcomes.filter((o) => !o.pass).length;
  say(failed === 0 ? `\n6 of 6 live outcomes verified on chain (task ${task}).` : `\n${failed} live outcome(s) FAILED.`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const w = (line: string) => process.stderr.write(`${scrubber(line)}\n`);
    w(`demo: ${err instanceof Error ? err.message : String(err)}`);
    w(`demo: task ${run.task || "(not created)"}; last step: ${run.step}`);
    if (outcomes.length) w(`demo: outcomes so far: ${outcomes.map((o) => `${o.n}=${o.pass ? "PASS" : "FAIL"}`).join(" ")}`);
    if (run.txs.length) w(`demo: txs verified on chain: ${run.txs.join(" ")}`);
    w("demo: the task is half-built and cannot be resumed; the run can be repeated with a new RUN_ID. A send that ended 'unknown' may have landed.");
    process.exit(2);
  },
);
