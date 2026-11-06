import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CALL_METHODS,
  REFUSALS,
  U64_BIGINT_FIELDS,
  classifyRefusal,
  toCommitmentId,
  toRequestId,
  yoctoFromBigint,
  U128_MAX,
  type Chain,
  type RefusalCode,
} from "../src/index.ts";

test("every frozen refusal classifies exactly, bare or with the near-sdk panic prefix", () => {
  for (const code of Object.keys(REFUSALS) as RefusalCode[]) {
    const { message, retry } = REFUSALS[code];
    assert.deepEqual(classifyRefusal(message), { code, retry });
    assert.deepEqual(classifyRefusal(`Smart contract panicked: ${message}`), { code, retry });
  }
});

test("classification is exact: substrings, extensions and unknown failures are not refusals", () => {
  assert.equal(classifyRefusal("Smart contract panicked: exceeds task budget!"), null);
  assert.equal(classifyRefusal("Smart contract panicked: in-flight retry"), null);
  assert.equal(classifyRefusal("Exceeded the prepaid gas."), null);
  assert.equal(classifyRefusal(""), null);
});

test("the frozen messages are unique", () => {
  const messages = Object.values(REFUSALS).map((r) => r.message);
  assert.equal(new Set(messages).size, messages.length);
});

test("yocto amounts stay within u128", () => {
  assert.equal(yoctoFromBigint(0n), "0");
  assert.equal(yoctoFromBigint(U128_MAX), U128_MAX.toString());
  assert.throws(() => yoctoFromBigint(-1n), RangeError);
  assert.throws(() => yoctoFromBigint(U128_MAX + 1n), RangeError);
});

test("commitment ids must be safe non-negative integers", () => {
  assert.equal(toCommitmentId(7), 7);
  for (const bad of [-1, 1.5, 2 ** 53, "7", null]) assert.throws(() => toCommitmentId(bad), RangeError);
});

test("request ids must be lowercase UUIDs", () => {
  assert.equal(toRequestId("0b5f1c2e-9a3d-4c1b-8e7f-123456789abc"), "0b5f1c2e-9a3d-4c1b-8e7f-123456789abc");
  assert.throws(() => toRequestId("not-a-uuid"), RangeError);
  assert.throws(() => toRequestId("0B5F1C2E-9A3D-4C1B-8E7F-123456789ABC"), RangeError);
});

test("generated surface: client calls, timestamp fields, externally tagged enums", () => {
  assert.ok(CALL_METHODS.includes("propose_payment"));
  assert.ok(!(CALL_METHODS as readonly string[]).includes("on_near_settled"), "private callbacks are excluded");
  assert.deepEqual([...U64_BIGINT_FIELDS], ["added_at", "created_at", "updated_at"]);
  const chains: Chain[] = ["NearNative", { Evm: { chain_id: 11155111 } }];
  assert.equal(chains.length, 2);
});

test("every refusal constant in the contract is classified or explicitly exempt (order-independent)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../../contract/src/error.rs", import.meta.url), "utf8");
  const messages = [...src.matchAll(/pub const MSG_\w+: &str = "([^"]+)";/g)].map((m) => m[1] ?? "");
  assert.ok(messages.length > 40, "the scan found the constants");
  // Owner-side registry/setup guards and internal accounting errors: never proposer-facing, so never
  // classified. Anything else, in whatever order it is declared, must be in REFUSALS.
  const exempt = new Set<string>([
    "spent exceeds reserved",
    "arithmetic overflow",
    "illegal reservation transition",
    "task exists",
    "cap must be positive",
    "crew_cap must be >= 1",
    "invalid derivation_path",
    "delegate exists",
    "crew cap reached",
    "no such delegate",
  ]);
  const known = new Set<string>(Object.values(REFUSALS).map((r) => r.message));
  for (const m of messages) {
    assert.ok(known.has(m) || exempt.has(m), `unclassified refusal: ${m}`);
  }
  for (const m of exempt) {
    assert.ok(messages.includes(m), `stale exemption (no such constant): ${m}`);
    assert.ok(!known.has(m), `exempt but classified: ${m}`);
  }
});
