#!/usr/bin/env node
// naive-baseline — the comparison shot of docs/PURSER-DEMO-SCRIPT.md. Deliberately UNSAFE, written for
// this demo; not Purser and not any real product. The spending limit lives inside the agents: each
// reads the shared account's balance, sees 100 of 100 units left, and sends a real 60-unit testnet
// transfer. Nothing reserves the budget, so both spend and the cap is blown by 20.
//
//   pnpm --filter @purser/proposer run naive-baseline
//
// The throwaway account naive.<operator> holds no contract and only what scripts/demo.sh setup funds.
// On full success, and only then, stdout gets one `BASELINE {json}` line; progress goes to stderr.

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Account, JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";
import { assertAccountId, assertChainId, loadConfig } from "../config.ts";
import { retryRateLimited } from "../purser-client.ts";
import { type BaselineLane, baselineSeenUnits, formatBaselineLine, judgeBaseline, makeScrubber, scrub, urlSecrets } from "./demo-lib.ts";

const CAP = 10n ** 23n; // 0.1 NEAR = 100 units: a policy number the agents hold themselves
const UNIT = CAP / 100n;
const CAP_UNITS = 100;
const SPEND = 60n * UNIT;
const GAS_MARGIN = 10n ** 22n;
const KEYS = resolve(import.meta.dirname, "../../../.near-keys");

let scrubber: (s: string) => string = scrub;
const progress = (line: string) => process.stderr.write(`${scrubber(line)}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readKey(name: string): string {
  const path = resolve(KEYS, `${name}.key`);
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${name}.key must be mode 0600`);
  return readFileSync(path, "utf8").trim();
}

async function main(): Promise<number> {
  if (process.env.NEAR_NETWORK !== "testnet") throw new Error("the baseline runs on testnet only (never mainnet)");
  const cfg = loadConfig({ ...process.env, NEAR_NETWORK: "testnet" });
  const operator = assertAccountId(process.env.OPERATOR_ACCOUNT_ID ?? "", "testnet", "OPERATOR_ACCOUNT_ID");
  if (!cfg.rpcUrl || !cfg.merchants) throw new Error("run scripts/deploy-testnet.sh first (.env.testnet is incomplete)");
  const rpcUrl = cfg.rpcUrl;
  scrubber = makeScrubber(urlSecrets(rpcUrl));
  const provider = new JsonRpcProvider({ url: rpcUrl });
  assertChainId("testnet", (await retryRateLimited(() => provider.viewNodeStatus())).chain_id); // before either key is read

  const shared = `naive.${operator}`;
  const keys = [readKey("naive-a"), readKey("naive-b")] as const;
  scrubber = makeScrubber([...urlSecrets(rpcUrl), ...keys]);
  const agent = (key: string) => new Account(shared, provider, KeyPairSigner.fromSecretKey(key as KeyPairString));
  const [agentA, agentB] = [agent(keys[0]), agent(keys[1])];
  const { data, compute } = cfg.merchants;

  // One anchor for the whole run: the balance and both merchants, all at the same final block.
  const head = await retryRateLimited(() => provider.viewBlock({ finality: "final" }));
  const at = { blockId: Number(head.header.height) };
  const atAnchor = (accountId: string) => retryRateLimited(() => provider.viewAccount({ accountId, blockQuery: at }));
  const [anchor, data0, compute0] = await Promise.all([atAnchor(shared), atAnchor(data), atAnchor(compute)]);
  const spendable = BigInt(anchor.amount) - BigInt(anchor.storage_usage) * 10n ** 19n;
  if (spendable < SPEND * 2n + GAS_MARGIN) {
    throw new Error(`${shared} cannot fund a run. Top it up: near tokens ${operator} send-near ${shared} '0.5 NEAR' network-config testnet sign-with-keychain send`);
  }

  // Each agent checks the balance on its own. No backoff on these reads: a delayed read could see the
  // other agent's transfer. If either read fails nothing has been sent, so the run stops here for free.
  const check = () => provider.viewAccount({ accountId: shared, blockQuery: { finality: "final" } });
  const [readA, readB] = await Promise.all([check(), check()]);
  const seen = [readA, readB].map((r) => baselineSeenUnits(BigInt(anchor.amount), BigInt(r.amount), CAP, UNIT));
  progress(`agent A reads ${seen[0]} units left at block ${readA.block_height}; agent B reads ${seen[1]} at block ${readB.block_height}`);
  if (seen[0] !== CAP_UNITS || seen[1] !== CAP_UNITS) throw new Error("the account moved since the anchor; nothing was sent, run it again");

  // Both agents pass their own check, so both spend. Separate keys, so separate nonces.
  const sent = await Promise.allSettled([agentA.transfer({ receiverId: data, amount: SPEND }), agentB.transfer({ receiverId: compute, amount: SPEND })]);
  const [sa, sb] = sent;
  if (sa.status === "rejected" || sb.status === "rejected") {
    const landed = sent.flatMap((s) => (s.status === "fulfilled" ? [s.value.transaction.hash] : []));
    throw new Error(`a transfer failed: ${sent.flatMap((s) => (s.status === "rejected" ? [s.reason instanceof Error ? s.reason.message : String(s.reason)] : [])).join("; ")}; landed: ${landed.join(" ") || "none"}`);
  }

  /** Re-read a transfer from the chain; returns the lane plus the last block its receipts ran in. */
  const verify = async (hash: string, to: string, read: number): Promise<{ lane: BaselineLane; settled: number }> => {
    const res = await retryRateLimited(() => provider.viewTransactionStatus({ txHash: hash, accountId: shared, waitUntil: "EXECUTED" }));
    const tx = res.transaction as { signer_id: string; receiver_id: string; actions: Array<{ Transfer?: { deposit: string } }> };
    if (tx.signer_id !== shared || tx.receiver_id !== to) throw new Error(`tx ${hash} is ${tx.signer_id} -> ${tx.receiver_id}, expected ${shared} -> ${to}`);
    const heightOf = async (blockId: string) => Number((await retryRateLimited(() => provider.viewBlock({ blockId }))).header.height);
    const included = await heightOf(res.transaction_outcome.block_hash);
    let settled = included;
    for (const blockHash of new Set(res.receipts_outcome.map((r) => r.block_hash))) settled = Math.max(settled, await heightOf(blockHash));
    const ok = typeof res.status === "object" && "SuccessValue" in res.status;
    return { lane: { hash, to, read, included, deposit: BigInt(tx.actions[0]?.Transfer?.deposit ?? "0"), ok }, settled };
  };
  const [a, b] = await Promise.all([verify(sa.value.transaction.hash, data, readA.block_height), verify(sb.value.transaction.hash, compute, readB.block_height)]);

  // An oracle that does not trust the sends: what the merchants actually received, once the credits are final.
  const minHeight = Math.max(a.settled, b.settled);
  let finalHead = 0;
  for (let i = 0; finalHead < minHeight; i++) {
    if (i > 0) await sleep(1000);
    if (i > 40) throw new Error(`final head never reached block ${minHeight}`);
    finalHead = Number((await retryRateLimited(() => provider.viewBlock({ finality: "final" }))).header.height);
  }
  const after = (accountId: string) => retryRateLimited(() => provider.viewAccount({ accountId, blockQuery: { blockId: finalHead } }));
  const [data1, compute1] = await Promise.all([after(data), after(compute)]);
  const merchantDelta = BigInt(data1.amount) - BigInt(data0.amount) + (BigInt(compute1.amount) - BigInt(compute0.amount));

  const verdict = judgeBaseline(a.lane, b.lane, { spend: SPEND, unit: UNIT, capUnits: CAP_UNITS, sawUnits: CAP_UNITS, merchantDelta });
  if (!verdict.pass || !verdict.result) throw new Error(`the double-spend was not proven: ${verdict.reasons.join("; ")}`);
  progress(`spent ${verdict.result.spentUnits} of ${CAP_UNITS} units: over the cap by ${verdict.result.overUnits}`);
  process.stdout.write(`${formatBaselineLine(verdict.result)}\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    progress(`naive-baseline: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
