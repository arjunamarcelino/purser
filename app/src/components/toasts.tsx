// App-level toast store: outlives the component that raised the toast (e.g. a closed dialog).

import { useSyncExternalStore } from "react";
import { Icon } from "./Icon.tsx";
import type { IconName, Tone } from "../lib/semantics.ts";

export interface Toast {
  id: number;
  tone: Tone;
  icon: IconName;
  title: string;
  detail?: string;
  href?: string;
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function pushToast(t: Omit<Toast, "id">, ttlMs = 9000) {
  const toast = { ...t, id: nextId++ };
  toasts = [...toasts, toast].slice(-4);
  emit();
  setTimeout(() => dismiss(toast.id), ttlMs);
}
export function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function Toasts() {
  const list = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => toasts,
  );
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast tone-${t.tone}`}>
          <Icon name={t.icon} />
          <div>
            <strong>{t.title}</strong>
            {t.detail && <div className="dim">{t.detail}</div>}
            {t.href && (
              <a href={t.href} target="_blank" rel="noopener noreferrer">
                view transaction ↗
              </a>
            )}
          </div>
          <button type="button" className="icon-btn" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
