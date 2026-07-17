import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentAdapter, AgentAdapterRequest } from "./contracts/agents/agent-adapter.types.js";
import { jsonSchema, runWorkflow } from "./index.js";

describe("@stepkit/core public API", () => {
  it("exports runtime APIs and agent adapter contracts from the public entrypoint", () => {
    expect(runWorkflow).toBeTypeOf("function");
    expect(jsonSchema).toBeTypeOf("function");

    type PublicAdapterRequest = import("./index.js").AgentAdapterRequest;
    type PublicAgentAdapter = import("./index.js").AgentAdapter;

    const adapter = null as unknown as AgentAdapter;
    const publicAdapter = adapter satisfies PublicAgentAdapter;
    const request = null as unknown as AgentAdapterRequest;
    const publicRequest = request satisfies PublicAdapterRequest;

    expect(publicAdapter).toBe(adapter);
    expect(publicRequest).toBe(request);
  });

  it("keeps shared contracts out of runtime and deleted engine folders", async () => {
    const sourceRoot = path.resolve(import.meta.dirname);
    const oldSharedPath = path.join(sourceRoot, "shared");
    const oldEnginePath = path.join(sourceRoot, "engine");

    expect(existsSync(oldSharedPath)).toBe(false);
    expect(existsSync(oldEnginePath)).toBe(false);

    const files = await listSourceFiles(sourceRoot);
    const contractFiles = files.filter((file) => file.includes(`${path.sep}contracts${path.sep}`));
    expect(contractFiles.length).toBeGreaterThan(0);

    for (const file of contractFiles) {
      const contents = await readFile(file, "utf8");
      expect(contents).not.toMatch(/\.\.\/runtime\//);
      expect(contents).not.toMatch(/\.\.\/agent-execution\//);
      expect(contents).not.toMatch(/\.\.\/engine\//);
    }
  });
});

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listSourceFiles(entryPath);
      }
      return entry.name.endsWith(".ts") ? [entryPath] : [];
    }),
  );
  return files.flat();
}
