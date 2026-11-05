// Environment -> validated config. Secrets are wrapped so they cannot reach a log line, an error
// message or a JSON file by accident. The relayer holds NO EVM key: RELAYER_PRIVATE_KEY is its NEAR
// function-call key, scoped to attest_external / mark_unknown / request_cancel.

import { inspect } from "node:util";
import { z } from "zod";

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

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** A failed startup check; the message is ours and never carries a configured value. */
export class StartupError extends Error {
  override name = "StartupError";
}

/** The only EVM chain the relayer will ever talk to (Sepolia). The eth_chainId check is the real backstop. */
export const SEPOLIA_CHAIN_ID = 11155111n;

const NAMED_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const IMPLICIT_ACCOUNT = /^([0-9a-f]{64}|0x[0-9a-f]{40})$/;
const FC_KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{64,90}$/;

const accountId = (label: string) =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .refine((v) => NAMED_ACCOUNT.test(v) && !IMPLICIT_ACCOUNT.test(v), { error: `${label} is not a named NEAR account id` })
    .refine((v) => v.endsWith(".testnet"), { error: `${label} must be a .testnet account (testnet only)` });

const optional = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

// Messages never interpolate the value: a malformed secret must not be echoed.
const httpsUrl = (label: string) =>
  z.string({ error: `${label} is required` }).refine(
    (v) => {
      try {
        return new URL(v).protocol === "https:";
      } catch {
        return false;
      }
    },
    { error: `${label} must be an https URL` },
  );

const EnvSchema = z.object({
  NEAR_NETWORK: z.literal("testnet", { error: "NEAR_NETWORK must be testnet (the relayer refuses everything else)" }),
  NEAR_RPC_URL: optional.pipe(z.url({ error: "NEAR_RPC_URL must be a URL" }).optional()),
  EVM_PURSER_CONTRACT_ID: accountId("EVM_PURSER_CONTRACT_ID"),
  RELAYER_ACCOUNT_ID: accountId("RELAYER_ACCOUNT_ID"),
  RELAYER_PRIVATE_KEY: z.string({ error: "RELAYER_PRIVATE_KEY is required" }).trim().regex(FC_KEY, { error: "RELAYER_PRIVATE_KEY is not an ed25519 secret key" }),
  EVM_RPC_URL: httpsUrl("EVM_RPC_URL"),
  EVM_RPC_URL_2: optional.pipe(httpsUrl("EVM_RPC_URL_2").optional()),
  OPERATOR_ACCOUNT_ID: optional,
  RELAYER_POLL_MS: optional.transform((v) => (v === undefined ? undefined : Number(v))).pipe(z.number({ error: "RELAYER_POLL_MS must be a number" }).int().min(1000).max(600_000).optional()),
});

export interface Config {
  network: "testnet";
  nearRpcUrl: string;
  contractId: string;
  relayerAccountId: string;
  relayerKey: Secret;
  /** Primary first. Every URL is a Secret: provider URLs routinely embed an API key. */
  evmRpcUrls: Secret[];
  /** For the "relayer != owner" check, when the operator account is known (the contract has no owner view). */
  operatorAccountId: string | undefined;
  pollMs: number;
  /** Finality is fixed. `Safe` never changes contract state, so there is no knob. */
  finality: "finalized";
}

/** Parse and validate the environment. Throws ConfigError; never echoes a value. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) throw new ConfigError(z.prettifyError(parsed.error));
  const e = parsed.data;
  if (e.OPERATOR_ACCOUNT_ID !== undefined && e.OPERATOR_ACCOUNT_ID === e.RELAYER_ACCOUNT_ID) {
    throw new ConfigError("RELAYER_ACCOUNT_ID must differ from the owner/operator account (two-key release)");
  }
  const urls = [e.EVM_RPC_URL, ...(e.EVM_RPC_URL_2 ? [e.EVM_RPC_URL_2] : [])];
  if (new Set(urls).size !== urls.length) throw new ConfigError("EVM_RPC_URL_2 must differ from EVM_RPC_URL (two independent RPCs)");
  return {
    network: "testnet",
    nearRpcUrl: e.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com",
    contractId: e.EVM_PURSER_CONTRACT_ID,
    relayerAccountId: e.RELAYER_ACCOUNT_ID,
    relayerKey: new Secret(e.RELAYER_PRIVATE_KEY),
    evmRpcUrls: urls.map((u) => new Secret(u)),
    operatorAccountId: e.OPERATOR_ACCOUNT_ID,
    pollMs: e.RELAYER_POLL_MS ?? 15_000,
    finality: "finalized",
  };
}
