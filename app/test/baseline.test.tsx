// The comparison page: labeled in every state, and never shows an overspend without a verified run.
// fetch is mocked; no job is ever started.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BaselinePage from "../src/baseline/BaselinePage.tsx";
import { parseResult, readStream } from "../src/baseline/parse.ts";

const BANNER = "NAÏVE BASELINE — NO RESERVATION (for comparison only)";
const TITLE = "NAÏVE BASELINE (NO RESERVATION) — for comparison only";
const CAPTION = "Naïve implementation — concurrent checks double-spend.";
const H1 = "5dRpkX87653fAYGwh3cnAy8F4YSNCqhviDKBc2vcjhyw";
const H2 = "7LCgg1qhqojfUcqV3mTbagLBs2kLx8oGM2AcFdoidwXD";
const lane = (hash: string, to: string) => ({ hash, to, read: 100, included: 104 });
const payload = { sawUnits: 100, capUnits: 100, spentUnits: 120, overUnits: 20, a: lane(H1, "data.op.testnet"), b: lane(H2, "compute.op.testnet") };
const resultLine = `BASELINE ${JSON.stringify(payload)}`;
const events = (lines: string[], code: number | null) => [...lines.map((line, i) => JSON.stringify({ seq: i + 1, line })), JSON.stringify({ seq: lines.length, done: true, code })].join("\n") + "\n";

function mockCompanion(routes: { start: { status: number; body: unknown }; events?: string; current?: unknown }) {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  vi.stubGlobal("fetch", async (path: string) => {
    if (path === "/__purser/jobs/current") return json(200, routes.current ?? { jobId: null });
    if (path === "/__purser/jobs") return json(routes.start.status, routes.start.body);
    if (path === "/__purser/jobs/events") return new Response(routes.events ?? "", { status: 200 });
    return json(404, {});
  });
}
const started = { status: 202, body: { jobId: "j1", kind: "baseline" } };
const fire = () => fireEvent.click(screen.getByRole("button", { name: "Fire 60 + 60 concurrently" }));

beforeEach(() => {
  const m = document.createElement("meta");
  m.name = "purser-token";
  m.content = "t";
  document.head.append(m);
});
afterEach(() => {
  document.head.querySelector('meta[name="purser-token"]')?.remove();
  vi.unstubAllGlobals();
});

describe("baseline page", () => {
  it("is labeled before any run, starts at spent 0 of cap 100, and carries no Purser branding", async () => {
    mockCompanion({ start: started });
    render(<BaselinePage />);
    expect(screen.getByText(BANNER)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(TITLE);
    await waitFor(() => expect(document.title).toBe(TITLE));
    expect(screen.getByLabelText("Baseline budget").textContent).toMatch(/0 \/ cap 100/);
    expect(screen.queryByText(/OVER CAP/)).toBeNull();
    expect(screen.queryByText("PURSER")).toBeNull();
    expect(screen.queryByText(/INVARIANT/)).toBeNull();
  });

  it("shows the overspend with both tx links after a verified run, still labeled", async () => {
    mockCompanion({ start: started, events: events(["$ pnpm", resultLine], 0) });
    render(<BaselinePage />);
    fire();
    expect(await screen.findByText("OVER CAP BY 20")).toBeTruthy();
    expect(screen.getByText(CAPTION)).toBeTruthy();
    expect(screen.getByLabelText("Baseline budget").textContent).toMatch(/120 \/ cap 100/);
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([`https://testnet.nearblocks.io/txns/${H1}`, `https://testnet.nearblocks.io/txns/${H2}`]);
    expect(screen.getByText(BANNER)).toBeTruthy();
  });

  it.each([
    ["a non-zero exit, even with a result line", events([resultLine], 1)],
    ["exit 0 with no result line", events(["$ pnpm"], 0)],
  ])("shows no overspend on %s", async (_name, stream) => {
    mockCompanion({ start: started, events: stream });
    render(<BaselinePage />);
    fire();
    expect(await screen.findByText(/did not complete/)).toBeTruthy();
    expect(screen.queryByText(/OVER CAP/)).toBeNull();
    expect(screen.queryByText(CAPTION)).toBeNull();
    expect(screen.getByText(BANNER)).toBeTruthy();
  });

  it("says so inline when another kind of job holds the slot, and does not attach to it", async () => {
    mockCompanion({ start: { status: 409, body: { error: "a job is already running", jobId: "j9", kind: "tests" } } });
    render(<BaselinePage />);
    fire();
    expect(await screen.findByText(/Another job is running \(tests\)/)).toBeTruthy();
    expect(screen.queryByText(/OVER CAP/)).toBeNull();
  });

  it("shows the cooldown inline", async () => {
    mockCompanion({ start: { status: 429, body: { error: "cooling down: this run spends testnet NEAR" } } });
    render(<BaselinePage />);
    fire();
    expect(await screen.findByText(/cooling down/)).toBeTruthy();
  });

  it("re-attaches after a reload only to a running baseline job", async () => {
    mockCompanion({ start: started, current: { jobId: "j1", kind: "baseline", done: false }, events: events([resultLine], 0) });
    render(<BaselinePage />);
    expect(await screen.findByText("OVER CAP BY 20")).toBeTruthy();
  });

  it("ignores a running job of another kind on load", async () => {
    mockCompanion({ start: started, current: { jobId: "j2", kind: "attack", done: false }, events: events([resultLine], 0) });
    render(<BaselinePage />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/OVER CAP/)).toBeNull();
    expect((screen.getByRole("button", { name: "Fire 60 + 60 concurrently" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("result parsing", () => {
  it("accepts the driver's line", () => expect(parseResult([resultLine])).toEqual(payload));
  it("shows the spend as unknown, not 0, when a run fails after sending", async () => {
    mockCompanion({ start: started, events: events(["demo: merchant balances disagree"], 1) });
    render(<BaselinePage />);
    fire();
    await screen.findByText(/result unknown/);
    expect(screen.queryByText(/remaining 100 units/)).toBeNull();
    expect(screen.queryByText(CAPTION)).toBeNull();
  });
  it("reads the job's exit code from the stream", () => expect(readStream(events(["x"], 3))).toEqual({ done: true, code: 3, lines: ["x"] }));
  it.each([
    ["two result lines", [resultLine, resultLine]],
    ["a truncated line", [`${resultLine.slice(0, 80)}…`]],
    ["a prefix that is not at the start", [`note ${resultLine}`]],
    ["a hash that is not a tx hash", [`BASELINE ${JSON.stringify({ ...payload, a: lane("javascript:alert(1)", "data.op.testnet") })}`]],
    ["the same tx twice", [`BASELINE ${JSON.stringify({ ...payload, b: payload.a })}`]],
    ["inconsistent totals", [`BASELINE ${JSON.stringify({ ...payload, overUnits: 5 })}`]],
  ])("rejects %s", (_name, lines) => expect(parseResult(lines)).toBeNull());
});
