import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { loadProviderPackage } from "./provider-package-loader.js";

function tmpDir(task: { readonly id: string }): string {
  return join(
    "node_modules",
    ".tmp-trailstep-provider-package-loader-tests",
    `${task.id}-${randomUUID()}`,
  );
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const validManifest = {
  schemaVersion: 1,
  id: "echo",
  displayName: "Echo Provider",
  working: {
    supported: true,
    command: "echo-provider",
    args: ["--prompt", "{{promptFile}}", "--output", "{{outputFile}}"],
    prompt: { kind: "prompt-file", reference: "at-prefixed-argument" },
    output: { style: "stdout-json-envelope", parsing: { resultField: "result" } },
  },
  interactive: {
    supported: false,
    reason: "Working-agent only.",
    modelFlag: "--model",
  },
  model: { supported: true, flag: "--model" },
  thinking: { supported: true, flag: "--thinking", levels: ["low", "medium"] },
} as const;

describe("provider package loader", () => {
  it("loads trailstepProvider.manifest and reports hook presence without embedding hooks in the manifest", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    const packageRoot = resolve(cwd, "providers", "echo-package");
    await writeJson(resolve(packageRoot, "package.json"), {
      name: "@example/trailstep-provider-echo",
      version: "1.2.3",
      type: "module",
      exports: "./index.mjs",
    });
    await writeFile(
      resolve(packageRoot, "index.mjs"),
      `export const trailstepProvider = {\n  manifest: ${JSON.stringify(validManifest)},\n  hooks: { beforeWorkingAgent: async () => undefined }\n};\n`,
      "utf8",
    );
    const importer = vi.fn(async (specifier: string) => {
      expect(specifier).toBe(pathToFileURL(resolve(packageRoot, "index.mjs")).href);
      return import(specifier) as Promise<Record<string, unknown>>;
    });

    const loaded = await loadProviderPackage(packageRoot, { importer });

    expect(importer).toHaveBeenCalledOnce();
    expect(loaded.manifest).toEqual(validManifest);
    expect(loaded.hooksPresent).toBe(true);
    expect(loaded.packageName).toBe("@example/trailstep-provider-echo");
    expect(loaded.version).toBe("1.2.3");
    expect(JSON.stringify(loaded.manifest)).not.toContain("beforeWorkingAgent");
  });
});
