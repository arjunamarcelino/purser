#!/usr/bin/env node
// demo-shots — docs/PURSER-DEMO-SCRIPT.md, one shot per command, on NEAR TESTNET with real tx refs.
//
//   ./scripts/demo.sh setup
//   ./scripts/demo.sh shot scout|forge|race|retry|tamper|revoke|buyer|final
//
// A take is cheap: when one goes wrong, run setup again. Spending shots are ordered by what the chain
// says is left, so a repeat fails instead of quietly bending the numbers. Every proposal that should
// show on the board is appended to the proposer's records, its only source for refusals and tx links.

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { JsonRpcProvider } from "near-api-js";
import type { ProposalRecord } from "@purser/types";
import { PERSONA_IDS, type PersonaId, assertAccountId, assertChainId, loadConfig } from "../config.ts";
import { PurserViewer, type SendResult, assertProposeOnlyKey } from "../purser-client.ts";
import { appendRecord } from "../records.ts";
import { type DemoRun, demoChain } from "./demo-chain.ts";
import { type DemoArgs, type DemoSession, assertRunId, capNearToYocto, explorerUrl, judgeInvariant, judgeRace, judgeRetry, makeScrubber, parseSession, scrub, shotRecord, taskIdFor, urlSecrets } from "./demo-lib.ts";

const SHOTS = ["scout", "forge", "race", "retry", "tamper", "revoke", "buyer", "final"] as const;
type Shot = (typeof SHOTS)[number];
const BOARD = "http://127.0.0.1:5173";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let scrubber: (s: string) => string = scrub;
const say = (line = "") => process.stdout.write(`${scrubber(line)}\n`);
const run: DemoRun = { task: "", step: "start", txs: [] };
const newTake = "Run ./scripts/demo.sh setup for a new take.";

function saveSession(path: string, s: DemoSession): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
function loadSession(path: string): DemoSession {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`no demo session yet. ${newTake}`);
  }
  return parseSession(raw);
}

async function main(): Promise<number> {
  const [mode, shotArg] = process.argv.slice(2);
  if (mode !== "setup" && mode !== "shot") throw new Error("usage: demo-shots setup | shot <name>");
  if (mode === "shot" && !SHOTS.includes(shotArg as Shot)) throw new Error(`unknown shot; expected one of: ${SHOTS.join(", ")}`);
  if (process.env.NEAR_NETWORK && process.env.NEAR_NETWORK !== "testnet") throw new Error("the demo runs on testnet only (never mainnet)");

  const cfg = loadConfig({ ...process.env, NEAR_NETWORK: "testnet" });
  scrubber = makeScrubber([...(cfg.rpcUrl ? urlSecrets(cfg.rpcUrl) : []), ...Object.values(cfg.delegates).flatMap((d) => (d ? [d.fcKey.reveal()] : []))]);
  const operator = assertAccountId(process.env.OPERATOR_ACCOUNT_ID ?? "", "testnet", "OPERATOR_ACCOUNT_ID");
  if (!cfg.rpcUrl || !cfg.contractId || !cfg.merchants) throw new Error("run scripts/deploy-testnet.sh first (.env.testnet is incomplete)");
  const contract = cfg.contractId;
  if (contract !== `purser.${operator}`) throw new Error(`PURSER_CONTRACT_ID ${contract} is not purser.${operator}`);
  const m = cfg.merchants;
  const sessionPath = resolve(dirname(cfg.recordsPath), "demo-session.json");

  const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
  const viewer = new PurserViewer(provider, contract);
  assertChainId("testnet", await viewer.chainId());
  for (const p of PERSONA_IDS) {
    const d = cfg.delegates[p];
    if (!d) throw new Error(`.env.testnet has no key for ${p}`);
    await assertProposeOnlyKey(provider, d.accountId, d.fcKey, contract);
  }

  if (mode === "setup") {
    const task = taskIdFor(assertRunId(process.env.RUN_ID ?? ""));
    run.task = task;
    const capNear = process.env.DEMO_CAP_NEAR ?? "0.1";
    const c = demoChain({ cfg, provider, viewer, contract, operator, task, cap: capNearToYocto(capNear), run, scrubber });
    await c.createTask(say, capNear, m);
    saveSession(sessionPath, { contract, task });
    say(`\nSeeded task ${task}: cap ${capNear} NEAR = 100 units, 3 delegates, allowlist set.`);
    say(`Board:    ${BOARD}/?task=${task}&units=1`);
    say(`Baseline: ${BOARD}/?baseline=1`);
    say(`Contract: https://testnet.nearblocks.io/address/${contract}`);
    return 0;
  }

  const shot = shotArg as Shot;
  const session = loadSession(sessionPath);
  if (session.contract !== contract) throw new Error(`the session is for ${session.contract}, not ${contract}. ${newTake}`);
  const task = session.task;
  run.task = task;
  const taskState = await viewer.view("get_task", { task_id: task });
  if (!taskState) throw new Error(`no such task ${task}. ${newTake}`);
  const cap = BigInt(taskState.cap);
  const c = demoChain({ cfg, provider, viewer, contract, operator, task, cap, run, scrubber });
  const { account, ref, u, show, args, send, refusal, hashOf, remainingAt } = c;
  const fail = (detail: string) => {
    say(`  FAIL  ${detail}`);
    return 1;
  };

  /** A spending shot only runs from exactly the budget the script expects. */
  const expectLeft = async (units: bigint) => {
    const left = await remainingAt(0);
    if (left !== u(units)) throw new Error(`this take is spent: shot ${shot} needs ${units} units left, found ${show(left)}. ${newTake}`);
  };
  /** Send and append the record straight away, so a later RPC error cannot lose the row. */
  const fire = async (p: PersonaId, a: DemoArgs): Promise<SendResult> => {
    const t0 = Date.now();
    const result = await send(p, a);
    const record = shotRecord({ decisionId: randomUUID(), persona: p, accountId: account(p), contract, args: a, result, latencyMs: Date.now() - t0, at: new Date().toISOString() });
    appendRecord(cfg.recordsPath, record as ProposalRecord);
    return result;
  };

  const buy = async (p: PersonaId, to: string, memo: string, before: bigint, want: bigint): Promise<number> => {
    await expectLeft(before);
    const r = await fire(p, args(to, 30n, memo));
    if (r.kind !== "success") return fail(`${p}: ${refusal(r)}`);
    const { settled } = await c.bindDetail(r.txHash, account(p), "propose_payment", "success");
    const left = await remainingAt(settled);
    say(`  ${p} pays 30 -> ${to}   Remaining ${before} -> ${show(left)}\n        ${ref(r.txHash)}`);
    return left === u(want) ? 0 : fail(`Remaining ${show(left)}, expected ${want}`);
  };

  switch (shot) {
    case "scout":
      return buy("scout", m.data, "weather dataset", 100n, 70n);
    case "forge":
      return buy("forge", m.compute, "gpu hours", 70n, 40n);

    case "race": {
      await expectLeft(40n);
      say("Three agents fire 30 each against 40 left.");
      const racers = PERSONA_IDS.map((p) => ({ p, a: args(m.data, 30n, `race-${p}`) }));
      const results = await Promise.all(racers.map(({ p, a }) => fire(p, a))); // three keys, started together
      let tip = 0;
      let winner: DemoSession["winner"];
      let refused: DemoSession["refused"];
      const view: Array<{ kind: string; code?: string; txHash: string | null; height: number | null }> = [];
      for (const [i, r] of results.entries()) {
        const { p, a } = racers[i]!;
        const bound = await c.bindResultDetail(p, r);
        if (bound) tip = Math.max(tip, bound.settled);
        view.push({ kind: r.kind, ...(r.kind === "refused" ? { code: r.code } : {}), txHash: hashOf(r), height: bound?.height ?? null });
        if (r.kind === "success") winner = { persona: p, args: a, cid: r.cid };
        else if (r.kind === "refused" && r.code === "exceeds_task_budget" && bound) refused ??= { persona: p, args: a };
        say(`  ${p.padEnd(5)} ${r.kind === "success" ? "ADMITTED" : `REFUSED (${refusal(r)})`}  block ${bound?.height ?? "-"}\n        ${ref(hashOf(r))}`);
      }
      const after = await remainingAt(tip);
      const race = judgeRace(view, u(40n), after, u(1n));
      saveSession(sessionPath, { ...session, ...(winner ? { winner } : {}), ...(refused ? { refused } : {}) });
      say(`  blocks: ${view.map((x) => x.height ?? "-").join(", ")} (${race.sameBlock ? "same block" : "not all in one block"})`);
      if (!race.pass) return fail(race.reasons.join("; "));
      say(`  PASS  ${race.admitted} admitted, ${race.refused} refused (exceeds task budget); Remaining 40 -> ${show(after)}`);
      return 0;
    }

    case "retry": {
      const { winner, refused } = session;
      if (!winner || !refused) throw new Error(`run shot race first. ${newTake}`);
      say("Same request_id -> same result, no new spend.");
      const again = await send(winner.persona, winner.args);
      const againRefused = await send(refused.persona, refused.args);
      let tip = 0;
      for (const [p, r] of [[winner.persona, again], [refused.persona, againRefused]] as const) {
        const bound = await c.bindResultDetail(p, r);
        if (bound) tip = Math.max(tip, bound.settled);
      }
      const side = (r: SendResult) => ({ kind: r.kind, ...(r.kind === "refused" ? { code: r.code } : {}), ...(r.kind === "success" ? { cid: String(r.cid) } : {}) });
      const left = await remainingAt(tip);
      const verdict = judgeRetry({ kind: "success", cid: String(winner.cid) }, side(again), side(againRefused), left, u(10n));
      say(`  winner's request resent: ${again.kind === "success" ? `same commitment ${again.cid}` : refusal(again)}\n        ${ref(hashOf(again))}`);
      say(`  refused request resent: ${refusal(againRefused)}\n        ${ref(hashOf(againRefused))}`);
      if (!verdict.pass) return fail(verdict.reasons.join("; "));
      say(`  PASS  Remaining unchanged at ${show(left)}`);
      return 0;
    }

    case "tamper": {
      const { winner } = session;
      if (!winner) throw new Error(`run shot race first. ${newTake}`);
      const rogue = await fire("scout", args(m.attacker, 5n, "redirect"));
      // An allowlisted recipient on purpose: the refusal must come from the idempotency check, not the allowlist.
      const swapped = await fire(winner.persona, { ...winner.args, intent: { ...winner.args.intent, recipient: m.compute } });
      await c.bindResult("scout", rogue);
      await c.bindResult(winner.persona, swapped);
      say(`  non-allowlisted recipient: ${refusal(rogue)}\n        ${ref(hashOf(rogue))}`);
      say(`  settled request_id reused with another recipient: ${refusal(swapped)}\n        ${ref(hashOf(swapped))}`);
      const ok = rogue.kind === "refused" && rogue.code === "recipient_not_allowlisted" && hashOf(rogue) !== null && swapped.kind === "refused" && swapped.code === "request_id_reused" && hashOf(swapped) !== null;
      if (!ok) return fail(`expected both rejected, got ${refusal(rogue)} / ${refusal(swapped)}`);
      say("  PASS  both rejected");
      return 0;
    }

    case "revoke": {
      if ((await viewer.view("is_delegate_authorized", { task_id: task, account_id: account("buyer") })) === false) {
        say("  Buyer is already revoked (no transaction sent).");
        return 0;
      }
      const hash = await c.owner("revoke_delegate", { task_id: task, account_id: account("buyer") });
      say(`  revoke_delegate ${account("buyer")}\n        ${ref(hash)}`);
      return 0;
    }

    case "buyer": {
      if ((await viewer.view("is_delegate_authorized", { task_id: task, account_id: account("buyer") })) !== false) {
        throw new Error("Buyer is not revoked yet: click Revoke on the board, or run ./scripts/demo.sh shot revoke");
      }
      const blocked = await fire("buyer", args(m.procurement, 5n, "font pack"));
      await c.bindResult("buyer", blocked);
      say(`  Buyer proposes after revoke: ${refusal(blocked)}\n        ${ref(hashOf(blocked))}`);
      if (blocked.kind !== "refused" || blocked.code !== "delegate_not_authorized" || hashOf(blocked) === null) return fail(`expected delegate_not_authorized, got ${refusal(blocked)}`);
      say("  PASS  blocked; revocation stops new authorizations only, never an issued payment");
      return 0;
    }

    case "final": {
      const polls = Number(process.env.DEMO_SETTLE_POLLS ?? "30");
      let inv = await c.readInvariant(0);
      for (let i = 0; i < polls && inv && inv.outstanding !== 0n; i++) {
        await sleep(2000); // settlement callbacks land a block or two after the propose receipts
        inv = await c.readInvariant(0);
      }
      const left = await remainingAt(0);
      if (inv) say(`  completed ${show(inv.completed)} + outstanding ${show(inv.outstanding)} = ${show(inv.completed + inv.outstanding)} <= cap 100 units   ${inv.holds ? "✓" : "✗ VIOLATED"}`);
      say(`  Remaining ${show(left)}`);
      const settled = judgeInvariant(inv, cap, left);
      if (!settled.pass) return fail(settled.reasons.join("; "));
      say("  PASS  completed + outstanding <= cap");
      say(`  Contract: https://testnet.nearblocks.io/address/${contract}`);
      return 0;
    }
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const w = (line: string) => process.stderr.write(`${scrubber(line)}\n`);
    w(`demo-shots: ${err instanceof Error ? err.message : String(err)}`);
    if (run.task) w(`demo-shots: task ${run.task}; last step: ${run.step}`);
    if (run.txs.length) w(`demo-shots: txs verified on chain: ${run.txs.map(explorerUrl).join(" ")}`);
    process.exit(2);
  },
);
