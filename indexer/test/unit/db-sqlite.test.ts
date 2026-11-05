import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openRepo, openRepoReadOnly } from "../../src/db/open.ts";
import { SqliteRepo } from "../../src/db/sqlite.ts";
import { RepoUnavailableError } from "../../src/db/types.ts";

// Composed at runtime so no credential-shaped literal sits in the source (pre-commit scan).
const badUrl = "mysql" + "://" + "user" + ":" + "secret" + "@" + "host/db";

describe("sqlite schema CHECKs", () => {
  async function fresh() {
    const repo = new SqliteRepo(":memory:");
    await repo.init();
    return repo;
  }
  const insertTask = (cap: string) => (repo: SqliteRepo) =>
    repo.db
      .prepare("INSERT INTO task (task_id, owner, token, cap, crew_cap, frozen, as_of_height) VALUES ('t','o','NearNative',?,1,0,1)")
      .run(cap);

  it.each(["12abc", "007", "", "-1", "1.5", "1".repeat(40)])("rejects numeric %j", async (bad) => {
    const repo = await fresh();
    expect(() => insertTask(bad)(repo)).toThrow(/CHECK/);
  });

  it.each(["0", "7", "340282366920938463463374607431768211455"])("accepts numeric %j", async (ok) => {
    const repo = await fresh();
    expect(() => insertTask(ok)(repo)).not.toThrow();
  });

  it("rejects bad booleans, tx_status, and resolved without near_tx", async () => {
    const repo = await fresh();
    expect(() => repo.db.exec("INSERT INTO task (task_id, owner, token, cap, crew_cap, frozen, as_of_height) VALUES ('t','o','n','1',1,2,1)")).toThrow(/CHECK/);
    repo.db.exec("INSERT INTO task (task_id, owner, token, cap, crew_cap, frozen, as_of_height) VALUES ('t','o','n','1',1,0,1)");
    const base = (status: string, tx: string) =>
      `INSERT INTO commitment_event (commitment_id, task_id, delegate, recipient, reserved_amount, state, request_id, tx_status, near_tx, as_of_height)
       VALUES (1,'t','d','r','1','Reserved','q','${status}',${tx},1)`;
    expect(() => repo.db.exec(base("bogus", "NULL"))).toThrow(/CHECK/);
    expect(() => repo.db.exec(base("resolved", "NULL"))).toThrow(/CHECK/);
    expect(() => repo.db.exec(base("pending", "'abc'"))).toThrow(/CHECK/);
    expect(() => repo.db.exec(base("resolved", "'abc'"))).not.toThrow();
  });

  it("enforces foreign keys and the token_digest shape", async () => {
    const repo = await fresh();
    expect(() => repo.db.exec("INSERT INTO delegate_snapshot (task_id, account_id, active, as_of_height) VALUES ('nope','a',1,1)")).toThrow(/FOREIGN KEY/);
    expect(() => repo.db.exec("INSERT INTO attestation (provider, token_digest) VALUES ('p','not-a-digest')")).toThrow(/CHECK/);
    expect(() => repo.db.exec(`INSERT INTO attestation (provider, token_digest) VALUES ('p','${"a".repeat(64)}')`)).not.toThrow();
  });

  it("refuses a database whose schema version is newer than the code", async () => {
    const repo = await fresh();
    repo.db.exec("INSERT INTO schema_migrations (version, applied_at) VALUES (999, 'x')");
    await expect(repo.init()).rejects.toBeInstanceOf(RepoUnavailableError);
  });
});

describe("openRepo", () => {
  it("rejects unknown schemes without echoing the input", async () => {
    await expect(openRepo(badUrl)).rejects.toThrow(/unsupported scheme "mysql"/);
    await expect(openRepo(badUrl)).rejects.not.toThrow(/secret/);
    await expect(openRepo("nonsense")).rejects.toThrow();
  });

  it("opens sqlite forms and a read-only second connection sees committed data but cannot write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "purser-db-"));
    try {
      const url = `sqlite://${join(dir, "x.db")}`;
      await using w = await openRepo(url);
      await w.init();
      await w.ensureScope({ network: "testnet", contractId: "c.testnet" });
      await w.setMeta("k", "v");
      await using r = await openRepoReadOnly(url);
      await r.init();
      await r.ensureScope({ network: "testnet", contractId: "c.testnet" });
      expect(await r.getMeta("k")).toBe("v");
      await expect(r.setMeta("k", "x")).rejects.toBeInstanceOf(RepoUnavailableError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports :memory: urls", async () => {
    await using r = await openRepo("sqlite://:memory:");
    await r.init();
    expect((await r.counts()).meta).toBe(0);
  });
});
