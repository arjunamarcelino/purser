// A small software 3D renderer for the hero: the anchor as lit tubes, projected onto the ASCII grid with a depth buffer.

export interface AnchorMesh {
  positions: Float32Array;
  normals: Float32Array;
  count: number;
}

export interface AnchorView {
  width: number;
  height: number;
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  centerX: number;
  centerY: number;
  shiftX: number;
  shiftY: number;
}

type Vec = [number, number, number];

const TUBE_RADIUS = 0.095;
const TUBE_SIDES = 20;
const STEP = 0.012;
const CAMERA = 4;

const line = (a: Vec, b: Vec): Vec[] => [a, b];
const arc = (cx: number, cy: number, radius: number, from: number, to: number, segments = 48): Vec[] =>
  Array.from({ length: segments + 1 }, (_, i) => {
    const angle = from + ((to - from) * i) / segments;
    return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 0];
  });

const ANCHOR_PATHS: Vec[][] = [
  arc(0, 0.82, 0.17, 0, Math.PI * 2),
  line([0, 0.65, 0], [0, -0.96, 0]),
  line([-0.42, 0.36, 0], [0.42, 0.36, 0]),
  arc(0, -0.14, 0.82, (-172 * Math.PI) / 180, (-8 * Math.PI) / 180),
  line([-0.81, -0.25, 0], [-0.62, -0.06, 0]),
  line([-0.81, -0.25, 0], [-0.98, -0.02, 0]),
  line([0.81, -0.25, 0], [0.62, -0.06, 0]),
  line([0.81, -0.25, 0], [0.98, -0.02, 0]),
];

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec): Vec => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};

export function buildAnchorMesh(): AnchorMesh {
  const positions: number[] = [];
  const normals: number[] = [];
  for (const path of ANCHOR_PATHS) {
    for (let s = 0; s < path.length - 1; s++) {
      const start = path[s]!;
      const end = path[s + 1]!;
      const along = sub(end, start);
      const length = Math.hypot(along[0], along[1], along[2]);
      const tangent = unit(along);
      const side = unit(cross(tangent, [0, 0, 1]));
      const depth = unit(cross(tangent, side));
      const rings = Math.max(1, Math.ceil(length / STEP));
      for (let r = 0; r <= rings; r++) {
        const t = r / rings;
        for (let a = 0; a < TUBE_SIDES; a++) {
          const angle = (a / TUBE_SIDES) * Math.PI * 2;
          const c = Math.cos(angle);
          const n = Math.sin(angle);
          const normal: Vec = [side[0] * c + depth[0] * n, side[1] * c + depth[1] * n, side[2] * c + depth[2] * n];
          normals.push(...normal);
          positions.push(start[0] + along[0] * t + normal[0] * TUBE_RADIUS, start[1] + along[1] * t + normal[1] * TUBE_RADIUS, start[2] + along[2] * t + normal[2] * TUBE_RADIUS);
        }
      }
    }
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), count: positions.length / 3 };
}

export const DRAG_GAIN = 0.01;

// After a drag the spin coasts to a stop, then eases to the nearest whole turn so the anchor faces front again.
export function settleSpin(spin: number, velocity: number): { spin: number; velocity: number } {
  const coasted = spin + velocity;
  const turn = Math.PI * 2;
  const home = Math.abs(velocity) < 0.002 ? (Math.round(coasted / turn) * turn - coasted) * 0.03 : 0;
  return { spin: coasted + home, velocity: velocity * 0.93 };
}

export const anchorScale = (width: number, height: number) => Math.min(height * 0.32, width * 0.17);

// 0 inside the circle around the anchor, easing to 1 outside it, so the background never crowds the mark.
export function fieldClearance(x: number, y: number, cx: number, cy: number, radius: number): number {
  const distance = Math.hypot(x - cx, y - cy) / radius;
  return Math.min(1, Math.max(0, (distance - 1) / 0.4));
}

const LIGHT = unit([-0.45, 0.6, 0.66]);
const HALF = unit([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);

// Writes each cell's brightness into `out`: 0 where the anchor isn't, otherwise diffuse light plus a highlight.
export function renderAnchor(mesh: AnchorMesh, yaw: number, pitch: number, view: AnchorView, out: Float32Array, depth: Float32Array): void {
  out.fill(0);
  depth.fill(-Infinity);
  const { positions, normals, count } = mesh;
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const cosX = Math.cos(pitch);
  const sinX = Math.sin(pitch);
  const scale = anchorScale(view.width, view.height);
  const cx = view.centerX + view.shiftX;
  const cy = view.centerY + view.shiftY;

  for (let i = 0; i < count; i++) {
    const nx0 = normals[i * 3]!;
    const nz0 = normals[i * 3 + 2]!;
    const ny0 = normals[i * 3 + 1]!;
    const nx = nx0 * cosY + nz0 * sinY;
    const nz1 = -nx0 * sinY + nz0 * cosY;
    const ny = ny0 * cosX - nz1 * sinX;
    const nz = ny0 * sinX + nz1 * cosX;
    if (nz <= 0) continue;

    const px = positions[i * 3]!;
    const py = positions[i * 3 + 1]!;
    const pz = positions[i * 3 + 2]!;
    const x = px * cosY + pz * sinY;
    const z1 = -px * sinY + pz * cosY;
    const y = py * cosX - z1 * sinX;
    const z = py * sinX + z1 * cosX;

    const perspective = (scale * CAMERA) / (CAMERA - z);
    const col = Math.floor((cx + x * perspective) / view.cellW);
    const row = Math.floor((cy - y * perspective) / view.cellH);
    if (col < 0 || row < 0 || col >= view.cols || row >= view.rows) continue;
    const cell = row * view.cols + col;
    if (z <= depth[cell]!) continue;
    depth[cell] = z;
    const diffuse = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
    const highlight = Math.max(0, nx * HALF[0] + ny * HALF[1] + nz * HALF[2]) ** 18;
    out[cell] = Math.min(1, 0.2 + 0.68 * diffuse + 0.4 * highlight);
  }
}
