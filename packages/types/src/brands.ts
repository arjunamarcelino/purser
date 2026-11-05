// Branded wire types. The ABI cannot express these (NearToken is a bare JSON string, u64 a bare
// number), so values get their brand at the one place they are validated.

export const U128_MAX = (1n << 128n) - 1n;

declare const yocto: unique symbol;
/** A NearToken amount on the wire: a decimal yoctoNEAR string within u128. */
export type YoctoString = string & { readonly [yocto]: true };

export function yoctoFromBigint(v: bigint): YoctoString {
  if (v < 0n || v > U128_MAX) throw new RangeError(`yocto amount out of u128 range: ${v}`);
  return v.toString() as YoctoString;
}

declare const cid: unique symbol;
/** A contract-assigned commitment id (u64; always a safe integer in practice, checked on entry). */
export type CommitmentId = number & { readonly [cid]: true };

export function toCommitmentId(n: unknown): CommitmentId {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`not a valid commitment id: ${String(n)}`);
  }
  return n as CommitmentId;
}

declare const rid: unique symbol;
/** A client idempotency key: a UUID minted once per decision. */
export type RequestId = string & { readonly [rid]: true };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function toRequestId(s: string): RequestId {
  if (!UUID.test(s)) throw new RangeError(`request_id must be a lowercase UUID: ${s}`);
  return s as RequestId;
}
