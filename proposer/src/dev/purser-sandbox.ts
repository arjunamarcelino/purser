// A Purser deployment on a local near-sandbox: contract, owner, task, three persona delegates
// (each holding ONLY a propose_payment function-call key), allowlisted merchants and one
// non-allowlisted "attacker". Dev/test tooling only — never used against testnet.
//
// Self-contained (imports nothing from the proposer's runtime modules) so it can move to a
// shared package when the indexer or metrics harness needs it.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString, nearToYocto } from "near-api-js";

export const NEAR = 10n ** 24n;
export const PERSONAS = ["scout", "forge", "buyer"] as const;
export type SandboxPersona = (typeof PERSONAS)[number];

export const PROD_WASM = process.env.PURSER_WASM_PROD ?? resolve(import.meta.dirname, "../../../contract/target/near/purser_contract.wasm");

/**
 * near-sandbox would otherwise download nearcore itself, with no integrity check. Require the
 * sha256-pinned binary from scripts/sandbox-bin.sh (what `make crew` / `make ts-test-sandbox` set).
 */
export function requireVerifiedSandboxBinary(): void {
  if (!process.env.NEAR_SANDBOX_BIN_PATH) {
    throw new Error('NEAR_SANDBOX_BIN_PATH is not set — run via make, or: export NEAR_SANDBOX_BIN_PATH="$(scripts/sandbox-bin.sh)"');
  }
}

export function readProdWasm(): Uint8Array {
  if (!existsSync(PROD_WASM)) throw new Error(`contract wasm not found at ${PROD_WASM} — run \`make build\` first`);
  return readFileSync(PROD_WASM);
}

export interface SandboxDelegate {
  accountId: string;
  /** Function-call key: receiver = Purser, methods = [propose_payment]. */
  fcKey: KeyPairString;
  fcPublicKey: string;
  /** Full-access key of the delegate account (tests only: to prove what the FC key cannot do). */
  fullKey: KeyPairString;
}

export interface PurserDeployment {
  provider: JsonRpcProvider;
  contractId: string;
  owner: Account;
  root: Account;
  delegates: Record<SandboxPersona, SandboxDelegate>;
  merchants: { data: string; compute: string; procurement: string; attacker: string };
  /** Create a fresh task (own delegates registered, own allowlist) on this deployment. */
  createTask(opts: { taskId: string; capNear: bigint; crewCap?: number }): Promise<void>;
  balance(accountId: string): Promise<bigint>;
}

let counter = 0;
const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

async function subAccount(root: Account, prefix: string, near: bigint): Promise<{ id: string; key: KeyPairString }> {
  const kp = KeyPair.fromRandom("ed25519");
  await root.createSubAccount({ accountOrPrefix: prefix, publicKey: kp.getPublicKey().toString(), nearToTransfer: near });
  return { id: `${prefix}.${root.accountId}`, key: kp.toString() as KeyPairString };
}

/**
 * Deploy Purser and its crew. `fundNear` is the contract's own balance: it pays merchants from
 * it, so it must exceed the caps of every task created on this deployment.
 */
export async function deployPurser(opts: { rpcUrl: string; rootId: string; rootKey: KeyPairString; fundNear?: bigint; fcAllowanceNear?: `${number}` }): Promise<PurserDeployment> {
  const provider = new JsonRpcProvider({ url: opts.rpcUrl });
  const root = new Account(opts.rootId, provider, opts.rootKey);
  const tag = uniq();

  const contract = await subAccount(root, `purser-${tag}`, (opts.fundNear ?? 600n) * NEAR);
  const owner = await subAccount(root, `owner-${tag}`, 20n * NEAR);
  const merchants = {
    data: (await subAccount(root, `data-${tag}`, 1n * NEAR)).id,
    compute: (await subAccount(root, `compute-${tag}`, 1n * NEAR)).id,
    procurement: (await subAccount(root, `procure-${tag}`, 1n * NEAR)).id,
    attacker: (await subAccount(root, `attacker-${tag}`, 1n * NEAR)).id,
  };

  const contractAccount = new Account(contract.id, provider, contract.key);
  await contractAccount.deployContract(readProdWasm());
  await contractAccount.callFunction({ contractId: contract.id, methodName: "new", args: { owner: owner.id, signer_id: `signer-${tag}.${opts.rootId}` } });

  const delegates = {} as Record<SandboxPersona, SandboxDelegate>;
  for (const p of PERSONAS) {
    const acct = await subAccount(root, `${p}-${tag}`, 5n * NEAR);
    const fc = KeyPair.fromRandom("ed25519");
    const delegateAccount = new Account(acct.id, provider, acct.key);
    // The delegate's own operator grants the proposer a key that can call ONE method.
    await delegateAccount.addFunctionCallAccessKey({
      publicKey: fc.getPublicKey().toString(),
      contractId: contract.id,
      methodNames: ["propose_payment"],
      allowance: nearToYocto(opts.fcAllowanceNear ?? "0.25"),
    });
    delegates[p] = { accountId: acct.id, fcKey: fc.toString() as KeyPairString, fcPublicKey: fc.getPublicKey().toString(), fullKey: acct.key };
  }

  const ownerAccount = new Account(owner.id, provider, owner.key);
  return {
    provider,
    contractId: contract.id,
    owner: ownerAccount,
    root,
    delegates,
    merchants,
    async createTask({ taskId, capNear, crewCap = 3 }) {
      const call = (methodName: string, args: Record<string, unknown>) => ownerAccount.callFunction({ contractId: contract.id, methodName, args });
      await call("create_task", { task_id: taskId, cap: (capNear * NEAR).toString(), token: "NearNative", crew_cap: crewCap });
      for (const p of PERSONAS) await call("add_delegate", { task_id: taskId, account_id: delegates[p].accountId, derivation_path: `purser/${taskId}/${p}` });
      await call("set_recipient_allowlist", { task_id: taskId, recipients: [merchants.data, merchants.compute, merchants.procurement] });
    },
    async balance(accountId) {
      return BigInt((await provider.viewAccount({ accountId })).amount);
    },
  };
}
