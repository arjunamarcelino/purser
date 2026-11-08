import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RACE_REFUSED, RACE_RESERVED, RACE_SETTLED, budgetChart, capBar, dissolveFrame, gauge, raceFrame, raceRemaining, railFrame, revealFrame, scrambleFrame } from "../src/ascii.ts";
import { ART_TUBES, DRAG_GAIN, artScale, buildAnchorMesh, buildMesh, fieldClearance, renderMesh, settleSpin } from "../src/anchor3d.ts";
import { ART_PATHS } from "../src/art3d.ts";
import { TURN_LIMITS, artNames, cellLuminance, charFor } from "../src/ascii-scene.ts";

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

describe("layout", () => {
  it("alternates black and white bands down the page", () => {
    const bands = [...html.matchAll(/<section id="([a-z]+)" class="[^"]*band-(dark|light)/g)].map((m) => m[2]);
    expect(bands).toHaveLength(9);
    bands.forEach((band, i) => expect(band).toBe(i % 2 === 0 ? "dark" : "light"));
  });

  it("has no invented people or quotes", () => {
    expect(prose).not.toMatch(/testimonial|investor|CEO|CTO|"[^"]{20,}"/i);
  });

  it("moves the refusal cards with page scroll, with no manual scroll area", () => {
    const said = css.slice(css.indexOf(".said {"), css.indexOf(".js-said .refuses"));
    expect(said).not.toMatch(/overflow-x|scroll-snap/);
    expect(html).not.toMatch(/class="said"[^>]*tabindex/);
    expect(read("src/motion.ts")).toMatch(/initSaidCards/);
  });

  it("links to the app only when an address exists", () => {
    const links = html.match(/<a [^>]*data-app-link[^>]*>/g)!;
    expect(links).toHaveLength(3);
    for (const link of links) expect(link).toContain("hidden");
    expect(css).toMatch(/\.btn\[hidden\]\s*\{\s*display: none/);
    expect(read("src/main.ts")).toMatch(/import\.meta\.env\.DEV \? "http:\/\/127\.0\.0\.1:5173/);
  });

  it("never writes noise into a real heading", () => {
    expect(read("src/motion.ts")).not.toMatch(/\bel\.textContent = scrambleFrame/);
    expect(read("src/motion.ts")).toMatch(/setAttribute\("aria-hidden", "true"\)/);
  });

  it("stops flexible canvases from growing their own tile", () => {
    expect(css).toMatch(/\.art-tall \{[^}]*contain: size/);
    expect(css).toMatch(/\.art \{[^}]*height: 15rem/);
  });

  it("points every piece of art at a drawing that exists", () => {
    for (const [, name] of html.matchAll(/data-ascii-art="([a-z]+)"/g)) expect(artNames()).toContain(name);
  });
});

describe("palette", () => {
  const theme = read("src/theme.css");
  const tokens = (selector: string) => {
    const start = theme.indexOf(selector);
    const body = theme.slice(theme.indexOf("{", start) + 1, theme.indexOf("}", start));
    return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]));
  };
  const channels = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const luminance = (rgb: number[]) => {
    const [r, g, b] = rgb.map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: number[], b: number[]) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };

  it.each([".band-dark", ".band-light"])("%s: all text passes AA on every surface", (band) => {
    const t = tokens(band);
    for (const fg of [t.text!, t["text-dim"]!, t.link!, t.ok!, t.warn!, t.alarm!]) for (const bg of [t.bg!, t.surface!]) expect(ratio(channels(fg), channels(bg)), `${band} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the glass bar legible over a white band", () => {
    const t = tokens(".band-dark");
    const bar = [0, 1, 2].map(() => 255 * 0.08);
    for (const fg of [t.text!, t["text-dim"]!, t.ok!]) expect(ratio(channels(fg), bar), fg).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps hero text legible over the field's densest cells", () => {
    const scrimOverWhite = [255, 255, 255].map((v) => v * 0.28);
    for (const fg of ["#ffffff", tokens(".band-dark")["text-dim"]!]) expect(ratio(channels(fg), scrimOverWhite), fg).toBeGreaterThanOrEqual(4.5);
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

describe("3d anchor", () => {
  const mesh = buildAnchorMesh();
  const view = { width: 900, height: 640, cols: 100, rows: 40, cellW: 9, cellH: 16, centerX: 450, centerY: 320, shiftX: 0, shiftY: 0, scale: 153, ambient: 0.32 };
  const render = (yaw: number, pitch: number, v = view) => {
    const out = new Float32Array(v.cols * v.rows);
    renderMesh(mesh, yaw, pitch, v, out, new Float32Array(v.cols * v.rows));
    return out;
  };
  const inked = (frame: Float32Array) => frame.filter((v) => v > 0).length;

  it("builds a solid surface with unit normals", () => {
    expect(mesh.count).toBeGreaterThan(5000);
    for (const i of [0, 1000, mesh.count - 1]) {
      expect(Math.hypot(mesh.normals[i * 3]!, mesh.normals[i * 3 + 1]!, mesh.normals[i * 3 + 2]!)).toBeCloseTo(1, 4);
    }
  });

  it("lands on the grid and stays within light limits", () => {
    const frame = render(0.5, -0.1);
    expect(inked(frame)).toBeGreaterThan(150);
    expect(Math.max(...frame)).toBeLessThanOrEqual(1);
  });

  it("coasts after a drag, then settles facing front", () => {
    let state = { spin: 0, velocity: 0.3 };
    state = settleSpin(state.spin, state.velocity);
    expect(state.spin).toBeCloseTo(0.3, 5);
    expect(state.velocity).toBeLessThan(0.3);
    state = { spin: 6.1, velocity: 0 };
    for (let i = 0; i < 400; i++) state = settleSpin(state.spin, state.velocity);
    expect(state.spin).toBeCloseTo(Math.PI * 2, 2);
  });

  it("turns far faster when dragged than when hovered", () => {
    const hoverSweep = TURN_LIMITS.hero.lean * 2;
    expect(DRAG_GAIN * 1400).toBeGreaterThan(hoverSweep * 5);
  });

  it("keeps the background field off the anchor", () => {
    expect(fieldClearance(450, 320, 450, 320, 200)).toBe(0);
    expect(fieldClearance(600, 320, 450, 320, 200)).toBe(0);
    expect(fieldClearance(900, 320, 450, 320, 200)).toBe(1);
    expect(fieldClearance(720, 320, 450, 320, 200)).toBeGreaterThan(0);
    expect(fieldClearance(720, 320, 450, 320, 200)).toBeLessThan(1);
  });

  it("centers on the vertical position it is given", () => {
    const middleRow = (frame: Float32Array) => {
      const rows: number[] = [];
      frame.forEach((v, i) => {
        if (v > 0) rows.push(Math.floor(i / view.cols));
      });
      return (Math.min(...rows) + Math.max(...rows)) / 2;
    };
    expect(Math.abs(middleRow(render(0, 0)) - 20)).toBeLessThanOrEqual(1.5);
    expect(middleRow(render(0, 0, { ...view, centerY: 400 }))).toBeGreaterThan(middleRow(render(0, 0)));
  });

  it("really turns in depth: edge-on covers far less than face-on", () => {
    expect(inked(render(Math.PI / 2 - 0.02, 0))).toBeLessThan(inked(render(0, 0)) * 0.5);
  });

  it("shades the tube rather than filling it flat", () => {
    const values = new Set([...render(0.4, -0.1)].filter((v) => v > 0).map((v) => charFor(v)));
    expect(values.size).toBeGreaterThanOrEqual(4);
  });

  it("leans toward the pointer's side when shifted", () => {
    const left = render(0, 0, { ...view, shiftX: -120 });
    const right = render(0, 0, { ...view, shiftX: 120 });
    const centroid = (frame: Float32Array) => {
      let sum = 0;
      let n = 0;
      frame.forEach((v, i) => {
        if (v > 0) {
          sum += i % view.cols;
          n++;
        }
      });
      return sum / n;
    };
    expect(centroid(right)).toBeGreaterThan(centroid(left));
  });
});

describe("3d section art", () => {
  const view = { width: 300, height: 240, cols: 60, rows: 27, cellW: 5, cellH: 9, centerX: 150, centerY: 120, shiftX: 0, shiftY: 0, scale: artScale(300, 240), ambient: 0.42 };
  const render = (name: string, yaw: number, pitch: number) => {
    const out = new Float32Array(view.cols * view.rows);
    renderMesh(buildMesh(ART_PATHS[name]!, ART_TUBES), yaw, pitch, view, out, new Float32Array(view.cols * view.rows));
    return out;
  };

  it("covers all eight section drawings", () => {
    expect(Object.keys(ART_PATHS).sort()).toEqual(["balance", "callback", "chain", "config", "fingerprint", "hourglass", "key", "vault"]);
  });

  it.each(Object.keys(ART_PATHS))("%s draws clearly and stays inside its frame at every angle", (name) => {
    const mesh = buildMesh(ART_PATHS[name]!, ART_TUBES);
    const views = [view, { ...view, width: 600, cols: 120, centerX: 300, scale: artScale(600, 240) }];
    for (const v of views) {
      for (const yaw of [0, 0.75, -0.75, 1.5]) {
        for (const pitch of [-0.7, 0, 0.7]) {
          const frame = new Float32Array(v.cols * v.rows);
          renderMesh(mesh, yaw, pitch, v, frame, new Float32Array(v.cols * v.rows));
          expect(frame.filter((value) => value > 0).length, `${name} ${yaw} ${pitch}`).toBeGreaterThan(25);
          frame.forEach((value, i) => {
            const col = i % v.cols;
            const row = Math.floor(i / v.cols);
            if (col === 0 || col === v.cols - 1 || row === 0 || row === v.rows - 1) expect(value, `${name} touches the edge at ${col},${row}`).toBe(0);
          });
        }
      }
    }
  });

  it.each(Object.keys(ART_PATHS))("%s changes shape as it turns", (name) => {
    expect([...render(name, 0, 0)]).not.toEqual([...render(name, 0.8, 0)]);
  });

  it("gives the depth drawings real depth, so they stay wide when turned edge-on", () => {
    const wide = (frame: Float32Array) => {
      const cols = new Set<number>();
      frame.forEach((v, i) => v > 0 && cols.add(i % view.cols));
      return cols.size;
    };
    const flat = wide(render("key", Math.PI / 2, 0));
    expect(wide(render("vault", Math.PI / 2, 0))).toBeGreaterThan(flat);
    expect(wide(render("hourglass", Math.PI / 2, 0))).toBeGreaterThan(flat * 2);
  });

  it("keeps every object well short of edge-on unless it is being dragged", () => {
    for (const { sway, lean } of Object.values(TURN_LIMITS)) expect(sway + lean).toBeLessThan(1.15);
  });

  it.each(Object.keys(ART_PATHS))("%s is bold and solid at the angles it actually reaches", (name) => {
    const { sway, lean } = TURN_LIMITS.art;
    for (const yaw of [0, sway + lean, -(sway + lean)]) {
      const frame = render(name, yaw, 0.15);
      const ink = frame.filter((v) => v > 0).length;
      expect(ink / frame.length, `${name} at ${yaw}`).toBeGreaterThan(0.08);
      expect(Math.min(...frame.filter((v) => v > 0)), name).toBeGreaterThanOrEqual(0.41);
    }
  });
});

describe("ascii frames", () => {
  const texts = (p: number, cols = 50) => raceFrame(p, cols).map((row) => row.text);

  it("starts the race at 40 left with nothing decided", () => {
    const frame = texts(0).join("\n");
    expect(frame).toMatch(/\] 40$/m);
    expect(frame).not.toMatch(/REFUSED|PAID/);
  });

  it("reports the budget from progress alone", () => {
    expect(raceRemaining(0)).toBe(40);
    expect(raceRemaining(RACE_RESERVED)).toBe(40);
    expect(raceRemaining(RACE_RESERVED + 0.1)).toBe(10);
    expect(raceRemaining(1)).toBe(10);
    expect(read("src/motion.ts")).toMatch(/onRefresh: \(self\) => show\(self\.progress\)/);
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

  it("charts the run's real balances in order", () => {
    const chart = budgetChart(1, 50);
    for (const label of ["START", "SCOUT", "FORGE", "RACE"]) expect(chart).toContain(label);
    const lines = chart.split("\n");
    const place = (value: string) => {
      const row = lines.findIndex((line) => line.slice(5).includes(` ${value} `));
      return { row, col: row < 0 ? -1 : lines[row]!.indexOf(` ${value} `, 5) };
    };
    const points = ["100", "70", "40", "10"].map(place);
    points.forEach((point, i) => {
      expect(point.row, `label ${i}`).toBeGreaterThanOrEqual(0);
      if (i > 0) {
        expect(point.col).toBeGreaterThan(points[i - 1]!.col);
        expect(point.row).toBeGreaterThan(points[i - 1]!.row);
      }
    });
    expect(budgetChart(0, 50)).not.toMatch(/SCOUT|#/);
  });

  it("fits the chart to its width", () => {
    for (const cols of [36, 60, 90]) for (const line of budgetChart(1, cols).split("\n")) expect(line.length).toBeLessThanOrEqual(cols + 1);
  });

  it("thins a dissolve away from its dense edge", () => {
    const ink = (s: string) => s.replace(/\s/g, "").length;
    const rows = dissolveFrame(200, 6, 1, true).split("\n");
    expect(ink(rows[0]!)).toBeGreaterThan(ink(rows[5]!));
    const up = dissolveFrame(200, 6, 1, false).split("\n");
    expect(ink(up[5]!)).toBeGreaterThan(ink(up[0]!));
    expect(ink(dissolveFrame(200, 6, 0, true))).toBe(0);
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
