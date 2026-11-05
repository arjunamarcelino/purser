// The relayer's narrow window onto Sepolia. No viem type crosses this interface, and the adapter
// uses ONLY: eth_chainId, receipt/block/nonce/code/balance reads and eth_sendRawTransaction. There is no
// fee estimation, no transaction preparation and no signing here: the contract signed the bytes.

import { retryRateLimited, type RetryOptions } from "@purser/chain-read";
import {
  createPublicClient,
  http,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex as ViemHex,
  type TransactionSerialized,
} from "viem";
import { errorText } from "./log.ts";
import { SEPOLIA_CHAIN_ID } from "./config.ts";

export type Hex = `0x${string}`;
export type BlockTag = "finalized" | "latest" | "pending";

export interface Receipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: Hex;
}
export interface BlockRef {
  number: bigint;
  hash: Hex;
}

/**
 * What a broadcast told us. Only `Accepted` and `Pending` mean the node holds the transaction.
 * `Landed` (nonce too low) means SOME transaction with that nonce was mined: check receipts, it is not
 * proof that OURS was. `Rejected` and `Unknown` are never treated as proof the transaction will not land.
 */
export type BroadcastClass = "Landed" | "Pending" | "Underpriced" | "Rejected" | "Unknown";
export type SendOutcome = { kind: "Accepted"; hash: Hex } | { kind: BroadcastClass };

export interface EvmClient {
  /** `provider#N`; never the URL. */
  readonly label: string;
  chainId(): Promise<bigint>;
  getReceipt(hash: Hex): Promise<Receipt | null>;
  getFinalized(): Promise<BlockRef>;
  getBlock(number: bigint): Promise<BlockRef | null>;
  getNonce(address: Hex, tag: BlockTag): Promise<bigint>;
  /** `"0x"` for an externally owned account. */
  getCode(address: Hex): Promise<Hex>;
  getBalance(address: Hex): Promise<bigint>;
  sendRaw(raw: Hex): Promise<SendOutcome>;
}

// ---- broadcast error classification (pure) ------------------------------------------------------
// Messages differ per execution client. Order matters: the specific replacement/underpriced text is
// checked before the generic "known"/"nonce" words. Anything unmatched is Unknown and is resolved by a
// receipt/nonce lookup, never treated as a failure.
const PATTERNS: Array<[BroadcastClass, RegExp]> = [
  ["Underpriced", /replacement transaction underpriced|replacement[_ ]underpriced|ReplacementNotAllowed|transaction underpriced|fee too low|FeeTooLow/i],
  ["Pending", /already known|known transaction|ALREADY_EXISTS|AlreadyKnown|already in (the )?(mempool|pool|txpool)|already imported/i],
  ["Landed", /nonce too low|nonce is too low|OldNonce|NONCE_TOO_LOW|already (been )?(mined|included)/i],
  ["Rejected", /insufficient funds|InsufficientFunds|exceeds block gas limit|intrinsic gas too low|max fee per gas less than block base fee|invalid sender|invalid chain id|oversized data|tx fee .* exceeds/i],
];

export function classifyBroadcastError(err: unknown): BroadcastClass {
  const text = errorText(err);
  for (const [cls, re] of PATTERNS) if (re.test(text)) return cls;
  return "Unknown";
}

// ---- validation of the contract's signed bytes (never re-encode) --------------------------------

export interface TxFields {
  raw: Hex | null;
  txHash: string | null;
  to: string;
  value: bigint;
}

export type RawVerdict = "ok" | "absent" | "bad_hash" | "bad_signer" | "bad_chain" | "bad_fields" | "unparseable";

/**
 * Validate `raw` against what the contract said it signed: keccak256(raw) == tx_hash, the recovered
 * signer is the lane address, chain id and nonce/to/value match. Anything else is an anomaly and the
 * bytes are never broadcast.
 */
export async function verifyRaw(t: TxFields, lane: { address: string; nonce: bigint }, chainId: bigint): Promise<RawVerdict> {
  if (t.raw === null || t.txHash === null) return "absent";
  if (keccak256(t.raw as ViemHex).toLowerCase() !== t.txHash.toLowerCase()) return "bad_hash";
  try {
    const serialized = t.raw as TransactionSerialized;
    const parsed = parseTransaction(serialized);
    if (BigInt(parsed.chainId ?? -1) !== chainId) return "bad_chain";
    if (BigInt(parsed.nonce ?? -1) !== lane.nonce || (parsed.to ?? "").toLowerCase() !== t.to.toLowerCase() || (parsed.value ?? 0n) !== t.value) return "bad_fields";
    const signer = await recoverTransactionAddress({ serializedTransaction: serialized });
    if (signer.toLowerCase() !== lane.address.toLowerCase()) return "bad_signer";
    return "ok";
  } catch {
    return "unparseable";
  }
}

// ---- viem adapter -------------------------------------------------------------------------------

export interface ViemEvmOptions {
  url: string;
  label: string;
  timeoutMs?: number;
  retry?: RetryOptions;
}

const NOT_FOUND = /TransactionReceiptNotFound|could not be found|BlockNotFound/i;

/** Wrap a read: 429 is retried with jittered backoff. Sends never go through here. */
export class ViemEvmClient implements EvmClient {
  readonly label: string;
  readonly #client: ReturnType<typeof makeClient>;
  readonly #retry: RetryOptions;

  constructor(opts: ViemEvmOptions) {
    this.label = opts.label;
    // retryCount 0: viem's own retry would blindly resend sendRawTransaction and hide 429s from our backoff.
    this.#client = makeClient(opts.url, opts.timeoutMs ?? 10_000);
    this.#retry = opts.retry ?? {};
  }

  #read<T>(fn: () => Promise<T>): Promise<T> {
    return retryRateLimited(fn, this.#retry);
  }

  chainId(): Promise<bigint> {
    return this.#read(async () => BigInt(await this.#client.getChainId()));
  }

  async getReceipt(hash: Hex): Promise<Receipt | null> {
    try {
      const r = await this.#read(() => this.#client.getTransactionReceipt({ hash }));
      return { status: r.status, blockNumber: r.blockNumber, blockHash: r.blockHash };
    } catch (err) {
      if (err instanceof Error && err.name === "TransactionReceiptNotFoundError") return null;
      throw err;
    }
  }

  async getFinalized(): Promise<BlockRef> {
    const b = await this.#read(() => this.#client.getBlock({ blockTag: "finalized" }));
    if (b.number === null || b.hash === null) throw new Error("finalized block has no number");
    return { number: b.number, hash: b.hash };
  }

  async getBlock(number: bigint): Promise<BlockRef | null> {
    try {
      const b = await this.#read(() => this.#client.getBlock({ blockNumber: number }));
      return b.number === null || b.hash === null ? null : { number: b.number, hash: b.hash };
    } catch (err) {
      if (NOT_FOUND.test(errorText(err))) return null;
      throw err;
    }
  }

  async getNonce(address: Hex, tag: BlockTag): Promise<bigint> {
    return BigInt(await this.#read(() => this.#client.getTransactionCount({ address, blockTag: tag })));
  }

  async getCode(address: Hex): Promise<Hex> {
    return (await this.#read(() => this.#client.getCode({ address }))) ?? "0x";
  }

  getBalance(address: Hex): Promise<bigint> {
    return this.#read(() => this.#client.getBalance({ address }));
  }

  async sendRaw(raw: Hex): Promise<SendOutcome> {
    try {
      const hash = await this.#client.sendRawTransaction({ serializedTransaction: raw });
      return { kind: "Accepted", hash };
    } catch (err) {
      return { kind: classifyBroadcastError(err) };
    }
  }
}

function makeClient(url: string, timeout: number) {
  return createPublicClient({ transport: http(url, { retryCount: 0, timeout }) });
}

/** eth_chainId must be Sepolia on this provider, or the relayer refuses to run (the never-mainnet backstop). */
export async function assertSepolia(client: EvmClient): Promise<void> {
  const id = await client.chainId();
  if (id !== SEPOLIA_CHAIN_ID) throw new Error(`${client.label} reports chain id ${id}, expected ${SEPOLIA_CHAIN_ID}; refusing to run`);
}

export const explorerTx = (hash: string): string => `https://sepolia.etherscan.io/tx/${hash}`;
