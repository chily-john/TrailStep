import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { PackageCommandRequest } from "../../command.types.js";
import { resolveStepKitSelfUpdateTargets, UpdateTargetResolutionError } from "./update-targets.js";

async function writeRootPackageJson(cwd: string) {
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify(
      {
        dependencies: { "@stepkit/core": "^0.0.1" },
        devDependencies: { "@stepkit/sdk": "~0.0.1", "@stepkit/cli": "0.0.1" },
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

describe("resolveStepKitSelfUpdateTargets", () => {
  it("selects the latest stable core and matching stable SDK and CLI peers", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-update-target-tests", task.id);
    await writeRootPackageJson(cwd);

    const plan = await resolveStepKitSelfUpdateTargets({
      cwd,
      packageCommandRunner: registryRunner({
        "@stepkit/core": [{ version: "1.0.0" }, { version: "1.1.0-beta.1" }, { version: "1.1.0" }],
        "@stepkit/sdk": [
          { version: "1.0.0", peerDependencies: { "@stepkit/core": "^1.0.0" } },
          { version: "1.1.0", peerDependencies: { "@stepkit/core": "^1.1.0" } },
          { version: "1.2.0", peerDependencies: { "@stepkit/core": "^2.0.0" } },
        ],
        "@stepkit/cli": [
          { version: "1.0.0", peerDependencies: { "@stepkit/core": "^1.0.0" } },
          { version: "1.1.0", peerDependencies: { "@stepkit/core": "^1.1.0" } },
          { version: "1.2.0", peerDependencies: { "@stepkit/core": "^2.0.0" } },
        ],
      }),
    });

    expect(plan.targets).toEqual([
      {
        packageName: "@stepkit/core",
        currentRange: "^0.0.1",
        targetVersion: "1.1.0",
        dependencySection: "dependencies",
      },
      {
        packageName: "@stepkit/sdk",
        currentRange: "~0.0.1",
        targetVersion: "1.1.0",
        dependencySection: "devDependencies",
      },
      {
        packageName: "@stepkit/cli",
        currentRange: "0.0.1",
        targetVersion: "1.1.0",
        dependencySection: "devDependencies",
      },
    ]);
  });

  it("selects SDK and CLI versions using npm semver range compatibility", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-update-target-tests", task.id);
    await writeRootPackageJson(cwd);

    const plan = await resolveStepKitSelfUpdateTargets({
      cwd,
      packageCommandRunner: registryRunner({
        "@stepkit/core": [{ version: "1.5.0" }],
        "@stepkit/sdk": [
          { version: "1.4.0", peerDependencies: { "@stepkit/core": "1.4.x" } },
          { version: "1.5.0", peerDependencies: { "@stepkit/core": ">=1.0.0 <2.0.0" } },
          { version: "1.6.0", peerDependencies: { "@stepkit/core": "~1.6.0" } },
        ],
        "@stepkit/cli": [
          { version: "1.4.0", peerDependencies: { "@stepkit/core": "1.4.x" } },
          { version: "1.5.0", peerDependencies: { "@stepkit/core": "1.5.x || >=2.0.0" } },
          { version: "1.6.0", peerDependencies: { "@stepkit/core": "~1.6.0" } },
        ],
      }),
    });

    expect(plan.targets).toEqual([
      {
        packageName: "@stepkit/core",
        currentRange: "^0.0.1",
        targetVersion: "1.5.0",
        dependencySection: "dependencies",
      },
      {
        packageName: "@stepkit/sdk",
        currentRange: "~0.0.1",
        targetVersion: "1.5.0",
        dependencySection: "devDependencies",
      },
      {
        packageName: "@stepkit/cli",
        currentRange: "0.0.1",
        targetVersion: "1.5.0",
        dependencySection: "devDependencies",
      },
    ]);
  });

  it("ignores prerelease SDK and CLI candidates when compatible stable versions exist", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-update-target-tests", task.id);
    await writeRootPackageJson(cwd);

    const plan = await resolveStepKitSelfUpdateTargets({
      cwd,
      packageCommandRunner: registryRunner({
        "@stepkit/core": [{ version: "1.5.0" }],
        "@stepkit/sdk": [
          { version: "1.5.0", peerDependencies: { "@stepkit/core": "^1.5.0" } },
          { version: "1.6.0-beta.1", peerDependencies: { "@stepkit/core": "^1.5.0" } },
        ],
        "@stepkit/cli": [
          { version: "1.5.0", peerDependencies: { "@stepkit/core": "^1.5.0" } },
          { version: "1.6.0-beta.1", peerDependencies: { "@stepkit/core": "^1.5.0" } },
        ],
      }),
    });

    expect(plan.targets.map((target) => [target.packageName, target.targetVersion])).toEqual([
      ["@stepkit/core", "1.5.0"],
      ["@stepkit/sdk", "1.5.0"],
      ["@stepkit/cli", "1.5.0"],
    ]);
  });

  it("blocks when no SDK version peer range satisfies the target core", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-update-target-tests", task.id);
    await writeRootPackageJson(cwd);

    await expect(
      resolveStepKitSelfUpdateTargets({
        cwd,
        packageCommandRunner: registryRunner({
          "@stepkit/core": [{ version: "2.0.0" }],
          "@stepkit/sdk": [{ version: "1.9.0", peerDependencies: { "@stepkit/core": "^1.0.0" } }],
          "@stepkit/cli": [{ version: "2.0.0", peerDependencies: { "@stepkit/core": "^2.0.0" } }],
        }),
      }),
    ).rejects.toThrow(UpdateTargetResolutionError);
  });

  it("blocks when no CLI version peer range satisfies the target core", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-update-target-tests", task.id);
    await writeRootPackageJson(cwd);

    await expect(
      resolveStepKitSelfUpdateTargets({
        cwd,
        packageCommandRunner: registryRunner({
          "@stepkit/core": [{ version: "2.0.0" }],
          "@stepkit/sdk": [{ version: "2.0.0", peerDependencies: { "@stepkit/core": "^2.0.0" } }],
          "@stepkit/cli": [{ version: "1.9.0", peerDependencies: { "@stepkit/core": "^1.0.0" } }],
        }),
      }),
    ).rejects.toThrow(UpdateTargetResolutionError);
  });
});
