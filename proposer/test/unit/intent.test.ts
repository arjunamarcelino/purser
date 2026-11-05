import { describe, expect, it } from "vitest";
import { nearToYocto, parseDecision, toPaymentIntent } from "../../src/intent.ts";

const ok = <T>(r: { ok: true; value: T } | { ok: false; reason: string }): T => {
  if (!r.ok) throw new Error(r.reason);
  return r.value;
};

describe("nearToYocto (exact, no floats)", () => {
  it.each([
    ["0", "0"],
    ["1", "1000000000000000000000000"],
    ["1.5", "1500000000000000000000000"],
    ["0.000000000000000000000001", "1"],
    ["30", "30000000000000000000000000"],
  ])("%s NEAR → %s yocto", (near, yocto) => expect(ok(nearToYocto(near))).toBe(yocto));

  it.each(["1e3", "-1", ".5", "1.", " 1", "1 ", "01", "0x10", "1.0000000000000000000000001", "", "NaN"])("rejects %j", (bad) =>
    expect(nearToYocto(bad).ok).toBe(false),
  );

  it("rejects amounts above u128", () => {
    expect(nearToYocto("340282366920938.463463374607431768211455").ok).toBe(true); // u128::MAX
    expect(nearToYocto("340282366920938.463463374607431768211456").ok).toBe(false);
  });
});

describe("parseDecision (shape only)", () => {
  const base = { rationale: "cheapest", action: "propose", recipient: "vendor.testnet", amount_near: "8", memo: null };

  it("accepts a proposal and a decline", () => {
    expect(ok(parseDecision(base))).toMatchObject({ action: "propose", recipient: "vendor.testnet", amountNear: "8" });
    expect(ok(parseDecision({ ...base, action: "decline", recipient: null, amount_near: null }))).toEqual({ action: "decline", rationale: "cheapest" });
  });

  it("rejects extra keys, so a model cannot smuggle chain or token", () => {
    expect(parseDecision({ ...base, chain: { Evm: { chain_id: 1 } } }).ok).toBe(false);
    expect(parseDecision({ ...base, token: { Nep141: { contract: "x.testnet" } } }).ok).toBe(false);
  });

  it("rejects a proposal missing its recipient or amount, and non-objects", () => {
    expect(parseDecision({ ...base, recipient: null }).ok).toBe(false);
    expect(parseDecision({ ...base, amount_near: null }).ok).toBe(false);
    expect(parseDecision("propose 8 NEAR").ok).toBe(false);
    expect(parseDecision(undefined).ok).toBe(false);
  });

  it("does NOT apply policy: over-budget, zero, odd recipients and long memos pass through to the contract", () => {
    for (const v of [{ amount_near: "500" }, { amount_near: "0" }, { recipient: "attacker.testnet" }, { recipient: "NOT AN ACCOUNT" }, { memo: "x".repeat(5000) }]) {
      expect(parseDecision({ ...base, ...v }).ok).toBe(true);
    }
  });
});

describe("toPaymentIntent", () => {
  it("takes chain and token from the task, never the model", () => {
    const d = ok(parseDecision({ rationale: "r", action: "propose", recipient: "vendor.testnet", amount_near: "0.5", memo: "m" }));
    if (d.action !== "propose") throw new Error("expected a proposal");
    expect(ok(toPaymentIntent(d, "NearNative"))).toEqual({
      chain: "NearNative",
      recipient: "vendor.testnet",
      amount: "500000000000000000000000",
      token: "NearNative",
      memo: "m",
    });
  });
});
