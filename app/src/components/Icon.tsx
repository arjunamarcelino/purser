// Status marks in text, the same voice as the landing page's [OK]. Decorative: every use sits next to words.

import type { IconName } from "../lib/semantics.ts";

const MARKS: Record<IconName, string> = {
  check: "[OK]",
  clock: "[..]",
  slash: "[NO]",
  alert: "[!!]",
  minus: "[--]",
};

export function Icon({ name }: { name: IconName }) {
  return (
    <span className="status-mark" aria-hidden="true">
      {MARKS[name]}
    </span>
  );
}
