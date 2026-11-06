#!/usr/bin/env node
// Small, checkable operations for scripts/deploy-testnet.sh — the parts near-cli-rs cannot do
// safely or parseably. Every command checks the RPC really is testnet first. Never prints a
// secret: keygen writes the private key straight to a 0600 file and prints only the public key.
//
//   node testnet-ops.ts chain-id                <rpc>
//   node testnet-ops.ts account-exists          <rpc> <account>
//   node testnet-ops.ts code-matches            <rpc> <account> <wasm>
//   node testnet-ops.ts has-code                <rpc> <account>
//   node testnet-ops.ts balance                 <rpc> <account>     (whole NEAR, rounded down)
//   node testnet-ops.ts can-fund                <rpc> <account> <cap-near>  (spendable after storage stake covers ~cap)
//   node testnet-ops.ts keygen                  <secret-file>
//   node testnet-ops.ts pubkey                  <secret-file>
//   node testnet-ops.ts verify-fc-key           <rpc> <account> <public-key> <contract> <min-allowance-near>
//   node testnet-ops.ts view                    <rpc> <contract> <method> <json-args>
//
// EVM path helpers (scripts/evm-testnet.sh; testnet + Sepolia only):
//   node testnet-ops.ts spendable               <rpc> <account>     (yocto: amount minus storage stake)
//   node testnet-ops.ts near-tx                 <rpc> <signer> <label> -- <near-cli args...>
//                                               spawn near (timeout, scrubbed env), parse + VERIFY the tx on chain; prints "TX <hash>"
//   node testnet-ops.ts verify-fc-methods       <rpc> <account> <public-key> <contract> <min-allowance-near> <m1,m2,..>
//   node testnet-ops.ts evm-verify-lane         <rpc> <contract> <signer-contract> <path>   (cached key == signer view, address recomputed)
//   node testnet-ops.ts eth-nonce               <sepolia-rpc> <0x-address>   (finalized count; refuses if a tx is pending)
//   node testnet-ops.ts eth-balance             <sepolia-rpc> <0x-address>   (wei)
//   node testnet-ops.ts eth-gas-price           <sepolia-rpc>                (base fee wei of the latest block)
//   node testnet-ops.ts env-merge               <env-file> KEY=value|KEY=@secret-file ...   (atomic, 0600, keeps other lines)
//   node testnet-ops.ts evm-propose             <rpc> <contract> <delegate> <key-file> <task> <to> <value-wei> <request-id>

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, type KeyPairString, nearToYocto } from "near-api-js";
import { parseU64Safe, retryRateLimited } from "../purser-client.ts";
import { toJson } from "../log.ts";
import { capNearToYocto, describeSpawn, makeScrubber, parseTxId, urlSecrets } from "./demo-lib.ts";

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

// ---- error scrubbing ---------------------------------------------------------------------------------
// near-api-js and fetch errors embed the request URL, and a provider URL often carries an API key. Every URL given
// on the command line or in the environment is registered here, and EVERY message that leaves this process (the
// top-level handler, the verify paths) goes through scrubText: registered secrets first, then any URL-shaped text.
const knownSecrets = new Set<string>();
function learnUrl(v: string | undefined): void {
  if (v !== undefined && /^[a-z][a-z0-9+.-]*:\/\//i.test(v)) for (const s of urlSecrets(v)) knownSecrets.add(s);
}
for (const a of process.argv.slice(2)) learnUrl(a);
for (const k of ["NEAR_RPC_URL", "EVM_RPC_URL", "EVM_RPC_URL_2"]) learnUrl(process.env[k]);

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi;
function scrubText(s: string): string {
  return makeScrubber([...knownSecrets])(s).replace(URL_IN_TEXT, "[url]");
}

async function testnet(rpc: string): Promise<JsonRpcProvider> {
  const p = new JsonRpcProvider({ url: rpc });
  const { chain_id } = await p.viewNodeStatus();
  if (chain_id !== "testnet") throw new Error(`the NEAR RPC reports chain_id "${chain_id}", not testnet — refusing`);
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


// ---- EVM path helpers ------------------------------------------------------------------------------

const BASE58_IDX = new Map([...BASE58].map((c, i) => [c, BigInt(i)]));
function base58decode(str: string): Uint8Array {
  let n = 0n;
  for (const c of str) {
    const d = BASE58_IDX.get(c);
    if (d === undefined) throw new Error("invalid base58");
    n = n * 58n + d;
  }
  const hex = n.toString(16);
  const body = Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
  const zeros = [...str].findIndex((c) => c !== "1");
  return Buffer.concat([Buffer.alloc(zeros < 0 ? str.length : zeros), n === 0n ? Buffer.alloc(0) : body]);
}

/** Keccak-256 (the pre-NIST padding Ethereum uses). Checked against known vectors in `selftest`. */
function keccak256(data: Uint8Array): Uint8Array {
  const M = (1n << 64n) - 1n;
  const rotl = (x: bigint, n: number) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M);
  const PI = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
  const RHO = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
  const RC: bigint[] = [];
  let r = 1;
  for (let t = 0; t < 24; t++) {
    let c = 0n;
    for (let j = 0; j < 7; j++) {
      if (r & 1) c |= 1n << BigInt((1 << j) - 1);
      r = r & 0x80 ? ((r << 1) ^ 0x171) & 0xff : (r << 1) & 0xff;
    }
    RC.push(c);
  }
  const A: bigint[] = new Array<bigint>(25).fill(0n);
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((data.length + 1) / rate) * rate);
  padded.set(data);
  padded[data.length] = (padded[data.length] ?? 0) ^ 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1] ?? 0) ^ 0x80;
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]!);
      A[i] = A[i]! ^ lane;
    }
    for (let round = 0; round < 24; round++) {
      const C = [0, 1, 2, 3, 4].map((x) => A[x]! ^ A[x + 5]! ^ A[x + 10]! ^ A[x + 15]! ^ A[x + 20]!);
      for (let x = 0; x < 5; x++) {
        const D = C[(x + 4) % 5]! ^ rotl(C[(x + 1) % 5]!, 1);
        for (let y = 0; y < 25; y += 5) A[y + x] = A[y + x]! ^ D;
      }
      let cur = A[1]!;
      for (let t = 0; t < 24; t++) {
        const j = PI[t]!;
        const tmp = A[j]!;
        A[j] = rotl(cur, RHO[t]!);
        cur = tmp;
      }
      for (let y = 0; y < 25; y += 5) {
        const row = A.slice(y, y + 5);
        for (let x = 0; x < 5; x++) A[y + x] = row[x]! ^ (~row[(x + 1) % 5]! & M & row[(x + 2) % 5]!);
      }
      A[0] = A[0]! ^ RC[round]!;
    }
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(A[i]!, i * 8);
  return out;
}

/** `0x` + last 20 bytes of keccak256(x || y). */
function evmAddress(pubkey64: Uint8Array): string {
  return `0x${Buffer.from(keccak256(pubkey64)).subarray(12).toString("hex")}`;
}

const SEPOLIA_CHAIN_ID = "0xaa36a7";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** One Sepolia JSON-RPC read. Never prints the URL (it may carry a key); `eth_chainId` is checked first. */
async function ethRpc(url: string, method: string, params: unknown[], checkChain = true): Promise<unknown> {
  if (!/^https:\/\//.test(url)) throw new Error("EVM RPC URL must be https");
  const scrub = makeScrubber(urlSecrets(url));
  const call = async (m: string, p: unknown[]): Promise<unknown> => {
    for (let i = 0; ; i++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (e) {
        throw new Error(scrub(`sepolia rpc ${m} failed: ${(e as Error).name}`));
      }
      if (res.status === 429 && i < 5) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
        continue;
      }
      if (!res.ok) throw new Error(`sepolia rpc ${m}: HTTP ${res.status}`);
      const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (body.error) throw new Error(scrub(`sepolia rpc ${m}: ${body.error.message ?? "error"}`.slice(0, 200)));
      return body.result;
    }
  };
  if (checkChain && (await call("eth_chainId", [])) !== SEPOLIA_CHAIN_ID) throw new Error("EVM RPC is not Sepolia (eth_chainId != 0xaa36a7); refusing");
  return call(method, params);
}

/** Spawn near-cli-rs, parse the tx id off stderr, and bind it to the chain. Never blind-retries. */
async function nearTx(rpc: string, signer: string, label: string, nearArgs: string[]): Promise<void> {
  const provider = await testnet(rpc);
  const scrub = makeScrubber(urlSecrets(rpc));
  const r = spawnSync("near", nearArgs, { encoding: "utf8", timeout: 180_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
  const stderr = r.stderr ?? "";
  const hash = parseTxId(stderr);
  const why = describeSpawn(r);
  const tail = scrub(stderr).split("\n").slice(-12).join("\n");
  if (!hash) {
    throw new Error(`${label}: ${why ?? "no transaction id in near output"} (the call MAY have landed; read state before retrying)\n${tail}`);
  }
  process.stdout.write(`TXHASH ${hash}\n`);
  // The hash is only a claim parsed off near's output until the chain confirms it: the shell logs it as "landed"
  // only after the `TX <hash>` line below, and as "sent, unverified" otherwise.
  let res: Awaited<ReturnType<JsonRpcProvider["viewTransactionStatus"]>>;
  try {
    res = await retryRateLimited(() => provider.viewTransactionStatus({ txHash: hash, accountId: signer, waitUntil: "EXECUTED" }));
  } catch (e) {
    throw new Error(scrubText(`${label}: tx ${hash} was sent but could not be verified on chain (${(e as Error).message.slice(0, 200)}); read state before retrying`));
  }
  const tx = res.transaction as { signer_id: string };
  if (tx.signer_id !== signer) throw new Error(`${label}: tx ${hash} was signed by ${tx.signer_id}, expected ${signer}`);
  const failed = (st: unknown) => typeof st === "object" && st !== null && "Failure" in st;
  const receipts = (res as unknown as { receipts_outcome?: Array<{ outcome: { status: unknown } }> }).receipts_outcome ?? [];
  if (failed(res.status) || receipts.some((x) => failed(x.outcome.status))) {
    throw new Error(`${label}: tx ${hash} FAILED on chain\n${tail}`);
  }
  if (typeof res.status !== "object" || !("SuccessValue" in res.status || "SuccessReceiptId" in res.status)) {
    throw new Error(`${label}: tx ${hash} has no success status`);
  }
  console.log(`TX ${hash}`);
}

async function ethBalanceWei(url: string, addr: string): Promise<bigint> {
  return BigInt((await ethRpc(url, "eth_getBalance", [addr, "latest"])) as string);
}

function mergeEnv(file: string, pairs: string[]): void {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const kv = new Map<string, string>();
  for (const p of pairs) {
    const i = p.indexOf("=");
    const k = p.slice(0, i);
    let v = p.slice(i + 1);
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`bad env key ${k}`);
    if (v.startsWith("@")) v = readFileSync(v.slice(1), "utf8").trim();
    if (/[\n\r]/.test(v)) throw new Error(`${k}: value has a newline`);
    kv.set(k, v);
  }
  const kept = lines.filter((l) => l !== "" && !kv.has(l.split("=")[0]!));
  const out = `${[...kept, ...[...kv].map(([k, v]) => `${k}=${v}`)].join("\n")}\n`;
  const tmp = `${file}.tmp${process.pid}`;
  writeFileSync(tmp, out, { mode: 0o600, flag: "wx" });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
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
    case "has-code": {
      const [rpc, account] = need(2);
      const view = await (await testnet(rpc!)).viewAccount({ accountId: account! });
      console.log(view.code_hash === "11111111111111111111111111111111" ? "no" : "yes");
      return;
    }
    case "balance": {
      const [rpc, account] = need(2);
      const view = await (await testnet(rpc!)).viewAccount({ accountId: account! });
      console.log((BigInt(view.amount) / 10n ** 24n).toString());
      return;
    }
    case "can-fund": {
      // Storage stake is locked (10^19 yocto per byte), so total balance overstates what can be paid out.
      const [rpc, account, cap] = need(3);
      const view = await (await testnet(rpc!)).viewAccount({ accountId: account! });
      const spendable = BigInt(view.amount) - BigInt(view.storage_usage) * 10n ** 19n;
      const capYocto = capNearToYocto(cap!);
      const needYocto = (capYocto * 9n) / 10n + 5n * 10n ** 22n; // 90 units paid out, plus task storage and slack
      const fmt = (y: bigint) => (Number(y / 10n ** 21n) / 1000).toFixed(3);
      if (spendable < needYocto) {
        console.log(`no: ${account} has ${fmt(spendable < 0n ? 0n : spendable)} NEAR spendable, a run needs ${fmt(needYocto)}`);
        return;
      }
      console.log("yes");
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
    case "selftest": {
      const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");
      if (hexOf(keccak256(new Uint8Array())) !== "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470") throw new Error("keccak256 self-test failed");
      const key = base58decode("67756ZjiVxANYvYhQagGaWj2APpo1C1UMq2ebVWoy3GMU3zmYaM9ho6DNyDxRjo1Uzo2UDMkmeutgZFKQhgpnd1W");
      if (key.length !== 64 || evmAddress(key) !== "0x0f3798297b9500b6c63ecc6c8101a7d6fae81e02") throw new Error("address derivation self-test failed");
      const canary = "https://canary.example.invalid/v3/CANARYKEY0123456789abcdef";
      learnUrl(canary);
      const leaked = scrubText(`HTTP request failed: POST ${canary} refused; also http://other.example.invalid:8545/abc and ${["https:/", "/user:pw1234@host.example.invalid/x"].join("")}`);
      if (/CANARY|canary\.example|other\.example|host\.example|pw1234/.test(leaked)) throw new Error("error scrubber self-test failed");
      knownSecrets.clear();
      console.log("ok");
      return;
    }
    case "spendable": {
      const [rpc, account] = need(2);
      const v = await retryRateLimited(async () => (await testnet(rpc!)).viewAccount({ accountId: account! }));
      console.log((BigInt(v.amount) - BigInt(v.storage_usage) * 10n ** 19n).toString());
      return;
    }
    case "near-tx": {
      const [rpc, signer, label] = need(4);
      const sep = args.indexOf("--");
      if (sep < 3) throw new Error("near-tx: expected -- before the near-cli arguments");
      await nearTx(rpc!, signer!, label!, args.slice(sep + 1));
      return;
    }
    case "verify-fc-methods": {
      const [rpc, account, pk, contract, minAllowance, csv] = need(6);
      const k = await retryRateLimited(async () => (await testnet(rpc!)).viewAccessKey({ accountId: account!, publicKey: pk! }));
      const fc = (k.permission as { FunctionCall?: { receiver_id: string; method_names: string[]; allowance: string | null } }).FunctionCall;
      if (!fc) throw new Error(`${account}: key ${pk} is a FULL-ACCESS key`);
      if (fc.receiver_id !== contract) throw new Error(`${account}: key receiver is ${fc.receiver_id}, expected ${contract}`);
      const want = csv!.split(",").sort().join(",");
      if (fc.method_names.slice().sort().join(",") !== want) throw new Error(`${account}: key methods are [${fc.method_names.join(", ")}], expected [${want}]`);
      if (fc.allowance === null) throw new Error(`${account}: key has an unlimited allowance`);
      if (BigInt(fc.allowance) < nearToYocto(minAllowance as `${number}`)) throw new Error(`${account}: allowance below ${minAllowance} NEAR`);
      console.log("ok");
      return;
    }
    case "evm-verify-lane": {
      const [rpc, contract, signerContract, path] = need(4);
      const p = await testnet(rpc!);
      const q = async (id: string, method: string, a: unknown) => {
        const raw = await retryRateLimited(() => p.callFunctionRaw({ contractId: id, method, args: new TextEncoder().encode(JSON.stringify(a)), blockQuery: { finality: "final" } }));
        return JSON.parse(new TextDecoder().decode(Uint8Array.from(raw.result))) as unknown;
      };
      const lane = (await q(contract!, "evm_lane", { path })) as { address: string; pubkey: string } | null;
      if (!lane) throw new Error(`no cached lane for path ${path}`);
      const derived = (await q(signerContract!, "derived_public_key", { path, predecessor: contract, domain_id: 0 })) as string;
      const m = /^secp256k1:([1-9A-HJ-NP-Za-km-z]+)$/.exec(derived);
      if (!m) throw new Error("signer returned an unexpected derived key format");
      const key = base58decode(m[1]!);
      if (key.length !== 64) throw new Error(`derived key is ${key.length} bytes, expected 64`);
      if (Buffer.from(key).toString("hex") !== lane.pubkey.replace(/^0x/, "").toLowerCase()) throw new Error("CACHED KEY DIFFERS from the signer's derived_public_key view");
      const addr = evmAddress(key);
      if (addr !== lane.address.toLowerCase()) throw new Error(`lane address ${lane.address} differs from the independently computed ${addr}`);
      console.log(addr);
      return;
    }
    case "eth-nonce": {
      const [url, addr] = need(2);
      if (!ADDRESS_RE.test(addr!)) throw new Error("bad address");
      const fin = BigInt((await ethRpc(url!, "eth_getTransactionCount", [addr, "finalized"])) as string);
      const pend = BigInt((await ethRpc(url!, "eth_getTransactionCount", [addr, "pending"], false)) as string);
      if (pend !== fin) throw new Error(`pending nonce ${pend} != finalized ${fin}: a transaction is in flight at ${addr}; not seeding`);
      console.log(fin.toString());
      return;
    }
    case "eth-balance": {
      const [url, addr] = need(2);
      if (!ADDRESS_RE.test(addr!)) throw new Error("bad address");
      console.log((await ethBalanceWei(url!, addr!)).toString());
      return;
    }
    case "eth-gas-price": {
      const [url] = need(1);
      const b = (await ethRpc(url!, "eth_getBlockByNumber", ["latest", false])) as { baseFeePerGas?: string };
      console.log(BigInt(b.baseFeePerGas ?? "0x0").toString());
      return;
    }
    case "env-merge": {
      const [file, ...pairs] = need(2);
      mergeEnv(file!, pairs);
      console.log("ok");
      return;
    }
    case "evm-propose": {
      // The delegate's function-call key signs propose_payment. Sent ONCE: an unclear result is resolved by reading
      // get_idempotency / get_commitment, never by resending.
      const [rpc, contract, delegate, keyFile, task, to, value, requestId] = need(8);
      if (!ADDRESS_RE.test(to!)) throw new Error("bad recipient address");
      if (!/^[1-9][0-9]{0,38}$/.test(value!)) throw new Error("bad value");
      const p = await testnet(rpc!);
      const kp = KeyPair.fromString(readFileSync(keyFile!, "utf8").trim() as KeyPairString);
      let k: Awaited<ReturnType<JsonRpcProvider["viewAccessKey"]>>;
      try {
        k = await retryRateLimited(() => p.viewAccessKey({ accountId: delegate!, publicKey: kp.getPublicKey().toString() }));
      } catch (e) {
        throw new Error(scrubText(`could not read the delegate's access key before proposing; nothing was sent (${(e as Error).message.slice(0, 200)})`));
      }
      const fc = (k.permission as { FunctionCall?: { receiver_id: string; method_names: string[] } }).FunctionCall;
      if (!fc || fc.receiver_id !== contract || fc.method_names.join() !== "propose_payment") throw new Error("delegate key must be a propose_payment-only function-call key on this contract");
      const body = JSON.stringify({
        task,
        intent: { chain: { Evm: { chain_id: 11155111 } }, recipient: to, amount: value, token: "NearNative", memo: null },
        request_id: requestId,
      });
      const account = new Account(delegate!, p, KeyPairSigner.fromSecretKey(kp.toString() as KeyPairString));
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("send timed out (it may have landed: read get_idempotency before anything else)")), 240_000);
      });
      try {
        let res: Awaited<ReturnType<Account["callFunctionRaw"]>>;
        try {
          res = await Promise.race([
            account.callFunctionRaw({ contractId: contract!, methodName: "propose_payment", args: new TextEncoder().encode(body), gas: 150_000_000_000_000n, deposit: 0n, waitUntil: "EXECUTED_OPTIMISTIC" }),
            timeout,
          ]);
        } catch (e) {
          throw new Error(scrubText(`propose_payment: ${(e as Error).message.slice(0, 200)} (it MAY have landed: read get_idempotency before anything else)`));
        }
        const hash = res.transaction.hash;
        console.log(`TXHASH ${hash}`);
        // Bind the hash to what was meant: signer, receiver and method, re-read from the chain.
        let again: Awaited<ReturnType<JsonRpcProvider["viewTransactionStatus"]>>;
        try {
          again = await retryRateLimited(() => p.viewTransactionStatus({ txHash: hash, accountId: delegate!, waitUntil: "EXECUTED_OPTIMISTIC" }));
        } catch (e) {
          throw new Error(scrubText(`tx ${hash} was sent but could not be verified on chain (${(e as Error).message.slice(0, 200)}); read get_idempotency before resending`));
        }
        const tx = again.transaction as { signer_id: string; receiver_id: string; actions: Array<{ FunctionCall?: { method_name: string } }> };
        if (tx.signer_id !== delegate || tx.receiver_id !== contract || tx.actions[0]?.FunctionCall?.method_name !== "propose_payment") {
          throw new Error(`tx ${hash} is ${tx.signer_id} -> ${tx.receiver_id}, not the proposal that was sent`);
        }
        console.log(`TX ${hash}`);
        const st = res.status as { SuccessValue?: string } | { Failure?: unknown } | string;
        if (typeof st === "object" && "SuccessValue" in st && st.SuccessValue !== undefined) {
          console.log(`CID ${Buffer.from(st.SuccessValue, "base64").toString("utf8").replace(/"/g, "")}`);
        } else {
          console.log(`STATUS ${JSON.stringify(st).slice(0, 300)}`);
        }
      } finally {
        clearTimeout(timer);
      }
      return;
    }
    default:
      throw new Error(`unknown command "${cmd ?? ""}"`);
  }
}

run().catch((e: unknown) => {
  process.stderr.write(`testnet-ops: ${scrubText(e instanceof Error ? e.message : String(e))}\n`);
  process.exit(1);
});
