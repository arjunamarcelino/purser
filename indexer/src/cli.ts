// node src/cli.ts <poll [--once|--loop] | serve | counts | rebuild --network N --contract C [--yes]>
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { parseArgs } from "node:util";
import { NearChainReader, defaultSleep } from "@purser/chain-read";
import { createApi } from "./api.ts";
import { loadConfig, parseDatabaseUrl, type Config } from "./config.ts";
import { openRepo, openRepoReadOnly } from "./db/open.ts";
import type { Repo } from "./db/types.ts";
import { ConfigError, MetaMismatchError } from "./errors.ts";
import { runPass, runPoller, type PassResult } from "./poller.ts";

const USAGE = "usage: cli.ts <poll [--once|--loop] | serve | counts | rebuild --network N --contract C [--yes]>";
const TABLES = ["task", "commitment_event", "delegate_snapshot", "attestation", "relayer_job", "meta"] as const;

const out = (line: string): void => void process.stdout.write(`${line}\n`);
const err = (line: string): void => void process.stderr.write(`${line}\n`);

function abortOnSignals(): AbortController {
  const ac = new AbortController();
  const stop = () => ac.abort(new Error("shutdown"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return ac;
}

function formatPass(r: PassResult, passNo: number): void {
  for (const t of r.tasks) {
    out(`pass ${passNo} task=${t.taskId} status=${t.status} commitments_seen=${t.commitmentsSeen} as_of_height=${t.asOfHeight}${t.error ? ` error=${t.error}` : ""}`);
  }
  const state = r.complete ? "complete" : r.aborted ? "aborted" : "incomplete";
  out(`pass ${passNo} ${state} height=${r.height ?? "-"} tasks=${r.tasks.length} ignored=${r.ignoredCommitments}${r.failureKinds.length ? ` failures=${[...new Set(r.failureKinds)].join(",")}` : ""}`);
}

function makeReader(cfg: Config): NearChainReader {
  if (cfg.rpcUrl === undefined) throw new ConfigError("NEAR_RPC_URL is required for sandbox");
  return new NearChainReader({ rpcUrl: cfg.rpcUrl, contractId: cfg.contractId });
}

/** Exclusive lockfile next to a sqlite DB. Postgres has no equivalent via Repo: pg advisory locks are not implemented. */
function acquireLock(cfg: Config): () => void {
  const target = parseDatabaseUrl(cfg.databaseUrl.reveal());
  if (target.kind !== "sqlite" || target.path === ":memory:") return () => {};
  const path = `${target.path}.poll.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(readFileSync(path, "utf8"));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (k) {
        alive = (k as NodeJS.ErrnoException).code === "EPERM";
      }
      if (alive) throw new ConfigError(`another poller (pid ${pid}) holds ${path}`);
      unlinkSync(path);
    }
  }
  throw new ConfigError(`could not acquire ${path}`);
}

async function withRepo<T>(cfg: Config, fn: (repo: Repo) => Promise<T>): Promise<T> {
  await using repo = await openRepo(cfg.databaseUrl.reveal());
  await repo.init();
  await repo.ensureScope({ network: cfg.network, contractId: cfg.contractId });
  return await fn(repo);
}

async function poll(cfg: Config, once: boolean): Promise<void> {
  const release = acquireLock(cfg);
  try {
    const ac = abortOnSignals();
    await withRepo(cfg, async (repo) => {
      await runPoller({
        reader: makeReader(cfg),
        repo,
        signal: ac.signal,
        sleep: defaultSleep,
        intervalMs: cfg.pollIntervalMs,
        config: { network: cfg.network, contractId: cfg.contractId, passBudgetMs: cfg.passBudgetMs },
        log: err,
        onPass: formatPass,
        ...(once && { maxPasses: 1 }),
      });
    });
  } finally {
    release();
  }
}

async function serve(cfg: Config): Promise<void> {
  const ac = abortOnSignals();
  await using repo = await openRepoReadOnly(cfg.databaseUrl.reveal());
  await repo.init();
  await repo.ensureScope({ network: cfg.network, contractId: cfg.contractId });
  const api = createApi({ repo, scope: { network: cfg.network, contractId: cfg.contractId }, host: cfg.apiHost, port: cfg.apiPort });
  const { port } = await api.listen();
  out(`listening on ${cfg.apiHost}:${port}`);
  await new Promise<void>((resolve) => ac.signal.addEventListener("abort", () => resolve(), { once: true }));
  await api.close();
}

async function counts(cfg: Config): Promise<void> {
  await withRepo(cfg, async (repo) => {
    const c = await repo.counts();
    for (const t of TABLES) out(`${t}: ${c[t]}`);
    out(`canonical sha256: ${(await repo.canonicalDump()).sha256}`);
  });
}

async function rebuild(cfg: Config, network: string | undefined, contract: string | undefined, yes: boolean): Promise<void> {
  if (network !== cfg.network || contract !== cfg.contractId) {
    throw new ConfigError("rebuild requires --network and --contract matching NEAR_NETWORK and PURSER_CONTRACT_ID");
  }
  if (!yes) throw new ConfigError("rebuild wipes the cache; pass --yes to confirm");
  const release = acquireLock(cfg);
  try {
    const ac = abortOnSignals();
    await using repo = await openRepo(cfg.databaseUrl.reveal());
    await repo.init();
    await repo.wipe();
    await repo.ensureScope({ network: cfg.network, contractId: cfg.contractId });
    const r = await runPass({
      reader: makeReader(cfg),
      repo,
      signal: ac.signal,
      passNo: 0,
      config: { network: cfg.network, contractId: cfg.contractId, passBudgetMs: Math.max(cfg.passBudgetMs, 600_000) },
      log: err,
    });
    formatPass(r, 1);
    if (!r.complete) process.exitCode = 1;
  } finally {
    release();
  }
}

async function main(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { once: { type: "boolean" }, loop: { type: "boolean" }, network: { type: "string" }, contract: { type: "string" }, yes: { type: "boolean" } },
  });
  const cmd = positionals[0];
  if (cmd === undefined || !["poll", "serve", "counts", "rebuild"].includes(cmd)) throw new ConfigError(USAGE);
  const cfg = loadConfig(process.env);
  if (cmd === "poll") await poll(cfg, values.once === true && values.loop !== true);
  else if (cmd === "serve") await serve(cfg);
  else if (cmd === "counts") await counts(cfg);
  else await rebuild(cfg, values.network, values.contract, values.yes === true);
}

main(process.argv.slice(2)).catch((e: unknown) => {
  // Only the error class and message; config errors never carry values.
  const kind = e instanceof MetaMismatchError || e instanceof ConfigError ? e.kind : "error";
  err(`${kind}: ${e instanceof Error ? e.message : "failed"}`);
  process.exitCode = 1;
});
