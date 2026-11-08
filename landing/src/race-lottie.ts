// A hand-authored Lottie of the demo's race, built from the current theme's tokens so one scene serves both themes.

export const RACE_FRAMES = 180;

export interface RacePalette {
  track: string;
  gate: string;
  agent: string;
  admitted: string;
  refused: string;
}

type Rgb = [number, number, number];
type Keyframe = { t: number; s: number[]; o?: unknown; i?: unknown };

const W = 640;
const H = 300;
const GATE_X = 420;
const LANES = [70, 150, 230] as const;

const rgb = (hex: string): Rgb => {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

const still = (k: number | number[]) => ({ a: 0, k });
const EASE = { o: { x: [0.33], y: [0] }, i: { x: [0.2], y: [1] } };
const SPATIAL_EASE = { o: { x: 0.33, y: 0 }, i: { x: 0.2, y: 1 } };

const animated = (keys: [number, number[]][], ease: object = EASE) => ({
  a: 1,
  k: keys.map(([t, s], n): Keyframe => (n < keys.length - 1 ? { t, s, ...ease } : { t, s })),
});

const transform = (position: object, scale: object = still([100, 100, 100]), rotation = 0) => ({
  o: still(100),
  r: still(rotation),
  p: position,
  a: still([0, 0, 0]),
  s: scale,
});

const fill = (color: object) => ({ ty: "fl", c: color, o: still(100), r: 1 });
const shapeTransform = { ty: "tr", p: still([0, 0]), a: still([0, 0]), s: still([100, 100]), r: still(0), o: still(100) };

const layer = (ind: number, name: string, ks: object, items: object[]) => ({
  ddd: 0,
  ind,
  ty: 4,
  nm: name,
  sr: 1,
  ks,
  ao: 0,
  ip: 0,
  op: RACE_FRAMES,
  st: 0,
  bm: 0,
  shapes: [{ ty: "gr", nm: name, it: [...items, shapeTransform] }],
});

const rect = (w: number, h: number, color: Rgb) => [{ ty: "rc", d: 1, p: still([0, 0]), s: still([w, h]), r: still(1) }, fill(still([...color, 1]))];

const agent = (ind: number, y: number, start: number, moves: [number, number][], from: Rgb, to: Rgb) =>
  layer(
    ind,
    `agent-${y}`,
    transform(animated([[start, [50, y, 0]], ...moves.map(([t, x]): [number, number[]] => [t, [x, y, 0]])], SPATIAL_EASE)),
    [
      { ty: "el", d: 1, p: still([0, 0]), s: still([24, 24]) },
      fill(animated([[70, [...from, 1]], [80, [...to, 1]]])),
    ],
  );

const stop = (ind: number, y: number, color: Rgb) =>
  layer(ind, `refused-${y}`, transform(still([GATE_X - 22, y - 34, 0]), animated([[74, [0, 0, 100]], [88, [100, 100, 100]]]), 45), [
    { ty: "rc", d: 1, p: still([0, 0]), s: still([22, 3]), r: still(1) },
    { ty: "rc", d: 1, p: still([0, 0]), s: still([3, 22]), r: still(1) },
    fill(still([...color, 1])),
  ]);

export function buildRaceAnimation(palette: RacePalette) {
  const track = rgb(palette.track);
  const gate = rgb(palette.gate);
  const agentColor = rgb(palette.agent);
  const admitted = rgb(palette.admitted);
  const refused = rgb(palette.refused);
  const [top, middle, bottom] = LANES;
  return {
    v: "5.7.4",
    fr: 60,
    ip: 0,
    op: RACE_FRAMES,
    w: W,
    h: H,
    nm: "purser-race",
    ddd: 0,
    assets: [],
    layers: [
      stop(1, top, refused),
      stop(2, bottom, refused),
      agent(3, middle, 0, [[62, GATE_X - 18], [130, 590]], agentColor, admitted),
      agent(4, top, 5, [[66, GATE_X - 18], [110, GATE_X - 70]], agentColor, refused),
      agent(5, bottom, 9, [[68, GATE_X - 18], [112, GATE_X - 70]], agentColor, refused),
      layer(6, "gate", transform(still([GATE_X, H / 2, 0])), rect(6, 240, gate)),
      ...LANES.map((y, n) => layer(7 + n, `lane-${y}`, transform(still([W / 2, y, 0])), rect(560, 2, track))),
    ],
  };
}
