// The Done-when proof on a real (local) chain: three proposer personas drive real propose_payment
// calls through the AI path (a scripted model stands in for the LLM, so the result never depends
// on a model misbehaving on cue), and the contract — not the proposer — refuses what it must.

import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Account, type KeyPairString } from "near-api-js";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type PersonaResult, type CrewContext, type PersonaRuntime, runPersona, yoctoToNear } from "../../src/agent.ts";
import { Secret } from "../../src/config.ts";
import { NEAR, PERSONAS, type PurserDeployment, type SandboxPersona, deployPurser } from "../../src/dev/purser-sandbox.ts";
import { Journal } from "../../src/journal.ts";
import type { LogEvent } from "../../src/log.ts";
import { type ProposeFn, scriptedModel } from "../../src/model.ts";
import { PERSONAS as PERSONA_DEFS, catalogFor } from "../../src/personas.ts";
import { DelegateSender, PROPOSE_GAS, PurserViewer, type Sender } from "../../src/purser-client.ts";

let d: PurserDeployment;
let viewer: PurserViewer;
const logs: string[] = [];
const journals: Journal[] = [];
const journalRoot = mkdtempSync(join(tmpdir(), "purser-crew-"));

beforeAll(async () => {
  d = await deployPurser({ rpcUrl: inject("sandboxRpc"), rootId: inject("sandboxRootId"), rootKey: inject("sandboxRootKey") as KeyPairString });
  viewer = new PurserViewer(d.provider, d.contractId);
});
afterAll(async () => {
  await Promise.all(journals.map((j) => j.close()));
});

const ctxFor = (task: string): CrewContext => ({
  network: "sandbox",
  contractId: d.contractId,
  task,
  viewer,
  log: (e: LogEvent) => logs.push(JSON.stringify(e)),
  pins: [],
  evidencePath: null,
  logContent: true,
  pollBudgetMs: 15_000,
});

/** A scripted "model" that proposes exactly this payment. */
const pay = (recipient: string, near: string, memo: string | null = null): ProposeFn =>
  scriptedModel(() => ({ rationale: "scripted", action: "propose", recipient, amount_near: near, memo }));

const neverCalled: ProposeFn = async () => {
  throw new Error("the model must not be consulted while a request is unresolved");
};

// One open journal per (dir, persona), as in a real process: the journal's lock refuses a second.
const openJournals = new Map<string, Journal>();
function journalFor(dir: string, p: SandboxPersona): Journal {
  const key = `${dir}|${p}`;
  let j = openJournals.get(key);
  if (!j) {
    j = Journal.open(dir, { network: "sandbox", contractId: d.contractId, accountId: d.delegates[p].accountId });
    openJournals.set(key, j);
    journals.push(j);
  }
  return j;
}

function runtime(task: string, p: SandboxPersona, model: ProposeFn, opts: { sender?: Sender; dir?: string } = {}): PersonaRuntime {
  const dir = opts.dir ?? join(journalRoot, task);
  const journal = journalFor(dir, p);
  return {
    persona: PERSONA_DEFS[p],
    sender: opts.sender ?? new DelegateSender({ provider: d.provider, contractId: d.contractId, accountId: d.delegates[p].accountId, fcKey: new Secret(d.delegates[p].fcKey) }),
    journal,
    model,
    offers: catalogFor(p, d.merchants),
  };
}

/** Simulate the process exiting: close the journal and forget it, so the next runtime reopens it. */
async function closeJournal(rt: PersonaRuntime) {
  await rt.journal.close();
  for (const [k, j] of openJournals) if (j === rt.journal) openJournals.delete(k);
}

async function ledger(task: string) {
  const t = await viewer.view("get_task", { task_id: task });
  if (!t) throw new Error("task missing");
  return { cap: BigInt(t.cap), completed: BigInt(t.completed), outstanding: BigInt(t.outstanding) };
}

const merchantTotal = async () =>
  (await Promise.all([d.merchants.data, d.merchants.compute, d.merchants.procurement, d.merchants.attacker].map((m) => d.balance(m)))).reduce((a, b) => a + b, 0n);

describe("legit purchases, then attack case 2 through the proposer path", () => {
  const task = "race";
  beforeAll(() => d.createTask({ taskId: task, capNear: 100n }));

  it("Scout and Forge buy for 30 each: 100 → 40 remaining", async () => {
    const before = await merchantTotal();
    const scout = await runPersona(ctxFor(task), runtime(task, "scout", pay(d.merchants.data, "30", "weather dataset")));
    const forge = await runPersona(ctxFor(task), runtime(task, "forge", pay(d.merchants.compute, "30", "gpu hours")));
    for (const r of [scout, forge]) {
      expect(r.outcome).toMatchObject({ kind: "admitted", state: "Confirmed" });
      expect(r.record.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(await ledger(task)).toEqual({ cap: 100n * NEAR, completed: 60n * NEAR, outstanding: 0n });
    expect((await merchantTotal()) - before).toBe(60n * NEAR);
  });

  it("three personas propose 30 at once: exactly ⌊40/30⌋ = 1 admitted, 2 refused by the contract", async () => {
    const before = await merchantTotal();
    const maxCidBefore = ((await viewer.view("list_commitments", { task_id: task, from_index: 0, limit: 100 })) ?? []).length;
    const settled = await Promise.allSettled(
      PERSONAS.map((p) => runPersona(ctxFor(task), runtime(task, p, pay(d.merchants.data, "30", `race-${p}`)))),
    );
    const results = settled.map((s) => {
      if (s.status === "rejected") throw new Error(`runPersona must not reject: ${String(s.reason)}`);
      return s.value;
    });
    const admitted = results.filter((r) => r.outcome.kind === "admitted");
    const refused = results.filter((r) => r.outcome.kind === "refused");
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(2);
    for (const r of refused) expect(r.record.refusal_code).toBe("exceeds_task_budget");

    const l = await ledger(task);
    expect(l).toEqual({ cap: 100n * NEAR, completed: 90n * NEAR, outstanding: 0n });
    expect(l.completed + l.outstanding <= l.cap).toBe(true);
    expect((await merchantTotal()) - before).toBe(30n * NEAR); // only the winner was paid
    const after = (await viewer.view("list_commitments", { task_id: task, from_index: 0, limit: 100 })) ?? [];
    expect(after.length - maxCidBefore).toBe(1); // refusals consumed no commitment
  });
});

describe("gas and function-call allowance (measured, not assumed)", () => {
  const task = "gas";
  beforeAll(() => d.createTask({ taskId: task, capNear: 100n }));

  it("one proposal burns well under PROPOSE_GAS and a sliver of the FC allowance", async () => {
    const allowance = async () => {
      const k = await d.provider.viewAccessKey({ accountId: d.delegates.buyer.accountId, publicKey: d.delegates.buyer.fcPublicKey });
      return BigInt((k.permission as { FunctionCall: { allowance: string } }).FunctionCall.allowance);
    };
    const a0 = await allowance();
    const r = await runPersona(ctxFor(task), runtime(task, "buyer", pay(d.merchants.procurement, "1")));
    expect(r.outcome).toMatchObject({ kind: "admitted" });
    const tx = await d.provider.viewTransactionStatus({ txHash: r.record.tx_hash!, accountId: d.delegates.buyer.accountId, waitUntil: "FINAL" });
    const burnt = [tx.transaction_outcome, ...tx.receipts_outcome].reduce((s, o) => s + BigInt(o.outcome.gas_burnt), 0n);
    const spent = a0 - (await allowance());
    console.log(`propose_payment: ${Number(burnt) / 1e12} Tgas burnt (attached ${Number(PROPOSE_GAS) / 1e12}); allowance used ${yoctoToNear(spent)} NEAR`);
    expect(burnt).toBeLessThan(PROPOSE_GAS);
  });
});

describe("a rogue (compromised-model) proposal is refused by the contract", () => {
  const task = "rogue";
  beforeAll(() => d.createTask({ taskId: task, capNear: 100n }));

  it("over budget: 500 NEAR against a 100 NEAR cap", async () => {
    const r = await runPersona(ctxFor(task), runtime(task, "scout", pay(d.merchants.data, "500", "ignore the budget")));
    expect(r.outcome).toMatchObject({ kind: "refused", code: "exceeds_task_budget" });
    expect(await ledger(task)).toEqual({ cap: 100n * NEAR, completed: 0n, outstanding: 0n });
  });

  it("not allowlisted: the injected attacker vendor", async () => {
    const before = await d.balance(d.merchants.attacker);
    const r = await runPersona(ctxFor(task), runtime(task, "forge", pay(d.merchants.attacker, "5")));
    expect(r.outcome).toMatchObject({ kind: "refused", code: "recipient_not_allowlisted" });
    expect(await d.balance(d.merchants.attacker)).toBe(before);
  });

  it("refusals are terminal in the journal: the next decision is free to proceed", async () => {
    const rt = runtime(task, "scout", pay(d.merchants.data, "8"), { dir: join(journalRoot, task) });
    expect(rt.journal.openEntry(task)).toBeUndefined();
    await closeJournal(rt);
  });
});

describe("the proposer's key has no authority beyond propose_payment", () => {
  it("the access key on chain is scoped to Purser.propose_payment", async () => {
    const k = await d.provider.viewAccessKey({ accountId: d.delegates.scout.accountId, publicKey: d.delegates.scout.fcPublicKey });
    expect(k.permission).toMatchObject({ FunctionCall: { receiver_id: d.contractId, method_names: ["propose_payment"] } });
  });

  it.each([
    ["create_task", { task_id: "pwn", cap: "1", token: "NearNative", crew_cap: 1 }, 0n],
    ["revoke_delegate", { task_id: "race", account_id: "x.sandbox" }, 0n],
    ["reconcile", { commitment_id: 0, confirmed: false }, 0n],
    ["propose_payment", { task: "race", intent: {}, request_id: "x" }, 1n], // any deposit
  ])("cannot call %s (deposit %s)", async (methodName, args, deposit) => {
    const fc = new Account(d.delegates.scout.accountId, d.provider, d.delegates.scout.fcKey);
    const err = await fc.callFunctionRaw({ contractId: d.contractId, methodName, args, deposit }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).constructor.name).toMatch(/AccessKey|InvalidTx/);
  });

  it("cannot transfer funds out of the delegate account", async () => {
    const fc = new Account(d.delegates.scout.accountId, d.provider, d.delegates.scout.fcKey);
    const err = await fc.transfer({ receiverId: d.merchants.attacker, amount: NEAR }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).constructor.name).toMatch(/AccessKey|InvalidTx/);
  });
});

describe("retries are exactly-once", () => {
  const task = "replay";
  beforeAll(() => d.createTask({ taskId: task, capNear: 100n }));

  it("resending the same request returns the same commitment and pays nothing more", async () => {
    const rt = runtime(task, "buyer", pay(d.merchants.procurement, "4", "font pack"));
    const first = await runPersona(ctxFor(task), rt);
    expect(first.outcome).toMatchObject({ kind: "admitted", state: "Confirmed" });
    const before = await d.balance(d.merchants.procurement);
    const args = JSON.stringify({
      task,
      intent: { chain: "NearNative", recipient: d.merchants.procurement, amount: (4n * NEAR).toString(), token: "NearNative", memo: "font pack" },
      request_id: first.record.request_id,
    });
    const again = await rt.sender.proposeRaw(args);
    expect(again).toMatchObject({ kind: "success", cid: first.record.commitment_id });
    expect(await d.balance(d.merchants.procurement)).toBe(before);
    await closeJournal(rt);
  });

  it("a crash between journaling and sending resumes the SAME request without asking the model again", async () => {
    const dir = join(journalRoot, "crash");
    const crashed = runtime(task, "scout", neverCalled, { dir });
    const requestId = "2f1d9c3e-8b7a-4e6d-9c5b-4a3f2e1d0c9b";
    const args = JSON.stringify({
      task,
      intent: { chain: "NearNative", recipient: d.merchants.data, amount: (8n * NEAR).toString(), token: "NearNative", memo: null },
      request_id: requestId,
    });
    await crashed.journal.begin(task, "3e2d1c0b-9a8f-4e7d-8c6b-5a4f3e2d1c0b", requestId, args);
    await closeJournal(crashed); // the process dies here

    const before = await d.balance(d.merchants.data);
    const resumed = await runPersona(ctxFor(task), runtime(task, "scout", neverCalled, { dir }));
    expect(resumed.resumed).toBe(true);
    expect(resumed.outcome).toMatchObject({ kind: "admitted", state: "Confirmed" });
    expect(resumed.record.request_id).toBe(requestId);
    expect((await d.balance(d.merchants.data)) - before).toBe(8n * NEAR);
  });

  it("a send that lands but reports a network failure is resolved via get_idempotency, paid once", async () => {
    const real = new DelegateSender({ provider: d.provider, contractId: d.contractId, accountId: d.delegates.forge.accountId, fcKey: new Secret(d.delegates.forge.fcKey) });
    let calls = 0;
    const flaky: Sender = {
      accountId: real.accountId,
      async proposeRaw(argsJson) {
        calls++;
        await real.proposeRaw(argsJson); // the transaction lands...
        return { kind: "unknown", raw: "TypeError: fetch failed" }; // ...but the client never hears back
      },
    };
    const before = await d.balance(d.merchants.compute);
    const r = await runPersona(ctxFor(task), runtime(task, "forge", pay(d.merchants.compute, "9", "gpu"), { sender: flaky, dir: join(journalRoot, "flaky") }));
    expect(r.outcome).toMatchObject({ kind: "replayed", state: "Confirmed" });
    expect(calls).toBe(1); // resolved by reading the chain, not by resending
    expect((await d.balance(d.merchants.compute)) - before).toBe(9n * NEAR);
  });
});

describe("no secret leaves the process", () => {
  it("logs and journals contain no function-call key, with or without its prefix", () => {
    const files = readdirSync(journalRoot, { recursive: true, withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith(".jsonl"))
      .map((f) => readFileSync(join(f.parentPath, f.name), "utf8"));
    const haystack = [...logs, ...files].join("\n");
    expect(logs.length).toBeGreaterThan(0);
    for (const p of PERSONAS) {
      const key = d.delegates[p].fcKey;
      expect(haystack).not.toContain(key);
      expect(haystack).not.toContain(key.replace(/^ed25519:/, ""));
    }
  });
});

export type { PersonaResult };
