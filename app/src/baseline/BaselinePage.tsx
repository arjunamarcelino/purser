// The comparison shot (DEMO-SCRIPT §2): a deliberately unsafe budget, loudly labeled, dev only (see main.tsx).
// A run starts ONLY from a click; a reload re-attaches or starts clean, so an earlier take's numbers never show.

import { useCallback, useEffect, useRef, useState } from "react";
import { explorer } from "../config.ts";
import { companionAvailable, companionCall } from "../data/companion.ts";
import { shortHash } from "../lib/format.ts";
import { type BaselineLane, type BaselineResult, parseResult, readStream } from "./parse.ts";
import "./baseline.css";

const BANNER = "NAÏVE BASELINE: NO RESERVATION (for comparison only)";
const TITLE = "NAÏVE BASELINE (NO RESERVATION): for comparison only";
const CAP_UNITS = 100;
const EACH_UNITS = 60;
const KIND = "baseline";
const FAILURE_TAIL = 8;

type Phase =
  | { name: "idle"; notice?: string }
  | { name: "running" }
  | { name: "done"; result: BaselineResult }
  | { name: "failed"; message: string; tail: string[] };

function Lane({ name, lane, saw, running }: { name: string; lane: BaselineLane | null; saw: number | null; running: boolean }) {
  const pending = running ? "running…" : "not run";
  return (
    <section className="naive-lane" aria-label={name}>
      <h2 className="label">{name}</h2>
      <ol>
        <li>
          Reads the shared balance: <span>{lane ? `sees ${saw} left` : pending}</span>
        </li>
        <li>
          Checks {EACH_UNITS} &lt;= what it saw: <span>{lane ? "OK" : pending}</span>
        </li>
        <li>
          Spends {EACH_UNITS}: <span>{lane ? `sent to ${lane.to}` : pending}</span>
        </li>
      </ol>
      {lane && (
        <p className="small">
          <a href={explorer.tx(lane.hash)} target="_blank" rel="noopener noreferrer">
            tx {shortHash(lane.hash)} -&gt;
          </a>{" "}
          <span className="dim">
            read at block {lane.read} | landed in block {lane.included}
          </span>
        </p>
      )}
    </section>
  );
}

export default function BaselinePage() {
  const available = companionAvailable();
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const streamRef = useRef<AbortController | null>(null);

  useEffect(() => {
    document.title = TITLE;
  }, []);

  const watch = useCallback(async (jobId: string) => {
    streamRef.current?.abort();
    const controller = new AbortController();
    streamRef.current = controller;
    setPhase({ name: "running" });
    try {
      const res = await companionCall("/__purser/jobs/events", { jobId, after: 0 }, controller.signal);
      if (!res.ok) throw new Error(`the run could not be read (HTTP ${res.status})`);
      const stream = readStream(await res.text());
      if (controller.signal.aborted) return;
      const result = stream.done && stream.code === 0 ? parseResult(stream.lines) : null;
      if (result) setPhase({ name: "done", result });
      else setPhase({ name: "failed", message: `The run did not complete (exit ${stream.code ?? "unknown"}). Nothing here proves an overspend.`, tail: stream.lines.filter((l) => !l.startsWith("BASELINE ")).slice(-FAILURE_TAIL) });
    } catch (e) {
      if (!controller.signal.aborted) setPhase({ name: "failed", message: e instanceof Error ? e.message : "the run could not be read", tail: [] });
    }
  }, []);

  useEffect(() => {
    if (!available) return;
    let live = true;
    companionCall("/__purser/jobs/current", {})
      .then((r) => r.json())
      .then((cur: { jobId: string | null; kind?: string; done?: boolean }) => {
        if (live && cur.jobId && cur.kind === KIND && !cur.done) void watch(cur.jobId);
      })
      .catch(() => {});
    return () => {
      live = false;
      streamRef.current?.abort();
    };
  }, [available, watch]);

  const fire = async () => {
    setPhase({ name: "running" });
    try {
      const res = await companionCall("/__purser/jobs", { kind: KIND });
      const body = (await res.json()) as { jobId?: string; kind?: string; error?: string };
      if (body.jobId && body.kind === KIND) void watch(body.jobId);
      else if (res.status === 409) setPhase({ name: "idle", notice: `Another job is running (${body.kind ?? "unknown"}). Wait for it to finish, then fire again.` });
      else setPhase({ name: "idle", notice: body.error ?? `Could not start (HTTP ${res.status}).` });
    } catch (e) {
      setPhase({ name: "idle", notice: e instanceof Error ? e.message : "Could not start." });
    }
  };

  const running = phase.name === "running";
  const result = phase.name === "done" ? phase.result : null;
  const failed = phase.name === "failed"; // funds may have moved: never show the idle 0 / remaining
  const spent = result?.spentUnits ?? 0;
  const cap = result?.capUnits ?? CAP_UNITS;

  return (
    <div className="naive">
      <div className="naive-banner">{BANNER}</div>
      <main className="naive-main">
        <h1>Two agents share one balance, with no reservation</h1>
        <p className="naive-sub">Deliberately unsafe, written for this demo. Not Purser and not any real product.</p>
        <p className="dim">The limit lives inside the agents. Each one reads the shared balance, checks it, then spends. Real NEAR testnet transfers from a throwaway account.</p>

        <section className={`naive-meter ${result ? "over" : ""}`} aria-label="Baseline budget">
          <div className="label">Spent</div>
          <div className="naive-numeral">
            {failed ? "?" : spent}
            <span className="of"> / cap {cap}</span>
          </div>
          <div className="small">
            {result ? <strong className="naive-over">OVER CAP BY {result.overUnits}</strong> : failed ? <span className="tone-warn">result unknown: check the output below</span> : <span className="dim">remaining {cap - spent} units</span>}
          </div>
        </section>

        <div className="naive-lanes">
          <Lane name="Agent A" lane={result?.a ?? null} saw={result?.sawUnits ?? null} running={running} />
          <Lane name="Agent B" lane={result?.b ?? null} saw={result?.sawUnits ?? null} running={running} />
        </div>

        {result && <p className="naive-caption">Naïve implementation: concurrent checks double-spend.</p>}

        <button type="button" className="btn btn-primary" disabled={!available || running} onClick={() => void fire()}>
          Fire {EACH_UNITS} + {EACH_UNITS} concurrently
        </button>
        {!available && <p className="dim small">This page needs the local dev server (make board).</p>}
        {phase.name === "idle" && phase.notice && (
          <p className="tone-warn small" role="status">
            {phase.notice}
          </p>
        )}
        {phase.name === "failed" && (
          <div role="status">
            <p className="tone-warn small">{phase.message}</p>
            {phase.tail.length > 0 && <pre className="small naive-tail">{phase.tail.join("\n")}</pre>}
          </div>
        )}
      </main>
    </div>
  );
}
