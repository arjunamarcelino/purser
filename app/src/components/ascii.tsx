// The landing page's ASCII pieces, for a page React owns: live data moves the layout, so nothing here is tied to scroll position.

import gsap from "gsap";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { initAsciiArt } from "../../../landing/src/ascii-scene.ts";
import { dissolveFrame, scrambleFrame } from "../../../landing/src/ascii.ts";
import { useReducedMotion } from "../lib/useReducedMotion.ts";

/** A text bar: # completed, = held, . still free. Any nonzero amount shows at least one cell. */
export function budgetBar(completed: bigint, outstanding: bigint, cap: bigint, cells: number): string {
  const share = (v: bigint) => (cap > 0n && v > 0n ? Math.max(1, Number((v * BigInt(cells)) / cap)) : 0);
  const done = Math.min(cells, share(completed));
  const held = Math.min(cells - done, share(outstanding));
  return `[${"#".repeat(done)}${"=".repeat(held)}${".".repeat(cells - done - held)}]`;
}

/** How many whole characters fit across an element, kept current as it resizes. */
export function useColumns(ref: RefObject<HTMLElement | null>, fallback = 40): number {
  const [columns, setColumns] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const probe = document.createElement("canvas").getContext("2d")!;
    const measure = () => {
      const css = getComputedStyle(el);
      probe.font = css.font;
      const inner = el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
      setColumns(Math.max(12, Math.floor(inner / probe.measureText("0").width)));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // The font swap changes character width without resizing the element.
    void document.fonts.ready.then(measure);
    return () => observer.disconnect();
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
  const original = el.textContent ?? "";
  const css = getComputedStyle(el);
  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.className = "decode-layer";
  Object.assign(layer.style, { font: css.font, letterSpacing: css.letterSpacing, textTransform: css.textTransform, left: `${el.offsetLeft}px`, top: `${el.offsetTop}px`, width: `${el.offsetWidth}px` });
  el.after(layer);
  el.classList.add("decoding");
  const state = { p: 0 };
  const finish = () => {
    tween.kill();
    layer.remove();
    el.classList.remove("decoding");
  };
  const tween = gsap.to(state, {
    p: 1,
    duration: 0.7,
    ease: "none",
    onUpdate: () => {
      layer.textContent = scrambleFrame(original, state.p);
    },
    onComplete: finish,
  });
  return finish;
}

/** A section title under the landing page's rule mark. Decodes once, the first time it comes into view. */
export function Heading({ id, children }: { id: string; children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el || reduced || typeof IntersectionObserver === "undefined") return;
    let stop = () => {};
    const seen = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      seen.disconnect();
      stop = decode(el);
    });
    seen.observe(el);
    return () => {
      seen.disconnect();
      stop();
    };
  }, [reduced]);
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

/** The landing page's 3D anchor: sways by itself, follows the pointer, spins when dragged, and stops off screen. */
export function AnchorArt() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || typeof IntersectionObserver === "undefined") return;
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
