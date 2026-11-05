// Configuration from the environment, validated once at startup. Secrets are wrapped so they
// cannot reach a log line, an error message or a JSON file by accident.

import { inspect } from "node:util";
import { resolve } from "node:path";
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

export type Network = "sandbox" | "testnet";
export const PERSONA_IDS = ["scout", "forge", "buyer"] as const;
export type PersonaId = (typeof PERSONA_IDS)[number];

// NEAR named account ids (https://nomicon.io/DataStructures/Account). Implicit accounts
// (64-hex ed25519 or 0x-prefixed eth) are refused: a typo there silently targets someone else.
const NAMED_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const IMPLICIT_ACCOUNT = /^([0-9a-f]{64}|0x[0-9a-f]{40})$/;

export function assertAccountId(id: string, network: Network, label: string): string {
  if (IMPLICIT_ACCOUNT.test(id)) throw new ConfigError(`${label}: implicit accounts are not accepted`);
  if (!NAMED_ACCOUNT.test(id)) throw new ConfigError(`${label}: not a valid NEAR account id`);
  if (network === "testnet" && !id.endsWith(".testnet")) {
    throw new ConfigError(`${label}: must be a .testnet account (testnet only, never mainnet)`);
  }
  return id;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));
const FC_KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{64,90}$/;

// Messages never interpolate the value: a malformed secret must not be echoed into a log.
const EnvSchema = z.object({
  NEAR_NETWORK: z.enum(["sandbox", "testnet"], { error: "NEAR_NETWORK must be sandbox or testnet (never mainnet)" }),
  NEAR_RPC_URL: optionalString.pipe(z.url({ error: "NEAR_RPC_URL must be a URL" }).optional()),
  PURSER_CONTRACT_ID: optionalString,
  PROPOSER_TASK_ID: optionalString,
  NEAR_AI_CLOUD_BASE_URL: optionalString.transform((v) => v ?? "https://cloud-api.near.ai/v1"),
  NEAR_AI_CLOUD_API_KEY: optionalString,
  NEAR_AI_MODEL: optionalString.transform((v) => v ?? "z-ai/glm-5.3-flash"),
  PROPOSER_SCOUT_ACCOUNT_ID: optionalString,
  PROPOSER_SCOUT_FC_PRIVATE_KEY: optionalString,
  PROPOSER_FORGE_ACCOUNT_ID: optionalString,
  PROPOSER_FORGE_FC_PRIVATE_KEY: optionalString,
  PROPOSER_BUYER_ACCOUNT_ID: optionalString,
  PROPOSER_BUYER_FC_PRIVATE_KEY: optionalString,
  PROPOSER_JOURNAL_PATH: optionalString,
  PROPOSER_EVIDENCE_PATH: optionalString,
  PROPOSER_LOG_CONTENT: optionalString.transform((v) => v === "1"),
});

export interface DelegateCredentials {
  persona: PersonaId;
  accountId: string;
  fcKey: Secret;
}

export interface Config {
  network: Network;
  rpcUrl: string | undefined;
  contractId: string | undefined;
  taskId: string | undefined;
  nearAi: { baseUrl: string; apiKey: Secret | undefined; model: string };
  delegates: Partial<Record<PersonaId, DelegateCredentials>>;
  journalDir: string;
  evidencePath: string;
  logContent: boolean;
}

const DEFAULT_RPC: Record<Network, string | undefined> = {
  testnet: "https://test.rpc.fastnear.com",
  sandbox: undefined, // a sandbox announces its own URL
};

/** Parse and validate the environment. Throws ConfigError; never echoes a value. */
export function loadConfig(env: NodeJS.ProcessEnv, outDir = resolve(import.meta.dirname, "../out")): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) throw new ConfigError(z.prettifyError(parsed.error));
  const e = parsed.data;
  const network = e.NEAR_NETWORK;

  const delegates: Config["delegates"] = {};
  for (const persona of PERSONA_IDS) {
    const upper = persona.toUpperCase();
    const accountId = e[`PROPOSER_${upper}_ACCOUNT_ID` as keyof typeof e] as string | undefined;
    const key = e[`PROPOSER_${upper}_FC_PRIVATE_KEY` as keyof typeof e] as string | undefined;
    if (accountId === undefined && key === undefined) continue;
    if (accountId === undefined || key === undefined) {
      throw new ConfigError(`PROPOSER_${upper}_ACCOUNT_ID and PROPOSER_${upper}_FC_PRIVATE_KEY must be set together`);
    }
    if (!FC_KEY.test(key)) throw new ConfigError(`PROPOSER_${upper}_FC_PRIVATE_KEY is not an ed25519 secret key`);
    delegates[persona] = {
      persona,
      accountId: assertAccountId(accountId, network, `PROPOSER_${upper}_ACCOUNT_ID`),
      fcKey: new Secret(key),
    };
  }

  return {
    network,
    rpcUrl: e.NEAR_RPC_URL ?? DEFAULT_RPC[network],
    contractId: e.PURSER_CONTRACT_ID && assertAccountId(e.PURSER_CONTRACT_ID, network, "PURSER_CONTRACT_ID"),
    taskId: e.PROPOSER_TASK_ID,
    nearAi: {
      baseUrl: e.NEAR_AI_CLOUD_BASE_URL,
      apiKey: e.NEAR_AI_CLOUD_API_KEY === undefined ? undefined : new Secret(e.NEAR_AI_CLOUD_API_KEY),
      model: e.NEAR_AI_MODEL,
    },
    delegates,
    journalDir: e.PROPOSER_JOURNAL_PATH ?? resolve(outDir, "journal"),
    evidencePath: e.PROPOSER_EVIDENCE_PATH ?? resolve(outDir, "evidence.jsonl"),
    logContent: e.PROPOSER_LOG_CONTENT,
  };
}

/**
 * Refuse to run against anything but the configured network, judged by what the RPC node
 * itself reports — not by a URL denylist. `status.chain_id` is "testnet" on testnet and
 * "mainnet" on mainnet; a local sandbox reports its own id (see SANDBOX_CHAIN_IDS).
 */
export const SANDBOX_CHAIN_IDS = new Set(["localnet", "sandbox", "test-chain-sandbox"]);

export function assertChainId(network: Network, chainId: string): void {
  const ok = network === "testnet" ? chainId === "testnet" : SANDBOX_CHAIN_IDS.has(chainId);
  if (!ok) throw new ConfigError(`RPC reports chain_id "${chainId}", expected ${network}; refusing to run`);
}
