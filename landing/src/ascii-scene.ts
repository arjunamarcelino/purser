// The hero's background: Purser's anchor mark as an ASCII field over a slow wave, drawn on a local canvas.

export const RAMP = " .:-=+*#%@";

const CELL_W = 9;
const CELL_H = 16;
const FRAME_MS = 1000 / 20;
const ANCHOR_PATH = "M12 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM12 7v14M5 13a7 7 0 0 0 14 0M8 10h8";

export function cellLuminance(mask: number, col: number, row: number, t: number): number {
  const wave = (Math.sin(col * 0.09 + t * 0.6) + Math.sin(row * 0.16 - t * 0.45) + Math.sin((col + row) * 0.05 + t * 0.3)) / 6 + 0.5;
  const crest = Math.max(0, wave - 0.62) * 0.9;
  return Math.min(1, Math.max(crest, mask * (0.62 + 0.38 * wave)));
}

export const charFor = (luminance: number) => RAMP[Math.round(Math.min(1, Math.max(0, luminance)) * (RAMP.length - 1))]!;

// Cells are taller than wide, so the mark is drawn in pixels and scaled down per axis to stay in proportion.
function anchorMask(width: number, height: number, cols: number, rows: number): Float32Array {
  const grid = document.createElement("canvas");
  grid.width = cols;
  grid.height = rows;
  const ctx = grid.getContext("2d", { willReadFrequently: true })!;
  const size = Math.min(height * 0.84, width * 0.42);
  const unit = size / 24;
  ctx.scale(1 / CELL_W, 1 / CELL_H);
  ctx.translate(width * (width < 1024 ? 0.5 : 0.29) - size / 2, height / 2 - size / 2);
  ctx.scale(unit, unit);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2.4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke(new Path2D(ANCHOR_PATH));
  const { data } = ctx.getImageData(0, 0, cols, rows);
  return Float32Array.from({ length: cols * rows }, (_, i) => data[i * 4 + 3]! / 255);
}

export function initAsciiScene(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
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
        const glyph = charFor(cellLuminance(mask[row * cols + col]!, col, row, t));
        if (glyph !== " ") ctx.fillText(glyph, col * CELL_W, row * CELL_H);
      }
    }
  };

  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    if (now - last < FRAME_MS) return;
    last = now;
    draw(now / 1000);
  };

  // Reduced motion gets one still frame, and the loop only runs while the hero is on screen.
  const sync = () => {
    cancelAnimationFrame(raf);
    if (!visible || cols === 0) return;
    if (calm.matches) draw(0);
    else raf = requestAnimationFrame(loop);
  };

  const resize = () => {
    const { width, height } = canvas.getBoundingClientRect();
    cols = Math.ceil(width / CELL_W);
    rows = Math.ceil(height / CELL_H);
    if (cols === 0 || rows === 0) {
      cols = 0;
      return;
    }
    const dpr = Math.min(devicePixelRatio, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '13px "IBM Plex Mono", monospace';
    ctx.textBaseline = "top";
    ctx.fillStyle = "#d8d8d8";
    mask = anchorMask(width, height, cols, rows);
    sync();
  };

  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    sync();
  }).observe(canvas);
  calm.addEventListener("change", sync);
}
