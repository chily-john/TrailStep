import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { withTestCustomProviders } from "../../test/provider-fixtures.js";
import { loadTrailStepProjectConfig, mergeConfigScopes } from "./config.js";

interface Sandbox {
  readonly projectDir: string;
  readonly homeDir: string;
  readonly localConfigPath: string;
  readonly projectConfigPath: string;
  readonly globalConfigPath: string;
}

const createdRoots: string[] = [];

async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "trailstep-config-scopes-"));
  createdRoots.push(root);
  const projectDir = join(root, "project");
  const homeDir = join(root, "home");
  await mkdir(join(projectDir, ".trailstep"), { recursive: true });
  await mkdir(join(homeDir, ".trailstep"), { recursive: true });

  return {
    projectDir,
    homeDir,
    localConfigPath: join(projectDir, ".trailstep", "config-local.json"),
    projectConfigPath: join(projectDir, ".trailstep", "config.json"),
    globalConfigPath: join(homeDir, ".trailstep", "config.json"),
  };
}

async function writeScopeConfig(path: string, value: Record<string, unknown>): Promise<void> {
  await writeFile(path, `${JSON.stringify(withTestCustomProviders(value), null, 2)}\n`, "utf8");
}

async function writeBrokenConfig(path: string): Promise<void> {
  await writeFile(path, "{ this is not json", "utf8");
}

afterEach(async () => {
  for (const root of createdRoots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

describe("mergeConfigScopes", () => {
  it("merges plain objects recursively and replaces arrays wholesale", () => {
    const merged = mergeConfigScopes([
      { agents: { default: [{ provider: "claude" }, { provider: "codex" }] } },
      { agents: { default: [{ provider: "pi" }] } },
    ]);

    expect(merged).toEqual({ agents: { default: [{ provider: "pi" }] } });
  });

  it("never lets undefined erase a defined value while null replaces it", () => {
    const merged = mergeConfigScopes([
      { settings: { timeout: 1000, retry: { maxAttempts: 3 } } },
      { settings: { timeout: undefined, retry: null } },
    ]);

    expect(merged).toEqual({ settings: { timeout: 1000, retry: null } });
  });
});

describe("loadTrailStepProjectConfig scope composition", () => {
  it("keeps a global settings.retry when a project scope declares settings.timeout", async () => {
    const paths = await sandbox();
    await writeScopeConfig(paths.globalConfigPath, {
      version: 1,
      settings: { retry: { maxAttempts: 3 } },
    });
    await writeScopeConfig(paths.projectConfigPath, {
      version: 1,
      settings: { timeout: 60000 },
    });

    const loaded = await loadTrailStepProjectConfig(paths.projectDir, {
      homeDir: paths.homeDir,
    });

    expect(loaded.trailstepConfig?.settings).toEqual({
      retry: { maxAttempts: 3 },
      timeout: 60000,
    });
  });

  it("keeps a global workflow role when a project scope configures another role of the same workflow", async () => {
    const paths = await sandbox();
    await writeScopeConfig(paths.globalConfigPath, {
      version: 1,
      workflows: {
        takeItAway: { agents: { planner: [{ provider: "claude" }] } },
      },
    });
    await writeScopeConfig(paths.projectConfigPath, {
      version: 1,
      workflows: {
        takeItAway: { agents: { builder: [{ provider: "codex" }] } },
      },
    });

    const loaded = await loadTrailStepProjectConfig(paths.projectDir, {
      homeDir: paths.homeDir,
    });

    expect(loaded.trailstepConfig?.workflows?.takeItAway?.agents).toMatchObject({
      planner: [{ provider: "claude" }],
      builder: [{ provider: "codex" }],
    });
  });

  it("lets local override a project value for the same key", async () => {
    const paths = await sandbox();
    await writeScopeConfig(paths.projectConfigPath, {
      version: 1,
      settings: { timeout: 1000 },
    });
    await writeScopeConfig(paths.localConfigPath, {
      version: 1,
      settings: { timeout: 2000 },
    });

    const loaded = await loadTrailStepProjectConfig(paths.projectDir, {
      homeDir: paths.homeDir,
    });

    expect(loaded.trailstepConfig?.settings?.timeout).toBe(2000);
  });

  it("keeps planner, builder and reviewer configured across all three scopes", async () => {
    const paths = await sandbox();
    await writeScopeConfig(paths.globalConfigPath, {
      version: 1,
      workflows: { takeItAway: { agents: { planner: [{ provider: "claude" }] } } },
    });
    await writeScopeConfig(paths.projectConfigPath, {
      version: 1,
      workflows: { takeItAway: { agents: { builder: [{ provider: "codex" }] } } },
    });
    await writeScopeConfig(paths.localConfigPath, {
      version: 1,
      workflows: { takeItAway: { agents: { reviewer: [{ provider: "pi" }] } } },
    });

    const loaded = await loadTrailStepProjectConfig(paths.projectDir, {
      homeDir: paths.homeDir,
    });

    expect(Object.keys(loaded.trailstepConfig?.workflows?.takeItAway?.agents ?? {}).sort()).toEqual(
      ["builder", "planner", "reviewer"],
    );
  });

  it("replaces an agent target list instead of splicing it", async () => {
    const paths = await sandbox();
    await writeScopeConfig(paths.globalConfigPath, {
      version: 1,
      agents: { default: [{ provider: "claude" }, { provider: "codex" }] },
    });
    await writeScopeConfig(paths.projectConfigPath, {
      version: 1,
      agents: { default: [{ provider: "pi" }] },
    });

    const loaded = await loadTrailStepProjectConfig(paths.projectDir, {
      homeDir: paths.homeDir,
    });

    expect(loaded.trailstepConfig?.agents.default).toEqual([{ provider: "pi" }]);
  });

  it("reports a malformed global config and still loads the project scope", async () => {
    const paths = await sandbox();
    await writeBrokenConfig(paths.globalConfigPath);
    await writeScopeConfig(paths.projectConfigPath, {
      version: 1,
      agents: { default: [{ provider: "pi" }] },
    });

    const loaded = await loadTrailStepProjectConfig(paths.projectDir, {
      homeDir: paths.homeDir,
    });

    expect(loaded.configErrors).toHaveLength(1);
    expect(loaded.configErrors[0]).toMatchObject({
      scope: "global",
      path: paths.globalConfigPath,
      message: expect.stringContaining("expected valid JSON"),
    });
    expect(loaded.trailstepConfig?.agents.default).toEqual([{ provider: "pi" }]);
  });

  it("reports a malformed project config and still loads the remaining scopes", async () => {
    const paths = await sandbox();
    await writeBrokenConfig(paths.projectConfigPath);
    await writeScopeConfig(paths.localConfigPath, {
      version: 1,
      agents: { default: [{ provider: "pi" }] },
    });

    const loaded = await loadTrailStepProjectConfig(paths.projectDir, {
      homeDir: paths.homeDir,
    });

    expect(loaded.configErrors).toHaveLength(1);
    expect(loaded.configErrors[0]).toMatchObject({
      scope: "project",
      path: paths.projectConfigPath,
    });
    expect(loaded.trailstepConfig?.agents.default).toEqual([{ provider: "pi" }]);
  });

  it("returns no config errors when every scope is valid", async () => {
    const paths = await sandbox();
    await writeScopeConfig(paths.globalConfigPath, {
      version: 1,
      agents: { default: [{ provider: "claude" }] },
    });
    await writeScopeConfig(paths.projectConfigPath, {
      version: 1,
      settings: { timeout: 1000 },
    });
    await writeScopeConfig(paths.localConfigPath, {
      version: 1,
      settings: { retry: { maxAttempts: 2 } },
    });

    const loaded = await loadTrailStepProjectConfig(paths.projectDir, {
      homeDir: paths.homeDir,
    });

    expect(loaded.configErrors).toEqual([]);
  });

  it("separates the global registry from the project registry", async () => {
    const paths = await sandbox();
    await writeScopeConfig(paths.globalConfigPath, {
      version: 1,
      workflowRegistry: { global: { delegate: "@trailstep/sub-agents#delegate" } },
    });
    await writeScopeConfig(paths.projectConfigPath, {
      version: 1,
      workflowRegistry: { project: { release: "./workflows/release.mjs" } },
    });

    const loaded = await loadTrailStepProjectConfig(paths.projectDir, {
      homeDir: paths.homeDir,
    });

    expect(loaded.workflowRegistry).toEqual({
      project: { release: "./workflows/release.mjs" },
    });
    expect(loaded.globalWorkflowRegistry).toEqual({
      global: { delegate: "@trailstep/sub-agents#delegate" },
    });
  });
});
