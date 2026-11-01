import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveAgentTargets } from "@trailstep/core";
import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../../index.js";
import { withTestCustomProviders } from "../../../test/provider-fixtures.js";
import { loadTrailStepProjectConfig } from "../../config/config.js";

const createdRoots: string[] = [];

interface Sandbox {
  readonly projectDir: string;
  readonly homeDir: string;
}

async function sandbox(task: { readonly id: string }): Promise<Sandbox> {
  // Sandboxes live inside the package's node_modules so the workflow files they import can
  // resolve `@trailstep/core` from this repository.
  const root = join("node_modules", ".tmp-trailstep-agents-listing-tests", task.id);
  createdRoots.push(root);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  const projectDir = join(root, "project");
  const homeDir = join(root, "home");
  await mkdir(join(projectDir, ".trailstep"), { recursive: true });
  await mkdir(join(homeDir, ".trailstep"), { recursive: true });
  return { projectDir, homeDir };
}

async function writeConfig(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(withTestCustomProviders(value), null, 2)}\n`, "utf8");
}

interface TargetShape {
  readonly provider: string;
  readonly model?: string;
  readonly thinking?: string;
}

function formatTarget(target: TargetShape): string {
  const parts = [`provider ${target.provider}`];
  if (typeof target.model === "string" && target.model.trim().length > 0) {
    parts.push(`model ${target.model}`);
  }
  if (target.thinking !== undefined) {
    parts.push(`thinking ${target.thinking}`);
  }
  return parts.join(", ");
}

function finalTargetLines(output: string, roleName: string): readonly string[] {
  const lines = output.split("\n");
  const roleStart = lines.findIndex((line) => line.startsWith(`  ${roleName} (size `));
  expect(roleStart).toBeGreaterThanOrEqual(0);

  const collected: string[] = [];
  let inFinalTargets = false;
  for (let index = roleStart + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("  ") && !line.startsWith("    ")) {
      break;
    }
    if (line.trim() === "Final targets:") {
      inFinalTargets = true;
      continue;
    }
    if (!inFinalTargets) {
      continue;
    }
    const match = /^ {6}\d+\. (.*)$/u.exec(line);
    if (match?.[1] !== undefined) {
      collected.push(match[1]);
    }
  }
  return collected;
}

afterEach(async () => {
  for (const root of createdRoots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

describe("agents explain workflow", () => {
  it("lists the same final targets the runtime resolves across global, project and local scopes", async ({
    task,
  }) => {
    const paths = await sandbox(task);
    await mkdir(join(paths.projectDir, "workflows"), { recursive: true });
    await writeFile(
      join(paths.projectDir, "workflows", "release.mjs"),
      [
        "export const release = {",
        "  id: 'release',",
        "  agents: { planner: { size: 'large' }, builder: { size: 'medium' }, reviewer: { size: 'medium' } },",
        "  start: () => ({ kind: 'done', output: {} }),",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    await writeConfig(join(paths.homeDir, ".trailstep", "config.json"), {
      version: 1,
      agents: { default: [{ provider: "gemini" }] },
      workflows: {
        release: { agents: { planner: [{ provider: "pi", model: "global-model" }] } },
      },
    });
    await writeConfig(join(paths.projectDir, ".trailstep", "config.json"), {
      version: 1,
      workflows: {
        project: { release: "./workflows/release.mjs" },
        release: { agents: { builder: [{ provider: "codex", model: "project-model" }] } },
      },
    });
    await writeConfig(join(paths.projectDir, ".trailstep", "config-local.json"), {
      version: 1,
      workflows: {
        release: { agents: { reviewer: [{ provider: "claude", model: "local-model" }] } },
      },
    });

    const lines: string[] = [];
    const exitCode = await main({
      argv: ["agents", "explain", "project/release"],
      cwd: paths.projectDir,
      homeDir: paths.homeDir,
      io: {
        writeLine: (line) => lines.push(line),
        writeError: (line) => lines.push(`ERR ${line}`),
      },
    });
    expect(exitCode).toBe(0);
    const output = lines.join("\n");

    const loaded = await loadTrailStepProjectConfig(paths.projectDir, {
      homeDir: paths.homeDir,
    });
    expect(loaded.configErrors).toEqual([]);
    const config = loaded.trailstepConfig;
    expect(config).toBeDefined();
    if (config === undefined) {
      return;
    }

    for (const [roleName, roleSize] of [
      ["planner", "large"],
      ["builder", "medium"],
      ["reviewer", "medium"],
    ] as const) {
      const expected = resolveAgentTargets({
        config,
        workflowId: "release",
        roleName,
        roleSize,
      }).map(formatTarget);
      expect(finalTargetLines(output, roleName)).toEqual(expected);
    }

    // Every scope's contribution is visible, so the runtime result is explainable.
    expect(output).toContain("Sources:");
    expect(output).toContain("workflows.release.agents.planner");
    expect(output).toContain("workflows.release.agents.builder");
    expect(output).toContain("workflows.release.agents.reviewer");
    expect(output).toContain("agents.default");
  });
});
