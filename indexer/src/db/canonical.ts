// Canonical dump: one definition, used by both drivers and every rebuild/idempotence proof.
// Excludes synced_at / observed_at / created_at / meta.last_pass_at / surrogate ids.
import { createHash } from "node:crypto";
import { jsonStringify, toBigInt } from "./codec.ts";

export type Kind = "text" | "int" | "bool";
export interface TableSpec {
  table: string;
  cols: ReadonlyArray<readonly [name: string, kind: Kind]>;
  /** text columns are ordered with a binary collation so both drivers agree */
  orderText: readonly string[];
  orderInt: readonly string[];
  where?: string;
}

export const CANONICAL_TABLES: readonly TableSpec[] = [
  {
    table: "task",
    cols: [
      ["task_id", "text"], ["owner", "text"], ["token", "text"], ["cap", "text"],
      ["completed_cached", "text"], ["outstanding_cached", "text"], ["crew_cap", "int"],
      ["frozen", "bool"], ["missing_since_height", "int"], ["as_of_height", "int"],
    ],
    orderText: ["task_id"],
    orderInt: [],
  },
  {
    table: "commitment_event",
    cols: [
      ["commitment_id", "int"], ["task_id", "text"], ["delegate", "text"], ["recipient", "text"],
      ["reserved_amount", "text"], ["actual_spent", "text"], ["state", "text"], ["request_id", "text"],
      ["payload_hash", "text"], ["near_tx", "text"], ["evm_tx", "text"], ["tx_status", "text"],
      ["as_of_height", "int"],
    ],
    orderText: [],
    orderInt: ["commitment_id"],
  },
  {
    table: "delegate_snapshot",
    cols: [["task_id", "text"], ["account_id", "text"], ["active", "bool"], ["as_of_height", "int"]],
    orderText: ["task_id", "account_id"],
    orderInt: [],
  },
  {
    table: "attestation",
    cols: [["commitment_id", "int"], ["provider", "text"], ["token_digest", "text"], ["verified", "bool"]],
    orderText: ["token_digest", "provider"],
    orderInt: [],
  },
  {
    table: "relayer_job",
    cols: [
      ["commitment_id", "int"], ["chain", "text"], ["signed_tx", "text"], ["status", "text"],
      ["attempts", "int"], ["last_error", "text"],
    ],
    orderText: ["chain", "signed_tx"],
    orderInt: ["commitment_id"],
  },
  {
    table: "meta",
    cols: [["key", "text"], ["value", "text"]],
    orderText: ["key"],
    orderInt: [],
    where: "key <> 'last_pass_at'",
  },
];

export function canonicalSql(spec: TableSpec, collate: string): string {
  const order = [...spec.orderInt, ...spec.orderText.map((c) => `${c} ${collate}`)].join(", ");
  const where = spec.where ? ` WHERE ${spec.where}` : "";
  return `SELECT ${spec.cols.map(([n]) => n).join(", ")} FROM ${spec.table}${where} ORDER BY ${order}`;
}

function normalize(v: unknown, kind: Kind): string | boolean | null {
  if (v === null || v === undefined) return null;
  switch (kind) {
    case "text":
      return String(v);
    case "int":
      return toBigInt(v).toString();
    case "bool":
      return v === true || v === 1 || v === 1n;
  }
}

export function canonicalLines(spec: TableSpec, rows: ReadonlyArray<Record<string, unknown>>): string[] {
  return rows.map((row) => {
    const o: Record<string, unknown> = { t: spec.table };
    for (const [name, kind] of spec.cols) o[name] = normalize(row[name], kind);
    return jsonStringify(o);
  });
}

export function canonicalResult(lines: string[]): { lines: string[]; sha256: string } {
  return { lines, sha256: createHash("sha256").update(lines.join("\n")).digest("hex") };
}
