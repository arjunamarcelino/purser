// Line icons (DESIGN-BRIEF §8): 1.5px stroke, currentColor. Decorative: every use sits next to text.

import type { IconName } from "../lib/semantics.ts";

const PATHS: Record<IconName | "anchor" | "link" | "sun" | "moon", string> = {
  check: "M5 12.5l4.5 4.5L19 7.5",
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
  slash: "M5.6 5.6l12.8 12.8M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
  key: "M15 7a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM12.6 11.4L4 20M7 17l2 2M9 15l2 2",
  alert: "M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  coins: "M8 8a5 2.5 0 1 0 10 0A5 2.5 0 1 0 8 8zM8 8v4c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5V8M3 13c0 1.4 2.2 2.5 5 2.5M3 13v4c0 1.4 2.2 2.5 5 2.5",
  minus: "M6 12h12",
  anchor: "M12 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM12 7v14M5 13a7 7 0 0 0 14 0M8 10h8",
  link: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
};

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
