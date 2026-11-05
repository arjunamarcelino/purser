(globalThis as Record<string, unknown>).__PURSER_CONFIG__ = { contractId: "purser.op.testnet", network: "testnet", rpcUrl: "https://test.rpc.fastnear.com" };

// Unmount rendered trees between tests (Testing Library auto-cleanup needs vitest globals).
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
afterEach(() => cleanup());
