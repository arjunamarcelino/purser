#!/usr/bin/env node
// relayer relay [--once]                              run the loop
// relayer status                                      print lane/commitment states and explorer links
// relayer cancel <cid> --max-fee <wei> --tip <wei>    ask the contract for the one nonce-burn cancel

import { parseArgs } from "node:util";
import { loadConfig, ConfigError, SEPOLIA_CHAIN_ID, StartupError, type Config } from "./config.ts";
import { ViemEvmClient, explorerTx, type EvmClient } from "./evm.ts";
import { describeError, installCrashHandlers, providerLabel, stderrLogger as log } from "./log.ts";
import { RpcNearClient, assertRelayerKey } from "./near.ts";
import { Relayer, cancelExitCode, requestCancel } from "./worker.ts";
import { startupChecks } from "./startup.ts";

const USAGE = `usage:
  relayer relay [--once]
  relayer status
  relayer cancel <commitment_id> --max-fee <wei> --tip <wei>`;

function build(cfg: Config, signal: AbortSignal) {
  const evm: EvmClient[] = cfg.evmRpcUrls.map((u, i) => new ViemEvmClient({ url: u.reveal(), label: providerLabel(i) }));
  const near = new RpcNearClient({ rpcUrl: cfg.nearRpcUrl, contractId: cfg.contractId, accountId: cfg.relayerAccountId, key: cfg.relayerKey, signal });
  return { evm, near };
}

const decimal = (v: string | undefined, label: string): bigint => {
  if (v === undefined || !/^(0|[1-9][0-9]*)$/.test(v)) throw new ConfigError(`${label} must be a decimal integer (wei)`);
  return BigInt(v);
};

async function main(): Promise<number> {
  installCrashHandlers(log);
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { once: { type: "boolean", default: false }, "max-fee": { type: "string" }, tip: { type: "string" } },
  });
  const [cmd, arg] = positionals;
  if (cmd !== "relay" && cmd !== "status" && cmd !== "cancel") {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const cfg = loadConfig(process.env);
  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => ac.abort());
  const { evm, near } = build(cfg, ac.signal);

  await assertRelayerKey(near.provider, cfg.relayerAccountId, cfg.relayerKey, cfg.contractId);
  await startupChecks(cfg, evm, near, log);
  log({ event: "config", network: cfg.network, contract_id: cfg.contractId, relayer: cfg.relayerAccountId, providers: evm.length, evidence: evm.length > 1 ? "dual_rpc" : cfg.allowSingleRpcEvidence ? "single_rpc_opt_in" : "single_rpc_withheld", finality: cfg.finality });
  log({ event: "startup_ok", chain_id: SEPOLIA_CHAIN_ID });

  if (cmd === "relay") {
    await new Relayer({ near, evm, log, allowSingleRpcEvidence: cfg.allowSingleRpcEvidence }).run(ac.signal, { pollMs: cfg.pollMs, once: values.once === true });
    return 0;
  }

  if (cmd === "cancel") {
    if (arg === undefined || !/^[0-9]+$/.test(arg)) throw new ConfigError("cancel needs a commitment id");
    const cid = Number(arg);
    const out = await requestCancel(near, log, cid, decimal(values["max-fee"], "--max-fee"), decimal(values.tip, "--tip"));
    const txNote = near.lastTxHash ? ` (NEAR tx ${near.lastTxHash})` : "";
    const code = cancelExitCode(out);
    if (code === 0) {
      process.stdout.write(`cid ${cid}: the cancel is on chain${out.result === "refused" ? " (it was already requested; nothing new was sent)" : ""}${txNote}. The running relayer broadcasts it; run \`status\` to follow it.\n`);
      return code;
    }
    if (code === 1) {
      process.stderr.write(`cid ${cid}: the cancel was REFUSED and nothing was requested (the commitment is not Unknown, or the contract rejected the call)${txNote}.\n`);
      return code;
    }
    process.stderr.write(`cid ${cid}: UNRESOLVED. The request was sent but its outcome could not be confirmed${txNote}. Run \`status\` and check whether a cancel exists for this commitment BEFORE running this command again (a second request is only safe because the contract rejects a duplicate).\n`);
    return code;
  }

  // status
  await near.pin();
  for (let cid = 0; ; cid++) {
    const c = await near.getCommitment(cid);
    if (c === null) break;
    if (!c.evm) continue;
    const tx = await near.getSignedTx(cid);
    if (tx === null) continue;
    log({
      event: "status",
      cid,
      state: tx.state,
      nonce: tx.nonce,
      original: tx.original.txHash,
      cancel: tx.cancel?.txHash ?? null,
      evidence: tx.evidence,
      explorer: tx.original.txHash ? explorerTx(tx.original.txHash) : null,
    });
    if (tx.cancel?.txHash) process.stdout.write(`cid ${cid} cancel: ${explorerTx(tx.cancel.txHash)}\n`);
    if (tx.original.txHash) process.stdout.write(`cid ${cid} ${tx.state} original: ${explorerTx(tx.original.txHash)}\n`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    // ConfigError/StartupError messages are ours and never carry a value; anything else is logged by class.
    if (err instanceof ConfigError || err instanceof StartupError) process.stderr.write(`${err.name}: ${err.message}\n`);
    else log({ event: "error", where: "main", class: describeError(err) });
    process.exit(1);
  },
);
