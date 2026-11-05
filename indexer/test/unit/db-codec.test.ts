import { describe, expect, it } from "vitest";
import { clampLimit, decodeCursor, encodeCursor, jsonStringify, toBigInt } from "../../src/db/codec.ts";

describe("codec", () => {
  it("toBigInt accepts bigint, decimal strings, safe integers", () => {
    expect(toBigInt(5n)).toBe(5n);
    expect(toBigInt("18446744073709551615")).toBe(18446744073709551615n);
    expect(toBigInt("9007199254740993")).toBe(9007199254740993n);
    expect(toBigInt(42)).toBe(42n);
  });

  it("toBigInt rejects lossy or foreign input", () => {
    for (const bad of [2 ** 53, 1.5, NaN, "1e3", "01", "", " 1", null, undefined, {}, true]) {
      expect(() => toBigInt(bad)).toThrow(TypeError);
    }
  });

  it("serialises bigint as decimal strings", () => {
    expect(jsonStringify({ h: 18446744073709551615n, n: 1 })).toBe('{"h":"18446744073709551615","n":1}');
  });

  it("clamps limit to 1..200", () => {
    expect([clampLimit(0), clampLimit(-5), clampLimit(1e9), clampLimit(7.9), clampLimit(NaN)]).toEqual([1, 1, 200, 7, 50]);
  });

  it("cursor round-trips and rejects junk", () => {
    expect(decodeCursor(encodeCursor(123))).toBe(123);
    expect(() => decodeCursor("")).toThrow();
    expect(() => decodeCursor(Buffer.from("c1:-1").toString("base64url"))).toThrow();
  });
});
