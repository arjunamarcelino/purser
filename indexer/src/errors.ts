// Error taxonomy: classes with a `kind` literal (no enums: erasableSyntaxOnly).

export { MetaMismatchError, RepoUnavailableError } from "./db/types.ts";

/** Transient read failure (RPC down, rate limited past retries, timeout): keep last good state, retry next pass. */
export class ChainReadError extends Error {
  readonly kind = "chain_read" as const;
}

/** The chain answered with something the cache cannot represent faithfully. Never retried, never coerced. */
export class ChainShapeError extends Error {
  readonly kind = "chain_shape" as const;
}

export class ConfigError extends Error {
  readonly kind = "config" as const;
}
