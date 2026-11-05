// One local sandbox for the whole sandbox project; test files share it via inject().
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, Sandbox } from "near-sandbox";
import type { TestProject } from "vitest/node";
import { readProdWasm, requireVerifiedSandboxBinary } from "../../../proposer/src/dev/purser-sandbox.ts";

// nearcore matching the contract's near-sdk 5.30 target (protocol 88); near-sandbox 0.3.4 defaults to 2.13.4.
const VERSION = process.env.NEAR_SANDBOX_VERSION ?? "2.14.0";

declare module "vitest" {
  export interface ProvidedContext {
    sandboxRpc: string;
    sandboxRootId: string;
    sandboxRootKey: string;
  }
}

let sandbox: Sandbox | undefined;

export async function setup(project: TestProject) {
  requireVerifiedSandboxBinary();
  readProdWasm(); // fail fast with "run make build" before starting nearcore
  sandbox = await Sandbox.start({ version: VERSION });
  project.provide("sandboxRpc", sandbox.rpcUrl);
  project.provide("sandboxRootId", DEFAULT_ACCOUNT_ID);
  project.provide("sandboxRootKey", DEFAULT_PRIVATE_KEY);
}

export async function teardown() {
  await sandbox?.tearDown();
}
