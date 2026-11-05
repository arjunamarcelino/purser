// Safety does not depend on the model. A property-based "model" proposes ARBITRARY schema-valid
// intents — any recipient, any amount up to twice the cap, oversized memos — in concurrent
// bursts from all three personas. Whatever it says, after every run the chain shows:
//   completed + outstanding <= cap, nothing paid to a non-allowlisted account, and the money
//   that actually left equals what the contract accounted as completed.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import type { KeyPairString } from "near-api-js";
import { beforeAll, expect, inject, it } from "vitest";
import { type CrewContext, runPersona, yoctoToNear } from "../../src/agent.ts";
import { Secret } from "../../src/config.ts";
import { NEAR, PERSONAS, type PurserDeployment, type SandboxPersona, deployPurser } from "../../src/dev/purser-sandbox.ts";
import { Journal } from "../../src/journal.ts";
import { scriptedModel } from "../../src/model.ts";
import { PERSONAS as PERSONA_DEFS, catalogFor } from "../../src/personas.ts";
import { DelegateSender, PurserViewer } from "../../src/purser-client.ts";

const CAP_NEAR = 10n;
const RUNS = Number(process.env.PURSER_PROPERTY_RUNS ?? 12);

let d: PurserDeployment;
let viewer: PurserViewer;
let run = 0;

beforeAll(async () => {
  d = await deployPurser({
    rpcUrl: inject("sandboxRpc"),
    rootId: inject("sandboxRootId"),
    rootKey: inject("sandboxRootKey") as KeyPairString,
    fundNear: CAP_NEAR * BigInt(RUNS) + 50n,
  });
  viewer = new PurserViewer(d.provider, d.contractId);
});

const intentArb = () =>
  fc.record({
    recipient: fc.constantFrom<keyof PurserDeployment["merchants"] | "bogus" | "root">("data", "compute", "procurement", "attacker", "bogus", "root"),
    yocto: fc.oneof(fc.bigInt({ min: 0n, max: 2n * CAP_NEAR * NEAR }), fc.constantFrom(0n, 1n, CAP_NEAR * NEAR, CAP_NEAR * NEAR + 1n)),
    memo: fc.option(fc.string({ maxLength: 300 }), { nil: null }),
  });
type Intent = ReturnType<typeof intentArb> extends fc.Arbitrary<infer T> ? T : never;

// A burst: some personas, each with its own arbitrary intent, all proposing at once.
const burstArb = fc.uniqueArray(fc.constantFrom(...PERSONAS), { minLength: 1, maxLength: 3 }).chain((ps) =>
  fc.tuple(...ps.map((p) => fc.tuple(fc.constant(p as SandboxPersona), intentArb()))),
);

it(`holds the cap, the allowlist and the money flow for arbitrary model output (${RUNS} runs)`, async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(burstArb, { minLength: 1, maxLength: 3 }), async (bursts) => {
      const task = `prop-${run++}`;
      await d.createTask({ taskId: task, capNear: CAP_NEAR });
      const dir = mkdtempSync(join(tmpdir(), `purser-${task}-`));
      const journals = Object.fromEntries(
        PERSONAS.map((p) => [p, Journal.open(dir, { network: "sandbox", contractId: d.contractId, accountId: d.delegates[p].accountId })]),
      ) as Record<SandboxPersona, Journal>;
      const ctx: CrewContext = { network: "sandbox", contractId: d.contractId, task, viewer, log: () => {}, pins: [], evidencePath: null, logContent: false, pollBudgetMs: 15_000 };
      const watched = [d.merchants.data, d.merchants.compute, d.merchants.procurement, d.merchants.attacker];
      const before = await Promise.all(watched.map((m) => d.balance(m)));
      const resolve = (r: Intent["recipient"]) => (r === "bogus" ? "Not An Account!" : r === "root" ? inject("sandboxRootId") : d.merchants[r]);

      try {
        for (const burst of bursts) {
          const outcomes = await Promise.all(
            burst.map(([p, i]) =>
              runPersona(ctx, {
                persona: PERSONA_DEFS[p],
                sender: new DelegateSender({ provider: d.provider, contractId: d.contractId, accountId: d.delegates[p].accountId, fcKey: new Secret(d.delegates[p].fcKey) }),
                journal: journals[p],
                model: scriptedModel(() => ({ rationale: "arbitrary", action: "propose", recipient: resolve(i.recipient), amount_near: yoctoToNear(i.yocto), memo: i.memo })),
                offers: catalogFor(p, d.merchants),
              }),
            ),
          );
          for (const o of outcomes) expect(["admitted", "refused"]).toContain(o.outcome.kind);
        }
      } finally {
        await Promise.all(Object.values(journals).map((j) => j.close()));
      }

      const t = await viewer.view("get_task", { task_id: task });
      if (!t) throw new Error("task missing");
      const [completed, outstanding, cap] = [BigInt(t.completed), BigInt(t.outstanding), BigInt(t.cap)];
      expect(completed + outstanding).toBeLessThanOrEqual(cap);
      expect(outstanding).toBe(0n); // every NEAR-native transfer settled

      const commitments = (await viewer.view("list_commitments", { task_id: task, from_index: 0, limit: 100 })) ?? [];
      const allowlisted = new Set([d.merchants.data, d.merchants.compute, d.merchants.procurement]);
      for (const c of commitments.filter((c) => c.state === "Confirmed")) expect(allowlisted.has(c.intent.recipient)).toBe(true);

      const after = await Promise.all(watched.map((m) => d.balance(m)));
      const deltas = after.map((a, i) => a - (before[i] ?? 0n));
      expect(deltas[3]).toBe(0n); // the attacker received nothing
      expect(deltas.reduce((a, b) => a + b, 0n)).toBe(completed); // money out == books
    }),
    { numRuns: RUNS, endOnFailure: true },
  );
});
