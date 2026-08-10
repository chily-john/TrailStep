import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { PackageCommandRequest } from "../../command.types.js";
import {
  resolveTrailStepSelfUpdateTargets,
  UpdateTargetResolutionError,
} from "./update-targets.js";

async function writeRootPackageJson(cwd: string) {
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify(
      {
        dependencies: { "@trailstep/core": "^0.0.1" },
        devDependencies: { "@trailstep/authoring": "~0.0.1", "@trailstep/cli": "0.0.1" },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function registryRunner(metadata: Record<string, unknown>, requests: PackageCommandRequest[] = []) {
  return async (request: PackageCommandRequest) => {
    requests.push(request);
    const packageName = String(request.args[1]).replace(/@\*$/u, "");
    return { exitCode: 0, stdout: JSON.stringify(metadata[packageName]) };
  };
}

describe("resolveTrailStepSelfUpdateTargets", () => {
  it("selects the latest stable core and matching stable authoring and CLI peers", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-target-tests", task.id);
    await writeRootPackageJson(cwd);

    const plan = await resolveTrailStepSelfUpdateTargets({
      cwd,
      packageCommandRunner: registryRunner({
        "@trailstep/core": [
          { version: "1.0.0" },
          { version: "1.1.0-beta.1" },
          { version: "1.1.0" },
        ],
        "@trailstep/authoring": [
          { version: "1.0.0", peerDependencies: { "@trailstep/core": "^1.0.0" } },
          { version: "1.1.0", peerDependencies: { "@trailstep/core": "^1.1.0" } },
          { version: "1.2.0", peerDependencies: { "@trailstep/core": "^2.0.0" } },
        ],
        "@trailstep/cli": [
          { version: "1.0.0", peerDependencies: { "@trailstep/core": "^1.0.0" } },
          { version: "1.1.0", peerDependencies: { "@trailstep/core": "^1.1.0" } },
          { version: "1.2.0", peerDependencies: { "@trailstep/core": "^2.0.0" } },
        ],
      }),
    });

    expect(plan.targets).toEqual([
      {
        packageName: "@trailstep/core",
        currentRange: "^0.0.1",
        targetVersion: "1.1.0",
        dependencySection: "dependencies",
      },
      {
        packageName: "@trailstep/authoring",
        currentRange: "~0.0.1",
        targetVersion: "1.1.0",
        dependencySection: "devDependencies",
      },
      {
        packageName: "@trailstep/cli",
        currentRange: "0.0.1",
        targetVersion: "1.1.0",
        dependencySection: "devDependencies",
      },
    ]);
  });

  it("selects authoring and CLI versions using npm semver range compatibility", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-target-tests", task.id);
    await writeRootPackageJson(cwd);

    const plan = await resolveTrailStepSelfUpdateTargets({
      cwd,
      packageCommandRunner: registryRunner({
        "@trailstep/core": [{ version: "1.5.0" }],
        "@trailstep/authoring": [
          { version: "1.4.0", peerDependencies: { "@trailstep/core": "1.4.x" } },
          { version: "1.5.0", peerDependencies: { "@trailstep/core": ">=1.0.0 <2.0.0" } },
          { version: "1.6.0", peerDependencies: { "@trailstep/core": "~1.6.0" } },
        ],
        "@trailstep/cli": [
          { version: "1.4.0", peerDependencies: { "@trailstep/core": "1.4.x" } },
          { version: "1.5.0", peerDependencies: { "@trailstep/core": "1.5.x || >=2.0.0" } },
          { version: "1.6.0", peerDependencies: { "@trailstep/core": "~1.6.0" } },
        ],
      }),
    });

    expect(plan.targets).toEqual([
      {
        packageName: "@trailstep/core",
        currentRange: "^0.0.1",
        targetVersion: "1.5.0",
        dependencySection: "dependencies",
      },
      {
        packageName: "@trailstep/authoring",
        currentRange: "~0.0.1",
        targetVersion: "1.5.0",
        dependencySection: "devDependencies",
      },
      {
        packageName: "@trailstep/cli",
        currentRange: "0.0.1",
        targetVersion: "1.5.0",
        dependencySection: "devDependencies",
      },
    ]);
  });

  it("ignores prerelease authoring and CLI candidates when compatible stable versions exist", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-target-tests", task.id);
    await writeRootPackageJson(cwd);

    const plan = await resolveTrailStepSelfUpdateTargets({
      cwd,
      packageCommandRunner: registryRunner({
        "@trailstep/core": [{ version: "1.5.0" }],
        "@trailstep/authoring": [
          { version: "1.5.0", peerDependencies: { "@trailstep/core": "^1.5.0" } },
          { version: "1.6.0-beta.1", peerDependencies: { "@trailstep/core": "^1.5.0" } },
        ],
        "@trailstep/cli": [
          { version: "1.5.0", peerDependencies: { "@trailstep/core": "^1.5.0" } },
          { version: "1.6.0-beta.1", peerDependencies: { "@trailstep/core": "^1.5.0" } },
        ],
      }),
    });

    expect(plan.targets.map((target) => [target.packageName, target.targetVersion])).toEqual([
      ["@trailstep/core", "1.5.0"],
      ["@trailstep/authoring", "1.5.0"],
      ["@trailstep/cli", "1.5.0"],
    ]);
  });

  it("blocks when no authoring version peer range satisfies the target core", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-target-tests", task.id);
    await writeRootPackageJson(cwd);

    await expect(
      resolveTrailStepSelfUpdateTargets({
        cwd,
        packageCommandRunner: registryRunner({
          "@trailstep/core": [{ version: "2.0.0" }],
          "@trailstep/authoring": [
            { version: "1.9.0", peerDependencies: { "@trailstep/core": "^1.0.0" } },
          ],
          "@trailstep/cli": [
            { version: "2.0.0", peerDependencies: { "@trailstep/core": "^2.0.0" } },
          ],
        }),
      }),
    ).rejects.toThrow(UpdateTargetResolutionError);
  });

  it("blocks when no CLI version peer range satisfies the target core", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-update-target-tests", task.id);
    await writeRootPackageJson(cwd);

    await expect(
      resolveTrailStepSelfUpdateTargets({
        cwd,
        packageCommandRunner: registryRunner({
          "@trailstep/core": [{ version: "2.0.0" }],
          "@trailstep/authoring": [
            { version: "2.0.0", peerDependencies: { "@trailstep/core": "^2.0.0" } },
          ],
          "@trailstep/cli": [
            { version: "1.9.0", peerDependencies: { "@trailstep/core": "^1.0.0" } },
          ],
        }),
      }),
    ).rejects.toThrow(UpdateTargetResolutionError);
  });
});
