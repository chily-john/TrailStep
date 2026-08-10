import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createPackageInstallRunner, detectPackageManager } from "./package-manager.js";

async function writePackageJson(cwd: string, packageJson: Record<string, unknown> = {}) {
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "package.json"), JSON.stringify(packageJson, null, 2), "utf8");
}

describe("detectPackageManager", () => {
  it.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
  ] as const)("selects %s before packageManager metadata", async (lockfile, name) => {
    const cwd = join("node_modules", ".tmp-trailstep-package-manager-tests", `lockfile-${name}`);
    await writePackageJson(cwd, { packageManager: "npm@10.0.0" });
    await writeFile(join(cwd, lockfile), "", "utf8");

    await expect(detectPackageManager({ cwd })).resolves.toEqual({
      name,
      installCommand: { command: name, args: ["install"] },
      warnings: [],
    });
  });

  it("uses packageManager metadata when no known lockfile exists", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-package-manager-tests", task.id);
    await writePackageJson(cwd, { packageManager: "pnpm@10.13.1" });

    await expect(detectPackageManager({ cwd })).resolves.toEqual({
      name: "pnpm",
      installCommand: { command: "pnpm", args: ["install"] },
      warnings: [],
    });
  });

  it("defaults to npm with a warning when no known lockfile or packageManager exists", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-package-manager-tests", task.id);
    await writePackageJson(cwd);

    await expect(detectPackageManager({ cwd })).resolves.toEqual({
      name: "npm",
      installCommand: { command: "npm", args: ["install"] },
      warnings: ["No lockfile or packageManager field found; defaulting to npm."],
    });
  });
});

describe("createPackageInstallRunner", () => {
  it("runs the detected install command through an injected package command runner", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-package-manager-tests", task.id);
    await writePackageJson(cwd);
    await writeFile(join(cwd, "pnpm-lock.yaml"), "", "utf8");
    const requests: Array<{ command: string; args: readonly string[]; cwd: string }> = [];

    const result = await createPackageInstallRunner({
      cwd,
      packageCommandRunner: async (request) => {
        requests.push(request);
        return { exitCode: 0, stdout: "installed" };
      },
    })();

    expect(requests).toEqual([{ command: "pnpm", args: ["install"], cwd }]);
    expect(result).toEqual({ exitCode: 0, stdout: "installed" });
  });
});
