import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findMcpToolJsonsToRemoveForRegistration,
  generateMcpToolJson,
  MCP_TOOL_OUTPUT_DIR,
  McpToolGenerationError,
  type McpToolWorkflowInput,
  mcpToolInputFromWorkflow,
  mcpToolJsonPathForWorkflowId,
} from "./mcp-tool-generation.js";

const KEY_ORDER = [
  "schemaVersion",
  "name",
  "workflowRef",
  "description",
  "inputSchema",
  "source",
  "generatedBy",
];

function workflowInput(overrides: Partial<McpToolWorkflowInput> = {}): McpToolWorkflowInput {
  return {
    id: "take-it-away",
    description: "Ship a finished change set.",
    workflowRef: "flows/take-it-away",
    sourceContent: "defineWorkflow({ id: 'take-it-away' })",
    ...overrides,
  };
}

async function listGeneratedFiles(projectDir: string): Promise<string[]> {
  try {
    return (await readdir(join(projectDir, MCP_TOOL_OUTPUT_DIR))).filter((name) =>
      name.startsWith("trst_"),
    );
  } catch {
    return [];
  }
}

async function readGenerated(projectDir: string, slug: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(projectDir, MCP_TOOL_OUTPUT_DIR, `trst_${slug}.json`), "utf8"),
  ) as Record<string, unknown>;
}

describe("generateMcpToolJson", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "trst-mcp-tool-gen-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("reflects a changed description when refreshed", async () => {
    const firstPath = await generateMcpToolJson(workflowInput({ description: "First cut." }), {
      projectDir,
    });
    expect(firstPath.endsWith("trst_take-it-away.json")).toBe(true);
    expect((await readGenerated(projectDir, "take-it-away")).description).toBe("First cut.");

    const secondPath = await generateMcpToolJson(workflowInput({ description: "Second cut." }), {
      projectDir,
    });
    expect(secondPath).toBe(firstPath);
    expect((await readGenerated(projectDir, "take-it-away")).description).toBe("Second cut.");
    expect(await listGeneratedFiles(projectDir)).toEqual(["trst_take-it-away.json"]);
  });

  it("maps inputShape params into inputSchema", async () => {
    await generateMcpToolJson(
      workflowInput({ inputShape: { title: "string", count: "number", active: "boolean" } }),
      { projectDir },
    );

    const generated = await readGenerated(projectDir, "take-it-away");
    const inputSchema = generated.inputSchema as {
      properties: Record<string, { type: string }>;
      required: readonly string[];
    };
    expect(inputSchema.properties.title).toEqual({ type: "string" });
    expect(inputSchema.properties.count).toEqual({ type: "number" });
    expect(inputSchema.properties.active).toEqual({ type: "boolean" });
    expect(inputSchema.required).toEqual(["title", "count", "active"]);
  });

  it("writes stable key order and a sha256 source hash", async () => {
    const sourceContent = "source-of-truth";
    await generateMcpToolJson(workflowInput({ sourceContent }), { projectDir });

    const generated = await readGenerated(projectDir, "take-it-away");
    expect(Object.keys(generated)).toEqual(KEY_ORDER);
    expect(Object.keys(generated.source as Record<string, unknown>)).toEqual(["scope", "hash"]);
    expect((generated.source as { scope: string }).scope).toBe("local");
    expect((generated.source as { hash: string }).hash).toBe(
      createHash("sha256").update(sourceContent, "utf-8").digest("hex"),
    );
    expect(generated.name).toBe("trst_take-it-away");
    expect(generated.generatedBy).toBe("trailstep");
    expect(generated.schemaVersion).toBe("1.0.0");
  });

  it("slugifies unsafe workflow ids for the tool name and file name", async () => {
    await generateMcpToolJson(workflowInput({ id: "pkg#ship-it" }), { projectDir });

    const generated = await readGenerated(projectDir, "pkg_ship-it");
    expect(generated.name).toBe("trst_pkg_ship-it");
    expect(await listGeneratedFiles(projectDir)).toEqual(["trst_pkg_ship-it.json"]);
  });

  it("never writes malformed payloads", async () => {
    await expect(
      generateMcpToolJson(workflowInput({ id: "" }), { projectDir }),
    ).rejects.toBeInstanceOf(McpToolGenerationError);
    await expect(
      generateMcpToolJson(workflowInput({ id: "###" }), { projectDir }),
    ).rejects.toBeInstanceOf(McpToolGenerationError);
    await expect(
      generateMcpToolJson(workflowInput({ workflowRef: "  " }), { projectDir }),
    ).rejects.toBeInstanceOf(McpToolGenerationError);
    await expect(
      generateMcpToolJson(workflowInput({ inputShape: { bad: "not-a-type" } as never }), {
        projectDir,
      }),
    ).rejects.toThrow();

    expect(await listGeneratedFiles(projectDir)).toEqual([]);
  });
});

describe("mcpToolInputFromWorkflow", () => {
  it("derives the tool input from a workflow definition, with a fallback description", () => {
    const input = mcpToolInputFromWorkflow(
      { id: "ship-it", inputShape: { title: "string" } },
      "flows/ship-it",
    );

    expect(input.id).toBe("ship-it");
    expect(input.workflowRef).toBe("flows/ship-it");
    expect(input.description).toBe('Run the TrailStep workflow "flows/ship-it".');
    expect(typeof input.sourceContent).toBe("string");
    expect(input.sourceContent).toContain("ship-it");
  });

  it("uses an explicit workflow description when present", () => {
    const input = mcpToolInputFromWorkflow(
      { id: "ship-it", description: "Ship it." },
      "flows/ship-it",
    );
    expect(input.description).toBe("Ship it.");
  });
});

describe("mcpToolJsonPathForWorkflowId", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "trst-mcp-tool-path-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("slugifies ids with the same naming rules generation uses", () => {
    expect(mcpToolJsonPathForWorkflowId("take-it-away", { projectDir })).toBe(
      join(projectDir, MCP_TOOL_OUTPUT_DIR, "trst_take-it-away.json"),
    );
    expect(mcpToolJsonPathForWorkflowId("pkg#ship-it", { projectDir })).toBe(
      join(projectDir, MCP_TOOL_OUTPUT_DIR, "trst_pkg_ship-it.json"),
    );
    expect(() => mcpToolJsonPathForWorkflowId("###", { projectDir })).toThrow(
      McpToolGenerationError,
    );
  });

  it("returns the exact path generateMcpToolJson writes", async () => {
    const writtenPath = await generateMcpToolJson(workflowInput(), { projectDir });
    expect(writtenPath).toBe(mcpToolJsonPathForWorkflowId("take-it-away", { projectDir }));
  });
});

describe("findMcpToolJsonsToRemoveForRegistration", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "trst-mcp-tool-remove-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("returns only tool JSONs that record the removed registration's workflowRef", async () => {
    await generateMcpToolJson(workflowInput({ id: "review", workflowRef: "project/review" }), {
      projectDir,
    });
    // Renamed registration: file named for the workflow id, not the name.
    await generateMcpToolJson(workflowInput({ id: "other-id", workflowRef: "project/renamed" }), {
      projectDir,
    });
    // Slug collision: trst_mismatch.json exists under the removed registration's
    // name but records a different ref, so it must never be deleted.
    await generateMcpToolJson(workflowInput({ id: "mismatch", workflowRef: "legacy/review" }), {
      projectDir,
    });

    const forRenamed = await findMcpToolJsonsToRemoveForRegistration({
      workflowRef: "project/renamed",
      registrationName: "renamed",
      projectDir,
    });
    expect(forRenamed).toEqual([join(projectDir, MCP_TOOL_OUTPUT_DIR, "trst_other-id.json")]);

    const forOriginal = await findMcpToolJsonsToRemoveForRegistration({
      workflowRef: "project/review",
      registrationName: "mismatch",
      projectDir,
    });
    expect(forOriginal).toEqual([join(projectDir, MCP_TOOL_OUTPUT_DIR, "trst_review.json")]);
  });

  it("returns nothing when no tool JSON records the ref", async () => {
    await expect(
      findMcpToolJsonsToRemoveForRegistration({
        workflowRef: "project/never-generated",
        registrationName: "never-generated",
        projectDir,
      }),
    ).resolves.toEqual([]);
  });
});
