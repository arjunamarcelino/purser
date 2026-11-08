import { useEffect, useRef, useState } from "react";
import type { Commitment, Delegate, ProposalRecord } from "@purser/types";
import { explorer } from "../config.ts";
import type { CachedCommitment } from "../data/cache.ts";
import { type AmountDisplay, formatTime, nearDisplay, safeText, shortHash } from "../lib/format.ts";
import { type LineHealth, groupOf, refusalBadge, stateBadge } from "../lib/semantics.ts";
import { useReducedMotion } from "../lib/useReducedMotion.ts";
import { Heading, budgetBar, useColumns } from "./ascii.tsx";
import { Badge } from "./Badge.tsx";
import { Icon } from "./Icon.tsx";

/** Counts the Remaining numeral to its new value in ≤300 ms; the last frame is the exact string. */
// Snaps with no count on the first value, on a task switch, and under prefers-reduced-motion.
export function useCountTo(target: bigint | null, snapKey: string): bigint | null {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState<bigint | null>(target);
  const shownRef = useRef<bigint | null>(target);
  const keyRef = useRef(snapKey);

  useEffect(() => {
    const snap = (v: bigint | null) => {
      shownRef.current = v;
      setShown(v);
    };
    if (target === null || shownRef.current === null || reduced || keyRef.current !== snapKey) {
      keyRef.current = snapKey;
      snap(target);
      return;
    }
    const from = shownRef.current;
    if (from === target) return;
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / 300);
      const eased = 1 - (1 - p) ** 3;
      // interpolate in milli-units of the display (bigint math; the final frame is exact)
      const v = p >= 1 ? target : from + ((target - from) * BigInt(Math.round(eased * 1000))) / 1000n;
      snap(v);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, snapKey, reduced]);

  return shown;
}

export function BudgetPanel({ task, cap, completed, outstanding, remaining, money = nearDisplay }: { task: string; cap: bigint; completed: bigint; outstanding: bigint; remaining: bigint; money?: AmountDisplay }) {
  const shown = useCountTo(remaining, task);
  const pct = cap > 0n ? Number(((completed + outstanding) * 1000n) / cap) / 10 : 0;
  const meter = useRef<HTMLDivElement>(null);
  const columns = useColumns(meter);
  return (
    <section className="budget" aria-labelledby="budget-h">
      <Heading id="budget-h">Budget</Heading>
      <div className="label">Remaining</div>
      <div className="display" aria-label={`${money.fmt(remaining)} of ${money.fmt(cap)} ${money.unit} remaining`}>
        <span aria-hidden="true">
          {shown === null || shown === remaining ? money.fmt(remaining) : money.frame(shown)}
          <span className="of"> / {money.fmt(cap)}</span>
        </span>
      </div>
      <div ref={meter} className="meter" role="progressbar" aria-label="Budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(pct))}>
        {budgetBar(completed, outstanding, cap, columns - 2)}
      </div>
      <div className="breakdown">
        # completed {money.fmt(completed)} | = outstanding {money.fmt(outstanding)} <span className="dim">{money.unit}</span>
      </div>
      {money.note && <div className="unit-note dim small">{money.note}</div>}
    </section>
  );
}

export function CrewPanel({
  delegates,
  personaOf,
  roleOf,
  isOwner,
  busy,
  revoking,
  onRevoke,
}: {
  delegates: Delegate[];
  personaOf: (accountId: string) => string;
  roleOf: (accountId: string) => string | null;
  isOwner: boolean;
  busy: boolean;
  revoking: ReadonlySet<string>;
  onRevoke: (d: Delegate) => void;
}) {
  return (
    <section className="crew" aria-labelledby="crew-h">
      <Heading id="crew-h">
        Crew <span className="dim">(delegates)</span>
      </Heading>
      {delegates.length === 0 && <p className="dim">{isOwner ? "No delegates on this task. Add one in Owner tools below." : "No delegates on this task yet. The task owner adds them."}</p>}
      <ul className="chips">
        {delegates.map((d) => {
          const pending = revoking.has(d.account_id) && d.active;
          const status = pending ? "REVOKING…" : d.active ? "ACTIVE" : "REVOKED";
          return (
            <li key={d.account_id} className={`chip ${d.active ? "" : "revoked"}`}>
              <span className={`dot ${d.active ? "active" : "hollow"}`} aria-hidden="true" />
              <span className="chip-name">
                {personaOf(d.account_id)}
                {roleOf(d.account_id) && <span className="chip-role dim small"> {roleOf(d.account_id)}</span>}
              </span>
              <span className="dim chip-id">{d.account_id}</span>
              <span className="chip-status tone-dim">{status}</span>
              {isOwner && d.active && (
                <button type="button" className="btn btn-danger" disabled={busy || pending} onClick={() => onRevoke(d)} aria-label={`Revoke ${personaOf(d.account_id)} (${d.account_id})`}>
                  Revoke
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {!isOwner && <p className="dim small">Connect the task owner's wallet to revoke. NEAR CLI signs in your terminal, so the key stays in your OS keychain.</p>}
    </section>
  );
}

interface Row {
  key: string;
  amount: string;
  who: string;
  to: string;
  badge: ReturnType<typeof refusalBadge>;
  tx: { href: string; label: string } | null;
  linking: boolean;
  at: string;
  reported: boolean;
  fresh: boolean;
}

/** Holds, Payments, Refused (+ Released when present). Chain rows are authoritative; record rows are labelled. */
export function Manifest({ commitments, records, personaOf, delegateIds, now, money = nearDisplay }: { commitments: Commitment[]; records: ProposalRecord[]; personaOf: (a: string) => string; delegateIds: ReadonlySet<string>; now: number; money?: AmountDisplay }) {
  // Records are untrusted: keep only those from accounts that are on-chain delegates of this task.
  const trusted = records.filter((r) => delegateIds.has(r.account_id));
  // A tx link attaches to a chain row only from a record that matches that commitment exactly
  // (same request, delegate, amount, recipient), so a self-asserted record cannot dress up a real row.
  const txFor = (c: Commitment): string | null =>
    trusted.find(
      (r) =>
        r.commitment_id === c.id &&
        r.tx_hash !== null &&
        r.request_id === c.request_id &&
        r.account_id === c.delegate &&
        r.amount_yocto === c.reserved_amount &&
        r.recipient === c.intent.recipient,
    )?.tx_hash ?? null;
  const fresh = useFreshKeys([...commitments.map((c) => `c${c.id}:${c.state}`), ...trusted.map((r) => `r${r.decision_id}`)]);
  const isFresh = (key: string) => fresh.has(key);

  const chainRow = (c: Commitment): Row => {
    const tx = txFor(c);
    const ageMs = now - Number(BigInt(c.updated_at) / 1_000_000n);
    const key = `c${c.id}:${c.state}`;
    return {
      key,
      amount: money.fmt(c.reserved_amount),
      who: personaOf(c.delegate),
      to: safeText(c.intent.recipient, 64),
      badge: stateBadge[c.state],
      tx: tx ? { href: explorer.tx(tx), label: shortHash(tx) } : null,
      linking: !tx && ageMs < 60_000,
      at: formatTime(c.updated_at),
      reported: false,
      fresh: isFresh(key),
    };
  };
  const groups = { holds: [] as Row[], payments: [] as Row[], released: [] as Row[] };
  for (const c of [...commitments].sort((a, b) => b.id - a.id)) groups[groupOf(c.state)].push(chainRow(c));

  const refused: Row[] = trusted
    .filter((r) => r.outcome === "refused" || r.outcome === "rejected_by_protocol")
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 30)
    .map((r) => {
      const key = `r${r.decision_id}`; // one row per decision: a re-run reusing a request_id is a new row
      return {
        key,
        amount: r.amount_yocto ? money.fmt(r.amount_yocto) : "n/a",
        who: personaOf(r.account_id),
        to: safeText(r.recipient, 64),
        badge: refusalBadge(r.refusal_code),
        tx: r.tx_hash ? { href: explorer.tx(r.tx_hash), label: shortHash(r.tx_hash) } : null,
        linking: false,
        at: new Date(r.at).toLocaleTimeString("en-GB", { hour12: false }),
        reported: true,
        fresh: isFresh(key),
      };
    });

  const section = (id: string, title: string, rows: Row[], empty: string, note?: string) => (
    <div className="mgroup">
      <h3 id={id} className="label">
        {title} <span className="count">{rows.length}</span>
      </h3>
      {rows.length > 0 && note && <p className="mgroup-note dim small">{note}</p>}
      {rows.length === 0 ? (
        <p className="dim small">{empty}</p>
      ) : (
        <ul aria-labelledby={id}>
          {rows.map((r) => (
            <li key={r.key} className={`mrow ${r.fresh ? "fresh" : ""} ${r.badge.tone === "warn" && r.fresh ? "flash" : ""}`}>
              <span className="amt">{r.amount}</span>
              <span className="who">
                {r.who} <span aria-hidden="true">-&gt;</span>
                <span className="sr-only">to</span> {r.to}
              </span>
              <span className="mbadge">
                <Badge badge={r.badge} />
              </span>
              <span className="mtx">
                {r.tx ? (
                  <a href={r.tx.href} target="_blank" rel="noopener noreferrer">
                    tx {r.tx.label} <span aria-hidden="true">-&gt;</span>
                    <span className="sr-only"> (hash reported by proposer)</span>
                  </a>
                ) : r.linking ? (
                  <span className="dim">linking…</span>
                ) : (
                  <span className="dim small">no tx record</span>
                )}
              </span>
              <span className="dim mtime">
                {r.at}
                {r.reported && <span className="reported">reported by proposer</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <section className="band band-light section" aria-labelledby="manifest-h">
      <Heading id="manifest-h">Manifest</Heading>
      {section("holds-h", "Holds (pending)", groups.holds, "No holds: nothing awaiting proof.", "Reserved budget stays held until there is proof of the outcome.")}
      {section("pay-h", "Payments (completed)", groups.payments, "No completed payments yet.")}
      {section("ref-h", "Refused", refused, "No refusals recorded.")}
      {groups.released.length > 0 && section("rel-h", "Released (failed / cancelled)", groups.released, "", "These reservations were released back to the budget.")}
      {[...groups.holds, ...groups.payments, ...refused, ...groups.released].some((r) => r.tx) && <p className="manifest-note dim small">Transaction hashes come from the proposer's records. Open one to verify it on the explorer.</p>}
    </section>
  );
}

export function InvariantLine({ health, completed, outstanding, cap, money = nearDisplay }: { health: LineHealth; completed: bigint | null; outstanding: bigint | null; cap: bigint | null; money?: AmountDisplay }) {
  const read = completed !== null && outstanding !== null && cap !== null;
  const used = read ? completed + outstanding : 0n;
  const pct = read && cap > 0n ? Number((used * 100n) / cap) : 0;
  const spoken = health.tone === "dim" || !read ? "invariant state unavailable" : `${health.label.toLowerCase()}: ${money.fmt(used)} of ${money.fmt(cap)} ${money.unit} used (${pct} percent)`;
  return (
    <div className={`invariant tone-${health.tone}`} role="status" aria-live="polite">
      <span className="sr-only">{spoken}</span>
      <span className="eq" aria-hidden="true">
        {read ? `completed ${money.fmt(completed)} + outstanding ${money.fmt(outstanding)} = ${money.fmt(used)} <= cap ${money.fmt(cap)}` : "waiting for the contract's first reading"}
      </span>
      {read && (
        <span className="gauge" aria-hidden="true">
          {budgetBar(completed, outstanding, cap, 12)}
        </span>
      )}
      <span className="badge" aria-hidden="true">
        <Icon name={health.icon} /> {health.label}
      </span>
    </div>
  );
}

/** Keys new since the previous commit, cleared after 1.5 s, so a row lands or flashes exactly once. */
// Computed after commit, so StrictMode's double render can't swallow or repeat it.
function useFreshKeys(keys: string[]): ReadonlySet<string> {
  const prev = useRef<Set<string> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const signature = keys.join("|");
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const now = new Set(signature ? signature.split("|") : []);
    const before = prev.current;
    prev.current = now;
    if (before === null) return;
    const added = new Set([...now].filter((k) => !before.has(k)));
    if (added.size === 0) return;
    setFresh(added);
    // Kept in a ref: a later change that only removes rows must not cancel this.
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFresh(new Set()), 1500);
  }, [signature]);
  return fresh;
}

/** Indexer rows. Every API string is a text node; the only href comes from a validated tx hash. */
// A row from a block the board has not reached is labelled ahead of the board, never as settled.
export function CachedHistory({
  rows,
  dropped,
  boardBlock,
  personaOf,
  recordTx,
  offline = false,
  money = nearDisplay,
}: {
  rows: CachedCommitment[];
  dropped: number;
  boardBlock: number | null;
  personaOf: (a: string) => string;
  recordTx: (r: CachedCommitment) => string | null;
  offline?: boolean;
  money?: AmountDisplay;
}) {
  return (
    <section className={`cached-history band band-dark section ${offline ? "offline" : ""}`} aria-labelledby="cache-h">
      <Heading id="cache-h">
        On-chain history <span className="dim">(cached)</span>
      </Heading>
      {offline && rows.length > 0 && <p className="tone-warn small">offline: showing last known</p>}
      {rows.length === 0 ? (
        <p className="dim small">No cached history for this task yet. It appears once the indexer has read this task's events.</p>
      ) : (
        <ul aria-labelledby="cache-h">
          {[...rows]
            .sort((a, b) => Number(b.commitmentId) - Number(a.commitmentId))
            .map((r) => {
              const ahead = boardBlock !== null && r.asOfHeight > boardBlock;
              const fallbackTx = r.txStatus === "resolved" && r.nearTx ? null : recordTx(r);
              const hash = r.txStatus === "resolved" ? r.nearTx : fallbackTx;
              return (
                <li key={`${r.commitmentId}:${r.state}`} className="mrow">
                  <span className="amt">{money.fmt(r.actualSpent ?? r.reservedAmount)}</span>
                  <span className="who">
                    {personaOf(r.delegate)} <span aria-hidden="true">-&gt;</span>
                    <span className="sr-only">to</span> {r.recipient}
                  </span>
                  <span className="mbadge">
                    <span className="dim small">{ahead ? `${r.state} (ahead of board)` : r.state}</span>
                  </span>
                  <span className="mtx">
                    {hash ? (
                      <>
                        <a href={explorer.tx(hash)} target="_blank" rel="noopener noreferrer">
                          tx {shortHash(hash)} <span aria-hidden="true">-&gt;</span>
                        </a>
                        {r.txStatus !== "resolved" && <span className="dim small"> proposer-reported, unverified</span>}
                      </>
                    ) : (
                      <span className="dim small">{r.txStatus === "unavailable" ? "tx unavailable" : r.txStatus === "pending" ? "tx pending" : "tx not indexed"}</span>
                    )}
                  </span>
                  <span className="dim mtime">cached @ block {r.asOfHeight}</span>
                </li>
              );
            })}
        </ul>
      )}
      {dropped > 0 && <p className="dim small">{dropped} invalid cache row{dropped === 1 ? "" : "s"} ignored.</p>}
    </section>
  );
}
