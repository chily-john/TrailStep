import { rmSync } from "node:fs";
import { resolve } from "node:path";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("TRAILSTEP_")) {
    delete process.env[key];
  }
}

const testHome = resolve(
  "node_modules",
  ".tmp-trailstep-vitest-home",
  process.env.VITEST_WORKER_ID ?? "0",
);
rmSync(testHome, { recursive: true, force: true });
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
