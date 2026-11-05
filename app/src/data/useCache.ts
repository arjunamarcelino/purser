import { useEffect, useState } from "react";
import { type CacheHistorySource, type CacheStatus, type CacheStatusSource, type CachedCommitment, WrongIndexerError } from "./cache.ts";

export interface CacheState {
  status: CacheStatus | null;
  /** Local Date.now() when `status` arrived; with status.serverTime it gives a clock-skew-free age. */
  receivedAt: number | null;
  rows: CachedCommitment[];
  dropped: number;
  offline: boolean;
  wrongIndexer: boolean;
}

const EMPTY: CacheState = { status: null, receivedAt: null, rows: [], dropped: 0, offline: false, wrongIndexer: false };
export const CACHE_POLL_MS = 15_000;

/** Polls the history cache on its own 15 s timer (independent of the 4 s board tick). Display-only. */
export function useCache(task: string | null, enabled: boolean, source: CacheHistorySource & CacheStatusSource): CacheState {
  const [state, setState] = useState<CacheState>(EMPTY);

  useEffect(() => {
    setState(EMPTY);
    if (!enabled || !task) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctl: AbortController | undefined;
    const tick = async () => {
      ctl = new AbortController();
      try {
        const status = await source.status(ctl.signal);
        const hist = await source.history(task, ctl.signal);
        if (live) setState({ status, receivedAt: Date.now(), rows: hist.rows, dropped: hist.dropped, offline: false, wrongIndexer: false });
      } catch (e) {
        if (!live) return;
        // Keep nothing from a wrong indexer; for plain outages keep the last good rows but flag offline.
        if (e instanceof WrongIndexerError) setState({ ...EMPTY, wrongIndexer: true });
        else setState((s) => ({ ...s, offline: true }));
      }
      if (live) timer = setTimeout(() => void tick(), CACHE_POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
      ctl?.abort();
    };
  }, [task, enabled, source]);

  return state;
}
