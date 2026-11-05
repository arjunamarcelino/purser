import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnknownBlockError, type ChainReader } from "@purser/chain-read";
import { openRepo } from "../../src/db/open.ts";
import type { Repo } from "../../src/db/types.ts";
import { ChainShapeError } from "../../src/errors.ts";
import { runPass, runPoller } from "../../src/poller.ts";

const config = { network: "testnet", contractId: "purser.testnet", passBudgetMs: 45_000 };
const ctl = new AbortController();

interface Ledger {
  height: bigint;
  tasks: Map<string, { frozen: boolean; invFrozen: boolean; completed: string; outstanding: string }>;
  delegates: Map<string, Array<{ account_id: string; active: boolean }>>;
  commitments: Array<{ task: string; state: string; actual: string | null }>;
  /** called before each view; may throw to script failures */
  hook?: (method: string, args: Record<string, unknown>, h: bigint) => void;
  minServed: bigint;
  calls: string[];
}

function ledger(): Ledger {
  return {
    height: 1000n,
    minServed: 0n,
    calls: [],
    tasks: new Map([
      ["t1", { frozen: false, invFrozen: false, completed: "0", outstanding: "10", }],
      ["t2", { frozen: false, invFrozen: false, completed: "0", outstanding: "0" }],
    ]),
    delegates: new Map([
      ["t1", [{ account_id: "scout.testnet", active: true }, { account_id: "pay.testnet", active: true }]],
      ["t2", [{ account_id: "scout.testnet", active: true }]],
    ]),
    commitments: [
      { task: "t1", state: "Reserved", actual: null },
      { task: "t1", state: "Confirmed", actual: "5" },
      { task: "t2", state: "Failed", actual: null },
    ],
  };
}

function reader(l: Ledger): ChainReader {
  return {
    chainId: async () => "testnet",
    finalBlock: async () => ({ height: l.height, hash: "h" }),
    view: async (method, args, h) => {
      const a = args as Record<string, unknown>;
      l.calls.push(method);
      if (h < l.minServed) throw new UnknownBlockError("gone");
      l.hook?.(method, a, h);
      switch (method) {
        case "get_config":
          return { max_memo_len: 1, max_request_id_len: 1, max_task_id_len: 1, reconcile_min_age_ns: "1" };
        case "list_task_ids":
          return [...l.tasks.keys()].slice(Number(a.from_index), Number(a.from_index) + Number(a.limit));
        case "get_task": {
          const t = l.tasks.get(String(a.task_id));
          return t ? { active_crew: 1, cap: "100", completed: t.completed, created_at: 1n, crew_cap: 3, frozen: t.frozen, outstanding: t.outstanding, owner: "own.testnet", token: "NearNative" } : null;
        }
        case "invariant": {
          const t = l.tasks.get(String(a.task_id));
          return t ? { cap: "100", completed: t.completed, frozen: t.invFrozen, holds: true, outstanding: t.outstanding, used: "10" } : null;
        }
        case "list_delegates":
          return (l.delegates.get(String(a.task_id)) ?? []).map((d) => ({ ...d, added_at: 1n, derivation_path: "p" }));
        case "get_commitment": {
          const id = Number(a.commitment_id);
          const c = l.commitments[id];
          if (!c) return null;
          return {
            id, task: c.task, delegate: "scout.testnet", request_id: `r${id}`, reserved_amount: "5", state: c.state, actual_spent: c.actual,
            near_tx: null, evm_tx: null, payload_hash: null, payload_version: 1, created_at: 1n, updated_at: 2n,
            intent: { amount: "5", chain: "NearNative", memo: null, recipient: "v.testnet", token: "NearNative" },
          };
        }
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

let repo: Repo;
let l: Ledger;
let t0 = 0;
const now = () => new Date(Date.UTC(2026, 10, 5) + t0++ * 1000);
const pass = (passNo = 1, extra: object = {}) => runPass({ reader: reader(l), repo, signal: ctl.signal, config, passNo, now, ...extra });
const dumpText = async () => (await repo.canonicalDump()).lines.join("\n");

beforeEach(async () => {
  repo = await openRepo("sqlite::memory:");
  await repo.init();
  await repo.ensureScope({ network: "testnet", contractId: "purser.testnet" });
  l = ledger();
  t0 = 0;
});
afterEach(async () => {
  await repo[Symbol.asyncDispose]();
});

describe("runPass", () => {
  it("populates tasks, delegates, commitments and meta", async () => {
    const r = await pass();
    expect(r.complete).toBe(true);
    const c = await repo.counts();
    expect(c.task).toBe(2);
    expect(c.commitment_event).toBe(3);
    expect(c.delegate_snapshot).toBe(3);
    expect(await repo.getMeta("last_pass_at")).not.toBeNull();
    expect(await repo.getMeta("last_complete_height")).toBe("1000");
    expect(await repo.getMeta("schema_version")).not.toBeNull();
  });

  it("is idempotent at the same height", async () => {
    await pass(1);
    const a = (await repo.canonicalDump()).sha256;
    await pass(2);
    expect((await repo.canonicalDump()).sha256).toBe(a);
  });

  it("picks up a new commitment by id probing", async () => {
    await pass(1);
    l.height = 1001n;
    l.commitments.push({ task: "t2", state: "Reserved", actual: null });
    await pass(2);
    expect((await repo.counts()).commitment_event).toBe(4);
  });

  it("reflects Reserved->Confirmed and Failed->Confirmed flips, and frozen from invariant", async () => {
    await pass(1);
    l.height = 1001n;
    l.commitments[0]!.state = "Confirmed";
    l.commitments[0]!.actual = "4";
    l.commitments[2]!.state = "Confirmed";
    l.commitments[2]!.actual = "5";
    l.tasks.get("t1")!.invFrozen = true; // get_task says false; the invariant view wins
    await pass(2, { includeFailed: true });
    const hist1 = await repo.listHistory({ task: "t1", limit: 10 });
    expect(hist1.rows.find((x) => x.commitment_id === 0)?.state).toBe("Confirmed");
    const hist2 = await repo.listHistory({ task: "t2", limit: 10 });
    expect(hist2.rows[0]?.state).toBe("Confirmed");
    expect(await dumpText()).toMatch(/"frozen":(true|1)/);
  });

  it("keeps Unknown as Unknown", async () => {
    l.commitments[0]!.state = "Unknown";
    await pass(1);
    await pass(2);
    const h = await repo.listHistory({ task: "t1", limit: 10 });
    expect(h.rows.find((x) => x.commitment_id === 0)?.state).toBe("Unknown");
  });

  it("sets a revoked delegate inactive", async () => {
    await pass(1);
    l.height = 1001n;
    l.delegates.set("t1", [{ account_id: "scout.testnet", active: false }]);
    await pass(2);
    const d = await dumpText();
    expect(d).not.toMatch(/pay\.testnet[^\n]*"active":(true|1)/);
    expect(d).toMatch(/scout\.testnet[^\n]*"active":(false|0)/);
  });

  it("does not advance last_pass_at on a shape failure and does not write that task", async () => {
    await pass(1);
    const before = await repo.getMeta("last_pass_at");
    l.height = 1001n;
    l.hook = (m, a) => {
      if (m === "get_task" && a.task_id === "t2") throw new ChainShapeError("bad");
    };
    const r = await pass(2);
    expect(r.complete).toBe(false);
    expect(r.failureKinds).toContain("chain_shape");
    expect(await repo.getMeta("last_pass_at")).toBe(before);
    const t2 = (await repo.listTasks()).find((t) => t.task_id === "t2");
    expect(t2?.as_of_height).toBe(1000n);
  });

  it("re-pins on UnknownBlock instead of failing", async () => {
    const rd = reader(l);
    let n = 0;
    const flaky: ChainReader = {
      ...rd,
      finalBlock: async () => ({ height: n++ === 0 ? 900n : 1000n, hash: "h" }),
    };
    l.minServed = 950n;
    const r = await runPass({ reader: flaky, repo, signal: ctl.signal, config, passNo: 1, now });
    expect(r.complete).toBe(true);
    expect(r.height).toBe(1000n);
  });

  it("a lagging height does not overwrite newer data", async () => {
    l.height = 1005n;
    await pass(1);
    l.height = 1002n;
    l.tasks.get("t1")!.completed = "99";
    const r = await pass(2);
    expect(r.tasks.every((t) => t.status === "skipped_stale")).toBe(true);
    expect(await dumpText()).not.toContain("99");
  });

  it("rebuild from empty at the same height reproduces the dump", async () => {
    await pass(1);
    const first = (await repo.canonicalDump()).sha256;
    await repo.wipe();
    await repo.ensureScope({ network: "testnet", contractId: "purser.testnet" });
    await pass(1);
    expect((await repo.canonicalDump()).sha256).toBe(first);
  });

  it("marks a task missing from list_task_ids", async () => {
    await pass(1);
    l.height = 1001n;
    l.tasks.delete("t2");
    await pass(2);
    expect((await repo.listTasks()).find((t) => t.task_id === "t2")?.missing_since_height).toBe(1001n);
  });

  it("ignores a commitment whose task is not listed", async () => {
    l.commitments.push({ task: "ghost", state: "Reserved", actual: null });
    const r = await pass(1);
    expect(r.ignoredCommitments).toBe(1);
    expect((await repo.counts()).commitment_event).toBe(3);
  });

  it("does not skip a lower commitment id when a task failed", async () => {
    l.commitments = [{ task: "t2", state: "Reserved", actual: null }, { task: "t1", state: "Reserved", actual: null }];
    l.hook = (m, a) => {
      if (m === "get_task" && a.task_id === "t2") throw new Error("boom");
    };
    await pass(1);
    expect((await repo.counts()).commitment_event).toBe(1);
    delete l.hook;
    l.height = 1001n;
    await pass(2);
    expect((await repo.counts()).commitment_event).toBe(2);
  });
});

describe("runPoller", () => {
  it("backs off after a 429-style failure then recovers", async () => {
    let fail = 2;
    l.hook = (m) => {
      if (m === "get_config" && fail-- > 0) throw new Error("429 Too Many Requests");
    };
    const sleeps: number[] = [];
    const ac = new AbortController();
    const results: boolean[] = [];
    await runPoller({
      reader: reader(l), repo, signal: ac.signal, config, intervalMs: 15_000, clock: now, random: () => 0,
      sleep: async (ms) => { sleeps.push(ms); },
      onPass: (r) => { results.push(r.complete); if (results.length === 3) ac.abort(); },
    });
    expect(results).toEqual([false, false, true]);
    expect(sleeps[0]).toBe(30_000);
    expect(sleeps[1]).toBe(60_000);
  });

  it("honours abort during sleep", async () => {
    const ac = new AbortController();
    const out = await runPoller({
      reader: reader(l), repo, signal: ac.signal, config, intervalMs: 1000, clock: now,
      sleep: async (_ms, s) => { ac.abort(); s?.throwIfAborted(); },
    });
    expect(out?.complete).toBe(true);
  });
});

describe("no signing surface", () => {
  it("indexer/src and chain-read/src contain no signing or write primitives", () => {
    const banned = /signTransaction|functionCall|FunctionCall|KeyPair|privateKey|Account\(/;
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        if (n === "node_modules" || n === "test") return [];
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
      });
    const roots = [new URL("../../src", import.meta.url).pathname, new URL("../../../packages/chain-read/src", import.meta.url).pathname];
    for (const f of roots.flatMap(walk)) expect(readFileSync(f, "utf8"), f).not.toMatch(banned);
  });
});
