import { describe, expect, it } from "vitest";
import { bigintFromDecimalString, parseCommitment, parseSignedTx } from "../../src/near.ts";

describe("decimal-string boundary", () => {
  it("round-trips 1000 ETH in wei without precision loss", () => {
    const wei = 10n ** 18n * 1000n;
    expect(bigintFromDecimalString.parse(wei.toString())).toBe(wei);
    expect(bigintFromDecimalString.parse((wei * wei).toString())).toBe(wei * wei);
  });

  it("refuses JSON numbers, signs, fractions and leading zeros", () => {
    for (const bad of [1, 1e21, "-1", "1.5", "01", "0x10", "", " 1"]) expect(bigintFromDecimalString.safeParse(bad).success).toBe(false);
  });

  it("parses a get_signed_tx view into bigints", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const tx = parseSignedTx({
      commitment_id: 3,
      state: "Signed",
      path: "p",
      chain_id: "11155111",
      nonce: "7",
      from: "0x0f3798297b9500b6c63ecc6c8101a7d6fae81e02",
      signed_at_ns: "1700000000000000000",
      original: { max_fee_per_gas: "1000000000000000000000", max_priority_fee_per_gas: "1", to: "0x00", value: "1000000000000000000000", sighash: hash, raw_tx: "0x02f8", tx_hash: hash },
      cancel: null,
      evidence: null,
    });
    expect(tx?.nonce).toBe(7n);
    expect(tx?.signedAtNs).toBe(1_700_000_000_000_000_000n);
    expect(tx?.original.value).toBe(10n ** 21n);
  });

  it("parses a commitment (u64 created_at already a bigint) and flags EVM ones", () => {
    const c = parseCommitment({ id: 0, state: "Signed", created_at: 1_700_000_000_000_000_000n, intent: { chain: { Evm: { chain_id: 11155111 } } } });
    expect(c).toEqual({ id: 0, state: "Signed", evm: true, createdAtNs: 1_700_000_000_000_000_000n });
    expect(parseCommitment({ id: 1, state: "Reserved", created_at: 5n, intent: { chain: "NearNative" } })?.evm).toBe(false);
    expect(parseCommitment(null)).toBeNull();
  });
});
