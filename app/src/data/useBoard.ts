// Polling that cannot tear, reorder or leak:
//   - a setTimeout chain: the next poll is scheduled only after the previous one settles;
//   - one AbortController + generation per task: switching tasks (or unmounting, or hiding the tab)
//     aborts the in-flight poll, and a late response for a stale generation is dropped;
//   - snapshots only move forward: one from an older block than the one on screen is discarded
//     (load-balanced RPC nodes can step backwards);
//   - syncedAt is the CLIENT's receipt time, never a block timestamp.

import { useEffect, useRef, useState } from "react";
import type { ProposalRecord } from "@purser/types";
import type { BoardSnapshot, BoardSource, HistorySource } from "./sources.ts";

export const POLL_MS = 3000;

export interface BoardState {
  snapshot: BoardSnapshot | null;
  records: ProposalRecord[];
  syncedAt: number | null;
  error: string | null;
  missing: boolean; // the task does not exist
}

const EMPTY: BoardState = { snapshot: null, records: [], syncedAt: null, error: null, missing: false };

export function useBoard(task: string | null, board: BoardSource, history: HistorySource, refreshKey = 0): BoardState {
  const [state, setState] = useState<BoardState>(EMPTY);
  const heightRef = useRef(0);

  useEffect(() => {
    setState(EMPTY);
    heightRef.current = 0;
    if (!task) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState === "hidden") return; // resumed by the visibility handler
      controller = new AbortController();
      const { signal } = controller;
      try {
        const [snapshot, records] = await Promise.all([
          board.snapshot(task, signal),
          history.available ? history.records(task, signal).catch(() => null) : Promise.resolve([]),
        ]);
        if (cancelled || signal.aborted) return;
        if (snapshot === null) {
          setState((s) => ({ ...s, missing: true, error: null, syncedAt: Date.now() }));
        } else if (snapshot.blockHeight >= heightRef.current) {
          heightRef.current = snapshot.blockHeight;
          setState((s) => ({ snapshot, records: records ?? s.records, syncedAt: Date.now(), error: null, missing: false }));
        }
      } catch (err) {
        if (cancelled || signal.aborted) return;
        setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
      } finally {
        if (!cancelled && !signal.aborted) timer = setTimeout(tick, POLL_MS);
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        controller?.abort();
        clearTimeout(timer);
      } else {
        clearTimeout(timer);
        void tick(); // resume at once; the staleness rule keeps the line non-green until fresh data lands
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    void tick();
    return () => {
      cancelled = true;
      controller?.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [task, board, history, refreshKey]);

  return state;
}

/** A 1 s clock for "synced Ns ago" and staleness, independent of polling. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
