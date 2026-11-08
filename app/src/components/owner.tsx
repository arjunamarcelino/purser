// Owner actions, one at a time (idle → confirming → signing → idle), each confirmed with exactly what will be signed.
// The signer is captured at the start; an account switch while confirming closes the dialog.

import { type InputHTMLAttributes, type ReactNode, useEffect, useId, useRef, useState } from "react";
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
      pushToast({ tone: "ok", icon: "check", title: `${req.title}: done`, ...(out.txHash ? { href: explorer.tx(out.txHash) } : {}) });
    } else if (out.kind === "refused") {
      const b = refusalBadge(out.code);
      pushToast({ tone: "warn", icon: "slash", title: `${req.title}: ${b.label}`, ...(out.code ? {} : { detail: out.raw }), ...(out.txHash ? { href: explorer.tx(out.txHash) } : {}) });
    } else if (out.kind === "rejected") {
      pushToast({ tone: "neutral", icon: "minus", title: `${req.title}: not signed`, detail: out.raw });
    } else {
      pushToast({ tone: "warn", icon: "clock", title: `${req.title}: outcome unknown`, detail: out.raw }, 20000);
    }
  };

  const cancel = () => setPhase((p) => (p.kind === "confirming" ? { kind: "idle" } : p));
  return { phase, request, confirm, cancel, busy: phase.kind !== "idle" };
}

export function ConfirmDialog({ phase, onConfirm, onCancel }: { phase: Phase; onConfirm: () => void; onCancel: () => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const open = phase.kind !== "idle";
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [open]);
  useEffect(() => {
    if (phase.kind === "confirming") confirmRef.current?.focus();
    else if (phase.kind === "signing") dialogRef.current?.focus(); // the buttons are gone while signing
  }, [phase.kind]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key !== "Tab" || !dialogRef.current) return;
      const dialog = dialogRef.current;
      const items = [...dialog.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input, select, textarea")];
      const first = items[0] ?? dialog;
      const last = items[items.length - 1] ?? dialog;
      const active = document.activeElement;
      if (!dialog.contains(active) || (e.shiftKey ? active === first || active === dialog : active === last)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);
  if (phase.kind === "idle") return null;
  const { req, signer } = phase;
  return (
    <div className="scrim" role="presentation">
      <div ref={dialogRef} tabIndex={-1} className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">{req.title}</h2>
        {req.warnings && <div className="warnings">{req.warnings}</div>}
        <dl className="tx-details">
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

function Field({ label, error, ...input }: { label: string; error: string | null } & InputHTMLAttributes<HTMLInputElement>) {
  const errorId = useId();
  return (
    <label>
      {label}
      <input {...input} aria-invalid={error !== null} aria-describedby={error ? errorId : undefined} />
      {error && (
        <span id={errorId} className="field-error">
          {error}
        </span>
      )}
    </label>
  );
}

/** Owner-only maintenance: create a task, add a delegate, set the allowlist. */
export function OwnerPanel({ task, request, busy }: { task: string | null; request: (r: OwnerRequest) => void; busy: boolean }) {
  const [newTask, setNewTask] = useState({ id: "", cap: "1", crew: "3" });
  const [delegate, setDelegate] = useState({ account: "", persona: "" });
  const [allow, setAllow] = useState("");

  const taskValid = SAFE_TASK_ID.test(newTask.id);
  const capYocto = nearToYocto(newTask.cap);
  const crewCap = Number(newTask.crew);
  const crewValid = Number.isInteger(crewCap) && crewCap >= 1 && crewCap <= 255;
  const accountValid = NEAR_ACCOUNT_ID.test(delegate.account);
  const personaValid = /^[a-z0-9_-]{1,32}$/.test(delegate.persona);
  const delegateValid = accountValid && personaValid;
  const allowList = allow.split(/[\s,]+/).filter(Boolean);
  const allowValid = allowList.length > 0 && allowList.length <= 20 && allowList.every((a) => NEAR_ACCOUNT_ID.test(a));
  const createReady = taskValid && capYocto !== null && crewValid;

  return (
    <details className="panel owner-panel">
      <summary>Owner tools</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!createReady) return;
          request({
            method: "create_task",
            args: { task_id: newTask.id, cap: capYocto, token: "NearNative", crew_cap: crewCap },
            title: `Create task ${newTask.id}`,
            warnings: <p>Cap {newTask.cap} NEAR ({capYocto} yoctoNEAR). The contract pays from its own balance up to this cap.</p>,
          });
        }}
      >
        <h3>Create task</h3>
        <Field label="Task id" value={newTask.id} onChange={(e) => setNewTask({ ...newTask, id: e.target.value.trim() })} error={newTask.id !== "" && !taskValid ? "Use lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit." : null} placeholder="board-1" />
        <Field label="Cap (NEAR)" value={newTask.cap} inputMode="decimal" onChange={(e) => setNewTask({ ...newTask, cap: e.target.value.trim() })} error={capYocto ? null : "Enter a NEAR amount, such as 1 or 0.5."} />
        <Field label="Crew cap" value={newTask.crew} inputMode="numeric" onChange={(e) => setNewTask({ ...newTask, crew: e.target.value.trim() })} error={crewValid ? null : "Enter a whole number from 1 to 255."} />
        <button className="btn" disabled={busy || !createReady}>
          Create task…
        </button>
        {newTask.id === "" && <p className="form-note dim small">Enter a task id to continue.</p>}
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
        <h3>Add delegate{task ? ` to ${task}` : ""}</h3>
        <Field label="Account" value={delegate.account} onChange={(e) => setDelegate({ ...delegate, account: e.target.value.trim() })} error={delegate.account !== "" && !accountValid ? "Enter a NEAR account, such as scout.you.testnet." : null} placeholder="scout.you.testnet" />
        <Field label="Persona" value={delegate.persona} onChange={(e) => setDelegate({ ...delegate, persona: e.target.value.trim() })} error={delegate.persona !== "" && !personaValid ? "Use up to 32 lowercase letters, digits, dashes or underscores." : null} placeholder="scout" />
        <button className="btn" disabled={busy || !task || !delegateValid}>
          Add delegate…
        </button>
        {!task ? <p className="form-note dim small">Select a task first.</p> : (delegate.account === "" || delegate.persona === "") && <p className="form-note dim small">Enter an account and a persona to continue.</p>}
      </form>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!task || !allowValid) return;
          request({ method: "set_recipient_allowlist", args: { task_id: task, recipients: allowList }, title: `Set allowlist on ${task}` });
        }}
      >
        <h3>Allowlist recipients{task ? ` on ${task}` : ""}</h3>
        <Field label="Accounts (comma or space separated)" value={allow} onChange={(e) => setAllow(e.target.value)} error={allow.trim() !== "" && !allowValid ? "Enter up to 20 valid NEAR accounts." : null} placeholder="data.you.testnet, compute.you.testnet" />
        <button className="btn" disabled={busy || !task || !allowValid}>
          Set allowlist…
        </button>
        {!task ? <p className="form-note dim small">Select a task first.</p> : allow.trim() === "" && <p className="form-note dim small">Enter at least one recipient to continue.</p>}
      </form>
    </details>
  );
}
