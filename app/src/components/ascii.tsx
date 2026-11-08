// The shared ASCII pieces, for a page React owns: live data moves the layout, so nothing here is tied to scroll position.

import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { initAsciiArt } from "@purser/ascii/ascii-scene.ts";
import { canvasFont, dissolveFrame, fitColumns, scrambleFrame } from "@purser/ascii/ascii.ts";
import { useReducedMotion } from "../lib/useReducedMotion.ts";

const DECODE_MS = 700;
// Per page load, so switching tasks doesn't scramble headings that have already played.
const decoded = new Set<string>();

/** A text bar: # completed, = held, . still free. Any nonzero amount shows at least one cell, and full means no free cell. */
export function budgetBar(completed: bigint, outstanding: bigint, cap: bigint, cells: number): string {
  const share = (v: bigint) => (cap > 0n && v > 0n ? Math.max(1, Number((v * BigInt(cells)) / cap)) : 0);
  const used = completed + outstanding;
  const usedEnd = used >= cap ? cells : share(used);
  const done = Math.min(cells, share(completed));
  const held = outstanding > 0n ? Math.min(cells - done, Math.max(1, usedEnd - done)) : 0;
  return `[${"#".repeat(done)}${"=".repeat(held)}${".".repeat(cells - done - held)}]`;
}

/** How many whole characters fit across an element, kept current as it resizes. */
export function useColumns(ref: RefObject<HTMLElement | null>, fallback = 40): number {
  const [columns, setColumns] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    const probe = document.createElement("canvas").getContext("2d")!;
    const measure = () => {
      if (!live) return;
      const css = getComputedStyle(el);
      probe.font = canvasFont(css);
      const inner = el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
      setColumns(fitColumns(inner, probe.measureText("0").width, 12));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // The font swap changes character width without resizing the element.
    void document.fonts.ready.then(measure);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [ref]);
  return columns;
}

/** Where a white band meets black: the characters are dense at the black edge and thin out across the white. */
export function Dissolve({ dense }: { dense: "top" | "bottom" }) {
  const ref = useRef<HTMLPreElement>(null);
  const columns = useColumns(ref, 120);
  return (
    <pre ref={ref} className="dissolve band-light" aria-hidden="true">
      {dissolveFrame(columns, 4, 1, dense === "top")}
    </pre>
  );
}

// The noise runs on an aria-hidden copy over the heading, so the heading's real text never changes.
function decode(el: HTMLElement) {
  const css = getComputedStyle(el);
  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.className = "decode-layer";
  layer.append(...[...el.childNodes].map((node) => node.cloneNode(true)));
  Object.assign(layer.style, { fontFamily: css.fontFamily, fontSize: css.fontSize, fontWeight: css.fontWeight, lineHeight: css.lineHeight, letterSpacing: css.letterSpacing, textTransform: css.textTransform, left: `${el.offsetLeft}px`, top: `${el.offsetTop}px`, width: `${el.offsetWidth}px` });
  // Each text node scrambles on its own, so a smaller "(cached)" stays smaller.
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  const originals = nodes.map((node) => node.data);
  const paint = (p: number) =>
    nodes.forEach((node, i) => {
      node.data = scrambleFrame(originals[i]!, p);
    });
  paint(0);
  el.after(layer);
  el.classList.add("decoding");
  let raf = 0;
  const finish = () => {
    cancelAnimationFrame(raf);
    layer.remove();
    el.classList.remove("decoding");
  };
  const start = performance.now();
  const step = (now: number) => {
    const p = Math.min(1, Math.max(0, (now - start) / DECODE_MS));
    paint(p);
    if (p < 1) raf = requestAnimationFrame(step);
    else finish();
  };
  raf = requestAnimationFrame(step);
  return finish;
}

/** A section title under the landing page's rule mark. Decodes once, the first time it comes into view. */
export function Heading({ id, children }: { id: string; children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el || reduced || decoded.has(id) || typeof IntersectionObserver === "undefined") return;
    let stop = () => {};
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      seen.disconnect();
      decoded.add(id);
      stop = decode(el);
    });
    seen.observe(el);
    return () => {
      seen.disconnect();
      stop();
    };
  }, [id, reduced]);
  return (
    <div className="heading">
      <div className="rule-mark" aria-hidden="true">
        <i />
        <span>&lt;=</span>
        <i />
      </div>
      <h2 ref={ref} id={id}>
        {children}
      </h2>
    </div>
  );
}

/** The landing page's 3D anchor: sways by itself, follows the pointer, spins when dragged, and rests when left alone. */
export function AnchorArt() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let live = true;
    let stop: (() => void) | undefined;
    // Waits for the font so the glyph atlas is drawn in IBM Plex Mono from the first frame.
    void document.fonts.ready.then(() => {
      if (live) stop = initAsciiArt(canvas);
    });
    return () => {
      live = false;
      stop?.();
    };
  }, []);
  return <canvas ref={ref} className="art" data-ascii-art="anchor" data-ascii-compact aria-hidden="true" />;
}
