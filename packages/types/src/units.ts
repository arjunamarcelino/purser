// Budget units: 1 unit = cap / 100. Exact integer math; display only, never an amount sent to the chain.

/** `units` budget units as yocto. The cap must divide into 100 units. */
export function unitsToYocto(capYocto: bigint, units: bigint): bigint {
  if (capYocto <= 0n || capYocto % 100n !== 0n) throw new Error("cap must be a positive multiple of 100 yocto");
  return (capYocto / 100n) * units;
}

/** Exact units for display: "40", or "40.9" with the remainder shown, never truncated. */
export function formatUnits(yocto: bigint, cap: bigint): string {
  const unit = unitsToYocto(cap, 1n);
  const whole = yocto / unit;
  const rem = yocto % unit;
  if (rem === 0n) return whole.toString();
  const frac = ((rem * 10000n) / unit).toString().padStart(4, "0").replace(/0+$/, "");
  return `${whole}.${frac || "0000"}~`;
}
