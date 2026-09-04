import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("core architecture invariants", () => {
  it("keeps refactored front doors and ownership boundaries in place", async () => {
    const sourceRoot = path.resolve(import.meta.dirname);

    expect(
      existsSync(
        path.join(sourceRoot, "agent-execution", "working-agent", "run-working-agent-command"),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(
          sourceRoot,
          "agent-execution",
          "interactive-agent",
          "run-interactive-agent-command",
        ),
      ),
    ).toBe(false);

    const files = await listSourceFiles(sourceRoot);
    const runtimeFiles = files.filter((file) => file.includes(`${path.sep}runtime${path.sep}`));
    await Promise.all(
      runtimeFiles.map(async (file) => {
        const contents = await readFile(file, "utf8");
        expect(contents, path.relative(sourceRoot, file)).not.toContain(
          "agent-execution/interactive-agent",
        );
      }),
    );

    const publicEntrypoint = await readFile(path.join(sourceRoot, "index.ts"), "utf8");
    expect(publicEntrypoint).not.toMatch(/from "\.\/runtime\/(failures|sub-prompts)\//);
    expect(publicEntrypoint).not.toMatch(
      /from "\.\/agent-execution\/(working-agent|interactive-agent)\/(artifacts|output|prompts|protocol|targets|run-working-agent-command\/|run-interactive-agent-command\/)/,
    );

    for (const boundary of [
      path.join(sourceRoot, "agent-execution", "working-agent"),
      path.join(sourceRoot, "agent-execution", "interactive-agent"),
      path.join(sourceRoot, "runtime", "sub-prompts"),
      path.join(sourceRoot, "runtime", "interactive-session"),
    ]) {
      const directoryNames = await listDirectoryNames(boundary);
      expect(directoryNames).not.toEqual(expect.arrayContaining(["utils", "helpers", "common"]));
    }
  });

  it("does not keep built-in provider implementations or registry exports in core", async () => {
    const sourceRoot = path.resolve(import.meta.dirname);
    const legacyProvidersRoot = path.join(
      sourceRoot,
      ["known", "cli", "providers"].join("-"),
      "official",
    );

    const concreteOfficialProviderFiles = [
      path.join(legacyProvidersRoot, "claude", "claude-provider.ts"),
      path.join(legacyProvidersRoot, "codex", "codex-provider.ts"),
      path.join(legacyProvidersRoot, "gemini", "gemini-provider.ts"),
      path.join(legacyProvidersRoot, "pi", "pi-provider.ts"),
    ];

    expect(
      concreteOfficialProviderFiles
        .filter((file) => existsSync(file))
        .map((file) => path.relative(sourceRoot, file)),
    ).toEqual([]);

    const legacyOfficialImportSegment = `${["known", "cli", "providers"].join("-")}/official/`;
    const legacyRegistryImportSegment = `${["known", "cli", "providers"].join("-")}/registry/${["provider", "registry"].join("-")}`;

    const sourceFiles = await listSourceFiles(sourceRoot);
    await Promise.all(
      sourceFiles.map(async (file) => {
        const contents = await readFile(file, "utf8");
        expect(contents, path.relative(sourceRoot, file)).not.toContain(
          legacyOfficialImportSegment,
        );
        expect(contents, path.relative(sourceRoot, file)).not.toContain(
          legacyRegistryImportSegment,
        );
      }),
    );

    const publicEntrypoint = await readFile(path.join(sourceRoot, "index.ts"), "utf8");
    expect(publicEntrypoint).not.toContain(["provider", "Registry"].join(""));
    expect(publicEntrypoint).not.toContain(["Provider", "RegistryKey"].join(""));
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

async function listDirectoryNames(directory: string): Promise<string[]> {
  if (!existsSync(directory)) {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return [entry.name, ...(await listDirectoryNames(entryPath))];
      }
      return [];
    }),
  );
  return nested.flat();
}
