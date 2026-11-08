// "Run attack demo" and "Run tests", streamed from the localhost companion.
// A job starts ONLY from a click, outlives this component, and re-attaches after a reload by replaying from the last seq.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon.tsx";
import { companionAvailable, companionCall as call } from "../data/companion.ts";
import { pushToast } from "./toasts.tsx";

type JobKind = "attack" | "tests";
interface JobView {
  jobId: string;
  kind: JobKind;
  lines: { seq: number; line: string }[];
  done: boolean;
  code: number | null;
}

const MAX_SHOWN = 400;
/** Only this panel's own kinds: another page's job must never stream under this panel's labels. */
const isPanelJob = (k: unknown): k is JobKind => k === "attack" || k === "tests";

/** The output console renders into `consoleSlot` (in the page flow), so a long run never covers the board. */
export function DemoControls({ task, onJobFinished, consoleSlot }: { task: string | null; onJobFinished: () => void; consoleSlot: HTMLElement | null }) {
  const available = companionAvailable();
  const [job, setJob] = useState<JobView | null>(null);
  const [starting, setStarting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const runRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  const streamRef = useRef<AbortController | null>(null);
  const onFinishedRef = useRef(onJobFinished);
  onFinishedRef.current = onJobFinished;

  const attach = useCallback(async (jobId: string, kind: JobKind) => {
    streamRef.current?.abort();
    const controller = new AbortController();
    streamRef.current = controller;
    let after = 0;
    setJob((j) => (j && j.jobId === jobId ? j : { jobId, kind, lines: [], done: false, code: null }));
    // Re-attach until the job reports done (a dropped connection resumes from `after`).
    for (let attempt = 0; attempt < 20 && !controller.signal.aborted; attempt++) {
      try {
        const res = await call("/__purser/jobs/events", { jobId, after }, controller.signal);
        if (!res.ok || !res.body) return;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          const parts = buf.split("\n");
          buf = parts.pop() ?? "";
          for (const p of parts) {
            if (!p) continue;
            const msg = JSON.parse(p) as { seq: number; line?: string; done?: boolean; code?: number | null };
            after = Math.max(after, msg.seq);
            if (msg.done) {
              setJob((j) => (j && j.jobId === jobId ? { ...j, done: true, code: msg.code ?? null } : j));
              onFinishedRef.current();
              return;
            }
            if (msg.line !== undefined) {
              const line = { seq: msg.seq, line: msg.line };
              setJob((j) => (j && j.jobId === jobId ? { ...j, lines: [...j.lines, line].slice(-MAX_SHOWN) } : j));
            }
          }
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }, []);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
    else if (wasConfirming.current) runRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  // After a reload, re-attach to a job that is still running (read-only: never starts one).
  useEffect(() => {
    if (!available) return;
    let live = true;
    call("/__purser/jobs/current", {})
      .then((r) => r.json())
      .then((cur: { jobId: string | null; kind?: JobKind; done?: boolean }) => {
        if (live && cur.jobId && isPanelJob(cur.kind) && !cur.done) void attach(cur.jobId, cur.kind);
      })
      .catch(() => {});
    return () => {
      live = false;
      streamRef.current?.abort();
    };
  }, [available, attach]);

  const start = async (kind: JobKind) => {
    if (starting) return;
    setStarting(true);
    try {
      const res = await call("/__purser/jobs", { kind, task });
      const body = (await res.json()) as { jobId?: string; error?: string; kind?: JobKind };
      if (res.status === 409 && body.jobId && isPanelJob(body.kind)) {
        pushToast({ tone: "neutral", icon: "clock", title: "A job is already running, showing it" });
        void attach(body.jobId, body.kind);
      } else if (!res.ok || !body.jobId) {
        pushToast({ tone: "warn", icon: "slash", title: body.error ?? `could not start (HTTP ${res.status})` });
      } else {
        setJob({ jobId: body.jobId, kind, lines: [], done: false, code: null });
        void attach(body.jobId, kind);
      }
    } catch (e) {
      pushToast({ tone: "warn", icon: "slash", title: e instanceof Error ? e.message : "could not start" });
    } finally {
      setStarting(false);
    }
  };

  const running = job !== null && !job.done;
  const cancel = () => job && void call("/__purser/jobs/cancel", { jobId: job.jobId }).catch(() => {});

  return (
    <div className="demo">
      <div className="demo-buttons">
        {confirming ? (
          <div className="demo-buttons" role="group" aria-label="Confirm attack demo" onKeyDown={(e) => e.key === "Escape" && setConfirming(false)}>
            <span className="small">Run on {task}? This sends real testnet transactions and spends from this task's budget.</span>
            <button
              ref={confirmRef}
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setConfirming(false);
                void start("attack");
              }}
            >
              Run attack demo
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <>
            <button ref={runRef} type="button" className="btn" disabled={!available || running || starting || !task} onClick={() => setConfirming(true)}>
              Run attack demo…
            </button>
            <button type="button" className="btn" disabled={!available || running || starting} onClick={() => void start("tests")}>
              Run tests
            </button>
          </>
        )}
        {running && (
          <button type="button" className="btn" onClick={cancel}>
            Stop
          </button>
        )}
        {!available && <span className="dim small">Demo controls need the local dev server (make board).</span>}
      </div>
      {job && !consoleSlot && <span className="dim small">{job.done ? "finished" : "running…"}</span>}
      {job &&
        consoleSlot &&
        createPortal(
        <div className="console" role="log" aria-live="polite" aria-label={`${job.kind === "attack" ? "Attack demo" : "Tests"} output`}>
          <div className="console-head">
            <span>
              {job.kind === "attack" ? `attack demo on ${task}` : "make prove (property tests + attack suite)"}
            </span>
            <span className={job.done ? (job.code === 0 ? "tone-ok" : "tone-warn") : "tone-neutral"}>
              <Icon name={job.done ? (job.code === 0 ? "check" : "slash") : "clock"} /> {job.done ? (job.code === 0 ? "passed" : `exit ${job.code ?? "?"}`) : "running…"}
            </span>
          </div>
          <pre>{job.lines.map((l) => l.line).join("\n")}</pre>
        </div>,
          consoleSlot,
        )}
    </div>
  );
}
