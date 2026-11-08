// Every drawing on the page is a lit 3D object rendered as ASCII: it sways by itself, speeds up on hover, spins when dragged.

import { DRAG_GAIN, type Mesh, anchorScale, artScale, buildMesh, fieldClearance, renderMesh, settleSpin } from "./mesh3d.ts";
import { ART_PATHS, ART_TUBES, buildAnchorMesh } from "./art3d.ts";

export const RAMP = " .:-=+*#%@";

const FRAME_MS = 1000 / 24;
const HELD_FRAME_MS = 1000 / 40;
const FIELD_INK = "rgb(255 255 255 / 0.2)";
const STILL_POSE = { yaw: 0.55, pitch: -0.14 };
const IDLE_RATE = { hero: 0.5, art: 0.3 };
const HOVER_RATE = 1.15;

// How far an object may turn by itself and on hover. Together they stay well short of edge-on (1.57), where shapes vanish.
export const TURN_LIMITS = { hero: { sway: 0.5, lean: 0.6 }, art: { sway: 0.4, lean: 0.45 } };

export const artNames = () => ["anchor", ...Object.keys(ART_PATHS)];

export function cellLuminance(col: number, row: number, t: number): number {
  const wave = (Math.sin(col * 0.09 + t * 0.6) + Math.sin(row * 0.16 - t * 0.45) + Math.sin((col + row) * 0.05 + t * 0.3)) / 6 + 0.5;
  return Math.max(0, wave - 0.62) * 0.9;
}

const glyphIndex = (luminance: number) => Math.round(Math.min(1, Math.max(0, luminance)) * (RAMP.length - 1));
export const charFor = (luminance: number) => RAMP[glyphIndex(luminance)]!;

interface Layout {
  cellW: number;
  cellH: number;
  font: string;
  ambient: number;
  shift: [number, number];
  centerX: (width: number) => number;
  scale: (width: number, height: number) => number;
}

const HERO: Layout = { cellW: 7, cellH: 12, font: "10.5px", ambient: 0.32, shift: [16, 10], centerX: (w) => w * (w < 1024 ? 0.5 : 0.29), scale: anchorScale };
// Bigger cells past 1600px keep the hero's glyph count from growing with the screen.
const HERO_WIDE: Layout = { ...HERO, cellW: 9, cellH: 16, font: "13px" };
const ART: Layout = { cellW: 5, cellH: 9, font: "7.5px", ambient: 0.42, shift: [6, 4], centerX: (w) => w * 0.5, scale: artScale };

// Each glyph is drawn once here, because copying pixels per cell is far cheaper than fillText per cell.
function glyphAtlas(ink: string, layout: Layout, dpr: number): HTMLCanvasElement {
  const atlas = document.createElement("canvas");
  atlas.width = Math.ceil(RAMP.length * layout.cellW * dpr);
  atlas.height = Math.ceil(layout.cellH * dpr);
  const ctx = atlas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.font = `${layout.font} "IBM Plex Mono", monospace`;
  ctx.textBaseline = "top";
  ctx.fillStyle = ink;
  [...RAMP].forEach((glyph, i) => ctx.fillText(glyph, i * layout.cellW, 0));
  return atlas;
}

function meshFor(name: string): Mesh {
  return name === "anchor" ? buildAnchorMesh() : buildMesh(ART_PATHS[name]!, ART_TUBES);
}

// Starts each object at its own point in the sway, so a row of them never moves in unison.
const seedPhase = (name: string) => [...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 7;

export function initAsciiArt(canvas: HTMLCanvasElement) {
  const name = canvas.dataset.asciiArt ?? "";
  const ctx = canvas.getContext("2d");
  if (!artNames().includes(name) || !ctx) return;
  const isHero = name === "anchor";
  let layout = isHero ? HERO : ART;
  const calm = matchMedia("(prefers-reduced-motion: reduce)");
  const root = canvas.closest<HTMLElement>(".hero, .card, .tile") ?? canvas;
  const panel = isHero ? root.querySelector<HTMLElement>(".hero-panel") : null;

  let cols = 0;
  let rows = 0;
  let width = 0;
  let height = 0;
  let centerY = 0;
  let dpr = 1;
  let inkAtlas: HTMLCanvasElement | null = null;
  let fieldAtlas: HTMLCanvasElement | null = null;
  let raf = 0;
  let last = 0;
  let visible = false;
  // Built on the first visible frame, so art further down the page costs nothing at load.
  let mesh: Mesh | null = null;
  let lit: Float32Array = new Float32Array(0);
  let depth: Float32Array = new Float32Array(0);
  let phase = seedPhase(name);
  let clock = 0;
  let hovering = false;
  const pose = { ...STILL_POSE };
  const pointer = { x: 0, y: 0 };
  const drag = { held: false, pointerId: -1, lastX: 0, lastY: 0, lastMove: 0, spin: 0, velocity: 0, tilt: 0 };

  const release = (event: PointerEvent) => {
    if (event.pointerId !== drag.pointerId) return;
    // Holding still before letting go means no fling, however fast the last movement was.
    if (performance.now() - drag.lastMove > 100) drag.velocity = 0;
    drag.held = false;
    drag.pointerId = -1;
    root.classList.remove("is-held");
  };
  // The hero is dragged anywhere outside its text. A card or tile only from its drawing, so its text stays selectable.
  const canGrab = (target: Element) => (isHero ? !target.closest(".hero-panel, .hero-strip, a, button") : target === canvas);

  root.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || drag.held || calm.matches || !canGrab(event.target as Element)) return;
    drag.held = true;
    drag.pointerId = event.pointerId;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    drag.velocity = 0;
    root.setPointerCapture(event.pointerId);
    root.classList.add("is-held");
  });
  root.addEventListener("pointerup", release);
  root.addEventListener("pointercancel", release);
  root.addEventListener("lostpointercapture", release);
  root.addEventListener("pointermove", (event) => {
    if (drag.held) {
      if (event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.lastX;
      const dy = event.clientY - drag.lastY;
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      drag.lastMove = performance.now();
      drag.velocity = dx * DRAG_GAIN;
      drag.spin += drag.velocity;
      drag.tilt = Math.min(0.9, Math.max(-0.9, drag.tilt + dy * DRAG_GAIN * 0.5));
      return;
    }
    if (event.pointerType === "touch") return;
    hovering = true;
    const box = root.getBoundingClientRect();
    pointer.x = ((event.clientX - box.left) / box.width) * 2 - 1;
    pointer.y = ((event.clientY - box.top) / box.height) * 2 - 1;
  });
  root.addEventListener("pointerleave", () => {
    if (drag.held) return;
    hovering = false;
    pointer.x = 0;
    pointer.y = 0;
  });

  const place = (t: number) => {
    if (calm.matches) {
      Object.assign(pose, STILL_POSE);
    } else {
      const elapsed = Math.min(0.1, t - clock);
      clock = t;
      phase += elapsed * (hovering || drag.held ? HOVER_RATE : isHero ? IDLE_RATE.hero : IDLE_RATE.art);
      if (!drag.held) {
        Object.assign(drag, settleSpin(drag.spin, drag.velocity));
        drag.tilt *= 0.92;
      }
      const follow = drag.held ? 0.4 : 0.12;
      const { sway, lean } = isHero ? TURN_LIMITS.hero : TURN_LIMITS.art;
      pose.yaw += (Math.sin(phase) * sway + pointer.x * lean + drag.spin - pose.yaw) * follow;
      pose.pitch += (Math.sin(phase * 0.74) * 0.1 + pointer.y * 0.3 + drag.tilt - pose.pitch) * follow;
    }
    const parallax = calm.matches ? 0 : 1;
    mesh ??= meshFor(name);
    renderMesh(
      mesh,
      pose.yaw,
      pose.pitch,
      {
        cols,
        rows,
        cellW: layout.cellW,
        cellH: layout.cellH,
        centerX: layout.centerX(width),
        centerY,
        shiftX: pointer.x * layout.shift[0] * parallax,
        shiftY: pointer.y * layout.shift[1] * parallax,
        scale: layout.scale(width, height),
        ambient: layout.ambient,
      },
      lit,
      depth,
    );
  };

  const stamp = (atlas: HTMLCanvasElement, glyph: number, col: number, row: number) => {
    const { cellW, cellH } = layout;
    ctx.drawImage(atlas, glyph * cellW * dpr, 0, cellW * dpr, cellH * dpr, col * cellW, row * cellH, cellW, cellH);
  };

  // The hero's faint wave needs its own ink, drawn first and cleared around the anchor.
  const drawField = (t: number) => {
    const clear = anchorScale(width, height) * 1.35;
    const cx = layout.centerX(width);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (lit[row * cols + col]! > 0) continue;
        const fade = fieldClearance(col * layout.cellW, row * layout.cellH, cx, centerY, clear);
        const glyph = fade > 0 ? glyphIndex(cellLuminance(col, row, t) * fade) : 0;
        if (glyph > 0) stamp(fieldAtlas!, glyph, col, row);
      }
    }
  };

  const draw = (t: number) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    place(t);
    if (isHero) drawField(t);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const glyph = glyphIndex(lit[row * cols + col]!);
        if (glyph > 0) stamp(inkAtlas!, glyph, col, row);
      }
    }
  };

  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    if (now - last < (drag.held ? HELD_FRAME_MS : FRAME_MS)) return;
    last = now;
    draw(now / 1000);
  };

  // Reduced motion gets one still frame, and the loop only runs while the art is on screen.
  const sync = () => {
    cancelAnimationFrame(raf);
    if (!visible || cols === 0) return;
    if (calm.matches) draw(0);
    else raf = requestAnimationFrame(loop);
  };

  const resize = () => {
    const box = canvas.getBoundingClientRect();
    ({ width, height } = box);
    // The hero's anchor sits level with the headline panel, because its canvas stops short of the hero's bottom edge.
    const panelBox = panel?.getBoundingClientRect();
    centerY = panelBox ? panelBox.top + panelBox.height / 2 - box.top : height / 2;
    if (isHero) layout = width > 1600 ? HERO_WIDE : HERO;
    cols = Math.ceil(width / layout.cellW);
    rows = Math.ceil(height / layout.cellH);
    if (cols === 0 || rows === 0) {
      cols = 0;
      return;
    }
    dpr = Math.min(devicePixelRatio, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    inkAtlas = glyphAtlas(getComputedStyle(canvas).color, layout, dpr);
    if (isHero) fieldAtlas = glyphAtlas(FIELD_INK, layout, dpr);
    lit = new Float32Array(cols * rows);
    depth = new Float32Array(cols * rows);
    sync();
    // Resizing clears the canvas, so repaint now and don't leave a blank frame for the next tick.
    if (visible && !calm.matches) draw(clock);
  };

  const resizes = new ResizeObserver(resize);
  resizes.observe(canvas);
  if (panel) resizes.observe(panel);
  new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    sync();
  }).observe(canvas);
  calm.addEventListener("change", sync);
}
