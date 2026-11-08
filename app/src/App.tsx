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
import { useTheme } from "./theme.ts";
import { useWalletAccount } from "./wallet/wallet.ts";
import { DemoControls } from "./components/DemoControls.tsx";
import { Icon } from "./components/Icon.tsx";
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
  const [theme, setTheme] = useTheme();
  const [task, setTask] = useTaskParam();
  const [tasks, setTasks] = useState<string[]>([]);
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
    board.taskIds(c.signal).then(setTasks, () => {});
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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden="true">
            <Icon name="anchor" size={22} />
          </span>
          <span className="wordmark">PURSER</span>
          <span className="tagline dim">One budget. Many agents. Nothing overspent.</span>
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
        <span className="label">
          token <span className="mono">NEAR</span>
        </span>
        <span className={`net ${chainOk === false ? "tone-alarm" : ""}`}>{chainOk === false ? "NOT TESTNET — refusing to load" : chainOk === null ? "checking network…" : "NEAR testnet"}</span>
        <div className="account">
          {wallet.accountId ? (
            <>
              <span className={`badge ${isOwner ? "tone-brass" : "tone-neutral"}`}>
                <span className={`dot ${isOwner ? "active" : "hollow"}`} aria-hidden="true" />
                {isOwner ? "owner" : "viewer"}
              </span>
              <span className="mono small">{wallet.accountId}</span>
              <button type="button" className="btn btn-small" onClick={() => void wallet.disconnect()}>
                Disconnect
              </button>
            </>
          ) : (
            <span className="connect" role="group" aria-label="Connect the owner's wallet">
              <button type="button" className="btn btn-small" title="Choose a wallet (Meteor, NEAR CLI)" onClick={() => void wallet.connect().catch(() => {})}>
                Connect wallet
              </button>
              <button type="button" className="btn btn-small" title="Sign in your terminal with near-cli — the key stays in your OS keychain" onClick={() => void wallet.connect("near-cli").catch(() => {})}>
                NEAR CLI
              </button>
            </span>
          )}
        </div>
        <button type="button" className="icon-btn" aria-label={`Theme: ${theme}. Switch theme`} onClick={() => setTheme(theme === "dark" ? "light" : theme === "light" ? "system" : "dark")}>
          <Icon name={theme === "light" ? "sun" : "moon"} /> <span className="small">{theme}</span>
        </button>
      </header>

      <main>
        {state.missing && <p className="panel">Task “{task}” does not exist on {config.contractId}.</p>}
        {state.error && <p className="panel tone-warn">RPC: {state.error} — retrying.</p>}
        {snap && (
          <>
            <div className="grid">
              <BudgetPanel task={snap.task} cap={BigInt(snap.budget.cap)} completed={BigInt(snap.budget.completed)} outstanding={BigInt(snap.budget.outstanding)} remaining={BigInt(snap.remaining)} money={money} />
              <CrewPanel delegates={snap.delegates} personaOf={personaOf} roleOf={roleOf} isOwner={isOwner} busy={owner.busy} revoking={new Set(revoking.keys())} onRevoke={revoke} />
            </div>
            <Manifest commitments={snap.commitments} records={state.records} personaOf={personaOf} delegateIds={delegateIds} now={now} money={money} />
            {config.indexerEnabled && !cache.wrongIndexer && (
              <CachedHistory rows={cache.rows} dropped={cache.dropped} boardBlock={snap.blockHeight} personaOf={personaOf} recordTx={recordTx} contractId={config.contractId} offline={cache.offline} money={money} />
            )}
            {isOwner && <OwnerPanel task={task} request={(r) => owner.request({ ...r, onSuccess: refresh })} busy={owner.busy} />}
          </>
        )}
        {!snap && !state.missing && !state.error && <p className="panel dim">Loading live state from {config.contractId}…</p>}
        <div ref={setConsoleSlot} className="console-slot" />
      </main>

      <footer className="statusbar">
        <InvariantLine
          health={health}
          completed={BigInt(snap?.invariant.completed ?? "0")}
          outstanding={BigInt(snap?.invariant.outstanding ?? "0")}
          cap={BigInt(snap?.invariant.cap ?? "0")}
          money={money}
        />
        <div className="status-row">
          <DemoControls task={task} onJobFinished={refresh} consoleSlot={consoleSlot} />
          <span className="meta small dim">
            synced {ago(state.syncedAt, now)} · block {snap?.blockHeight ?? "—"} ·{" "}
            <a href={explorer.account(config.contractId)} target="_blank" rel="noopener noreferrer" className="mono">
              {config.contractId} ↗
            </a>
            {config.indexerEnabled && (
              <>
                {" · "}
                {cache.wrongIndexer ? (
                  <span className="tone-warn">history: wrong indexer</span>
                ) : cache.status === null ? (
                  <span className={cache.offline ? "tone-warn" : ""}>{cache.offline ? "history offline" : "history cache …"}</span>
                ) : (
                  <span className={cache.offline || (cacheAge ?? Infinity) > 60_000 ? "tone-warn" : ""}>
                    history cache {cacheAge === null ? "never" : `${Math.round(cacheAge / 1000)}s`} · cache block {cache.status.asOfHeight ?? "—"}
                    {cache.offline && " · history offline"}
                    {cacheLag !== null && cacheLag > 100 && ` · Δ ${cacheLag} blocks`}
                  </span>
                )}
              </>
            )}
          </span>
        </div>
      </footer>
      <ConfirmDialog phase={owner.phase} onConfirm={() => void owner.confirm()} onCancel={owner.cancel} />
      <Toasts />
    </div>
  );
}
