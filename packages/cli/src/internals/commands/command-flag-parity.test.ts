import { describe, expect, it } from "vitest";

import { parseAddCommandArgs } from "./add/add-args.js";
import { parseAgentsCommandArgs } from "./agents/agents-args.js";
import { initCommand } from "./init/init-command.js";
import { mcpCommand } from "./mcp/command.js";
import { parseProvidersCommandArgs } from "./providers/providers-args.js";
import { removeCommand } from "./remove/remove-command.js";

/**
 * Regression coverage for the shared command flag parser
 * (`internals/command-framework/flags.ts`): every command must keep parsing
 * exactly the flags it parsed before the parser was shared.
 */
describe("command flag parsing parity", () => {
  describe("trailstep add", () => {
    it("parses boolean and value flags", () => {
      expect(
        parseAddCommandArgs([
          "add",
          "workflows/review.mjs",
          "--force",
          "--yes",
          "--dry-run",
          "--project-skill",
          "--scope",
          "project",
          "--namespace",
          "ns",
          "--name",
          "review",
          "--workflow",
          "review",
        ]),
      ).toEqual({
        source: "workflows/review.mjs",
        scope: "project",
        namespace: "ns",
        name: "review",
        workflow: "review",
        force: true,
        projectSkill: true,
        userSkill: false,
        projectSkillExplicit: true,
        userSkillExplicit: false,
        yes: true,
        dryRun: true,
      });
    });

    it("rejects unknown options", () => {
      expect(() => parseAddCommandArgs(["add", "workflows/review.mjs", "--bogus"])).toThrow(
        "Unknown option for trailstep add: --bogus",
      );
    });

    it("rejects missing values", () => {
      expect(() => parseAddCommandArgs(["add", "workflows/review.mjs", "--scope"])).toThrow(
        "Missing value for --scope.",
      );
    });
  });

  describe("trailstep agents", () => {
    it("parses value flags", () => {
      expect(
        parseAgentsCommandArgs([
          "agents",
          "set",
          "review",
          "--provider",
          "pi",
          "--model",
          "model-a",
          "--thinking",
          "medium",
          "--scope",
          "project",
        ]),
      ).toEqual({
        action: "set",
        name: "review",
        provider: "pi",
        model: "model-a",
        thinking: "medium",
        scope: "project",
      });
    });

    it("rejects unknown options", () => {
      expect(() => parseAgentsCommandArgs(["agents", "set", "review", "--bogus", "x"])).toThrow(
        "Unknown option for trailstep agents: --bogus",
      );
    });

    it("rejects missing values", () => {
      expect(() => parseAgentsCommandArgs(["agents", "delete", "review", "--scope"])).toThrow(
        "Missing value for --scope.",
      );
    });
  });

  describe("trailstep init", () => {
    it("parses the skill install flags", () => {
      expect(initCommand.parseArgs(["init", "--scope", "project", "--install-skill"])).toEqual({
        scope: "project",
        skillInstallMode: "install",
      });
      expect(initCommand.parseArgs(["init", "--no-install-skill"])).toEqual({
        skillInstallMode: "skip",
      });
      expect(initCommand.parseArgs(["init"])).toEqual({ skillInstallMode: "prompt" });
    });

    it("rejects both skill install flags at once", () => {
      expect(() =>
        initCommand.parseArgs(["init", "--install-skill", "--no-install-skill"]),
      ).toThrow("Use only one of --install-skill or --no-install-skill.");
    });

    it("rejects unknown options", () => {
      expect(() => initCommand.parseArgs(["init", "--bogus"])).toThrow(
        "Unknown option for trailstep init: --bogus",
      );
    });
  });

  describe("trailstep mcp", () => {
    it("parses the project flag", () => {
      expect(mcpCommand.parseArgs(["mcp", "--project", "dir"])).toEqual({ project: "dir" });
      expect(mcpCommand.parseArgs(["mcp"])).toEqual({});
    });

    it("ignores unknown options", () => {
      expect(mcpCommand.parseArgs(["mcp", "--bogus", "--project", "dir"])).toEqual({
        project: "dir",
      });
    });
  });

  describe("trailstep providers", () => {
    it("parses the scope flag", () => {
      expect(parseProvidersCommandArgs(["providers", "list", "--scope", "project"])).toEqual({
        action: "list",
        scope: "project",
      });
    });

    it("rejects unknown options", () => {
      expect(() => parseProvidersCommandArgs(["providers", "list", "--bogus"])).toThrow(
        "Unknown option for trailstep providers: --bogus",
      );
    });

    it("rejects missing values", () => {
      expect(() => parseProvidersCommandArgs(["providers", "list", "--scope"])).toThrow(
        "Missing value for --scope.",
      );
    });
  });

  describe("trailstep remove", () => {
    it("parses the scope flag", () => {
      expect(removeCommand.parseArgs(["remove", "ns/name", "--scope", "local"])).toEqual({
        ref: "ns/name",
        scope: "local",
      });
      expect(removeCommand.parseArgs(["remove", "ns/name"])).toEqual({ ref: "ns/name" });
    });

    it("rejects unknown options", () => {
      expect(() => removeCommand.parseArgs(["remove", "ns/name", "--bogus"])).toThrow(
        "Unknown option for trailstep remove: --bogus",
      );
    });

    it("rejects missing values", () => {
      expect(() => removeCommand.parseArgs(["remove", "ns/name", "--scope"])).toThrow(
        "Missing value for --scope.",
      );
    });
  });
});
