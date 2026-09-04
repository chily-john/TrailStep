import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const docsRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../../");

async function readDoc(...segments: string[]): Promise<string> {
  return readFile(join(docsRoot, ...segments), "utf8");
}

describe("provider public docs", () => {
  it("documents package and local-manifest provider registration instead of built-in core providers", async () => {
    const [rootReadme, cliReadme, cliReference] = await Promise.all([
      readDoc("README.md"),
      readDoc("packages", "cli", "README.md"),
      readDoc("docs", "cli-reference.md"),
    ]);

    const publicDocs = [rootReadme, cliReadme, cliReference].join("\n\n");

    expect(publicDocs).toContain("trailstep providers add <path-or-package>");
    expect(publicDocs).toContain("trailstep providers add @trailstep/provider-pi --scope project");
    expect(publicDocs).toContain(
      "trailstep providers add ./providers/my-agent.trailstep-provider.json --scope project",
    );
    expect(publicDocs).not.toMatch(/built-in provider/i);
    expect(publicDocs).not.toMatch(/built-in or custom provider shortcut/i);
    expect(publicDocs).not.toMatch(/providers are built into @trailstep\/core/i);
  });

  it("documents the hook trust boundary for provider packages", async () => {
    const [rootReadme, cliReadme, cliReference] = await Promise.all([
      readDoc("README.md"),
      readDoc("packages", "cli", "README.md"),
      readDoc("docs", "cli-reference.md"),
    ]);

    const publicDocs = [rootReadme, cliReadme, cliReference].join("\n\n");

    expect(publicDocs).toContain("execute provider package code");
    expect(publicDocs).toContain("trusted like installed npm");
    expect(publicDocs).toContain("trailstep providers test");
  });

  it("keeps official provider READMEs aligned with install and register flows", async () => {
    const providerReadmes = [
      {
        id: "claude",
        packageName: "@trailstep/provider-claude",
        readme: await readDoc("packages", "provider-claude", "README.md"),
      },
      {
        id: "codex",
        packageName: "@trailstep/provider-codex",
        readme: await readDoc("packages", "provider-codex", "README.md"),
      },
      {
        id: "gemini",
        packageName: "@trailstep/provider-gemini",
        readme: await readDoc("packages", "provider-gemini", "README.md"),
      },
      {
        id: "pi",
        packageName: "@trailstep/provider-pi",
        readme: await readDoc("packages", "provider-pi", "README.md"),
      },
    ];

    for (const provider of providerReadmes) {
      expect(provider.readme).toContain(`npm install ${provider.packageName}`);
      expect(provider.readme).toContain(
        `trailstep providers add ${provider.packageName} --scope project`,
      );
      expect(provider.readme).toContain(
        `trailstep agents set default --provider ${provider.id} --scope project`,
      );
    }
  });
});
