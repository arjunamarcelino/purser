// near_tx backfill is optional: the cache never invents a link. The default resolves nothing.
import type { CommitmentRow } from "./db/types.ts";

export interface TxResolveContext {
  network: string;
  contractId: string;
  height: bigint;
  signal: AbortSignal;
}

export interface TxResolver {
  resolve(row: CommitmentRow, ctx: TxResolveContext): Promise<{ near_tx: string } | null>;
}

export const nullResolver: TxResolver = { resolve: async () => null };
