// Write-ahead journal: one decision → one request_id, recorded with its exact call arguments
// BEFORE the transaction is sent.
//
// It closes a client-side double-pay that the contract cannot see. If a run dies (or the network
// fails) after sending, a re-run that asked the model again would mint a NEW request_id for the
// same need, and the contract would rightly accept both payments. Instead:
//   - a task with an unresolved entry gets no new decision; that entry is resumed instead;
//   - a resume resends the SAME bytes (a replay must be the same request), never rebuilt args;
//   - a refusal is terminal: the panic rolled the call back, so no idempotency record exists,
//     and resending the same request_id could be admitted later, when budget frees up.
//
// One file per (network, contract, account), one process per file (an atomically created lock),
// appends serialized in-process, fsync'd. A torn last line (crash mid-write) is truncated away on
// load; an unreadable line anywhere else refuses the journal, since it might be the only record
// of an unresolved request.

import { closeSync, constants, fsyncSync, ftruncateSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

export interface JournalScope {
  network: string;
  contractId: string;
  accountId: string;
}

const Entry = z.strictObject({
  seq: z.number().int().nonnegative(),
  network: z.string(),
  contract_id: z.string(),
  account_id: z.string(),
  task: z.string(),
  decision_id: z.string(),
  request_id: z.string(),
  status: z.enum(["pending", "resolved"]),
  args_json: z.string(),
  outcome: z.string().nullable(),
  at: z.string(),
});
export type JournalEntry = z.infer<typeof Entry>;

export class JournalLockedError extends Error {
  override name = "JournalLockedError";
}

export class JournalCorruptError extends Error {
  override name = "JournalCorruptError";
}

const fileFor = (dir: string, s: JournalScope) =>
  join(dir, `${[s.network, s.contractId, s.accountId].map((p) => p.replace(/[^a-zA-Z0-9._-]/g, "_")).join("__")}.jsonl`);

function fsyncDir(dir: string) {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class Journal {
  readonly #path: string;
  readonly #lockPath: string;
  readonly #scope: JournalScope;
  readonly #latest = new Map<string, JournalEntry>(); // request_id → latest entry
  #seq = 0;
  #fd: number;
  #chain: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(path: string, scope: JournalScope, warn: (m: string) => void) {
    this.#path = path;
    this.#lockPath = `${path}.lock`;
    this.#scope = scope;
    this.#acquireLock();
    let loaded: ReturnType<Journal["load"]>;
    try {
      loaded = this.load(warn);
    } catch (e) {
      this.#releaseLock();
      throw e;
    }
    this.#fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
    if (loaded.keepBytes !== undefined) {
      // Cut the torn tail so the next append starts on a fresh line, not glued to the fragment.
      ftruncateSync(this.#fd, loaded.keepBytes);
      fsyncSync(this.#fd);
    }
    const created = !loaded.existed;
    if (created) {
      fsyncSync(this.#fd);
      fsyncDir(dirname(path)); // make the new file's directory entry durable too
    }
  }

  static open(dir: string, scope: JournalScope, warn: (m: string) => void = () => {}): Journal {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return new Journal(fileFor(dir, scope), scope, warn);
  }

  // The lock file appears atomically WITH its pid (written to a temp file, then hard-linked into
  // place), so no reader ever sees an empty lock. A stale lock (dead pid) is taken over by renaming
  // it aside and checking that what was renamed is the stale lock we inspected; if another process
  // got there first, its live lock is put back and we report the journal as locked.
  #acquireLock() {
    const tmp = `${this.#lockPath}.${process.pid}.${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, String(process.pid), { mode: 0o600 });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          linkSync(tmp, this.#lockPath);
          return;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
        const seen = this.#readLockPid();
        if (seen !== undefined && pidAlive(seen)) throw new JournalLockedError(`journal ${this.#path} is in use by pid ${seen}`);
        const aside = `${tmp}.stale`;
        try {
          renameSync(this.#lockPath, aside);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // someone removed it; retry
          throw e;
        }
        const moved = Number.parseInt(readFileSync(aside, "utf8"), 10);
        if (moved !== seen && Number.isInteger(moved) && pidAlive(moved)) {
          try {
            linkSync(aside, this.#lockPath); // restore the live lock we raced with
          } finally {
            unlinkSync(aside);
          }
          throw new JournalLockedError(`journal ${this.#path} is in use by pid ${moved}`);
        }
        unlinkSync(aside);
      }
      throw new JournalLockedError(`could not lock journal ${this.#path}`);
    } finally {
      unlinkSync(tmp);
    }
  }

  #readLockPid(): number | undefined {
    try {
      const pid = Number.parseInt(readFileSync(this.#lockPath, "utf8"), 10);
      return Number.isInteger(pid) ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  #releaseLock() {
    if (this.#readLockPid() !== process.pid) return; // never remove a lock we do not hold
    try {
      unlinkSync(this.#lockPath);
    } catch {
      // already gone
    }
  }

  /** Load existing entries. `keepBytes` is set when a torn tail must be truncated. */
  private load(warn: (m: string) => void): { existed: boolean; keepBytes?: number } {
    let text: string;
    try {
      text = readFileSync(this.#path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { existed: false };
      throw e;
    }
    let keepBytes: number | undefined;
    if (text.length > 0 && !text.endsWith("\n")) {
      const cut = text.lastIndexOf("\n") + 1;
      keepBytes = Buffer.byteLength(text.slice(0, cut), "utf8");
      text = text.slice(0, cut);
      warn(`journal: truncating a torn last line in ${this.#path}`);
    }
    const lines = text.split("\n").filter((l) => l.length > 0);
    lines.forEach((line, i) => {
      let entry: JournalEntry;
      try {
        entry = Entry.parse(JSON.parse(line));
      } catch {
        throw new JournalCorruptError(`journal ${this.#path}: line ${i + 1} is unreadable; refusing to guess whether a request is unresolved — inspect the file`);
      }
      const s = this.#scope;
      if (entry.network !== s.network || entry.contract_id !== s.contractId || entry.account_id !== s.accountId) {
        warn(`journal: ignoring an entry for another network/contract/account (request ${entry.request_id})`);
        return;
      }
      this.#seq = Math.max(this.#seq, entry.seq + 1);
      this.#latest.set(entry.request_id, entry);
    });
    return keepBytes === undefined ? { existed: true } : { existed: true, keepBytes };
  }

  /** The unresolved entry for a task, if any (at most one by construction). */
  openEntry(task: string): JournalEntry | undefined {
    return [...this.#latest.values()].filter((e) => e.task === task && e.status === "pending").sort((a, b) => a.seq - b.seq)[0];
  }

  /** Record a new decision's exact call before it is sent. */
  begin(task: string, decisionId: string, requestId: string, argsJson: string): Promise<JournalEntry> {
    if (this.openEntry(task)) throw new Error(`journal: task ${task} already has an unresolved request`);
    return this.#append({ task, decision_id: decisionId, request_id: requestId, status: "pending", args_json: argsJson, outcome: null });
  }

  /** Mark a request resolved (terminal). Unresolved requests are simply left pending. */
  resolve(entry: JournalEntry, outcome: string): Promise<JournalEntry> {
    return this.#append({ ...entry, status: "resolved", outcome });
  }

  #append(fields: Omit<JournalEntry, "seq" | "network" | "contract_id" | "account_id" | "at">): Promise<JournalEntry> {
    if (this.#closed) return Promise.reject(new Error("journal is closed"));
    const entry: JournalEntry = {
      ...fields,
      seq: this.#seq++,
      network: this.#scope.network,
      contract_id: this.#scope.contractId,
      account_id: this.#scope.accountId,
      at: new Date().toISOString(),
    };
    // Visible to openEntry() immediately, so a second begin() for the task cannot race this one.
    this.#latest.set(entry.request_id, entry);
    const write = this.#chain.then(() => {
      writeSync(this.#fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(this.#fd);
    });
    this.#chain = write.catch(() => {});
    return write.then(() => entry);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#chain;
    closeSync(this.#fd);
    this.#releaseLock();
  }
}
