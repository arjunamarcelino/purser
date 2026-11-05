// The owner's wallet. Used ONLY to sign owner methods on the configured contract; delegates
// propose through the proposer's function-call keys, never through this UI.

import { useEffect, useState } from "react";
import { type DataStorage, LocalStorage, NearConnector } from "@hot-labs/near-connect";
import { type RefusalCode, classifyRefusal } from "@purser/types";
import { config } from "../config.ts";
import { WALLET_MANIFEST } from "./manifest.ts";

// near-connect registers arbitrary "debug wallets" from storage; this storage never yields them.
class NoDebugWalletsStorage implements DataStorage {
  readonly #inner = new LocalStorage();
  async get(key: string) {
    return key === "debug-wallets" ? null : this.#inner.get(key).catch(() => null);
  }
  async set(key: string, value: string) {
    if (key !== "debug-wallets") await this.#inner.set(key, value).catch(() => {});
  }
  async remove(key: string) {
    await this.#inner.remove(key).catch(() => {});
  }
}

// One connector for the app's lifetime (never created in an effect: StrictMode would double it).
export const connector = new NearConnector({
  network: "testnet",
  manifest: structuredClone(WALLET_MANIFEST) as unknown as { wallets: never[]; version: string },
  storage: new NoDebugWalletsStorage(),
  autoConnect: true,
});

export function useWalletAccount(): { accountId: string | null; connect: () => Promise<void>; disconnect: () => Promise<void> } {
  const [accountId, setAccountId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    connector
      .getConnectedWallet()
      .then((r) => live && setAccountId(r.accounts[0]?.accountId ?? null))
      .catch(() => {});
    const onIn = (e: { accounts: { accountId: string }[] }) => live && setAccountId(e.accounts[0]?.accountId ?? null);
    const onOut = () => live && setAccountId(null);
    connector.on("wallet:signIn", onIn);
    connector.on("wallet:signOut", onOut);
    return () => {
      live = false;
      connector.off("wallet:signIn", onIn);
      connector.off("wallet:signOut", onOut);
    };
  }, []);
  return {
    accountId,
    connect: async () => {
      await connector.connect();
    },
    disconnect: async () => {
      await connector.disconnect().catch(() => {});
      setAccountId(null);
    },
  };
}

export type OwnerMethod = "revoke_delegate" | "add_delegate" | "set_recipient_allowlist" | "create_task";

export type OwnerOutcome =
  | { kind: "ok"; txHash: string; blockHash: string }
  | { kind: "refused"; code: RefusalCode | null; raw: string; txHash: string | null }
  | { kind: "rejected"; raw: string } // the user declined, or the wallet failed before sending
  | { kind: "unknown"; raw: string };

const GAS = "30000000000000"; // 30 Tgas; owner methods are tiny

type Outcome = {
  status?: { SuccessValue?: string; Failure?: unknown } | string;
  transaction?: { hash?: string; signer_id?: string; receiver_id?: string };
  transaction_outcome?: { block_hash?: string };
};

function executionError(failure: unknown): string {
  const text = JSON.stringify(failure);
  const m = /"ExecutionError":"((?:[^"\\]|\\.)*)"/.exec(text);
  return m ? JSON.parse(`"${m[1]}"`) : text;
}

/**
 * Sign one owner call. The receiver is ALWAYS the configured contract; the signer must be the
 * account the caller expects (captured when the action started) — anything else is reported, not
 * silently accepted.
 */
export async function signOwnerCall(method: OwnerMethod, args: Record<string, unknown>, expectedSigner: string, timeoutMs = 180_000): Promise<OwnerOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const wallet = await connector.wallet();
    const send = wallet.signAndSendTransaction({
      network: "testnet",
      signerId: expectedSigner,
      receiverId: config.contractId,
      actions: [{ type: "FunctionCall", params: { methodName: method, args, gas: GAS, deposit: "0" } }],
    }) as Promise<Outcome>;
    const timeout = new Promise<"timeout">((r) => {
      timer = setTimeout(() => r("timeout"), timeoutMs);
    });
    const outcome = await Promise.race([send, timeout]);
    if (outcome === "timeout") return { kind: "unknown", raw: "no answer from the wallet — check the explorer before retrying" };
    const tx = outcome.transaction;
    if (tx?.receiver_id !== undefined && tx.receiver_id !== config.contractId) {
      return { kind: "unknown", raw: `signed for ${tx.receiver_id}, not ${config.contractId}` };
    }
    if (tx?.signer_id !== undefined && tx.signer_id !== expectedSigner) {
      return { kind: "unknown", raw: `signed by ${tx.signer_id}, expected ${expectedSigner}` };
    }
    const status = outcome.status;
    if (typeof status === "object" && status !== null && "Failure" in status && status.Failure !== undefined) {
      const raw = executionError(status.Failure);
      return { kind: "refused", code: classifyRefusal(raw)?.code ?? null, raw, txHash: tx?.hash ?? null };
    }
    return { kind: "ok", txHash: tx?.hash ?? "", blockHash: outcome.transaction_outcome?.block_hash ?? "" };
  } catch (err) {
    return { kind: "rejected", raw: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
