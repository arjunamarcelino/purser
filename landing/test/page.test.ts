import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RACE_FRAMES, buildRaceAnimation } from "../src/race-lottie.ts";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const html = read("index.html");
const css = read("src/styles.css");
const prose = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");

describe("page content", () => {
  it("uses no em dashes in the page or its source", () => {
    for (const file of [html, css, read("src/main.ts"), read("src/motion.ts"), read("src/race-lottie.ts")]) expect(file).not.toContain("—");
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

  it("frosts only the invariant bar", () => {
    const blocks = css.match(/[^{}]+\{[^{}]*[^-]backdrop-filter:\s*blur[^{}]*\}/g) ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain(".invariant-bar");
  });

  it("offers a solid bar when transparency is reduced", () => {
    expect(css).toMatch(/prefers-reduced-transparency: reduce\)\s*\{\s*\.invariant-bar/);
  });
});

describe("race animation", () => {
  const scene = buildRaceAnimation({ track: "#5f7090", gate: "#e8eef7", agent: "#9fb0c8", admitted: "#3fb68b", refused: "#f08a24" });

  it("is a bounded, non-empty Lottie scene", () => {
    expect(scene.op).toBe(RACE_FRAMES);
    expect(scene.layers.length).toBeGreaterThanOrEqual(9);
    expect(JSON.parse(JSON.stringify(scene)).w).toBe(640);
  });

  it("keeps every keyframe inside the scene", () => {
    for (const t of JSON.stringify(scene).matchAll(/"t":(\d+)/g)) expect(Number(t[1])).toBeLessThan(RACE_FRAMES);
  });

  it("stops two agents and passes one through the gate", () => {
    const position = (name: string) => (scene.layers.find((l) => l.nm === name)!.ks as { p: { k: { s: number[] }[] } }).p.k.at(-1)!.s[0]!;
    expect(position("agent-150")).toBeGreaterThan(420);
    expect(position("agent-70")).toBeLessThan(420);
    expect(position("agent-230")).toBeLessThan(420);
  });
});
