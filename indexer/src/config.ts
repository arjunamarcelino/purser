// Configuration from the environment, validated once at startup. DATABASE_URL may embed a password,
// so it is wrapped to keep it out of logs, error messages and JSON dumps.

import { inspect } from "node:util";
import { z } from "zod";
import { ConfigError } from "./errors.ts";

export { ConfigError };

/** A secret value. Every implicit conversion yields "[redacted]"; only `reveal()` returns it. */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return "[redacted]";
  }
  toJSON(): string {
    return "[redacted]";
  }
  [Symbol.toPrimitive](): string {
    return "[redacted]";
  }
  [inspect.custom](): string {
    return "Secret([redacted])";
  }
}

export type Network = "sandbox" | "testnet";

const NAMED_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const IMPLICIT_ACCOUNT = /^([0-9a-f]{64}|0x[0-9a-f]{40})$/;
const DB_SCHEME = /^(sqlite|postgres|postgresql):/i;
const DEFAULT_DATABASE_URL = "sqlite://./purser-indexer.db";

export type DatabaseTarget = { kind: "sqlite"; path: string } | { kind: "postgres"; url: string };

/**
 * `new URL` mangles relative sqlite paths, so sqlite is parsed by hand: strip `sqlite:`, then one
 * leading `//`. `sqlite://./rel.db` -> `./rel.db`, `sqlite:///abs/x.db` -> `/abs/x.db`, `sqlite::memory:` -> `:memory:`.
 */
export function parseDatabaseUrl(url: string): DatabaseTarget {
  if (/^postgres(ql)?:/i.test(url)) return { kind: "postgres", url };
  if (!/^sqlite:/i.test(url)) throw new ConfigError("DATABASE_URL scheme must be sqlite:, postgres: or postgresql:");
  let rest = url.slice("sqlite:".length);
  if (rest.startsWith("//")) rest = rest.slice(2);
  if (rest === "") throw new ConfigError("DATABASE_URL has no sqlite path");
  return { kind: "sqlite", path: rest };
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/i;
export const isLoopbackHost = (host: string): boolean => LOOPBACK.test(host);

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

const intVar = (name: string, def: number, min: number, max: number) =>
  optionalString.transform((v, ctx) => {
    if (v === undefined) return def;
    const n = /^\d{1,9}$/.test(v) ? Number(v) : NaN;
    if (!(n >= min && n <= max)) {
      ctx.addIssue({ code: "custom", message: `${name} must be an integer in [${min}, ${max}]` });
      return z.NEVER;
    }
    return n;
  });

// Messages never interpolate the value: a malformed URL may carry a password.
const EnvSchema = z.object({
  DATABASE_URL: optionalString.transform((v) => v ?? DEFAULT_DATABASE_URL).refine((v) => DB_SCHEME.test(v), {
    error: "DATABASE_URL scheme must be sqlite:, postgres: or postgresql:",
  }),
  NEAR_NETWORK: z.enum(["sandbox", "testnet"], { error: "NEAR_NETWORK must be sandbox or testnet (never mainnet)" }),
  NEAR_RPC_URL: optionalString.pipe(z.url({ error: "NEAR_RPC_URL must be a URL" }).optional()),
  PURSER_CONTRACT_ID: z.string({ error: "PURSER_CONTRACT_ID is required" }).trim().min(1, "PURSER_CONTRACT_ID is required"),
  POLL_INTERVAL_MS: intVar("POLL_INTERVAL_MS", 15_000, 1000, 3_600_000),
  POLL_PASS_BUDGET_MS: intVar("POLL_PASS_BUDGET_MS", 45_000, 1000, 3_600_000),
  API_HOST: optionalString.transform((v) => v ?? "127.0.0.1"),
  API_PORT: intVar("API_PORT", 8787, 1, 65_535),
});

export interface Config {
  network: Network;
  rpcUrl: string | undefined;
  contractId: string;
  databaseUrl: Secret;
  pollIntervalMs: number;
  passBudgetMs: number;
  apiHost: string;
  apiPort: number;
}

const DEFAULT_RPC: Record<Network, string | undefined> = {
  testnet: "https://test.rpc.fastnear.com",
  sandbox: undefined, // a sandbox announces its own URL
};

function assertAccountId(id: string, network: Network): string {
  if (IMPLICIT_ACCOUNT.test(id)) throw new ConfigError("PURSER_CONTRACT_ID: implicit accounts are not accepted");
  if (!NAMED_ACCOUNT.test(id)) throw new ConfigError("PURSER_CONTRACT_ID: not a valid NEAR account id");
  if (network === "testnet" && !id.endsWith(".testnet")) {
    throw new ConfigError("PURSER_CONTRACT_ID: must be a .testnet account (testnet only, never mainnet)");
  }
  return id;
}

/** Parse and validate the environment. Throws ConfigError; never echoes a value. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) throw new ConfigError(z.prettifyError(parsed.error));
  const e = parsed.data;
  const network = e.NEAR_NETWORK;

  parseDatabaseUrl(e.DATABASE_URL); // shape check only; the value stays wrapped

  if (!isLoopbackHost(e.API_HOST)) throw new ConfigError("API_HOST must be a loopback address (127.0.0.1, localhost or ::1)");

  const rpcUrl = e.NEAR_RPC_URL ?? DEFAULT_RPC[network];
  if (rpcUrl !== undefined) {
    const u = new URL(rpcUrl);
    const local = network === "sandbox" || isLoopbackHost(u.hostname);
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) {
      throw new ConfigError("NEAR_RPC_URL must be https (http only for sandbox/localhost)");
    }
  }

  return {
    network,
    rpcUrl,
    contractId: assertAccountId(e.PURSER_CONTRACT_ID, network),
    databaseUrl: new Secret(e.DATABASE_URL),
    pollIntervalMs: e.POLL_INTERVAL_MS,
    passBudgetMs: e.POLL_PASS_BUDGET_MS,
    apiHost: e.API_HOST,
    apiPort: e.API_PORT,
  };
}
