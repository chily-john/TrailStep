import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Workflow-run suites (e.g. run-workflow-parallel-tracks) can exceed vitest's
    // 5s default under `turbo run test` parallel contention across packages.
    testTimeout: 30_000,
  },
});
