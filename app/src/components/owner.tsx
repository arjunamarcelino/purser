// Owner actions: one at a time, every one confirmed with exactly what will be signed.
//   idle → confirming → signing → idle
// The signer and task are captured when the action starts; an account switch while confirming
// closes the dialog; the receiver is always the configured contract (wallet.ts).

import { type ReactNode, useEffect, useRef, useState } from "react";
import { NEAR_ACCOUNT_ID, SAFE_TASK_ID } from "@purser/types";
import { config, explorer } from "../config.ts";
import { type OwnerMethod, signOwnerCall } from "../wallet/wallet.ts";
import { pushToast } from "./toasts.tsx";
import { refusalBadge } from "../lib/semantics.ts";

export interface OwnerRequest {
  method: OwnerMethod;
  args: Record<string, unknown>;
  title: string;
  /** Plain-language consequences, shown before signing. */
  warnings?: ReactNode;
  /** Called once the transaction succeeded (e.g. to show a pending overlay). */
  onSuccess?: () => void;
}

type Phase = { kind: "idle" } | { kind: "confirming"; req: OwnerRequest; signer: string } | { kind: "signing"; req: OwnerRequest; signer: string };

export function useOwnerActions(accountId: string | null, isOwner: boolean) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  // An account change (or sign-out) while confirming invalidates what the user is about to approve.
  useEffect(() => {
    setPhase((p) => (p.kind === "confirming" && p.signer !== accountId ? { kind: "idle" } : p));
  }, [accountId]);

  const request = (req: OwnerRequest) => {
    if (!accountId || !isOwner || phase.kind !== "idle") return;
    setPhase({ kind: "confirming", req, signer: accountId });
  };

  const confirm = async () => {
    if (phase.kind !== "confirming") return;
    const { req, signer } = phase;
    setPhase({ kind: "signing", req, signer });
    const out = await signOwnerCall(req.method, req.args, signer);
    setPhase({ kind: "idle" });
    if (out.kind === "ok") {
      req.onSuccess?.();
      pushToast({ tone: "ok", icon: "check", title: `${req.title} — done`, ...(out.txHash ? { href: explorer.tx(out.txHash) } : {}) });
    } else if (out.kind === "refused") {
      const b = refusalBadge(out.code);
      pushToast({ tone: "warn", icon: "slash", title: `${req.title} — ${b.label}`, ...(out.code ? {} : { detail: out.raw }), ...(out.txHash ? { href: explorer.tx(out.txHash) } : {}) });
    } else if (out.kind === "rejected") {
      pushToast({ tone: "neutral", icon: "minus", title: `${req.title} — not signed`, detail: out.raw });
    } else {
      pushToast({ tone: "warn", icon: "clock", title: `${req.title} — outcome unknown`, detail: out.raw }, 20000);
    }
  };

  const cancel = () => setPhase((p) => (p.kind === "confirming" ? { kind: "idle" } : p));
  return { phase, request, confirm, cancel, busy: phase.kind !== "idle" };
}

export function ConfirmDialog({ phase, onConfirm, onCancel }: { phase: Phase; onConfirm: () => void; onCancel: () => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const open = phase.kind !== "idle";
  useEffect(() => {
    if (phase.kind === "confirming") confirmRef.current?.focus();
  }, [phase.kind]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);
  if (phase.kind === "idle") return null;
  const { req, signer } = phase;
  return (
    <div className="scrim" role="presentation">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">{req.title}</h2>
        {req.warnings && <div className="warnings">{req.warnings}</div>}
        <dl className="tx-details mono">
          <dt>network</dt>
          <dd>{config.network}</dd>
          <dt>contract</dt>
          <dd>{config.contractId}</dd>
          <dt>method</dt>
          <dd>{req.method}</dd>
          <dt>arguments</dt>
          <dd>
            <pre>{JSON.stringify(req.args, null, 2)}</pre>
          </dd>
          <dt>deposit</dt>
          <dd>0 NEAR</dd>
          <dt>signer</dt>
          <dd>{signer}</dd>
        </dl>
        {phase.kind === "signing" ? (
          <p className="dim" role="status">
            Waiting for the wallet… With the NEAR CLI wallet, run the shown command in your terminal and paste the transaction hash back.
          </p>
        ) : (
          <div className="row-actions">
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
            <button ref={confirmRef} type="button" className="btn btn-primary" onClick={onConfirm}>
              Sign with wallet
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const YOCTO = 10n ** 24n;
/** "1.5" NEAR → yocto string, exactly (no floats). */
export function nearToYocto(near: string): string | null {
  if (!/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,24})?$/.test(near)) return null;
  const [w = "0", f = ""] = near.split(".");
  return (BigInt(w) * YOCTO + BigInt(f.padEnd(24, "0"))).toString();
}

/** Owner-only maintenance: create a task, add a delegate, set the allowlist. */
export function OwnerPanel({ task, request, busy }: { task: string | null; request: (r: OwnerRequest) => void; busy: boolean }) {
  const [newTask, setNewTask] = useState({ id: "", cap: "1", crew: "3" });
  const [delegate, setDelegate] = useState({ account: "", persona: "" });
  const [allow, setAllow] = useState("");

  const taskValid = SAFE_TASK_ID.test(newTask.id);
  const capYocto = nearToYocto(newTask.cap);
  const crewCap = Number(newTask.crew);
  const delegateValid = NEAR_ACCOUNT_ID.test(delegate.account) && /^[a-z0-9_-]{1,32}$/.test(delegate.persona);
  const allowList = allow.split(/[\s,]+/).filter(Boolean);
  const allowValid = allowList.length > 0 && allowList.length <= 20 && allowList.every((a) => NEAR_ACCOUNT_ID.test(a));

  return (
    <details className="panel owner-panel">
      <summary>Owner tools</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!taskValid || !capYocto || !(crewCap >= 1 && crewCap <= 255)) return;
          request({
            method: "create_task",
            args: { task_id: newTask.id, cap: capYocto, token: "NearNative", crew_cap: crewCap },
            title: `Create task ${newTask.id}`,
            warnings: <p>Cap {newTask.cap} NEAR ({capYocto} yoctoNEAR). The contract pays from its own balance up to this cap.</p>,
          });
        }}
      >
        <h3>Create task</h3>
        <label>
          Task id <input value={newTask.id} onChange={(e) => setNewTask({ ...newTask, id: e.target.value.trim() })} aria-invalid={newTask.id !== "" && !taskValid} placeholder="board-1" />
        </label>
        <label>
          Cap (NEAR) <input value={newTask.cap} inputMode="decimal" onChange={(e) => setNewTask({ ...newTask, cap: e.target.value.trim() })} aria-invalid={!capYocto} />
        </label>
        <label>
          Crew cap <input value={newTask.crew} inputMode="numeric" onChange={(e) => setNewTask({ ...newTask, crew: e.target.value.trim() })} />
        </label>
        <button className="btn" disabled={busy || !taskValid || !capYocto}>
          Create…
        </button>
      </form>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!task || !delegateValid) return;
          request({
            method: "add_delegate",
            args: { task_id: task, account_id: delegate.account, derivation_path: `purser/${task}/${delegate.persona}` },
            title: `Add ${delegate.account} to ${task}`,
          });
        }}
      >
        <h3>Add delegate to {task ?? "—"}</h3>
        <label>
          Account <input value={delegate.account} onChange={(e) => setDelegate({ ...delegate, account: e.target.value.trim() })} placeholder="scout.you.testnet" />
        </label>
        <label>
          Persona <input value={delegate.persona} onChange={(e) => setDelegate({ ...delegate, persona: e.target.value.trim() })} placeholder="scout" />
        </label>
        <button className="btn" disabled={busy || !task || !delegateValid}>
          Add…
        </button>
      </form>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!task || !allowValid) return;
          request({ method: "set_recipient_allowlist", args: { task_id: task, recipients: allowList }, title: `Set allowlist on ${task}` });
        }}
      >
        <h3>Allowlist recipients on {task ?? "—"}</h3>
        <label>
          Accounts (comma or space separated) <input value={allow} onChange={(e) => setAllow(e.target.value)} placeholder="data.you.testnet, compute.you.testnet" />
        </label>
        <button className="btn" disabled={busy || !task || !allowValid}>
          Set…
        </button>
      </form>
    </details>
  );
}
