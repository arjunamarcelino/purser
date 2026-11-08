import type { Badge as BadgeSpec } from "../lib/semantics.ts";
import { Icon } from "./Icon.tsx";

/** A state pill: tone + icon + text, with a screen-reader description (never color alone). */
export function Badge({ badge }: { badge: BadgeSpec }) {
  return (
    <span className={`badge tone-${badge.tone}`}>
      <Icon name={badge.icon} size={14} />
      <span aria-hidden="true">{badge.label}</span>
      <span className="sr-only">{badge.description}</span>
    </span>
  );
}
