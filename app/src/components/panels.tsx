import { useEffect, useRef, useState } from "react";
import type { Commitment, Delegate, ProposalRecord } from "@purser/types";
import { explorer } from "../config.ts";
import { formatNear, formatTime, safeText, shortHash } from "../lib/format.ts";
import { type LineHealth, groupOf, refusalBadge, stateBadge } from "../lib/semantics.ts";
import { useReducedMotion } from "../theme.ts";
import { Badge } from "./Badge.tsx";
import { Icon } from "./Icon.tsx";

/**
 * The Remaining numeral. Counts from the value currently on screen to the new one (≤300 ms, one rAF
 * loop, cancelled on change/unmount); the last frame is the exact string. Snaps (no count) on the
 * first value, on a task switch, and under prefers-reduced-motion.
 */
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

export function BudgetPanel({ task, cap, completed, outstanding, remaining }: { task: string; cap: bigint; completed: bigint; outstanding: bigint; remaining: bigint }) {
  const shown = useCountTo(remaining, task);
  const pct = cap > 0n ? Number(((completed + outstanding) * 1000n) / cap) / 10 : 0;
  return (
    <section className="panel budget" aria-labelledby="budget-h">
      <h2 id="budget-h" className="label">
        <Icon name="coins" /> Budget
      </h2>
      <div className="label">Remaining</div>
      <div className="display mono" aria-label={`${formatNear(remaining)} of ${formatNear(cap)} NEAR remaining`}>
        <span aria-hidden="true">
          {formatNear(shown ?? remaining)}
          <span className="of"> / {formatNear(cap)}</span>
        </span>
      </div>
      <div className="meter" role="progressbar" aria-label="Budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <div className="meter-fill" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="breakdown mono">
        completed {formatNear(completed)} · outstanding {formatNear(outstanding)} <span className="dim">NEAR</span>
      </div>
    </section>
  );
}

export function CrewPanel({
  delegates,
  personaOf,
  isOwner,
  busy,
  revoking,
  onRevoke,
}: {
  delegates: Delegate[];
  personaOf: (accountId: string) => string;
  isOwner: boolean;
  busy: boolean;
  revoking: ReadonlySet<string>;
  onRevoke: (d: Delegate) => void;
}) {
  return (
    <section className="panel crew" aria-labelledby="crew-h">
      <h2 id="crew-h" className="label">
        <Icon name="key" /> Crew <span className="dim">(delegates)</span>
      </h2>
      {delegates.length === 0 && <p className="dim">No delegates on this task.</p>}
      <ul className="chips">
        {delegates.map((d) => {
          const pending = revoking.has(d.account_id) && d.active;
          const status = pending ? "REVOKING…" : d.active ? "ACTIVE" : "REVOKED";
          return (
            <li key={d.account_id} className={`chip ${d.active ? "" : "revoked"}`}>
              <span className={`dot ${d.active ? "active" : "hollow"}`} aria-hidden="true" />
              <span className="chip-name">{personaOf(d.account_id)}</span>
              <span className="mono dim chip-id">{d.account_id}</span>
              <span className={`chip-status ${d.active ? "tone-brass" : "tone-dim"}`}>{status}</span>
              {isOwner && d.active && (
                <button type="button" className="btn btn-danger" disabled={busy || pending} onClick={() => onRevoke(d)} aria-label={`Revoke ${personaOf(d.account_id)} (${d.account_id})`}>
                  Revoke
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {!isOwner && <p className="dim small">Connect the task owner's wallet to revoke.</p>}
    </section>
  );
}

interface Row {
  key: string;
  amount: string;
  who: string;
  to: string;
  badge: ReturnType<typeof refusalBadge>;
  tx: { href: string; label: string; reported: boolean } | null;
  linking: boolean;
  at: string;
  reported: boolean;
  fresh: boolean;
}

/** Holds, Payments, Refused (+ Released when present). Chain rows are authoritative; record rows are labelled. */
export function Manifest({ commitments, records, personaOf, delegateIds, now }: { commitments: Commitment[]; records: ProposalRecord[]; personaOf: (a: string) => string; delegateIds: ReadonlySet<string>; now: number }) {
  // Records are untrusted: keep only those from accounts that are on-chain delegates of this task.
  const trusted = records.filter((r) => delegateIds.has(r.account_id));
  const txByCid = new Map(trusted.filter((r) => r.commitment_id !== null && r.tx_hash).map((r) => [r.commitment_id!, r.tx_hash!]));
  const fresh = useFreshKeys([...commitments.map((c) => `c${c.id}:${c.state}`), ...trusted.map((r) => `r${r.request_id ?? r.decision_id}`)]);
  const isFresh = (key: string) => fresh.has(key);

  const chainRow = (c: Commitment): Row => {
    const tx = txByCid.get(c.id);
    const ageMs = now - Number(BigInt(c.updated_at) / 1_000_000n);
    const key = `c${c.id}:${c.state}`;
    return {
      key,
      amount: formatNear(c.reserved_amount),
      who: personaOf(c.delegate),
      to: safeText(c.intent.recipient, 64),
      badge: stateBadge[c.state],
      tx: tx ? { href: explorer.tx(tx), label: shortHash(tx), reported: true } : null,
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
      const key = `r${r.request_id ?? r.decision_id}`;
      return {
        key,
        amount: r.amount_yocto ? formatNear(r.amount_yocto) : "—",
        who: personaOf(r.account_id),
        to: safeText(r.recipient, 64),
        badge: refusalBadge(r.refusal_code),
        tx: r.tx_hash ? { href: explorer.tx(r.tx_hash), label: shortHash(r.tx_hash), reported: true } : null,
        linking: false,
        at: new Date(r.at).toLocaleTimeString("en-GB", { hour12: false }),
        reported: true,
        fresh: isFresh(key),
      };
    });

  const section = (id: string, title: string, rows: Row[], empty: string) => (
    <div className="mgroup">
      <h3 id={id} className="label">
        {title} <span className="count">{rows.length}</span>
      </h3>
      {rows.length === 0 ? (
        <p className="dim small">{empty}</p>
      ) : (
        <ul aria-labelledby={id}>
          {rows.map((r) => (
            <li key={r.key} className={`mrow ${r.fresh ? "fresh" : ""} ${r.badge.tone === "warn" && r.fresh ? "flash" : ""}`}>
              <span className="mono amt">{r.amount}</span>
              <span className="who">
                {r.who} <span aria-hidden="true">→</span>
                <span className="sr-only">to</span> <span className="mono">{r.to}</span>
              </span>
              <span className="mbadge">
                <span className="mbadge-inner">
                  <Badge badge={r.badge} />
                </span>
              </span>
              <span className="mtx">
                {r.tx ? (
                  <a href={r.tx.href} target="_blank" rel="noopener noreferrer" className="mono">
                    <Icon name="link" size={14} /> tx {r.tx.label}
                  </a>
                ) : r.linking ? (
                  <span className="dim">linking…</span>
                ) : (
                  <span className="dim small">no tx record</span>
                )}
              </span>
              <span className="mono dim mtime">
                {r.at}
                {r.reported && <span className="reported"> · reported by proposer</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <section className="panel manifest" aria-labelledby="manifest-h">
      <h2 id="manifest-h" className="label">
        Manifest
      </h2>
      {section("holds-h", "Holds (pending)", groups.holds, "No holds — nothing awaiting proof.")}
      {section("pay-h", "Payments (completed)", groups.payments, "No completed payments yet.")}
      {section("ref-h", "Refused", refused, "No refusals recorded.")}
      {groups.released.length > 0 && section("rel-h", "Released (failed / cancelled)", groups.released, "")}
    </section>
  );
}

export function InvariantLine({ health, completed, outstanding, cap }: { health: LineHealth; completed: bigint; outstanding: bigint; cap: bigint }) {
  const used = completed + outstanding;
  const pct = cap > 0n ? Number((used * 100n) / cap) : 0;
  const spoken = health.tone === "dim" ? "invariant state unavailable" : `${health.label.toLowerCase()}: ${formatNear(used)} of ${formatNear(cap)} NEAR used (${pct} percent)`;
  return (
    <div className={`invariant tone-${health.tone}`} role="status" aria-live="polite" aria-label={spoken}>
      <span className="mono eq" aria-hidden="true">
        completed {formatNear(completed)} + outstanding {formatNear(outstanding)} = {formatNear(used)} ≤ cap {formatNear(cap)}
      </span>
      <span className="health" aria-hidden="true">
        <Icon name={health.icon} /> {health.label}
      </span>
    </div>
  );
}

/**
 * Keys that appeared since the previous commit (never on the first load), cleared after 1.5 s:
 * a row "lands" or flashes once, and re-renders don't re-flash it. Computed after commit, so
 * StrictMode's double render can't swallow or repeat it.
 */
function useFreshKeys(keys: string[]): ReadonlySet<string> {
  const prev = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const signature = keys.join("|");
  useEffect(() => {
    const now = new Set(signature ? signature.split("|") : []);
    const before = prev.current;
    prev.current = now;
    if (before === null) return;
    const added = new Set([...now].filter((k) => !before.has(k)));
    if (added.size === 0) return;
    setFresh(added);
    const t = setTimeout(() => setFresh(new Set()), 1500);
    return () => clearTimeout(t);
  }, [signature]);
  return fresh;
}
