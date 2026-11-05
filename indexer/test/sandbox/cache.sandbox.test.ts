// The cache is a derived mirror with zero authority. These tests run the real contract wasm on a
// local sandbox, a real NearChainReader and a real sqlite file, and prove: it mirrors the chain
// exactly, a SIGKILLed poller leaves a consistent DB and cannot influence the contract, and the
// whole cache rebuilds byte-for-byte from the chain alone.
//
// Not covered here: the Failed -> Confirmed flip (needs the fault-injection wasm, which the
// sandbox suite does not build; the unit flip test in test/unit/poller.test.ts covers it) and the
// vanished-task case (unit level).

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type ChainReader, NearChainReader } from "@purser/chain-read";
import { Account, type KeyPairString } from "near-api-js";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { openRepo } from "../../src/db/open.ts";
import type { Repo } from "../../src/db/types.ts";
import { type PassResult, runPass } from "../../src/poller.ts";
import { NEAR, PERSONAS, type PurserDeployment, type SandboxPersona, deployPurser } from "../../../proposer/src/dev/purser-sandbox.ts";

const dir = mkdtempSync(join(tmpdir(), "purser-indexer-"));
const NO_ABORT = new AbortController().signal;
const INDEXER_ROOT = join(import.meta.dirname, "../..");
const j = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

let seq = 0;
const newDb = () => join(dir, `cache-${seq++}.db`);

async function deploy(): Promise<PurserDeployment> {
  return deployPurser({ rpcUrl: inject("sandboxRpc"), rootId: inject("sandboxRootId"), rootKey: inject("sandboxRootKey") as KeyPairString });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the FINAL head has caught up with the optimistic head, so a pass sees every tx so far. */
async function settle(d: PurserDeployment): Promise<void> {
  const target = (await d.provider.viewBlock({ finality: "optimistic" })).header.height;
  for (let i = 0; i < 100; i++) {
    if ((await d.provider.viewBlock({ finality: "final" })).header.height >= target) return;
    await sleep(200);
  }
  throw new Error("final head never caught up");
}

const reader = (d: PurserDeployment) => new NearChainReader({ rpcUrl: inject("sandboxRpc"), contractId: d.contractId });

/** A reader whose "final block" is fixed, so two passes (even on different DBs) read the same state. */
function pinned(r: NearChainReader, height: bigint, hash: string): ChainReader {
  return { chainId: (s) => r.chainId(s), finalBlock: async () => ({ height, hash }), view: (m, a, h, s) => r.view(m, a, h, s) } as ChainReader;
}

async function openCache(path: string, d: PurserDeployment): Promise<Repo> {
  const repo = await openRepo(`sqlite:${path}`);
  await repo.init();
  await repo.ensureScope({ network: "sandbox", contractId: d.contractId });
  return repo;
}

const passCfg = (d: PurserDeployment) => ({ network: "sandbox", contractId: d.contractId, passBudgetMs: 120_000 });

async function pass(repo: Repo, d: PurserDeployment, r: ChainReader = reader(d), passNo = 1): Promise<PassResult> {
  const res = await runPass({ reader: r, repo, signal: NO_ABORT, passNo, config: passCfg(d), log: (l) => console.log(`[poller] ${l}`) });
  expect(res.complete, j(res)).toBe(true);
  return res;
}

function sql(path: string, q: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(q).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

type Pay = { ok: true } | { ok: false; error: string };
async function propose(d: PurserDeployment, who: SandboxPersona, task: string, recipient: string, near: bigint, requestId: string): Promise<Pay> {
  const acct = new Account(d.delegates[who].accountId, d.provider, d.delegates[who].fcKey);
  try {
    await acct.callFunction({
      contractId: d.contractId,
      methodName: "propose_payment",
      args: { task, intent: { amount: (near * NEAR).toString(), chain: "NearNative", memo: null, recipient, token: "NearNative" }, request_id: requestId },
      gas: 50_000_000_000_000n,
      deposit: 0n,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function view(d: PurserDeployment, method: string, args: Record<string, unknown>, height?: bigint): Promise<unknown> {
  const r = reader(d);
  const h = height ?? (await r.finalBlock(NO_ABORT)).height;
  return r.view(method as never, args as never, h, NO_ABORT);
}

async function commitmentIds(d: PurserDeployment, h: bigint): Promise<number[]> {
  const ids: number[] = [];
  for (;;) {
    if ((await view(d, "get_commitment", { commitment_id: ids.length }, h)) === null) return ids;
    ids.push(ids.length);
  }
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("populate, rebuild and revoke against the real contract", () => {
  let d: PurserDeployment;
  const TASK = "pop";
  const dbA = newDb();
  let repoA: Repo;

  beforeAll(async () => {
    d = await deploy();
    await d.createTask({ taskId: TASK, capNear: 100n });
    const m = d.merchants;
    const results = [
      await propose(d, "scout", TASK, m.data, 5n, "pop-1"),
      await propose(d, "forge", TASK, m.compute, 7n, "pop-2"),
      await propose(d, "buyer", TASK, m.procurement, 3n, "pop-3"),
      await propose(d, "scout", TASK, m.attacker, 1n, "pop-refused"), // not allowlisted: the contract refuses
    ];
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    await settle(d);
    repoA = await openCache(dbA, d);
  });
  afterAll(async () => repoA && (await repoA[Symbol.asyncDispose]()));

  it("a) populate: cache rows equal the contract's views field for field", async () => {
    await pass(repoA, d);
    const c = await repoA.counts();
    console.log(`[counts after populate] ${j(c)}`);
    expect(c.task).toBeGreaterThan(0);
    expect(c.commitment_event).toBeGreaterThan(0);
    expect(c.delegate_snapshot).toBeGreaterThan(0);
    expect(c.attestation).toBe(0);
    expect(c.relayer_job).toBe(0);

    const h = (await reader(d).finalBlock(NO_ABORT)).height;
    const ids = await commitmentIds(d, h);
    expect(ids.length).toBe(c.commitment_event);
    const hist = (await repoA.listHistory({ task: TASK, limit: 100 })).rows;
    expect(hist.length).toBe(ids.length);
    for (const id of ids) {
      const chain = (await view(d, "get_commitment", { commitment_id: id }, h)) as {
        state: string; reserved_amount: string; actual_spent?: string | null; request_id: string; intent: { recipient: string };
      };
      const row = hist.find((r) => r.commitment_id === id)!;
      expect(row, `commitment ${id}`).toBeDefined();
      expect({ state: row.state, reserved: row.reserved_amount, spent: row.actual_spent, recipient: row.recipient, rid: row.request_id }).toEqual({
        state: chain.state, reserved: chain.reserved_amount, spent: chain.actual_spent ?? null, recipient: chain.intent.recipient, rid: chain.request_id,
      });
    }

    const t = (await view(d, "get_task", { task_id: TASK }, h)) as { cap: string; completed: string; outstanding: string; crew_cap: number };
    const inv = (await view(d, "invariant", { task_id: TASK }, h)) as { frozen: boolean };
    const [row] = sql(dbA, `SELECT cap, completed_cached, outstanding_cached, frozen FROM task WHERE task_id = '${TASK}'`);
    expect({ cap: row!.cap, completed: row!.completed_cached, outstanding: row!.outstanding_cached, frozen: Boolean(row!.frozen) }).toEqual({
      cap: t.cap, completed: t.completed, outstanding: t.outstanding, frozen: inv.frozen,
    });
    expect(c.delegate_snapshot).toBe(PERSONAS.length);
  });

  it("c) rebuild: deleting the DB and re-reading the chain at the same height gives an identical canonical dump", async () => {
    await settle(d);
    const fb = await reader(d).finalBlock(NO_ABORT);
    // Both passes are pinned to the same block H. as_of_height and meta.last_complete_height are
    // part of the dump, so pinning (not excluding columns) is what makes the comparison exact.
    const pin = () => pinned(reader(d), fb.height, fb.hash);
    await pass(repoA, d, pin(), 2);
    const before = await repoA.canonicalDump();
    const beforeCounts = await repoA.counts();
    await repoA[Symbol.asyncDispose]();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbA + suffix, { force: true });

    // The incrementally built DB A stamps a terminal (Confirmed) commitment with the height at which
    // it was first read; the poller never re-reads terminal rows, so a rebuild stamps the rebuild
    // height instead. That is the only legitimate difference, so A-vs-rebuild is compared with
    // commitment_event.as_of_height removed, and two from-empty rebuilds at the same H are compared in full.
    const stripCommitmentHeight = (lines: string[]) => lines.map((l) => (l.startsWith('{"t":"commitment_event"') ? l.replace(/,"as_of_height":"\d+"\}$/, "}") : l));
    const rebuild = async () => {
      const repo = await openCache(newDb(), d);
      try {
        await pass(repo, d, pin(), 1);
        return { dump: await repo.canonicalDump(), counts: await repo.counts() };
      } finally {
        await repo[Symbol.asyncDispose]();
      }
    };
    const b1 = await rebuild();
    const b2 = await rebuild();
    console.log(`[rebuild] pinned height ${fb.height}`);
    console.log(`[rebuild] sha256 incremental DB   =${before.sha256}`);
    console.log(`[rebuild] sha256 rebuilt #1       =${b1.dump.sha256}`);
    console.log(`[rebuild] sha256 rebuilt #2       =${b2.dump.sha256}`);
    console.log(`[rebuild] counts incremental=${j(beforeCounts)}`);
    console.log(`[rebuild] counts rebuilt    =${j(b1.counts)}`);
    expect(b2.dump.sha256).toBe(b1.dump.sha256);
    expect(b1.counts).toEqual(beforeCounts);
    expect(stripCommitmentHeight(b1.dump.lines)).toEqual(stripCommitmentHeight(before.lines));
    // reopen A on a fresh file for the revoke test
    repoA = await openCache(newDb(), d);
    await pass(repoA, d);
  });

  it("d) revoking a delegate on-chain flips delegate_snapshot.active after the next pass", async () => {
    const victim = d.delegates.forge.accountId;
    await d.owner.callFunction({ contractId: d.contractId, methodName: "revoke_delegate", args: { task_id: TASK, account_id: victim } });
    await settle(d);
    await pass(repoA, d, reader(d), 3);
    const chain = (await view(d, "list_delegates", { task_id: TASK, from_index: 0, limit: 100 })) as { account_id: string; active: boolean }[];
    expect(chain.find((x) => x.account_id === victim)?.active).toBe(false);
    const hist = await repoA.canonicalDump();
    const lines = hist.lines.map((l) => JSON.parse(l) as { t: string; account_id?: string; active?: boolean });
    const snap = lines.filter((l) => l.t === "delegate_snapshot");
    console.log(`[revoke] delegate_snapshot: ${j(snap.map((s) => [s.account_id, s.active]))}`);
    expect(snap.find((s) => s.account_id === victim)?.active).toBe(false);
    expect(snap.filter((s) => s.active).length).toBe(PERSONAS.length - 1);
  });
});

describe("kill proof: a SIGKILLed poller changes nothing on chain and cannot authorize anything", () => {
  let d: PurserDeployment;
  const TASK = "kill";
  const db = newDb();

  beforeAll(async () => {
    d = await deploy();
    await d.createTask({ taskId: TASK, capNear: 10n });
    expect((await propose(d, "scout", TASK, d.merchants.data, 2n, "kill-1")).ok).toBe(true);
    await settle(d);
  });

  const remaining = async () => BigInt((await view(d, "remaining_budget", { task_id: TASK })) as string);

  it("b) views at block H are byte-identical after SIGKILL; DB is consistent; cache never authorizes", async () => {
    const r = reader(d);
    const H = (await r.finalBlock(NO_ABORT)).height;
    const snapshotAt = async () => {
      const ids = await commitmentIds(d, H);
      return j({
        task: await view(d, "get_task", { task_id: TASK }, H),
        inv: await view(d, "invariant", { task_id: TASK }, H),
        remaining: await view(d, "remaining_budget", { task_id: TASK }, H),
        commitments: await Promise.all(ids.map((id) => view(d, "get_commitment", { commitment_id: id }, H))),
      });
    };
    const before = await snapshotAt();

    // Seed the DB with a first successful pass via the real CLI, then SIGKILL a --loop poller after its first output line.
    const env = { ...process.env, DATABASE_URL: `sqlite:${db}`, NEAR_NETWORK: "sandbox", NEAR_RPC_URL: inject("sandboxRpc"), PURSER_CONTRACT_ID: d.contractId, POLL_INTERVAL_MS: "1000" };
    const child = spawn("node", ["src/cli.ts", "poll", "--loop"], { cwd: INDEXER_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    const lines: string[] = [];
    let buf = "";
    const firstLine = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (b: Buffer) => {
        buf += b.toString();
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          lines.push(buf.slice(0, i));
          buf = buf.slice(i + 1);
          resolve();
        }
      });
      child.stderr.on("data", (b: Buffer) => lines.push(`stderr: ${b.toString().trimEnd()}`));
      child.on("exit", (code) => reject(new Error(`poller exited early (${code}): ${lines.join(" | ")}`)));
    });
    await firstLine;
    child.removeAllListeners("exit");
    const exited = new Promise<string | null>((res) => child.once("exit", (_c, sig) => res(sig)));
    child.kill("SIGKILL");
    const exitSignal = await exited;
    for (const l of lines) console.log(`[poller stdout] ${l}`);
    console.log(`[poller] killed with ${exitSignal}`);
    expect(exitSignal).toBe("SIGKILL");

    // 1. chain history at H is untouched
    expect(await snapshotAt()).toBe(before);

    // 2. DB is consistent after the kill
    expect(sql(db, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(sql(db, "SELECT c.commitment_id FROM commitment_event c LEFT JOIN task t ON t.task_id = c.task_id WHERE t.task_id IS NULL")).toEqual([]);
    expect(sql(db, "SELECT x.task_id FROM delegate_snapshot x LEFT JOIN task t ON t.task_id = x.task_id WHERE t.task_id IS NULL")).toEqual([]);
    const taskRows = sql(db, "SELECT task_id FROM task");
    for (const t of taskRows) {
      // a task row is only ever written together with its delegates (one transaction)
      expect(sql(db, `SELECT 1 FROM delegate_snapshot WHERE task_id = '${t.task_id as string}'`).length).toBeGreaterThan(0);
    }
    console.log(`[after kill] tasks=${taskRows.length} commitments=${sql(db, "SELECT COUNT(*) n FROM commitment_event")[0]!.n} delegates=${sql(db, "SELECT COUNT(*) n FROM delegate_snapshot")[0]!.n}`);

    // 3. while the poller is dead: a legitimate propose moves the budget only through the contract.
    const rem0 = await remaining();
    expect(rem0).toBe(8n * NEAR);
    const cachedRemaining = () => {
      const [row] = sql(db, `SELECT cap, completed_cached, outstanding_cached FROM task WHERE task_id = '${TASK}'`);
      return BigInt(row!.cap as string) - BigInt(row!.completed_cached as string) - BigInt(row!.outstanding_cached as string);
    };
    if (taskRows.length === 0) {
      // the poller was killed before its first write: seed the cache with one pass so a stale value exists
      const repo = await openCache(db, d);
      await pass(repo, d);
      await repo[Symbol.asyncDispose]();
    }
    const staleCache = cachedRemaining();
    expect(staleCache).toBe(8n * NEAR);

    expect((await propose(d, "forge", TASK, d.merchants.compute, 5n, "kill-2")).ok).toBe(true);
    await settle(d);
    expect(await remaining()).toBe(3n * NEAR); // 10 - 2 - 5, by contract arithmetic
    expect(cachedRemaining()).toBe(8n * NEAR); // the dead poller's cache is stale: it still says 8
    console.log(`[stale] chain remaining=3 NEAR, cache remaining=${cachedRemaining() / NEAR} NEAR`);

    // 4. a stale cache cannot authorize: 6 <= stale 8, but > chain 3, so the contract refuses
    const over = await propose(d, "buyer", TASK, d.merchants.procurement, 6n, "kill-over");
    expect(over.ok).toBe(false);
    console.log(`[stale] over-budget propose refused: ${(over as { error: string }).error.slice(0, 160)}`);
    await settle(d);
    expect(await remaining()).toBe(3n * NEAR);

    // 5. restart (real CLI, stale lock left by the killed process): the cache converges.
    const once = spawn("node", ["src/cli.ts", "poll", "--once"], { cwd: INDEXER_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    once.stdout.on("data", (b: Buffer) => (out += b.toString()));
    once.stderr.on("data", (b: Buffer) => (out += `stderr: ${b.toString()}`));
    const code = await new Promise<number | null>((res) => once.on("exit", (c) => res(c)));
    console.log(`[restart poller output]\n${out.trimEnd()}`);
    expect(code, out).toBe(0);
    expect(cachedRemaining()).toBe(3n * NEAR);
    const [row] = sql(db, `SELECT cap, completed_cached, outstanding_cached FROM task WHERE task_id = '${TASK}'`);
    const t = (await view(d, "get_task", { task_id: TASK })) as { completed: string; outstanding: string };
    expect({ c: row!.completed_cached, o: row!.outstanding_cached }).toEqual({ c: t.completed, o: t.outstanding });
    expect(sql(db, "SELECT COUNT(*) n FROM commitment_event")[0]!.n).toBe(2);
  });
});
