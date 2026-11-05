import { useCallback, useEffect, useMemo, useState } from "react";
import type { Delegate } from "@purser/types";
import { config, explorer } from "./config.ts";
import { ChainBoardSource, CompanionHistorySource } from "./data/sources.ts";
import { useBoard, useNow } from "./data/useBoard.ts";
import { ago } from "./lib/format.ts";
import { lineHealth } from "./lib/semantics.ts";
import { useTheme } from "./theme.ts";
import { useWalletAccount } from "./wallet/wallet.ts";
import { DemoControls } from "./components/DemoControls.tsx";
import { Icon } from "./components/Icon.tsx";
import { ConfirmDialog, OwnerPanel, useOwnerActions } from "./components/owner.tsx";
import { BudgetPanel, CrewPanel, InvariantLine, Manifest } from "./components/panels.tsx";
import { Toasts } from "./components/toasts.tsx";

// Module singletons: StrictMode double-mounts effects, never these.
const board = new ChainBoardSource(config.rpcUrl, config.contractId);
const recordsSource = new CompanionHistorySource();

const PERSONAS = new Set(["scout", "forge", "buyer"]);
const personaOf = (accountId: string) => {
  const first = accountId.split(".")[0] ?? accountId;
  return PERSONAS.has(first) ? first[0]!.toUpperCase() + first.slice(1) : accountId;
};

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
  const now = useNow();
  const wallet = useWalletAccount();
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Refuse to show anything as "testnet" unless the RPC itself says so.
  useEffect(() => {
    board.chainId().then((id) => setChainOk(id === "testnet"), () => setChainOk(false));
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

  const delegateIds = useMemo(() => new Set(snap?.delegates.map((d) => d.account_id) ?? []), [snap]);
  const health = lineHealth(
    snap ? { cap: BigInt(snap.invariant.cap), completed: BigInt(snap.invariant.completed), outstanding: BigInt(snap.invariant.outstanding), holds: snap.invariant.holds, frozen: snap.invariant.frozen } : null,
    { hasUnknown: snap?.commitments.some((c) => c.state === "Unknown") ?? false, syncedAt: state.syncedAt, now },
  );

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
        <span className={`net ${chainOk === false ? "tone-alarm" : ""}`}>{chainOk === false ? "NOT TESTNET — refusing to load" : "NEAR testnet"}</span>
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
            <button type="button" className="btn btn-small" onClick={() => void wallet.connect().catch(() => {})}>
              Connect wallet
            </button>
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
              <BudgetPanel task={snap.task} cap={BigInt(snap.budget.cap)} completed={BigInt(snap.budget.completed)} outstanding={BigInt(snap.budget.outstanding)} remaining={BigInt(snap.remaining)} />
              <CrewPanel delegates={snap.delegates} personaOf={personaOf} isOwner={isOwner} busy={owner.busy} revoking={new Set(revoking.keys())} onRevoke={revoke} />
            </div>
            <Manifest commitments={snap.commitments} records={state.records} personaOf={personaOf} delegateIds={delegateIds} now={now} />
            {isOwner && <OwnerPanel task={task} request={(r) => owner.request({ ...r, onSuccess: refresh })} busy={owner.busy} />}
          </>
        )}
        {!snap && !state.missing && !state.error && <p className="panel dim">Loading live state from {config.contractId}…</p>}
      </main>

      <footer className="statusbar">
        <InvariantLine
          health={health}
          completed={BigInt(snap?.invariant.completed ?? "0")}
          outstanding={BigInt(snap?.invariant.outstanding ?? "0")}
          cap={BigInt(snap?.invariant.cap ?? "0")}
        />
        <div className="status-row">
          <DemoControls task={task} onJobFinished={refresh} />
          <span className="meta small dim">
            synced {ago(state.syncedAt, now)} · block {snap?.blockHeight ?? "—"} ·{" "}
            <a href={explorer.account(config.contractId)} target="_blank" rel="noopener noreferrer" className="mono">
              {config.contractId} ↗
            </a>
          </span>
        </div>
      </footer>
      <ConfirmDialog phase={owner.phase} onConfirm={() => void owner.confirm()} onCancel={owner.cancel} />
      <Toasts />
    </div>
  );
}
