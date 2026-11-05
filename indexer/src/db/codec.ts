// Value handling shared by both drivers. Amounts and heights never pass through JS `number`.

export class InvalidCursorError extends Error {
  readonly kind = "invalid_cursor" as const;
}

export function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "string" && /^(0|-?[1-9][0-9]*)$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  throw new TypeError(`cannot convert ${typeof v} to bigint losslessly`);
}

/** Canonical yocto string: no sign, no leading zeros, at most 39 digits. */
export function assertYocto(v: string, field: string): string {
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,38})$/.test(v)) {
    throw new TypeError(`${field}: not a canonical non-negative decimal integer`);
  }
  return v;
}

/** The only JSON serializer for cache data: bigint becomes a decimal string. */
export function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

export function encodeCursor(commitmentId: number): string {
  return Buffer.from(`c1:${commitmentId}`, "utf8").toString("base64url");
}

/** Returns the last commitment_id of the previous page. Anything malformed is rejected, never interpolated. */
export function decodeCursor(cursor: string): number {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cursor)) throw new InvalidCursorError("invalid cursor");
  const m = /^c1:(0|[1-9][0-9]{0,14})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!m?.[1]) throw new InvalidCursorError("invalid cursor");
  return Number(m[1]);
}
