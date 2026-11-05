#!/usr/bin/env node
// Small, checkable operations for scripts/deploy-testnet.sh — the parts near-cli-rs cannot do
// safely or parseably. Every command checks the RPC really is testnet first. Never prints a
// secret: keygen writes the private key straight to a 0600 file and prints only the public key.
//
//   node testnet-ops.ts chain-id                <rpc>
//   node testnet-ops.ts account-exists          <rpc> <account>
//   node testnet-ops.ts code-matches            <rpc> <account> <wasm>
//   node testnet-ops.ts keygen                  <secret-file>
//   node testnet-ops.ts pubkey                  <secret-file>
//   node testnet-ops.ts verify-fc-key           <rpc> <account> <public-key> <contract> <min-allowance-near>
//   node testnet-ops.ts view                    <rpc> <contract> <method> <json-args>

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { JsonRpcProvider, KeyPair, type KeyPairString, nearToYocto } from "near-api-js";
import { parseU64Safe } from "../purser-client.ts";
import { toJson } from "../log.ts";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let s = "";
  while (n > 0n) {
    s = BASE58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = `1${s}`;
  }
  return s;
}

async function testnet(rpc: string): Promise<JsonRpcProvider> {
  const p = new JsonRpcProvider({ url: rpc });
  const { chain_id } = await p.viewNodeStatus();
  if (chain_id !== "testnet") throw new Error(`RPC ${rpc} reports chain_id "${chain_id}", not testnet — refusing`);
  return p;
}

async function exists(p: JsonRpcProvider, accountId: string): Promise<boolean> {
  try {
    await p.viewAccount({ accountId });
    return true;
  } catch (e) {
    if (/does not exist|UNKNOWN_ACCOUNT|AccountDoesNotExist/i.test(`${(e as Error).name} ${(e as Error).message}`)) return false;
    throw e;
  }
}

const [cmd, ...args] = process.argv.slice(2);
const need = (n: number) => {
  if (args.length < n) throw new Error(`${cmd}: expected ${n} argument(s)`);
  return args as string[];
};

async function run(): Promise<void> {
  switch (cmd) {
    case "chain-id": {
      const [rpc] = need(1);
      await testnet(rpc!);
      console.log("testnet");
      return;
    }
    case "account-exists": {
      const [rpc, account] = need(2);
      console.log((await exists(await testnet(rpc!), account!)) ? "yes" : "no");
      return;
    }
    case "code-matches": {
      const [rpc, account, wasm] = need(3);
      const local = base58(createHash("sha256").update(readFileSync(wasm!)).digest());
      const view = await (await testnet(rpc!)).viewAccount({ accountId: account! });
      console.log(view.code_hash === local ? "yes" : "no");
      return;
    }
    case "keygen": {
      const [file] = need(1);
      if (existsSync(file!)) throw new Error(`${file} exists; refusing to overwrite a key`);
      const kp = KeyPair.fromRandom("ed25519");
      writeFileSync(file!, `${kp.toString()}\n`, { mode: 0o600, flag: "wx" });
      console.log(kp.getPublicKey().toString());
      return;
    }
    case "pubkey": {
      const [file] = need(1);
      console.log(KeyPair.fromString(readFileSync(file!, "utf8").trim() as KeyPairString).getPublicKey().toString());
      return;
    }
    case "verify-fc-key": {
      const [rpc, account, pk, contract, minAllowance] = need(5);
      const k = await (await testnet(rpc!)).viewAccessKey({ accountId: account!, publicKey: pk! });
      const fc = (k.permission as { FunctionCall?: { receiver_id: string; method_names: string[]; allowance: string | null } }).FunctionCall;
      if (!fc) throw new Error(`${account}: key ${pk} is a FULL-ACCESS key — the proposer must never hold one`);
      if (fc.receiver_id !== contract) throw new Error(`${account}: key receiver is ${fc.receiver_id}, expected ${contract}`);
      if (fc.method_names.length !== 1 || fc.method_names[0] !== "propose_payment") {
        throw new Error(`${account}: key methods are [${fc.method_names.join(", ")}] (empty means ALL), expected [propose_payment]`);
      }
      if (fc.allowance === null) throw new Error(`${account}: key has an unlimited allowance`);
      if (BigInt(fc.allowance) < nearToYocto(minAllowance as `${number}`)) throw new Error(`${account}: allowance below ${minAllowance} NEAR — rotate the key`);
      console.log("ok");
      return;
    }
    case "view": {
      const [rpc, contract, method, json] = need(4);
      const raw = await (await testnet(rpc!)).callFunctionRaw({ contractId: contract!, method: method!, args: new TextEncoder().encode(json!), blockQuery: { finality: "final" } });
      console.log(toJson(parseU64Safe(new TextDecoder().decode(Uint8Array.from(raw.result)))));
      return;
    }
    default:
      throw new Error(`unknown command "${cmd ?? ""}"`);
  }
}

run().catch((e: unknown) => {
  process.stderr.write(`testnet-ops: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
