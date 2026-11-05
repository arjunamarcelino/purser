import { describe, expect, it } from "vitest";
import { assertRunId, explorerUrl, parseTxId, scrub, taskIdFor, unitsToYocto, capNearToYocto } from "../../src/dev/demo-lib.ts";

const HASH = "AiziHNaehWKh9NbxE3M3bw7ecCZ3Jtmkz7zzcu46HUwu";

describe("run id and task id", () => {
  it("accepts lowercase, digits and dashes", () => {
    expect(taskIdFor("20261105-1")).toBe("demo-20261105-1");
  });
  it.each(["", "UPPER", "a b", "../x", 'a"b', "a".repeat(33), "a_b"])("rejects %j", (bad) => {
    expect(() => assertRunId(bad)).toThrow();
  });
});

describe("parseTxId", () => {
  it("reads the hash from near-cli stderr", () => {
    expect(parseTxId(`├  Transaction Execution Info:\n│    Transaction ID: ${HASH}\n│    url`)).toBe(HASH);
  });
  it("returns null when absent or malformed", () => {
    expect(parseTxId("no hash here")).toBeNull();
    expect(parseTxId("Transaction ID: not-a-hash!")).toBeNull();
  });
});

describe("explorerUrl", () => {
  it("builds a fixed-host link", () => {
    expect(explorerUrl(HASH)).toBe(`https://testnet.nearblocks.io/txns/${HASH}`);
  });
  it("refuses anything that is not a hash", () => {
    expect(() => explorerUrl("x/../y")).toThrow();
  });
});

describe("scrub", () => {
  it("redacts ed25519 secret-key-shaped strings", () => {
    const key = `ed25519:${"A".repeat(60)}`;
    expect(scrub(`secret ${key} end`)).toBe("secret ed25519:[redacted] end");
  });
});

describe("units", () => {
  it("derives 30 units from the cap", () => {
    const cap = capNearToYocto("1");
    expect(unitsToYocto(cap, 30n)).toBe(3n * 10n ** 23n);
  });
  it("accepts a decimal cap and derives units exactly", () => {
    expect(capNearToYocto("0.5")).toBe(5n * 10n ** 23n);
    expect(unitsToYocto(capNearToYocto("0.5"), 30n)).toBe(15n * 10n ** 22n);
  });
  it("rejects zero, negative-looking and over-precise caps", () => {
    for (const bad of ["0", "0.0", "1.2345", "-1", "1e3", ""]) expect(() => capNearToYocto(bad)).toThrow();
  });
});
