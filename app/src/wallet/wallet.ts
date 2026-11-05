// The owner's wallet. Used ONLY to sign owner methods on the configured contract; delegates
// propose through the proposer's function-call keys, never through this UI.

import { useEffect, useState } from "react";
import { type DataStorage, LocalStorage, NearConnector } from "@hot-labs/near-connect";
import { config } from "../config.ts";
import { WALLET_MANIFEST } from "./manifest.ts";
import { type Outcome, type OwnerMethod, type OwnerOutcome, checkOutcome } from "./outcome.ts";

export type { OwnerMethod, OwnerOutcome };

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

/** The wallets the board offers, in order: NEAR CLI first (no key enters the browser). */
export const WALLETS = [
  { id: "near-cli", label: "NEAR CLI", hint: "sign in your terminal — key stays in your keychain" },
  { id: "meteor-wallet", label: "Meteor", hint: "browser extension" },
] as const;
export type WalletId = (typeof WALLETS)[number]["id"];

export function useWalletAccount(): { accountId: string | null; connect: (walletId: WalletId) => Promise<void>; disconnect: () => Promise<void> } {
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
    // An explicit wallet id: the owner always knows which wallet is about to open (no remembered default).
    connect: async (walletId) => {
      await connector.connect({ walletId });
    },
    disconnect: async () => {
      await connector.disconnect().catch(() => {});
      setAccountId(null);
    },
  };
}

const GAS = "30000000000000"; // 30 Tgas; owner methods are tiny

/** Sign one owner call: receiver fixed to the configured contract, outcome verified (outcome.ts). */
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
    return checkOutcome(outcome, method, args, expectedSigner);
  } catch (err) {
    return { kind: "rejected", raw: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
