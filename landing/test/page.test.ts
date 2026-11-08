import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RACE_REFUSED, RACE_RESERVED, RACE_SETTLED, capBar, gauge, raceFrame, railFrame, revealFrame, scrambleFrame } from "../src/ascii.ts";
import { cellLuminance, charFor } from "../src/ascii-scene.ts";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const html = read("index.html");
const css = read("src/styles.css");
const prose = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");

describe("page content", () => {
  it("uses no em dashes in the page or its source", () => {
    for (const file of [html, css, read("src/main.ts"), read("src/motion.ts"), read("src/ascii.ts")]) expect(file).not.toContain("—");
  });

  it("is plain ASCII from top to bottom", () => {
    expect(html).toMatch(/^[\x00-\x7f]*$/);
    expect(css).toMatch(/^[\x00-\x7f]*$/);
  });

  it("points every in-page link at a section that exists", () => {
    for (const [, id] of html.matchAll(/href="#([^"]+)"/g)) expect(html, id).toContain(`id="${id}"`);
  });

  it("links out only over https and opens new tabs safely", () => {
    for (const [tag] of html.matchAll(/<a [^>]*href="http[^>]*>/g)) {
      expect(tag).toMatch(/href="https:/);
      expect(tag).toContain('rel="noopener noreferrer"');
    }
  });

  it("carries no marketing filler", () => {
    expect(prose).not.toMatch(/\b(seamless|revolutionary|cutting[- ]edge|next[- ]generation|effortless|powerful|get started|learn more|trusted by)\b/i);
  });

  it("states that the metrics are sandbox figures and the page is testnet only", () => {
    expect(prose).toMatch(/local nearcore sandbox/);
    expect(prose).toMatch(/NEAR testnet only/);
  });

  it("keeps real tx references whole", () => {
    for (const [, hash] of html.matchAll(/nearblocks\.io\/txns\/([^"]+)"/g)) expect(hash!.length).toBeGreaterThanOrEqual(43);
  });
});

describe("stylesheet", () => {
  it("never removes the focus outline", () => {
    expect(css).not.toMatch(/outline:\s*(none|0)/);
  });

  it("sets the whole page in monospace, with square corners", () => {
    expect(css).not.toContain("--font-ui");
    expect(read("src/main.ts")).not.toContain("ibm-plex-sans");
    expect(css).not.toMatch(/border-radius/);
  });

  it("opens every section with the rule mark", () => {
    const headings = html.match(/<h2 /g)!.length;
    expect(html.match(/class="rule-mark"/g)).toHaveLength(headings + 1);
  });

  it("frosts only the invariant bar", () => {
    const blocks = css.match(/[^{}]+\{[^{}]*[^-]backdrop-filter:\s*blur[^{}]*\}/g) ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain(".invariant-bar");
  });

  it("offers a solid bar when transparency is reduced", () => {
    expect(css).toMatch(/prefers-reduced-transparency: reduce\)\s*\{\s*\.invariant-bar/);
  });
});

describe("hero", () => {
  it("carries none of the source component's placeholder text", () => {
    expect(prose).not.toMatch(/UIMIX|ENDLESS PURSUIT|SISYPHUS|SYSTEM\.ACTIVE|RENDERING|LAT:|LONG:|EST\. 2025|V1\.0\.0/);
  });

  it("loads no third-party scene or script", () => {
    for (const file of [html, css, read("src/main.ts"), read("src/motion.ts")]) expect(file).not.toMatch(/unicorn|jsdelivr|data-us-project|dotlottie/i);
    expect(html).not.toMatch(/<script[^>]+src="http/);
  });
});

describe("ascii scene", () => {
  it("orders the ramp from empty to dense", () => {
    expect(charFor(0)).toBe(" ");
    expect(charFor(1)).toBe("@");
    expect(charFor(2)).toBe("@");
    expect(charFor(-1)).toBe(" ");
  });

  it("draws the mark brighter than the empty field at every sampled time", () => {
    for (const t of [0, 1.5, 7, 40]) {
      for (const [col, row] of [[10, 10], [60, 20], [120, 40]] as const) {
        expect(cellLuminance(1, col, row, t)).toBeGreaterThan(cellLuminance(0, col, row, t));
      }
    }
  });

  it("leaves most of the empty field dark", () => {
    let blank = 0;
    for (let col = 0; col < 100; col++) for (let row = 0; row < 40; row++) if (charFor(cellLuminance(0, col, row, 3)) === " ") blank++;
    expect(blank / 4000).toBeGreaterThan(0.6);
  });
});

describe("ascii frames", () => {
  const texts = (p: number, cols = 50) => raceFrame(p, cols).map((row) => row.text);

  it("starts the race at 40 left with nothing decided", () => {
    const frame = texts(0).join("\n");
    expect(frame).toMatch(/\] 40$/m);
    expect(frame).not.toMatch(/REFUSED|PAID/);
  });

  it("reserves before anyone is refused, then settles", () => {
    expect(RACE_RESERVED).toBeLessThan(RACE_REFUSED);
    expect(RACE_REFUSED).toBeLessThan(RACE_SETTLED);
    expect(texts(RACE_RESERVED + 0.02).join("\n")).toMatch(/RESERVED/);
  });

  it("ends with one paid, two refused and 10 left", () => {
    const rows = raceFrame(1, 50);
    expect(rows[1]).toMatchObject({ tone: "ok" });
    expect(rows[1]!.text).toContain("PAID 30");
    expect(rows[3]).toMatchObject({ tone: "warn" });
    expect(rows[5]!.text).toContain("REFUSED");
    expect(rows[7]!.text).toMatch(/\] 10$/);
  });

  it("fits the stage at every width and moment", () => {
    for (const cols of [30, 44, 64, 72]) {
      for (const p of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
        for (const line of texts(p, cols)) expect(line.length, `${cols}@${p}: ${line}`).toBeLessThanOrEqual(cols + 3);
      }
    }
  });

  it("runs the overspend past the cap marker", () => {
    const bar = capBar(120, 100, 120, 40);
    expect(bar.indexOf("|")).toBeGreaterThan(0);
    expect(bar.slice(bar.indexOf("|") + 1, bar.indexOf("]"))).toMatch(/^#+$/);
    expect(bar).toMatch(/120\/100$/);
  });

  it("draws gauges and rails to size", () => {
    expect(gauge(90, 100, 10)).toBe("[#########.]");
    expect(railFrame(0.5, 4)).toBe("#\n#\n:\n:");
  });

  it("holds a diagram's layout while it reveals", () => {
    const source = "ab\ncd";
    expect(revealFrame(source, 0)).toBe("  \n  ");
    expect(revealFrame(source, 1)).toBe(source);
  });

  it("decodes headings to the exact text, keeping their shape", () => {
    expect(scrambleFrame("Why NEAR", 1)).toBe("Why NEAR");
    const mid = scrambleFrame("Why NEAR", 0.4);
    expect(mid).toHaveLength(8);
    expect(mid[3]).toBe(" ");
  });
});
