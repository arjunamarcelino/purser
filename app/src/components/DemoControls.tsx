// "Run attack demo" and "Run tests", streamed from the localhost companion.
// A job starts ONLY from a click (never an effect), outlives this component and any connection,
// and is re-attached after a reload by replaying its output from the last seen sequence number.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon.tsx";
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
const token = () => document.querySelector<HTMLMetaElement>('meta[name="purser-token"]')?.content ?? null;

async function call(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const t = token();
  if (!t) throw new Error("companion not available");
  return fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-purser-token": t }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
}

/**
 * The buttons live in the sticky footer next to the invariant line; the output console renders into
 * `consoleSlot` (in the page flow), so a long run never covers the board.
 */
export function DemoControls({ task, onJobFinished, consoleSlot }: { task: string | null; onJobFinished: () => void; consoleSlot: HTMLElement | null }) {
  const available = token() !== null;
  const [job, setJob] = useState<JobView | null>(null);
  const [starting, setStarting] = useState(false);
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

  // After a reload, re-attach to a job that is still running (read-only: never starts one).
  useEffect(() => {
    if (!available) return;
    let live = true;
    call("/__purser/jobs/current", {})
      .then((r) => r.json())
      .then((cur: { jobId: string | null; kind?: JobKind; done?: boolean }) => {
        if (live && cur.jobId && cur.kind && !cur.done) void attach(cur.jobId, cur.kind);
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
      if (res.status === 409 && body.jobId && body.kind) {
        pushToast({ tone: "neutral", icon: "clock", title: "A job is already running — showing it" });
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
        <button type="button" className="btn btn-primary" disabled={!available || running || starting || !task} onClick={() => void start("attack")}>
          Run attack demo
        </button>
        <button type="button" className="btn" disabled={!available || running || starting} onClick={() => void start("tests")}>
          Run tests
        </button>
        {running && (
          <button type="button" className="btn" onClick={cancel}>
            Stop
          </button>
        )}
        {!available && <span className="dim small">Demo controls need the local dev server (pnpm --filter @purser/app dev).</span>}
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
            <span className={job.done ? (job.code === 0 ? "tone-ok" : "tone-warn") : "tone-brass"}>
              <Icon name={job.done ? (job.code === 0 ? "check" : "slash") : "clock"} size={14} /> {job.done ? (job.code === 0 ? "passed" : `exit ${job.code ?? "?"}`) : "running…"}
            </span>
          </div>
          <pre className="mono">{job.lines.map((l) => l.line).join("\n")}</pre>
        </div>,
          consoleSlot,
        )}
    </div>
  );
}
