// Pure helpers for the testnet demo driver (demo.ts): input validation, near-cli output parsing,
// explorer links and output scrubbing. No I/O here, so they are unit-tested.

export const RUN_ID = /^[a-z0-9-]{1,32}$/;
const BASE58_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const ED25519_SECRET_RE = /ed25519:[A-Za-z0-9]{40,}/g;

export function assertRunId(id: string): string {
  if (!RUN_ID.test(id)) throw new Error("RUN_ID must match ^[a-z0-9-]{1,32}$");
  return id;
}

/** Task id for one demo run. The run id is validated first, so it cannot widen the id. */
export const taskIdFor = (runId: string): string => `demo-${assertRunId(runId)}`;

/** near-cli-rs prints `Transaction ID: <hash>` on stderr after a send (no JSON flag exists). */
export function parseTxId(stderr: string): string | null {
  const m = /Transaction ID:\s*(\S+)/.exec(stderr);
  return m && BASE58_HASH.test(m[1]!) ? m[1]! : null;
}

/** A link is built only from a fixed host and a hash that looks like one. */
export function explorerUrl(txHash: string): string {
  if (!BASE58_HASH.test(txHash)) throw new Error("not a transaction hash");
  return `https://testnet.nearblocks.io/txns/${txHash}`;
}

/** Anything that looks like an ed25519 secret key never reaches the terminal. */
export const scrub = (s: string): string => s.replace(ED25519_SECRET_RE, "ed25519:[redacted]");

/** `units` budget units (1 unit = cap/100) as yocto. Exact integer math; cap must divide into 100 units. */
export function unitsToYocto(capYocto: bigint, units: bigint): bigint {
  if (capYocto <= 0n || capYocto % 100n !== 0n) throw new Error("cap must be a positive multiple of 100 yocto");
  return (capYocto / 100n) * units;
}

/** The demo cap in NEAR (up to 3 decimals, e.g. "1" or "0.5") as exact yocto. */
export function capNearToYocto(near: string): bigint {
  if (!/^(0|[1-9][0-9]{0,3})(\.[0-9]{1,3})?$/.test(near)) throw new Error("DEMO_CAP_NEAR must be a NEAR amount with up to 3 decimals (e.g. 1 or 0.5)");
  const [whole = "0", frac = ""] = near.split(".");
  const yocto = BigInt(whole) * 10n ** 24n + BigInt(frac.padEnd(24, "0"));
  if (yocto === 0n) throw new Error("DEMO_CAP_NEAR must be greater than zero");
  return yocto;
}
