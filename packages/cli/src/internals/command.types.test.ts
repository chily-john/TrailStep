import { describe, expect, it } from "vitest";

import type {
  CliCommandContext,
  PackageCommandRunner,
  TrailStepCliPrompts,
} from "./command.types.js";
import { usageText } from "./command.types.js";

describe("usageText", () => {
  it("documents workflow skill distribution flags, add dry-run, init scope, agents management, and update confirmation", () => {
    expect(usageText).toContain("--project-skill");
    expect(usageText).toContain("--user-skill");
    expect(usageText).toContain("--dry-run");
    expect(usageText).toContain(
      "trailstep init [--scope <local|project|global>] [--install-skill | --no-install-skill]",
    );
    expect(usageText).toContain("trailstep agents set <name>");
    expect(usageText).toContain("trailstep agents delete <name>");
    expect(usageText).toContain("trailstep agents rename <old> <new>");
    expect(usageText).toContain("trailstep doctor");
    expect(usageText).toContain(
      "trailstep update [--all | --project | --workflows | --workflow <name>] [--force] [--yes | --assume-yes]",
    );
  });

  it("documents optional model override semantics for agents set", () => {
    expect(usageText).toContain(
      "trailstep agents set <name> --provider <provider> [--model <model>]",
    );
    expect(usageText).toContain("provider defaults");
    expect(usageText).toContain("model override");
    expect(usageText).toContain("reasoning/thinking override");
    expect(usageText).toContain("Use provider default");
  });

  it("documents custom provider optional override placeholders", () => {
    expect(usageText).toContain("{{thinking}}");
    expect(usageText).toContain("{{#model}}");
    expect(usageText).toContain("{{#thinking}}");
  });

  it("documents direct source workflow refs and bulk add selection syntax", () => {
    expect(usageText).toContain("./workflow.ts#reviewWorkflow");
    expect(usageText).toContain("./workflows#takeItAway");
    expect(usageText).toContain("path#exportName");
    expect(usageText).toContain("--workflow review,release,cleanup");
    expect(usageText).toContain("--workflow '*'");
  });

  it("documents workflow package lifecycle commands and safety flags", () => {
    expect(usageText).toContain("Package-backed workflow lifecycle:");
    expect(usageText).toContain(
      "trailstep add accepts versioned npm package specs and github:<owner>/<repo> package specs",
    );
    expect(usageText).toContain("uninstalls only orphaned TrailStep-owned package installs");
    expect(usageText).toContain("trailstep update updates the globally installed TrailStep CLI");
    expect(usageText).toContain("trailstep update --project");
    expect(usageText).toContain("trailstep update --workflows");
    expect(usageText).toContain("trailstep update --workflow <name>");
    expect(usageText).toContain("trailstep update --all");
    expect(usageText).toContain(
      "Updates prompt before writing unless --yes or --assume-yes is passed",
    );
    expect(usageText).toContain("local-file refs are skipped");
    expect(usageText).toContain("GitHub-sourced workflow package updates are not supported yet");
  });

  it("allows CLI prompts to expose multiSelect choices", async () => {
    const prompts: TrailStepCliPrompts = {
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
        args: ["view", "@trailstep/core"],
        cwd: context.cwd,
      }),
    ).resolves.toEqual({ exitCode: 0, stdout: "ok" });
    expect(requests).toEqual([{ command: "npm", args: ["view", "@trailstep/core"], cwd: "/repo" }]);
  });
});
