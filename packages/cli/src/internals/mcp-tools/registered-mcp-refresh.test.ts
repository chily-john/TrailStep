import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { refreshRegisteredWorkflowMcpTools } from "./registered-mcp-refresh.js";

// Per-entry failure isolation contract for the `trailstep update --workflows`
// MCP tool refresh: one registration that fails to resolve (missing source,
// module without a workflow export, ...) must be reported in `failures` while
// every other registration is still refreshed into `.trailstep/mcp/trst_*.json`.
// All fixtures live under per-test tmp dirs; homeDir is injected so the real
// ~/.trailstep registry is never read.

function tmpDir(task: { readonly id: string }): string {
  return join(
    "node_modules",
    ".tmp-trailstep-registered-mcp-refresh-tests",
    `${task.id}-${randomUUID()}`,
  );
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const healthyWorkflowSource =
  'export const healthy = { id: "healthy", description: "Healthy flow.", start: (input) => input };\n';

describe("refreshRegisteredWorkflowMcpTools", () => {
  it("isolates a failing registration so the other entries still refresh", async ({ task }) => {
    const cwd = tmpDir(task);
    const homeDir = tmpDir(task);
    // The broken entry is registered first, so a non-isolating implementation
    // would abort before ever reaching the healthy entry.
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { broken: "./missing.mjs", healthy: "./healthy.mjs" } },
    });
    await writeFile(join(cwd, "healthy.mjs"), healthyWorkflowSource, "utf8");

    const result = await refreshRegisteredWorkflowMcpTools({ cwd, homeDir });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.registeredRef).toBe("project/broken");
    expect(result.failures[0]?.message).toContain("missing.mjs");

    expect(result.generated).toHaveLength(1);
    const generatedPath = result.generated[0] ?? "";
    expect(generatedPath).toContain("trst_healthy.json");
    const payload = JSON.parse(await readFile(generatedPath, "utf8")) as Record<string, unknown>;
    expect(payload.name).toBe("trst_healthy");
    expect(payload.workflowRef).toBe("project/healthy");
    expect(payload.description).toBe("Healthy flow.");
  });

  it("reports resolution errors per entry and refreshes entries after the failure", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    const homeDir = tmpDir(task);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: {
        project: {
          alpha: "./alpha.mjs",
          noflow: "./no-workflow.mjs",
          omega: "./omega.mjs",
        },
      },
    });
    await writeFile(
      join(cwd, "alpha.mjs"),
      'export const alpha = { id: "alpha", description: "Alpha flow.", start: (input) => input };\n',
      "utf8",
    );
    await writeFile(join(cwd, "no-workflow.mjs"), "export const notAWorkflow = 42;\n", "utf8");
    await writeFile(
      join(cwd, "omega.mjs"),
      'export const omega = { id: "omega", description: "Omega flow.", start: (input) => input };\n',
      "utf8",
    );

    const result = await refreshRegisteredWorkflowMcpTools({ cwd, homeDir });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.registeredRef).toBe("project/noflow");
    expect(result.failures[0]?.message).toContain("no-workflow.mjs");

    expect(result.generated).toHaveLength(2);
    const generatedNames = result.generated.map((filePath) => filePath.split(/[\\/]/u).pop());
    expect(generatedNames).toEqual(["trst_alpha.json", "trst_omega.json"]);
  });
});
