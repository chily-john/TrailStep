import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "data/**", ".trailstep/**", "**/.trailstep/**"],
    // Workflow-level tests do real filesystem work (sandbox creation, event
    // writes, artifact output). The 5s Vitest default is too tight for them
    // when the whole suite runs in parallel, which made them flaky rather
    // than broken.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
