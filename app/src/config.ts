// Runtime config, frozen at build time by vite.config.ts from an explicit allowlist of three keys.
// Nothing else from the repo's .env files can reach the bundle.

import { NEAR_ACCOUNT_ID } from "@purser/types";

declare const __PURSER_CONFIG__: { contractId: string; network: string; rpcUrl: string };

export interface AppConfig {
  readonly contractId: string;
  readonly network: "testnet";
  readonly rpcUrl: string;
  readonly explorer: string;
}

function load(): AppConfig {
  const raw = __PURSER_CONFIG__;
  if (raw.network !== "testnet") throw new Error(`NEAR_NETWORK must be "testnet" (got "${raw.network}") — this board never targets mainnet`);
  if (!NEAR_ACCOUNT_ID.test(raw.contractId) || !raw.contractId.endsWith(".testnet")) {
    throw new Error("PURSER_CONTRACT_ID must be a .testnet account (set it in .env.testnet via scripts/deploy-testnet.sh)");
  }
  const rpc = new URL(raw.rpcUrl);
  if (rpc.protocol !== "https:") throw new Error("NEAR_RPC_URL must be https");
  return Object.freeze({ contractId: raw.contractId, network: "testnet", rpcUrl: rpc.toString(), explorer: "https://testnet.nearblocks.io" });
}

export const config: AppConfig = load();

/** Explorer links, built with URL + encoding — never by string concatenation of untrusted values. */
export const explorer = {
  tx: (hash: string) => new URL(`/txns/${encodeURIComponent(hash)}`, config.explorer).toString(),
  account: (id: string) => new URL(`/address/${encodeURIComponent(id)}`, config.explorer).toString(),
};
