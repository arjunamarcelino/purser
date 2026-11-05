// The proposer's record of what it proposed and what the contract did — the dashboard's only
// source for refusals (a refusal leaves nothing on chain) and for tx links (the contract stores no
// tx hash). Append-only JSONL, owner-only. Self-asserted: readers validate and treat it as untrusted.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ProposalRecord } from "@purser/types";

export function appendRecord(path: string, record: ProposalRecord): void {
  const valid = ProposalRecord.parse(record);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(valid)}\n`, { mode: 0o600 });
}
