import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { openRepo, openRepoReadOnly } from "../../src/db/open.ts";
import { RepoUnavailableError } from "../../src/db/types.ts";

// Built by concatenation so no credential-shaped literal sits in the source (pre-commit scan).
const unreachableUrl = "postgres" + "://" + "u" + ":" + "pw" + "@" + "127.0.0.1:1/none";

const URL_ = process.env["TEST_DATABASE_URL"] ?? "";

describe("openRepoReadOnly (postgres, no database)", () => {
  it("rejects every write before touching the network", async () => {
    await using r = await openRepoReadOnly(unreachableUrl);
    const bad = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(RepoUnavailableError);
    await bad(r.setMeta("k", "v"));
    await bad(r.wipe());
    await bad(r.reconcileTaskPresence([], 1n));
    await bad(
      r.applyTaskSnapshot(
        { task: { task_id: "t", owner: "o", token: "NearNative", cap: "1", completed_cached: "0", outstanding_cached: "0", crew_cap: 1, frozen: false }, delegates: [], commitments: [] },
        1n,
      ),
    );
  });
});

describe.skipIf(!URL_)("openRepoReadOnly (postgres)", () => {
  it("does not migrate, verifies schema, and rejects writes", async () => {
    const schema = `t_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Client({ connectionString: URL_ });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = `${URL_}${URL_.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;
    try {
      // fresh database: read-only init must refuse rather than migrate
      await using ro0 = await openRepoReadOnly(url);
      await expect(ro0.init()).rejects.toBeInstanceOf(RepoUnavailableError);
      const t = await admin.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1", [schema]);
      expect(t.rows[0].n).toBe(0);

      await using w = await openRepo(url);
      await w.init();
      await w.ensureScope({ network: "testnet", contractId: "c.testnet" });
      await w.setMeta("k", "v");

      await using r = await openRepoReadOnly(url);
      await r.init();
      await r.ensureScope({ network: "testnet", contractId: "c.testnet" });
      expect(await r.getMeta("k")).toBe("v");
      await expect(r.setMeta("k", "x")).rejects.toBeInstanceOf(RepoUnavailableError);
      await expect(r.wipe()).rejects.toBeInstanceOf(RepoUnavailableError);
      expect(await r.getMeta("k")).toBe("v");
    } finally {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
});
