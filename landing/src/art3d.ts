// The page's artwork as 3D objects: each is a few bold tube paths, simple enough to read at ASCII resolution.

import { type MeshPath, type TubeOptions, type Vec, buildMesh } from "./mesh3d.ts";

const ANCHOR_TUBES: TubeOptions = { radius: 0.095, step: 0.012, sides: 20, normalize: false };
export const ART_TUBES: TubeOptions = { radius: 0.11, step: 0.018, sides: 14, normalize: true };

const TAU = Math.PI * 2;
const deg = (d: number) => (d * Math.PI) / 180;

function loop(point: (angle: number) => Vec, from = 0, to = TAU, segments = 40): MeshPath {
  return Array.from({ length: segments + 1 }, (_, i) => point(from + ((to - from) * i) / segments));
}
const ringXY = (cx: number, cy: number, r: number, z = 0, from = 0, to = TAU) => loop((a) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r, z], from, to);
const ringXZ = (y: number, r: number) => loop((a) => [Math.cos(a) * r, y, Math.sin(a) * r]);

const arrowHead = (tip: Vec, direction: number, size = 0.42): MeshPath => {
  const barb = (turn: number): Vec => [tip[0] + Math.cos(direction + turn) * size, tip[1] + Math.sin(direction + turn) * size, tip[2]];
  return [barb(deg(138)), tip, barb(deg(-138))];
};

function arrow(from: Vec, tip: Vec): MeshPath[] {
  return [[from, tip], arrowHead(tip, Math.atan2(tip[1] - from[1], tip[0] - from[0]), 0.34)];
}

function arch(r: number, leftLeg: number, rightLeg: number, z: number): MeshPath {
  const top = -0.05;
  return [[-r, top - leftLeg, z], ...ringXY(0, top, r, z, Math.PI, 0), [r, top - rightLeg, z]];
}

function link(cx: number, tilt: number): MeshPath {
  return loop((a) => [cx + Math.cos(a) * 0.62, Math.sin(a) * 0.4 * Math.cos(tilt), Math.sin(a) * 0.4 * Math.sin(tilt)]);
}

function vault(): MeshPath[] {
  const s = 0.8;
  const front = 0.12;
  const back = -0.12;
  const frame = (z: number): MeshPath => [[-s, -s, z], [s, -s, z], [s, s, z], [-s, s, z], [-s, -s, z]];
  const corners: [number, number][] = [[-s, -s], [s, -s], [s, s], [-s, s]];
  const spokes = [45, 135, 225, 315].map((d): MeshPath => [
    [Math.cos(deg(d)) * 0.3, Math.sin(deg(d)) * 0.3, front],
    [Math.cos(deg(d)) * 0.56, Math.sin(deg(d)) * 0.56, front],
  ]);
  return [frame(front), frame(back), ...corners.map(([x, y]): MeshPath => [[x, y, back], [x, y, front]]), ringXY(0, 0, 0.3, front), ...spokes];
}

export const ART_PATHS: Record<string, MeshPath[]> = {
  config: [
    [[-0.62, 0.92, 0], [0.26, 0.92, 0], [0.62, 0.56, 0], [0.62, -0.92, 0], [-0.62, -0.92, 0], [-0.62, 0.92, 0]],
    [[0.26, 0.92, 0], [0.26, 0.56, 0], [0.62, 0.56, 0]],
    [[-0.32, 0.12, 0], [0.32, 0.12, 0]],
    [[-0.32, -0.22, 0], [0.32, -0.22, 0]],
    [[-0.32, -0.56, 0], [0.08, -0.56, 0]],
  ],
  balance: [ringXY(0, -0.42, 0.56), [[0, -0.74, 0], [0, -0.1, 0]], ...arrow([-0.98, 0.92, 0], [-0.36, 0.2, 0]), ...arrow([0.98, 0.92, 0], [0.36, 0.2, 0])],
  hourglass: [
    ringXZ(0.92, 0.6),
    ringXZ(-0.92, 0.6),
    [[-0.54, 0.92, 0], [-0.07, 0, 0], [-0.54, -0.92, 0]],
    [[0.54, 0.92, 0], [0.07, 0, 0], [0.54, -0.92, 0]],
    [[-0.26, -0.62, 0], [0.26, -0.62, 0]],
  ],
  key: [ringXY(-0.5, 0, 0.42), [[-0.08, 0, 0], [1, 0, 0]], [[0.56, 0, 0], [0.56, -0.38, 0]], [[0.86, 0, 0], [0.86, -0.38, 0]]],
  vault: vault(),
  callback: [ringXY(0, 0, 0.78, 0, deg(60), TAU), arrowHead([0.78, 0, 0], Math.PI / 2, 0.52)],
  chain: [link(-0.42, deg(38)), link(0.42, deg(-38))],
  fingerprint: [arch(0.25, 0.2, 0.55, 0.04), arch(0.56, 0.62, 0.34, 0), arch(0.88, 0.42, 0.78, -0.04), [[0, -0.05, 0.04], [0, -0.42, 0.04]]],
};

const ANCHOR_PATHS: MeshPath[] = [
  ringXY(0, 0.82, 0.17),
  [[0, 0.65, 0], [0, -0.96, 0]],
  [[-0.42, 0.36, 0], [0.42, 0.36, 0]],
  ringXY(0, -0.14, 0.82, 0, deg(-172), deg(-8)),
  [[-0.81, -0.25, 0], [-0.62, -0.06, 0]],
  [[-0.81, -0.25, 0], [-0.98, -0.02, 0]],
  [[0.81, -0.25, 0], [0.62, -0.06, 0]],
  [[0.81, -0.25, 0], [0.98, -0.02, 0]],
];

export const buildAnchorMesh = () => buildMesh(ANCHOR_PATHS, ANCHOR_TUBES);
