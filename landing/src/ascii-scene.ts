// Line art drawn as ASCII on local canvases: the hero's anchor and the page's section artwork.

export const RAMP = " .:-=+*#%@";

const FRAME_MS = 1000 / 20;

// Every drawing is a 24-unit stroke path, sharing the look of the anchor mark.
const ART: Record<string, string> = {
  anchor: "M12 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM12 7v14M5 13a7 7 0 0 0 14 0M8 10h8",
  config: "M6 2h9l4 4v16H6zM15 2v4h4M9 11h7M9 15h7M9 19h4",
  balance: "M8 6a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM21 6a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM16 17a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM6 10l4 4M18 10l-4 4",
  hourglass: "M6 2h12M6 22h12M7 2v4c0 3 10 5 10 10v6M17 2v4c0 3-10 5-10 10v6",
  key: "M15 7a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM12.6 11.4L4 20M7 17l2 2M9 15l2 2",
  vault: "M3 3h18v18H3zM16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM12 8V5M12 19v-3M8 12H5M19 12h-3",
  callback: "M20 11a8 8 0 1 0-2 6M20 5v6h-6",
  chain: "M10 14a4 4 0 0 1 0-6l3-3a4 4 0 0 1 6 6l-2 2M14 10a4 4 0 0 1 0 6l-3 3a4 4 0 0 1-6-6l2-2",
  fingerprint: "M12 11v4M8 20c1-3 1-6 1-9a3 3 0 0 1 6 0c0 3 0 7-1 10M4 16c1-2 1-3 1-5a7 7 0 0 1 14 0c0 3 0 5-.5 7",
};

export const artNames = () => Object.keys(ART);

export function cellLuminance(mask: number, col: number, row: number, t: number, field = true): number {
  const wave = (Math.sin(col * 0.09 + t * 0.6) + Math.sin(row * 0.16 - t * 0.45) + Math.sin((col + row) * 0.05 + t * 0.3)) / 6 + 0.5;
  const crest = field ? Math.max(0, wave - 0.62) * 0.9 : 0;
  return Math.min(1, Math.max(crest, mask * (0.62 + 0.38 * wave)));
}

export const charFor = (luminance: number) => RAMP[Math.round(Math.min(1, Math.max(0, luminance)) * (RAMP.length - 1))]!;

interface Layout {
  cellW: number;
  cellH: number;
  font: string;
  field: boolean;
  scale: number;
  widthScale: number;
  centerX: (width: number) => number;
}

const HERO: Layout = { cellW: 9, cellH: 16, font: "13px", field: true, scale: 0.84, widthScale: 0.42, centerX: (w) => w * (w < 1024 ? 0.5 : 0.29) };
const TILE: Layout = { cellW: 6, cellH: 11, font: "9px", field: false, scale: 0.92, widthScale: 0.9, centerX: (w) => w * 0.5 };

// Cells are taller than wide, so the art is drawn in pixels and scaled down per axis to stay in proportion.
function strokeMask(path: string, layout: Layout, width: number, height: number, cols: number, rows: number): Float32Array {
  const grid = document.createElement("canvas");
  grid.width = cols;
  grid.height = rows;
  const ctx = grid.getContext("2d", { willReadFrequently: true })!;
  const size = Math.min(height * layout.scale, width * layout.widthScale);
  const unit = size / 24;
  ctx.scale(1 / layout.cellW, 1 / layout.cellH);
  ctx.translate(layout.centerX(width) - size / 2, height / 2 - size / 2);
  ctx.scale(unit, unit);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2.4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke(new Path2D(path));
  const { data } = ctx.getImageData(0, 0, cols, rows);
  return Float32Array.from({ length: cols * rows }, (_, i) => data[i * 4 + 3]! / 255);
}

export function initAsciiArt(canvas: HTMLCanvasElement) {
  const name = canvas.dataset.asciiArt ?? "";
  const path = ART[name];
  const ctx = canvas.getContext("2d");
  if (!path || !ctx) return;
  const layout = name === "anchor" ? HERO : TILE;
  const calm = matchMedia("(prefers-reduced-motion: reduce)");
  let cols = 0;
  let rows = 0;
  let mask: Float32Array = new Float32Array(0);
  let raf = 0;
  let last = 0;
  let visible = false;

  const draw = (t: number) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const glyph = charFor(cellLuminance(mask[row * cols + col]!, col, row, t, layout.field));
        if (glyph !== " ") ctx.fillText(glyph, col * layout.cellW, row * layout.cellH);
      }
    }
  };

  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    if (now - last < FRAME_MS) return;
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
    const { width, height } = canvas.getBoundingClientRect();
    cols = Math.ceil(width / layout.cellW);
    rows = Math.ceil(height / layout.cellH);
    if (cols === 0 || rows === 0) {
      cols = 0;
      return;
    }
    const dpr = Math.min(devicePixelRatio, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `${layout.font} "IBM Plex Mono", monospace`;
    ctx.textBaseline = "top";
    ctx.fillStyle = getComputedStyle(canvas).color;
    mask = strokeMask(path, layout, width, height, cols, rows);
    sync();
  };

  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    sync();
  }).observe(canvas);
  calm.addEventListener("change", sync);
}
