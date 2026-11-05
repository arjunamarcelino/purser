// Generate src/generated.ts from the contract ABI emitted by `cargo near build`.
//
//   PURSER_ABI=<path> node scripts/gen.ts      (default: contract/target/near/purser_contract_abi.json)
//
// Reads only the ABI `body` (never `metadata`, which embeds build info that differs between a
// local build and CI), so the output is a pure function of the contract's public interface and
// the CI drift check (`git diff --exit-code src/generated.ts`) cannot flap.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, type JSONSchema } from "json-schema-to-typescript";

type Schema = Record<string, unknown>;
type AbiArg = { name: string; type_schema: Schema };
type AbiFunction = {
  name: string;
  kind: "view" | "call";
  modifiers?: string[];
  params?: { serialization_type: string; args: AbiArg[] };
  result?: { serialization_type: string; type_schema: Schema };
};
type Abi = { body: { functions: AbiFunction[]; root_schema: { definitions: Record<string, Schema> } } };

// Byte-order comparison: locale-aware sorting depends on ICU data and could make CI drift flap.
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortKeys = <T>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).sort(([a], [b]) => byCodeUnit(a, b)));

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const abiPath = process.env.PURSER_ABI ?? resolve(repoRoot, "contract/target/near/purser_contract_abi.json");
const outPath = resolve(here, "../src/generated.ts");

const abi = JSON.parse(readFileSync(abiPath, "utf8")) as Abi;
const pascal = (s: string) => s.replace(/(^|_)([a-z0-9])/g, (_m, _u, c: string) => c.toUpperCase());

// Block timestamps are plain `u64` on the wire (~1.7e18 ns, beyond 2^53), so a plain
// JSON.parse corrupts them. Every `*_at` u64 is typed `bigint`; clients parse view results
// with a reviver keyed on U64_BIGINT_FIELDS (exported below) to match.
const bigintFields = new Set<string>();
function retype(node: unknown): void {
  if (Array.isArray(node)) return node.forEach(retype);
  if (node === null || typeof node !== "object") return;
  const obj = node as Schema;
  const props = obj.properties as Record<string, Schema> | undefined;
  if (props) {
    for (const [key, prop] of Object.entries(props)) {
      if (key.endsWith("_at") && prop.format === "uint64") {
        prop.tsType = "bigint";
        bigintFields.add(key);
      }
    }
  }
  Object.values(obj).forEach(retype);
}

// near-sdk repeats its long AccountId rustdoc on every account field; argument schemas drop all
// descriptions (method docs carry the meaning).
const isAccountIdDoc = (v: unknown) => typeof v === "string" && v.startsWith("NEAR Account Identifier.");
function stripDescriptions(node: unknown, all = false): unknown {
  if (Array.isArray(node)) return node.map((n) => stripDescriptions(n, all));
  if (node === null || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node as Schema)
      .filter(([k, v]) => k !== "description" || !(all || isAccountIdDoc(v)))
      .map(([k, v]) => [k, stripDescriptions(v, all)]),
  );
}



// Private callbacks are contract-internal; clients can never call them.
const functions = abi.body.functions
  .filter((f) => !(f.modifiers ?? []).includes("private"))
  .sort((a, b) => byCodeUnit(a.name, b.name));

// A result that is a bare `$ref` names its type directly (the generator would fold an alias away).
const refName = (schema: Schema) => {
  const keys = Object.keys(schema).filter((k) => k !== "description");
  return keys.length === 1 && typeof schema.$ref === "string" ? schema.$ref.split("/").pop() : undefined;
};
const resultType = (f: AbiFunction) =>
  f.result ? (refName(f.result.type_schema) ?? `${pascal(f.name)}Result`) : "void";

const definitions = stripDescriptions(abi.body.root_schema.definitions) as Record<string, Schema>;
for (const f of functions) {
  const args = f.params?.args ?? [];
  definitions[`${pascal(f.name)}Args`] = {
    type: "object",
    additionalProperties: false,
    required: args.map((a) => a.name),
    properties: Object.fromEntries(args.map((a) => [a.name, stripDescriptions(a.type_schema, true)])),
  };
  if (f.result && !refName(f.result.type_schema)) {
    definitions[`${pascal(f.name)}Result`] = stripDescriptions(f.result.type_schema, true) as Schema;
  }
}
retype(definitions);

const root = { title: "PurserAbiRoot", type: "object", additionalProperties: false, definitions: sortKeys(definitions) };
let body = await compile(root as JSONSchema, "PurserAbiRoot", {
  bannerComment: "",
  unreachableDefinitions: true,
  additionalProperties: false,
  strictIndexSignatures: true,
  ignoreMinAndMaxItems: true,
  format: true,
});
// The synthetic root only exists to carry `definitions`; drop it and the generator's
// "referenced by PurserAbiRoot" boilerplate (and any doc block it leaves empty).
body = body
  .replace(/export interface PurserAbiRoot \{\}\n\n?/, "")
  .replace(/( \*\n)? \* This interface was referenced by `PurserAbiRoot`'s JSON-Schema\n \* via the `definition` "\w+"\.\n/g, "")
  .replace(/\/\*\*\n \*\/\n/g, "");

const methodMap = (kind: "view" | "call") =>
  functions
    .filter((f) => f.kind === kind)
    .map((f) => `  ${f.name}: { args: ${pascal(f.name)}Args; result: ${resultType(f)} };`)
    .join("\n");
const names = (kind: "view" | "call") =>
  functions
    .filter((f) => f.kind === kind)
    .map((f) => `"${f.name}"`)
    .join(", ");

const out = `// GENERATED by packages/types/scripts/gen.ts from the contract ABI — do not edit.
// Regenerate: make types-gen

${body.trimEnd()}

/** View methods (free, no signer). */
export interface PurserViews {
${methodMap("view")}
}

/** Change methods a client may call (private callbacks excluded). */
export interface PurserCalls {
${methodMap("call")}
}

export const VIEW_METHODS = [${names("view")}] as const satisfies readonly (keyof PurserViews)[];
export const CALL_METHODS = [${names("call")}] as const satisfies readonly (keyof PurserCalls)[];

/** u64 fields typed \`bigint\`: parse view JSON with a reviver keyed on these names. */
export const U64_BIGINT_FIELDS = [${[...bigintFields].sort().map((f) => `"${f}"`).join(", ")}] as const;
`;

writeFileSync(outPath, out);
console.log(`wrote ${outPath} (${functions.length} methods, ${Object.keys(definitions).length} types)`);
