// Pure text frames for every ASCII visual on the page, so each one is testable without a browser.

const NOISE = "#%*+=-:.";
const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

export function scrambleFrame(text: string, p: number): string {
  const tick = Math.floor(p * 40);
  return [...text].map((ch, i) => (ch === " " || i / text.length < p ? ch : NOISE[(i * 7 + tick) % NOISE.length]!)).join("");
}

// Unrevealed cells become spaces, so a diagram holds its exact layout while it draws in.
export function revealFrame(source: string, p: number): string {
  const cutoff = Math.floor(clamp(p) * source.length);
  return [...source].map((ch, i) => (ch === "\n" || i < cutoff ? ch : " ")).join("");
}

export function gauge(value: number, cap: number, cells: number): string {
  const filled = Math.round(clamp(value / cap) * cells);
  return `[${"#".repeat(filled)}${".".repeat(cells - filled)}]`;
}

// The cap sits inside the bar, so spending past it visibly runs over the marker.
export function capBar(spent: number, cap: number, max: number, cols: number): string {
  const tail = ` ${Math.round(spent)}/${cap}`;
  const cells = Math.max(10, cols - 2 - ` ${max}/${cap}`.length);
  const mark = Math.round((cap / max) * cells);
  const filled = Math.round(clamp(spent / max) * cells);
  const inner = Array.from({ length: cells }, (_, i) => (i === mark ? "|" : i < filled ? "#" : ".")).join("");
  return `[${inner}]${tail}`;
}

export function railFrame(p: number, lines: number): string {
  const done = Math.round(clamp(p) * lines);
  return Array.from({ length: lines }, (_, i) => (i < done ? "#" : ":")).join("\n");
}

export interface StageRow {
  text: string;
  tone: "plain" | "ok" | "warn";
}

// One frame of the demo's race. Thresholds match the pinned timeline in motion.ts.
export const RACE_RESERVED = 0.38;
export const RACE_REFUSED = 0.62;
export const RACE_SETTLED = 0.72;

export function raceFrame(p: number, cols: number): StageRow[] {
  const width = Math.max(30, Math.min(72, cols));
  const gutter = 2;
  const track = width - gutter;
  const gate = Math.floor(track * 0.6);
  const along = (from: number, to: number, start: number, end: number) => Math.round(from + (to - from) * clamp((p - start) / (end - start)));

  const lane = (name: string, position: number, mark: string, label: string) => {
    const cells: string[] = Array.from({ length: track }, (_, i) => (i === gate ? "#" : i < position ? "=" : i < gate ? "-" : " "));
    if (label) {
      [...` ${label} `].forEach((ch, i) => {
        cells[gate + 1 + i] = ch;
      });
    }
    cells[position] = mark;
    return `${name} ${cells.join("")}`;
  };

  const first = p < 0.5 ? along(0, gate - 1, 0, 0.34) : along(gate - 1, track - 1, 0.5, RACE_SETTLED);
  const firstLabel = p >= RACE_SETTLED ? "PAID 30" : p >= RACE_RESERVED && p < 0.5 ? "RESERVED" : "";
  const refused = p >= RACE_REFUSED;
  const post = `${" ".repeat(gutter + gate)}#`;
  const left = p < RACE_RESERVED ? 40 : 10;
  const held = p >= RACE_RESERVED && p < RACE_SETTLED ? 30 : 0;
  const cells = width - 12;
  const count = (v: number) => Math.round((v / 100) * cells);
  const bar = "#".repeat(count(left)) + "=".repeat(count(held));

  return [
    { text: `${" ".repeat(Math.max(0, gutter + gate - 3))}CONTRACT`, tone: "plain" },
    { text: lane("A", first, "o", firstLabel), tone: p >= RACE_SETTLED ? "ok" : "plain" },
    { text: post, tone: "plain" },
    { text: lane("B", along(0, gate - 1, 0.02, 0.36), refused ? "x" : "o", refused ? "REFUSED" : ""), tone: refused ? "warn" : "plain" },
    { text: post, tone: "plain" },
    { text: lane("C", along(0, gate - 1, 0.04, 0.38), refused ? "x" : "o", refused ? "REFUSED" : ""), tone: refused ? "warn" : "plain" },
    { text: "", tone: "plain" },
    { text: `LEFT [${bar.padEnd(cells, ".")}] ${left}`, tone: "plain" },
  ];
}
