import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentAdapter, AgentAdapterRequest } from "./contracts/agents/agent-adapter.types.js";
import * as core from "./index.js";
import { jsonSchema, runWorkflow, selectLatestUnresolvedFailure, subPrompt } from "./index.js";

describe("@trailstep/core public API", () => {
  it("exports TrailStep config and failure APIs", () => {
    expect(core.parseTrailStepConfig).toBeTypeOf("function");
    expect(core.TrailStepFailureError).toBeTypeOf("function");
  });

  it("exports runtime APIs and agent adapter contracts from the public entrypoint", () => {
    expect(runWorkflow).toBeTypeOf("function");
    expect(jsonSchema).toBeTypeOf("function");
    expect(selectLatestUnresolvedFailure).toBeTypeOf("function");

    type PublicLatestUnresolvedFailure = import("./index.js").LatestUnresolvedFailure;
    const retryTarget = null as unknown as PublicLatestUnresolvedFailure;
    expect(retryTarget).toBeNull();

    type PublicAdapterRequest = import("./index.js").AgentAdapterRequest;
    type PublicAgentAdapter = import("./index.js").AgentAdapter;

    const adapter = null as unknown as AgentAdapter;
    const publicAdapter = adapter satisfies PublicAgentAdapter;
    const request = null as unknown as AgentAdapterRequest;
    const publicRequest = request satisfies PublicAdapterRequest;

    expect(publicAdapter).toBe(adapter);
    expect(publicRequest).toBe(request);
  });

  it("exports subPrompt and preserves the intended curried type surface", () => {
    expect(subPrompt).toBeTypeOf("function");

    const assertPublicSubPromptTypes = () => {
      const output = jsonSchema<{ answer: string }>({
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      });
      const requiredInputSubPrompt = subPrompt<{ path: string }, { answer: string }>(
        ({ input }) => `Read ${input.path}`,
        { output },
      );
      requiredInputSubPrompt({ path: "story.md" });
      // @ts-expect-error required input keys must be provided.
      requiredInputSubPrompt();

      // biome-ignore lint/complexity/noBannedTypes: public subPrompt authoring supports `{}` as the no-required-input type.
      const optionalInputSubPrompt = subPrompt<{}, { answer: string }>("Answer briefly.", {
        output,
      });
      optionalInputSubPrompt();
      optionalInputSubPrompt({});

      const subPromptOptions = {
        output,
        agent: "researcher",
        adapter: async () => undefined,
        maxSubPrompts: 3,
      } satisfies import("./index.js").SubPromptOptions<{ answer: string }>;
      const subPromptOptionsWithMode = {
        // @ts-expect-error subPrompt options intentionally do not support prompt mode selection.
        mode: "working",
      } satisfies import("./index.js").SubPromptOptions<{
        answer: string;
      }>;
      const promptOptions = {
        mode: "interactive",
        maxSubPrompts: 3,
      } satisfies import("./index.js").PromptOptions<{ answer: string }>;

      return { promptOptions, subPromptOptions, subPromptOptionsWithMode };
    };

    expect(assertPublicSubPromptTypes).toBeTypeOf("function");
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
