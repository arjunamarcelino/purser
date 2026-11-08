import { useCallback, useEffect, useMemo, useState } from "react";
import type { Delegate } from "@purser/types";
import type { CachedCommitment } from "./data/cache.ts";
import { config, explorer } from "./config.ts";
import { ChainBoardSource, CompanionHistorySource } from "./data/sources.ts";
import { IndexerClient, cacheAgeMs } from "./data/cache.ts";
import { useBoard, useNow } from "./data/useBoard.ts";
import { useCache } from "./data/useCache.ts";
import { ago, amountDisplay } from "./lib/format.ts";
import { lineHealth } from "./lib/semantics.ts";
import { useWalletAccount } from "./wallet/wallet.ts";
import { AnchorArt, Dissolve } from "./components/ascii.tsx";
import { DemoControls } from "./components/DemoControls.tsx";
import { ConfirmDialog, OwnerPanel, useOwnerActions } from "./components/owner.tsx";
import { BudgetPanel, CachedHistory, CrewPanel, InvariantLine, Manifest } from "./components/panels.tsx";
import { Toasts } from "./components/toasts.tsx";

// Module singletons: StrictMode double-mounts effects, never these.
const board = new ChainBoardSource(config.rpcUrl, config.contractId);
const recordsSource = new CompanionHistorySource();
const indexer = new IndexerClient({ network: config.network, contractId: config.contractId });

const PERSONAS = new Set(["scout", "forge", "buyer"]);
const personaOf = (accountId: string) => {
  const first = accountId.split(".")[0] ?? accountId;
  return PERSONAS.has(first) ? first[0]!.toUpperCase() + first.slice(1) : accountId;
};

const ROLES: Record<string, string> = { scout: "research/data", forge: "compute", buyer: "procurement" };
const roleOf = (accountId: string) => ROLES[accountId.split(".")[0] ?? ""] ?? null;

function useTaskParam(): [string | null, (t: string) => void] {
  const read = () => new URLSearchParams(location.search).get("task");
  const [task, setTask] = useState<string | null>(read);
  useEffect(() => {
    const on = () => setTask(read());
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  const set = (t: string) => {
    const url = new URL(location.href);
    url.searchParams.set("task", t);
    window.history.pushState(null, "", url);
    setTask(t);
  };
  return [task, set];
}

export function App() {
  const [task, setTask] = useTaskParam();
  const [tasks, setTasks] = useState<string[]>([]);
  const [tasksStatus, setTasksStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [chainOk, setChainOk] = useState<boolean | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [revoking, setRevoking] = useState<ReadonlyMap<string, number>>(new Map());
  const [consoleSlot, setConsoleSlot] = useState<HTMLElement | null>(null);
  const now = useNow();
  const wallet = useWalletAccount();
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Refuse to show anything as "testnet" unless the RPC itself says so. A failed check (e.g. a rate
  // limit) is not an answer: retry with backoff; only a successful reply naming another chain blocks.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = (attempt: number) => {
      board.chainId().then(
        (id) => live && setChainOk(id === "testnet"),
        () => {
          if (live) timer = setTimeout(() => check(attempt + 1), Math.min(2000 * 2 ** attempt, 30_000));
        },
      );
    };
    check(0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const c = new AbortController();
    board.taskIds(c.signal).then(
      (ids) => {
        setTasks(ids);
        setTasksStatus("ready");
      },
      () => {
        if (!c.signal.aborted) setTasksStatus("failed");
      },
    );
    return () => c.abort();
  }, [refreshKey]);
  useEffect(() => {
    if (!task && tasks.length > 0) setTask(tasks[tasks.length - 1]!);
  }, [task, tasks]);

  const state = useBoard(chainOk ? task : null, board, recordsSource, refreshKey);
  const snap = state.snapshot;
  const cache = useCache(task, config.indexerEnabled && chainOk === true, indexer);
  const isOwner = wallet.accountId !== null && snap !== null && wallet.accountId === snap.budget.owner;
  const owner = useOwnerActions(wallet.accountId, isOwner);

  // Clear a "REVOKING…" overlay once the chain shows the delegate inactive (or after 90 s).
  useEffect(() => {
    if (!snap || revoking.size === 0) return;
    const next = new Map(revoking);
    for (const [acct, at] of revoking) {
      const d = snap.delegates.find((x) => x.account_id === acct);
      if (!d || !d.active || now - at > 90_000) next.delete(acct);
    }
    if (next.size !== revoking.size) setRevoking(next);
  }, [snap, now, revoking]);

  // Display-only (?units=1): the demo's round numbers on a small testnet cap.
  const money = amountDisplay(BigInt(snap?.budget.cap ?? "0"), new URLSearchParams(location.search).get("units") === "1");
  const delegateIds = useMemo(() => new Set(snap?.delegates.map((d) => d.account_id) ?? []), [snap]);
  const health = lineHealth(
    snap ? { cap: BigInt(snap.invariant.cap), completed: BigInt(snap.invariant.completed), outstanding: BigInt(snap.invariant.outstanding), holds: snap.invariant.holds, frozen: snap.invariant.frozen } : null,
    { hasUnknown: snap?.commitments.some((c) => c.state === "Unknown") ?? false, syncedAt: state.syncedAt, now },
  );

  // Display-only: a tx hash for a cached row may come from a proposer record, but only one that matches the
  // cached commitment exactly and comes from an on-chain delegate (same rule as the Manifest).
  const recordTx = (r: CachedCommitment): string | null =>
    state.records.find(
      (x) => delegateIds.has(x.account_id) && x.tx_hash !== null && x.commitment_id !== null && String(x.commitment_id) === r.commitmentId && x.request_id === r.requestId && x.account_id === r.delegate && x.recipient === r.recipient,
    )?.tx_hash ?? null;
  const cacheAge = cache.status && cache.receivedAt !== null ? cacheAgeMs(cache.status, cache.receivedAt, now) : null;
  const cacheLag = snap && cache.status?.asOfHeight != null ? snap.blockHeight - cache.status.asOfHeight : null;

  const revoke = (d: Delegate) => {
    if (!task) return;
    owner.request({
      method: "revoke_delegate",
      args: { task_id: task, account_id: d.account_id },
      title: `Revoke ${personaOf(d.account_id)} on ${task}`,
      warnings: (
        <ul>
          <li>Blocks every NEW proposal from {d.account_id} immediately.</li>
          <li>Cannot recall a payment or signature already made; holds already reserved stay until settled.</li>
          <li>
            <strong>Permanent for this task:</strong> a revoked delegate cannot be re-added to {task}.
          </li>
        </ul>
      ),
      onSuccess: () => {
        setRevoking((m) => new Map(m).set(d.account_id, Date.now()));
        refresh();
      },
    });
  };

  const showHistory = config.indexerEnabled && !cache.wrongIndexer;

  // What the board says while it has nothing to show: each cause names itself and what to do next.
  const boardNotice = () => {
    if (chainOk === false) return <p className="tone-warn">This board only reads NEAR testnet, and the configured RPC reports another network. Set NEAR_RPC_URL to a testnet RPC and reload.</p>;
    if (chainOk === null) return <p className="dim">Checking that the RPC is on NEAR testnet…</p>;
    if (!task && tasksStatus === "failed")
      return (
        <p className="tone-warn">
          Could not list the tasks on {config.contractId}.{" "}
          <button type="button" className="btn btn-small" onClick={refresh}>
            Retry
          </button>
        </p>
      );
    if (!task && tasksStatus === "ready" && tasks.length === 0) return <p className="dim">No tasks on {config.contractId} yet. Run ./scripts/demo.sh setup to create one.</p>;
    return <p className="dim">Loading live state from {config.contractId}…</p>;
  };

  return (
    <div className="app">
      <a className="skip" href="#main">
        Skip to the board
      </a>
      <header className="topbar band band-dark">
        <div className="brand">
          <h1 className="wordmark">PURSER</h1>
          <span className="tagline">One budget. Many agents. Nothing overspent.</span>
        </div>
        <label className="task-pick">
          <span className="label">task</span>
          <select value={task ?? ""} onChange={(e) => setTask(e.target.value)} aria-label="Task">
            {task && !tasks.includes(task) && <option value={task}>{task}</option>}
            {tasks.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <span className="label token">
          token NEAR
        </span>
        <span className={`net ${chainOk === false ? "tone-alarm" : ""}`}>{chainOk === false ? "NOT TESTNET: refusing to load" : chainOk === null ? "checking network…" : "NEAR testnet"}</span>
        <div className="account">
          {wallet.accountId ? (
            <>
              <span className="badge tone-neutral">
                <span className={`dot ${isOwner ? "active" : "hollow"}`} aria-hidden="true" />
                {isOwner ? "owner" : "viewer"}
              </span>
              <span className="small">{wallet.accountId}</span>
              <button type="button" className="btn btn-small" onClick={() => void wallet.disconnect()}>
                Disconnect
              </button>
            </>
          ) : (
            <span className="connect" role="group" aria-label="Connect the owner's wallet">
              <button type="button" className="btn btn-small" onClick={() => void wallet.connect().catch(() => {})}>
                Connect wallet
              </button>
              <button type="button" className="btn btn-small" onClick={() => void wallet.connect("near-cli").catch(() => {})}>
                NEAR CLI
              </button>
            </span>
          )}
        </div>
      </header>

      <main id="main">
        <div className="notices band band-dark section">
          {state.missing && <p>Task "{task}" does not exist on {config.contractId}.</p>}
          {state.error && <p className="tone-warn">RPC: {state.error}. Retrying.</p>}
          {!snap && !state.missing && !state.error && boardNotice()}
        </div>
        {snap && (
          <>
            <div className="lead band band-dark section">
              <BudgetPanel task={snap.task} cap={BigInt(snap.budget.cap)} completed={BigInt(snap.budget.completed)} outstanding={BigInt(snap.budget.outstanding)} remaining={BigInt(snap.remaining)} money={money} />
              <AnchorArt />
              <CrewPanel delegates={snap.delegates} personaOf={personaOf} roleOf={roleOf} isOwner={isOwner} busy={owner.busy} revoking={new Set(revoking.keys())} onRevoke={revoke} />
            </div>
            <Dissolve dense="top" />
            <Manifest commitments={snap.commitments} records={state.records} personaOf={personaOf} delegateIds={delegateIds} now={now} money={money} />
            <Dissolve dense="bottom" />
            {showHistory && <CachedHistory rows={cache.rows} dropped={cache.dropped} boardBlock={snap.blockHeight} personaOf={personaOf} recordTx={recordTx} offline={cache.offline} money={money} />}
            {isOwner && (
              // Owner tools take the color the section above them doesn't have, so the bands keep alternating.
              <>
                {showHistory && <Dissolve dense="top" />}
                <div className={`band section ${showHistory ? "band-light" : "band-dark"}`}>
                  <OwnerPanel task={task} request={(r) => owner.request({ ...r, onSuccess: refresh })} busy={owner.busy} />
                </div>
                {showHistory && <Dissolve dense="bottom" />}
              </>
            )}
          </>
        )}
        <div ref={setConsoleSlot} className="console-slot band band-dark" />
      </main>

      <div className="statusbar band-dark">
        <InvariantLine
          health={health}
          completed={snap ? BigInt(snap.invariant.completed) : null}
          outstanding={snap ? BigInt(snap.invariant.outstanding) : null}
          cap={snap ? BigInt(snap.invariant.cap) : null}
          money={money}
        />
      </div>
      <footer className="status-row band band-dark">
        <DemoControls task={task} onJobFinished={refresh} consoleSlot={consoleSlot} />
        <span className="meta dim">
          synced {ago(state.syncedAt, now)} | block {snap?.blockHeight ?? "not read yet"} |{" "}
          <a href={explorer.account(config.contractId)} target="_blank" rel="noopener noreferrer">
            {config.contractId} -&gt;
          </a>
          {config.indexerEnabled && (
            <>
              {" | "}
              {cache.wrongIndexer ? (
                <span className="tone-warn">history: wrong indexer</span>
              ) : cache.status === null ? (
                <span className={cache.offline ? "tone-warn" : ""}>{cache.offline ? "history offline" : "history cache …"}</span>
              ) : (
                <span className={cache.offline || (cacheAge ?? Infinity) > 60_000 ? "tone-warn" : ""}>
                  history cache {cacheAge === null ? "never" : `${Math.round(cacheAge / 1000)}s`} | cache block {cache.status.asOfHeight ?? "not read yet"}
                  {cache.offline && " | history offline"}
                  {cacheLag !== null && cacheLag > 100 && ` | ${cacheLag} blocks behind`}
                </span>
              )}
            </>
          )}
        </span>
      </footer>
      <ConfirmDialog phase={owner.phase} onConfirm={() => void owner.confirm()} onCancel={owner.cancel} />
      <Toasts />
    </div>
  );
}
