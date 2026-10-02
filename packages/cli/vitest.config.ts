import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["src/test/setup-clean-env.ts"],
    // e2e/run suites run the CLI in-process and spawn child processes; the 5s
    // default flakes under `turbo run test` parallel contention across packages.
    testTimeout: 30_000,
  },
});
