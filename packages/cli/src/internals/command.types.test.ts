import { describe, expect, it } from "vitest";

import type {
  CliCommandContext,
  PackageCommandRunner,
  StepkitCliPrompts,
} from "./command.types.js";
import { usageText } from "./command.types.js";

describe("usageText", () => {
  it("documents workflow skill distribution flags, init scope, and agents management", () => {
    expect(usageText).toContain("--project-skill");
    expect(usageText).toContain("--user-skill");
    expect(usageText).toContain(
      "stepkit init [--scope <local|project|global>] [--install-skill | --no-install-skill]",
    );
    expect(usageText).toContain("stepkit agents set <name>");
    expect(usageText).toContain("stepkit agents delete <name>");
    expect(usageText).toContain("stepkit agents rename <old> <new>");
    expect(usageText).toContain("stepkit doctor");
    expect(usageText).toContain(
      "stepkit update [--all | --workflows | --workflow <name>] [--force] [--assume-yes]",
    );
  });

  it("documents direct source workflow refs and bulk add selection syntax", () => {
    expect(usageText).toContain("./workflow.ts#reviewWorkflow");
    expect(usageText).toContain("./workflows#takeItAway");
    expect(usageText).toContain("path#exportName");
    expect(usageText).toContain("--workflow review,release,cleanup");
    expect(usageText).toContain("--workflow '*'");
  });

  it("allows CLI prompts to expose multiSelect choices", async () => {
    const prompts: StepkitCliPrompts = {
      text: async () => "",
      select: async () => "a",
      multiSelect: async () => ["a", "b"],
    };

    await expect(prompts.multiSelect?.("Label", ["a", "b"])).resolves.toEqual(["a", "b"]);
  });

  it("threads a generic package command runner through command context", async () => {
    const requests: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    const packageCommandRunner: PackageCommandRunner = async (request) => {
      requests.push(request);
      return { exitCode: 0, stdout: "ok" };
    };
    const context: CliCommandContext = {
      cwd: "/repo",
      io: { writeLine: () => {}, writeError: () => {} },
      packageCommandRunner,
    };

    await expect(
      context.packageCommandRunner?.({
        command: "npm",
        args: ["view", "@stepkit/core"],
        cwd: context.cwd,
      }),
    ).resolves.toEqual({ exitCode: 0, stdout: "ok" });
    expect(requests).toEqual([{ command: "npm", args: ["view", "@stepkit/core"], cwd: "/repo" }]);
  });
});
