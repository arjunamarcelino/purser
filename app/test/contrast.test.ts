// AA contrast for every text/background pair and every control border, on both bands, read
// straight from the landing page's theme.css (the board shares it) so the test and the stylesheet cannot drift.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(import.meta.dirname, "../../landing/src/theme.css"), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const bands = { black: block(".band-dark"), white: block(".band-light") };
const TEXT = ["text", "text-dim", "accent", "ok", "warn", "alarm", "link"];
const SURFACES = ["bg", "surface"];

describe.each(Object.entries(bands))("%s band", (_name, t) => {
  it.each(TEXT.flatMap((fg) => SURFACES.map((bg) => [fg, bg] as const)))("%s on %s ≥ 4.5:1 (AA text)", (fg, bg) => {
    expect(ratio(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SURFACES)("control border on %s ≥ 3:1 (AA non-text)", (bg) => {
    expect(ratio(t["border-strong"]!, t[bg]!)).toBeGreaterThanOrEqual(3);
  });

  it("text on inverted hover states (--bg on --text, --warn, --link) ≥ 4.5:1", () => {
    for (const fill of ["text", "warn", "link"]) expect(ratio(t.bg!, t[fill]!)).toBeGreaterThanOrEqual(4.5);
  });

  it("baseline banner text (--bg on --alarm) ≥ 4.5:1", () => {
    expect(ratio(t.bg!, t.alarm!)).toBeGreaterThanOrEqual(4.5);
  });
});
