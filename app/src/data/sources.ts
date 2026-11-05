// The board's data layer: two small sources behind interfaces, so Prompt 9 can swap the history
// source for the indexer without touching the board.
//
//   BoardSource   — authoritative chain state, every view read at ONE final block (no tearing).
//   HistorySource — the proposer's records (refusals, tx links): self-asserted, untrusted, validated.

import { JsonRpcProvider } from "near-api-js";
import {
  type Commitment,
  type Delegate,
  type InvariantView,
  ProposalRecord,
  type PurserViews,
  type TaskBudget,
  parseU64Safe,
} from "@purser/types";

export interface BoardSnapshot {
  task: string;
  blockHeight: number;
  budget: TaskBudget;
  invariant: InvariantView;
  remaining: string;
  delegates: Delegate[];
  commitments: Commitment[];
}

export interface BoardSource {
  snapshot(task: string, signal: AbortSignal): Promise<BoardSnapshot | null>;
  taskIds(signal: AbortSignal): Promise<string[]>;
  chainId(): Promise<string>;
}

export interface HistorySource {
  readonly available: boolean;
  records(task: string, signal: AbortSignal): Promise<ProposalRecord[]>;
}

const decoder = new TextDecoder();
const CALL_TIMEOUT_MS = 10_000;

/** A provider call that gives up after 10 s or when the poll is aborted (near-api-js takes no signal). */
function withTimeout<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("RPC timed out")), CALL_TIMEOUT_MS);
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  });
}
const encoder = new TextEncoder();
const PAGE = 100;

export class ChainBoardSource implements BoardSource {
  readonly #provider: JsonRpcProvider;
  readonly #contractId: string;

  constructor(rpcUrl: string, contractId: string) {
    // One attempt per call (near-api-js's `retries` is the ATTEMPT count — 0 would never send). Its own
    // retry loop backs off for minutes with no timeout, freezing the board; useBoard backs off instead.
    this.#provider = new JsonRpcProvider({ url: rpcUrl }, { retries: 1 });
    this.#contractId = contractId;
  }

  async #view<M extends keyof PurserViews>(method: M, args: PurserViews[M]["args"], blockId: number | undefined, signal: AbortSignal): Promise<PurserViews[M]["result"]> {
    signal.throwIfAborted();
    const raw = await withTimeout(
      this.#provider.callFunctionRaw({
        contractId: this.#contractId,
        method,
        args: encoder.encode(JSON.stringify(args)),
        blockQuery: blockId === undefined ? { finality: "final" } : { blockId },
      }),
      signal,
    );
    return parseU64Safe(decoder.decode(Uint8Array.from(raw.result))) as PurserViews[M]["result"];
  }

  async snapshot(task: string, signal: AbortSignal): Promise<BoardSnapshot | null> {
    // Pin every read to one final block: invariant, budget and the ledger then describe the SAME
    // chain state (separate "final" reads can land on different blocks or RPC nodes).
    const block = await withTimeout(this.#provider.viewBlock({ finality: "final" }), signal);
    const h = block.header.height;
    const budget = await this.#view("get_task", { task_id: task }, h, signal);
    if (budget === null) return null;
    // Five calls per poll (block + four views). "Remaining" is cap − used from the invariant view —
    // the same math as remaining_budget, without another request against a rate-limited RPC.
    const [invariant, delegates, commitments] = await Promise.all([
      this.#view("invariant", { task_id: task }, h, signal),
      this.#pages((from) => this.#view("list_delegates", { task_id: task, from_index: from, limit: PAGE }, h, signal)),
      this.#pages((from) => this.#view("list_commitments", { task_id: task, from_index: from, limit: PAGE }, h, signal)),
    ]);
    if (invariant === null) return null;
    const used = BigInt(invariant.used);
    const cap = BigInt(invariant.cap);
    const remaining = (used >= cap ? 0n : cap - used).toString();
    return { task, blockHeight: h, budget, invariant, remaining, delegates, commitments };
  }

  async #pages<T>(page: (from: number) => Promise<T[]>): Promise<T[]> {
    const all: T[] = [];
    for (let from = 0; ; from += PAGE) {
      const rows = await page(from);
      all.push(...rows);
      if (rows.length < PAGE || all.length >= 2000) return all; // list_commitments scans the ledger; Prompt 9's indexer is the scale path
    }
  }

  async taskIds(signal: AbortSignal): Promise<string[]> {
    return this.#pages((from) => this.#view("list_task_ids", { from_index: from, limit: PAGE }, undefined, signal));
  }

  async chainId(): Promise<string> {
    return (await this.#provider.viewNodeStatus()).chain_id;
  }
}

/** Reads the proposer's records through the localhost companion (dev only). */
export class CompanionHistorySource implements HistorySource {
  readonly available: boolean;
  readonly #token: string | null;

  constructor() {
    this.#token = document.querySelector<HTMLMetaElement>('meta[name="purser-token"]')?.content ?? null;
    this.available = this.#token !== null;
  }

  async records(task: string, signal: AbortSignal): Promise<ProposalRecord[]> {
    if (!this.#token) return [];
    const res = await fetch("/__purser/records", {
      method: "POST",
      headers: { "content-type": "application/json", "x-purser-token": this.#token },
      body: JSON.stringify({ task }),
      signal,
    });
    if (!res.ok) throw new Error(`records: HTTP ${res.status}`);
    const body = (await res.json()) as { records?: unknown[] };
    // Validate again here: the board treats records as untrusted whatever the server did.
    return (body.records ?? []).flatMap((r) => {
      const parsed = ProposalRecord.safeParse(r);
      return parsed.success ? [parsed.data] : [];
    });
  }
}
