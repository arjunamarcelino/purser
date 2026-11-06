// Startup checks. Each failure throws a StartupError whose message is OURS (never an RPC error's text,
// which embeds the provider URL and key).

import { SEPOLIA_CHAIN_ID, StartupError, type Config } from "./config.ts";
import type { EvmClient } from "./evm.ts";
import { describeError, type Logger } from "./log.ts";
import type { NearClient } from "./near.ts";

export { StartupError };

export async function startupChecks(cfg: Pick<Config, "relayerAccountId" | "operatorAccountId"> & Partial<Pick<Config, "allowSingleRpcEvidence">>, evm: EvmClient[], near: NearClient, log: Logger): Promise<void> {
  for (const c of evm) {
    let id: bigint;
    try {
      id = await c.chainId();
    } catch (err) {
      throw new StartupError(`${c.label}: eth_chainId failed (${describeError(err)})`);
    }
    if (id !== SEPOLIA_CHAIN_ID) throw new StartupError(`${c.label}: chain id ${id} is not Sepolia (${SEPOLIA_CHAIN_ID}); refusing to run`);
    try {
      await c.getFinalized();
    } catch (err) {
      throw new StartupError(`${c.label}: the "finalized" block tag is not supported (${describeError(err)}); use a provider that serves it`);
    }
  }
  if (evm.length < 2) {
    // One RPC cannot corroborate itself: release evidence is withheld unless the operator opted in.
    log({ event: "warn", code: "single_rpc_evidence", cid: null, detail: cfg.allowSingleRpcEvidence === true ? "opt_in_single_rpc_evidence_enabled" : "release_evidence_disabled_set_EVM_RPC_URL_2" });
  }

  await near.pin();
  const evmCfg = await near.getEvmCfg();
  if (evmCfg === null) throw new StartupError("the contract has no EVM configuration (set_evm_cfg not called)");
  if (evmCfg.chainId !== SEPOLIA_CHAIN_ID) throw new StartupError(`the contract is configured for chain ${evmCfg.chainId}, not Sepolia`);
  const relayer = await near.getRelayer();
  if (relayer !== cfg.relayerAccountId) throw new StartupError("the contract's relayer is not RELAYER_ACCOUNT_ID (owner must call set_relayer)");
  // The contract has no owner view; set_relayer already refuses relayer == owner, and OPERATOR_ACCOUNT_ID
  // (when set) was compared in loadConfig.
}
