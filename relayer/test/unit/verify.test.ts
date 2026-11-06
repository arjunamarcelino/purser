import { describe, expect, it } from "vitest";
import { SEPOLIA_CHAIN_ID } from "../../src/config.ts";
import { verifyRaw, type Hex, type TxFields } from "../../src/evm.ts";
import { LANE_ADDRESS, RECIPIENT, signLegacy, signTx } from "./fakes.ts";

const LANE = { address: LANE_ADDRESS, nonce: 4n };
const BASE = { nonce: 4, to: RECIPIENT, value: 5n, maxFee: 100n, tip: 2n } as const;

async function fields(over: Partial<Parameters<typeof signTx>[0]> = {}, claim: Partial<TxFields> = {}): Promise<TxFields> {
  const { raw, hash } = await signTx({ ...BASE, ...over });
  return { raw, txHash: hash, to: RECIPIENT, value: 5n, maxFee: 100n, tip: 2n, ...claim };
}

describe("verifyRaw", () => {
  it("accepts exactly what the contract described", async () => {
    expect(await verifyRaw(await fields(), LANE, SEPOLIA_CHAIN_ID)).toBe("ok");
  });

  it("is absent without bytes or hash", async () => {
    expect(await verifyRaw({ ...(await fields()), raw: null }, LANE, SEPOLIA_CHAIN_ID)).toBe("absent");
  });

  const cases: Array<[string, Parameters<typeof signTx>[0] extends infer T ? Partial<T> : never, Partial<TxFields>, string]> = [
    ["gas limit other than 21000", { gas: 21_001n }, {}, "bad_fields"],
    ["calldata present", { data: "0xdeadbeef" }, {}, "bad_fields"],
    ["a non-empty access list", { accessList: [{ address: RECIPIENT, storageKeys: [] }] }, {}, "bad_fields"],
    ["wrong chain id", { chainId: 1 }, {}, "bad_chain"],
    ["max fee differs from the view", {}, { maxFee: 101n }, "bad_fields"],
    ["tip differs from the view", {}, { tip: 3n }, "bad_fields"],
    ["recipient differs from the view", {}, { to: "0x2222222222222222222222222222222222222222" }, "bad_fields"],
    ["value differs from the view", {}, { value: 6n }, "bad_fields"],
    ["nonce differs from the lane", { nonce: 5 }, {}, "bad_fields"],
  ];
  for (const [name, signed, claim, verdict] of cases) {
    it(`refuses ${name}`, async () => {
      expect(await verifyRaw(await fields(signed, claim), LANE, SEPOLIA_CHAIN_ID)).toBe(verdict);
    });
  }

  it("refuses a legacy (type 0) transaction", async () => {
    const { raw, hash } = await signLegacy({ nonce: 4, to: RECIPIENT, value: 5n, gasPrice: 100n });
    expect(await verifyRaw({ raw, txHash: hash, to: RECIPIENT, value: 5n, maxFee: 100n, tip: 2n }, LANE, SEPOLIA_CHAIN_ID)).toBe("bad_fields");
  });

  it("refuses bytes whose hash is not the contract's, and a different signer", async () => {
    const f = await fields();
    expect(await verifyRaw({ ...f, txHash: `0x${"00".repeat(32)}` }, LANE, SEPOLIA_CHAIN_ID)).toBe("bad_hash");
    expect(await verifyRaw(f, { address: "0x3333333333333333333333333333333333333333" as Hex, nonce: 4n }, SEPOLIA_CHAIN_ID)).toBe("bad_signer");
  });

  it("a cancel shape (self-send, value 0) is accepted when the view says so, and refused with calldata", async () => {
    const cancel = await fields({ to: LANE_ADDRESS, value: 0n }, { to: LANE_ADDRESS, value: 0n });
    expect(await verifyRaw(cancel, LANE, SEPOLIA_CHAIN_ID)).toBe("ok");
    const withData = await fields({ to: LANE_ADDRESS, value: 0n, data: "0x01" }, { to: LANE_ADDRESS, value: 0n });
    expect(await verifyRaw(withData, LANE, SEPOLIA_CHAIN_ID)).toBe("bad_fields");
  });
});
