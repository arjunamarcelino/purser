import { mkdtempSync, readFileSync, appendFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Journal, JournalLockedError, type JournalScope } from "../../src/journal.ts";

const scope: JournalScope = { network: "sandbox", contractId: "purser.sandbox", accountId: "scout.sandbox" };
const open: Journal[] = [];
const fresh = () => mkdtempSync(join(tmpdir(), "purser-journal-"));
const make = (dir: string, s = scope, warn?: (m: string) => void) => {
  const j = Journal.open(dir, s, warn);
  open.push(j);
  return j;
};
afterEach(async () => {
  await Promise.all(open.splice(0).map((j) => j.close()));
});

describe("Journal", () => {
  it("persists a pending request and resumes it with the SAME id and bytes after a crash", async () => {
    const dir = fresh();
    const j1 = make(dir);
    await j1.begin("task-1", "dec-1", "req-1", '{"task":"task-1","request_id":"req-1"}');
    await j1.close(); // the process "dies" between journaling and learning the outcome

    const j2 = make(dir);
    const e = j2.openEntry("task-1");
    expect(e).toMatchObject({ request_id: "req-1", args_json: '{"task":"task-1","request_id":"req-1"}', status: "pending" });
  });

  it("blocks a second decision while one is unresolved, and allows one once resolved", async () => {
    const j = make(fresh());
    const e = await j.begin("task-1", "dec-1", "req-1", "{}");
    expect(() => j.begin("task-1", "dec-2", "req-2", "{}")).toThrow(/unresolved/);
    await j.resolve(e, "refused");
    expect(j.openEntry("task-1")).toBeUndefined();
    await expect(j.begin("task-1", "dec-2", "req-2", "{}")).resolves.toMatchObject({ request_id: "req-2" });
  });

  it("keeps a refused request resolved across restarts (never resent)", async () => {
    const dir = fresh();
    const j1 = make(dir);
    await j1.resolve(await j1.begin("t", "d", "r", "{}"), "refused");
    await j1.close();
    expect(make(dir).openEntry("t")).toBeUndefined();
  });

  it("is scoped: an entry for another network or contract is never resumed", async () => {
    const dir = fresh();
    const j1 = make(dir);
    await j1.begin("t", "d", "r", "{}");
    await j1.close();
    // Same file name forced by copying the line into the testnet scope's file.
    const testnet = { ...scope, network: "testnet" };
    const jt = make(dir, testnet);
    expect(jt.openEntry("t")).toBeUndefined();
    await jt.close();
    const sandboxFile = readdirSync(dir).find((f) => f.startsWith("sandbox") && f.endsWith(".jsonl"))!;
    const testnetFile = readdirSync(dir).find((f) => f.startsWith("testnet") && f.endsWith(".jsonl"))!;
    appendFileSync(join(dir, testnetFile), readFileSync(join(dir, sandboxFile)));
    const warnings: string[] = [];
    expect(make(dir, testnet, (m) => warnings.push(m)).openEntry("t")).toBeUndefined();
    expect(warnings.join()).toMatch(/another network/);
  });

  it("tolerates a torn last line", async () => {
    const dir = fresh();
    const j1 = make(dir);
    await j1.begin("t", "d", "r", "{}");
    await j1.close();
    const file = join(dir, readdirSync(dir).find((f) => f.endsWith(".jsonl"))!);
    appendFileSync(file, '{"seq":1,"netw');
    const warnings: string[] = [];
    expect(make(dir, scope, (m) => warnings.push(m)).openEntry("t")).toMatchObject({ request_id: "r" });
    expect(warnings.join()).toMatch(/torn/);
  });

  it("allows one process per journal, and recovers a stale lock", async () => {
    const dir = fresh();
    make(dir);
    expect(() => Journal.open(dir, scope)).toThrow(JournalLockedError);
    await open.splice(0)[0]!.close();
    const lock = join(dir, `${readdirSync(dir).find((f) => f.endsWith(".jsonl"))!}.lock`);
    writeFileSync(lock, "999999"); // a pid that does not exist
    expect(() => make(dir)).not.toThrow();
  });

  it("creates its file owner-only", async () => {
    const dir = fresh();
    make(dir);
    const file = join(dir, readdirSync(dir).find((f) => f.endsWith(".jsonl"))!);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
