import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Delegate suites spawn `git` and run workflows; the 5s default flakes under
    // `turbo run test` parallel contention across packages.
    testTimeout: 30_000,
  },
});
