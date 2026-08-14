import { cp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

await rm(join(packageDir, "shared"), { recursive: true, force: true });
await cp(join(packageDir, "src", "feature-implementation", "shared"), join(packageDir, "shared"), {
  recursive: true,
});
