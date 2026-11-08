import { describe, expect, it } from "vitest";
import { REFUSALS, type RefusalCode, type ReservationState } from "@purser/types";
import { amountDisplay, formatNear, nearDisplay, safeText } from "../src/lib/format.ts";
import { groupOf, lineHealth, refusalBadge, stateBadge, STALE_AFTER_MS } from "../src/lib/semantics.ts";

const N = 10n ** 24n;
const inv = (o: Partial<{ cap: bigint; completed: bigint; outstanding: bigint; holds: boolean; frozen: boolean }> = {}) => ({
  cap: 100n * N, completed: 60n * N, outstanding: 0n, holds: true, frozen: false, ...o,
});
const now = 1_000_000;

describe("refusal wording", () => {
  it("names a reused request_id as a rejection, in amber", () => {
    expect(refusalBadge("request_id_reused")).toMatchObject({ label: "REJECTED: request_id reused with a different request", tone: "warn" });
  });
});

describe("invariant line", () => {
  it("is green only on fresh, healthy contract state", () => {
    expect(lineHealth(inv(), { hasUnknown: false, syncedAt: now - 1000, now })).toMatchObject({ tone: "ok", label: "INVARIANT HEALTHY" });
  });
  it("is amber when holds are pending-heavy or any outcome is unknown", () => {
    expect(lineHealth(inv({ outstanding: 50n * N }), { hasUnknown: false, syncedAt: now, now }).tone).toBe("warn");
    expect(lineHealth(inv({ outstanding: 1n }), { hasUnknown: true, syncedAt: now, now }).tone).toBe("warn");
    expect(lineHealth(inv({ outstanding: 30n * N }), { hasUnknown: false, syncedAt: now, now }).tone).toBe("ok"); // one 30-of-100 hold stays green
  });
  it("is red only when the contract reports the invariant does not hold", () => {
    expect(lineHealth(inv({ holds: false }), { hasUnknown: false, syncedAt: now, now })).toMatchObject({ tone: "alarm", label: "INVARIANT VIOLATED" });
    expect(lineHealth(inv({ holds: false, frozen: true }), { hasUnknown: false, syncedAt: now, now }).label).toMatch(/FROZEN/);
  });
  it("is never green on stale or missing data", () => {
    expect(lineHealth(inv(), { hasUnknown: false, syncedAt: now - STALE_AFTER_MS - 1, now }).tone).toBe("dim");
    expect(lineHealth(inv(), { hasUnknown: false, syncedAt: null, now }).tone).toBe("dim");
    expect(lineHealth(null, { hasUnknown: false, syncedAt: now, now }).tone).toBe("dim");
  });
});

describe("badges", () => {
  it("never use red for a refusal, block or rejection, and always carry text", () => {
    for (const code of [...(Object.keys(REFUSALS) as RefusalCode[]), null]) {
      const b = refusalBadge(code);
      expect(b.tone).toBe("warn");
      expect(b.label.length).toBeGreaterThan(0);
      expect(b.description.length).toBeGreaterThan(0);
    }
    expect(refusalBadge("delegate_not_authorized").label).toBe("BLOCKED: delegate revoked");
  });
  it("map every reservation state to a labelled badge, none red", () => {
    for (const [state, b] of Object.entries(stateBadge)) {
      expect(b.tone).not.toBe("alarm");
      expect(b.label).toBe(state.toUpperCase());
    }
  });
  it("group states into the manifest sections", () => {
    const g = (s: ReservationState) => groupOf(s);
    expect([g("Reserved"), g("Signed"), g("Unknown"), g("Confirmed"), g("Failed"), g("Cancelled")]).toEqual(["holds", "holds", "holds", "payments", "released", "released"]);
  });
});

describe("format", () => {
  it("formats yocto as NEAR without floats, rounding down", () => {
    expect(formatNear(30n * N)).toBe("30");
    expect(formatNear(3n * 10n ** 23n)).toBe("0.3");
    expect(formatNear(123456789n * 10n ** 18n)).toBe("123.4567");
    expect(formatNear(1n)).toBe("0.0001");
    expect(formatNear(1234n * N)).toBe("1,234");
  });
  it("strips bidi and invisible characters from untrusted text", () => {
    expect(safeText("pay‮evil​.testnet")).toBe("payevil.testnet");
    expect(safeText("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
    expect(safeText(null)).toBe("");
  });
});

describe("unit display", () => {
  const cap = N / 10n; // 0.1 NEAR = 100 units
  const unit = cap / 100n;
  it("writes round units and always says what a unit is", () => {
    const m = amountDisplay(cap, true);
    expect(m.fmt(70n * unit)).toBe("70");
    expect(m.note).toBe("units · 1 unit = 0.001 NEAR");
  });
  it("never rounds a settled value, and shows whole units on an animation frame", () => {
    const m = amountDisplay(cap, true);
    expect(m.fmt(70n * unit + 1n)).toMatch(/~$/);
    expect(m.frame(87n * unit + unit / 3n)).toBe("87");
  });
  it("falls back to NEAR when not asked, or when the cap does not divide into 100 units", () => {
    expect(amountDisplay(cap, false)).toBe(nearDisplay);
    expect(amountDisplay(cap + 1n, true)).toBe(nearDisplay);
    expect(amountDisplay(0n, true)).toBe(nearDisplay);
  });
});
