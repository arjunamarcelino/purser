import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["test/unit/**/*.test.ts"] } },
      { test: { name: "sandbox", include: ["test/sandbox/**/*.test.ts"], pool: "forks", testTimeout: 180_000 } },
    ],
  },
});
