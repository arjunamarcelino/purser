import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { SqliteRepo } from "../../src/db/sqlite.ts";
import { PostgresRepo } from "../../src/db/postgres.ts";
import { InvalidCursorError } from "../../src/db/codec.ts";
import { MetaMismatchError, type CommitmentRow, type Repo, type TaskSnapshot } from "../../src/db/types.ts";

const U64_MAX = "340282366920938463463374607431768211455"; // u128 max, 39 digits

function commitment(id: number, over: Partial<CommitmentRow> = {}): CommitmentRow {
  return {
    commitment_id: id,
    delegate: "bot.testnet",
    recipient: "shop.testnet",
    reserved_amount: "1000",
    actual_spent: null,
    state: "Reserved",
    request_id: `req-${id}`,
    payload_hash: null,
    near_tx: null,
    evm_tx: null,
    tx_status: "pending",
    ...over,
  };
}

function snap(over: { task_id?: string; commitments?: CommitmentRow[]; delegates?: TaskSnapshot["delegates"]; cap?: string } = {}): TaskSnapshot {
  return {
    task: {
      task_id: over.task_id ?? "task-1",
      owner: "owner.testnet",
      token: "NearNative",
      cap: over.cap ?? "5000",
      completed_cached: "0",
      outstanding_cached: "1000",
      crew_cap: 3,
      frozen: false,
    },
    delegates: over.delegates ?? [{ account_id: "bot.testnet", active: true }],
    commitments: over.commitments ?? [commitment(0)],
  };
}

interface Handle {
  repo: Repo;
  /** fresh repo on the same database, for ensureScope tests; sqlite :memory: cannot be shared so skipped there */
  cleanup(): Promise<void>;
}

const drivers: Array<[string, () => Promise<Handle>, boolean]> = [
  [
    "sqlite",
    async () => {
      const repo = new SqliteRepo(":memory:");
      await repo.init();
      return { repo, cleanup: () => repo[Symbol.asyncDispose]() };
    },
    true,
  ],
  [
    "postgres",
    async () => {
      const url = process.env["TEST_DATABASE_URL"] ?? "";
      const schema = `t_${randomUUID().replaceAll("-", "")}`;
      const admin = new PostgresRepo(url);
      // isolate each test in its own schema through the search_path option
      const sep = url.includes("?") ? "&" : "?";
      const { default: pg } = await import("pg");
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.end();
      await admin[Symbol.asyncDispose]();
      const repo = new PostgresRepo(`${url}${sep}options=-c%20search_path%3D${schema}`);
      await repo.init();
      return {
        repo,
        cleanup: async () => {
          await repo[Symbol.asyncDispose]();
          const d = new pg.Client({ connectionString: url });
          await d.connect();
          await d.query(`DROP SCHEMA ${schema} CASCADE`);
          await d.end();
        },
      };
    },
    Boolean(process.env["TEST_DATABASE_URL"]),
  ],
];

for (const [name, open, enabled] of drivers) {
  describe.skipIf(!enabled)(`repo contract (${name})`, () => {
    let h: Handle;
    let repo: Repo;
    beforeEach(async () => {
      h = await open();
      repo = h.repo;
    });
    afterEach(async () => {
      await h.cleanup();
    });

    it("applies a snapshot and reads it back", async () => {
      expect(await repo.applyTaskSnapshot(snap(), 10n)).toBe("applied");
      expect(await repo.counts()).toEqual({ task: 1, commitment_event: 1, delegate_snapshot: 1, attestation: 0, relayer_job: 0, meta: 0 });
      const tasks = await repo.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.as_of_height).toBe(10n);
      expect(tasks[0]?.missing_since_height).toBeNull();
      const page = await repo.listHistory({ task: "task-1", limit: 10 });
      expect(page.rows[0]).toMatchObject({ commitment_id: 0, state: "Reserved", as_of_height: 10n, tx_status: "pending" });
    });

    it("skips a stale height and writes nothing for the task", async () => {
      await repo.applyTaskSnapshot(snap(), 20n);
      const before = (await repo.canonicalDump()).sha256;
      const stale = snap({ commitments: [commitment(0, { state: "Failed" }), commitment(1)] });
      expect(await repo.applyTaskSnapshot(stale, 19n)).toBe("skipped_stale");
      expect((await repo.canonicalDump()).sha256).toBe(before);
      expect((await repo.counts()).commitment_event).toBe(1);
    });

    it("is idempotent at an equal height (dump hash unchanged)", async () => {
      await repo.applyTaskSnapshot(snap(), 10n);
      const a = await repo.canonicalDump();
      expect(await repo.applyTaskSnapshot(snap(), 10n)).toBe("applied");
      const b = await repo.canonicalDump();
      expect(b.sha256).toBe(a.sha256);
      expect(b.lines).toEqual(a.lines);
    });

    it("follows Failed -> Confirmed flips at a higher height", async () => {
      await repo.applyTaskSnapshot(snap({ commitments: [commitment(0, { state: "Failed" })] }), 10n);
      await repo.applyTaskSnapshot(
        snap({ commitments: [commitment(0, { state: "Confirmed", actual_spent: "900", payload_hash: "ab".repeat(32) })] }),
        11n,
      );
      const row = (await repo.listHistory({ task: "task-1", limit: 5 })).rows[0];
      expect(row).toMatchObject({ state: "Confirmed", actual_spent: "900", payload_hash: "ab".repeat(32), as_of_height: 11n });
    });

    it("deactivates delegates absent from the snapshot without deleting them", async () => {
      await repo.applyTaskSnapshot(
        snap({ delegates: [{ account_id: "a.testnet", active: true }, { account_id: "b.testnet", active: true }] }),
        10n,
      );
      await repo.applyTaskSnapshot(snap({ delegates: [{ account_id: "a.testnet", active: true }] }), 11n);
      const lines = (await repo.canonicalDump()).lines.filter((l) => l.includes('"t":"delegate_snapshot"')).map((l) => JSON.parse(l));
      expect(lines).toHaveLength(2);
      expect(lines.find((l) => l.account_id === "a.testnet").active).toBe(true);
      expect(lines.find((l) => l.account_id === "b.testnet").active).toBe(false);
    });

    it("lets two delegates reuse the same request_id", async () => {
      const s = snap({
        commitments: [
          commitment(0, { delegate: "a.testnet", request_id: "same" }),
          commitment(1, { delegate: "b.testnet", request_id: "same" }),
        ],
      });
      await repo.applyTaskSnapshot(s, 10n);
      expect((await repo.counts()).commitment_event).toBe(2);
    });

    it("keeps near_tx only while the commitment identity is unchanged, and never downgrades resolved", async () => {
      const tx = "A".repeat(44);
      await repo.applyTaskSnapshot(snap({ commitments: [commitment(0, { near_tx: tx, tx_status: "resolved", state: "Confirmed" })] }), 10n);
      await repo.applyTaskSnapshot(snap({ commitments: [commitment(0, { state: "Confirmed" })] }), 11n);
      expect((await repo.listHistory({ task: "task-1", limit: 1 })).rows[0]).toMatchObject({ near_tx: tx, tx_status: "resolved" });
      await repo.applyTaskSnapshot(snap({ commitments: [commitment(0, { state: "Confirmed", recipient: "other.testnet" })] }), 12n);
      expect((await repo.listHistory({ task: "task-1", limit: 1 })).rows[0]).toMatchObject({ near_tx: null, tx_status: "pending" });
    });

    it("keeps hostile strings inert (task id, cursor)", async () => {
      const evil = "x'; DROP TABLE task;--";
      await repo.applyTaskSnapshot(snap({ task_id: evil }), 10n);
      expect((await repo.listHistory({ task: evil, limit: 5 })).rows).toHaveLength(1);
      for (const cursor of ["'; DROP TABLE task;--", Buffer.from("c1:1; DROP TABLE task").toString("base64url"), "!!"]) {
        await expect(repo.listHistory({ task: evil, limit: 5, cursor })).rejects.toBeInstanceOf(InvalidCursorError);
      }
      expect((await repo.counts()).task).toBe(1);
    });

    it("paginates by keyset cursor and clamps the limit", async () => {
      const cs = Array.from({ length: 7 }, (_, i) => commitment(i));
      await repo.applyTaskSnapshot(snap({ commitments: cs }), 10n);
      const seen: number[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const p = await repo.listHistory({ task: "task-1", limit: 3, ...(cursor ? { cursor } : {}) });
        seen.push(...p.rows.map((r) => r.commitment_id));
        cursor = p.next ?? undefined;
        pages++;
      } while (cursor);
      expect(seen).toEqual([6, 5, 4, 3, 2, 1, 0]);
      expect(pages).toBe(3);
      expect((await repo.listHistory({ task: "task-1", limit: 0 })).rows).toHaveLength(1);
      expect((await repo.listHistory({ task: "task-1", limit: 10_000 })).rows).toHaveLength(7);
    });

    it("round-trips amounts above 2^53 exactly", async () => {
      await repo.applyTaskSnapshot(snap({ cap: U64_MAX, commitments: [commitment(0, { reserved_amount: "9007199254740993", actual_spent: U64_MAX })] }), 9223372036854775807n);
      const row = (await repo.listHistory({ task: "task-1", limit: 1 })).rows[0];
      expect(row).toMatchObject({ reserved_amount: "9007199254740993", actual_spent: U64_MAX, as_of_height: 9223372036854775807n });
    });

    it("rejects non-canonical amounts before they reach the database", async () => {
      for (const bad of ["12abc", "007", "", "-1"]) {
        await expect(repo.applyTaskSnapshot(snap({ cap: bad }), 10n)).rejects.toThrow();
      }
      expect((await repo.counts()).task).toBe(0);
    });

    it("tracks task presence", async () => {
      await repo.applyTaskSnapshot(snap(), 10n);
      await repo.reconcileTaskPresence([], 12n);
      expect((await repo.listTasks())[0]?.missing_since_height).toBe(12n);
      await repo.reconcileTaskPresence([], 13n);
      expect((await repo.listTasks())[0]?.missing_since_height).toBe(12n);
      await repo.reconcileTaskPresence(["task-1"], 14n);
      expect((await repo.listTasks())[0]?.missing_since_height).toBeNull();
      expect((await repo.counts()).task).toBe(1);
    });

    it("lists open commitment ids and the max id", async () => {
      expect(await repo.maxCommitmentId()).toBe(-1);
      const states = ["Reserved", "Signed", "Confirmed", "Unknown", "Failed", "Cancelled"] as const;
      await repo.applyTaskSnapshot(snap({ commitments: states.map((s, i) => commitment(i, { state: s })) }), 10n);
      expect(await repo.openCommitmentIds({ includeFailed: false })).toEqual([0, 1, 3]);
      expect(await repo.openCommitmentIds({ includeFailed: true })).toEqual([0, 1, 3, 4, 5]);
      expect(await repo.maxCommitmentId()).toBe(5);
    });

    it("canonicalDump is stable across applies and excludes volatile columns", async () => {
      await repo.setMeta("last_pass_at", "t1");
      await repo.setMeta("last_seen_id", "0");
      await repo.applyTaskSnapshot(snap(), 10n);
      const a = await repo.canonicalDump();
      await repo.setMeta("last_pass_at", "t2");
      await repo.applyTaskSnapshot(snap(), 10n);
      const b = await repo.canonicalDump();
      expect(b).toEqual(a);
      const text = a.lines.join("\n");
      expect(text).not.toMatch(/synced_at|observed_at|last_pass_at/);
      expect(text).toContain('"as_of_height":"10"');
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("get/setMeta upserts", async () => {
      expect(await repo.getMeta("k")).toBeNull();
      await repo.setMeta("k", "1");
      await repo.setMeta("k", "2");
      expect(await repo.getMeta("k")).toBe("2");
    });

    it("ensureScope records then enforces (network, contract_id)", async () => {
      await repo.ensureScope({ network: "testnet", contractId: "c.testnet" });
      await repo.ensureScope({ network: "testnet", contractId: "c.testnet" });
      await expect(repo.ensureScope({ network: "mainnet", contractId: "c.testnet" })).rejects.toBeInstanceOf(MetaMismatchError);
      await expect(repo.ensureScope({ network: "testnet", contractId: "d.testnet" })).rejects.toBeInstanceOf(MetaMismatchError);
    });

    it("wipe empties every table and clears the scope guard", async () => {
      await repo.ensureScope({ network: "testnet", contractId: "c.testnet" });
      await repo.applyTaskSnapshot(snap(), 10n);
      await repo.wipe();
      expect(await repo.counts()).toEqual({ task: 0, commitment_event: 0, delegate_snapshot: 0, attestation: 0, relayer_job: 0, meta: 0 });
      await repo.ensureScope({ network: "mainnet", contractId: "z.near" });
    });

    it("init is idempotent", async () => {
      await repo.init();
      await repo.init();
      expect((await repo.counts()).task).toBe(0);
    });
  });
}
