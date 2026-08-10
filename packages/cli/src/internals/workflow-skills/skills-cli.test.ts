import { describe, expect, it } from "vitest";

import { distributeWorkflowSkill } from "./skills-cli.js";

describe("distributeWorkflowSkill", () => {
  it("spawns skills add for project distribution with --agent * and -y", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    await distributeWorkflowSkill({
      skillDirectory: ".trailstep/skills/project-review",
      target: "project",
      resolver: async () => "/repo/node_modules/skills/dist/index.js",
      runner: async (command, args) => {
        calls.push({ command, args });
        return { exitCode: 0 };
      },
    });

    expect(calls).toEqual([
      {
        command: process.execPath,
        args: [
          "/repo/node_modules/skills/dist/index.js",
          "add",
          ".trailstep/skills/project-review",
          "--agent",
          "*",
          "-y",
        ],
      },
    ]);
  });

  it("spawns skills add with -g for user distribution", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    await distributeWorkflowSkill({
      skillDirectory: ".trailstep/skills/project-review",
      target: "user",
      resolver: async () => "/repo/node_modules/skills/dist/index.js",
      runner: async (command, args) => {
        calls.push({ command, args });
        return { exitCode: 0 };
      },
    });

    expect(calls[0]?.args).toEqual([
      "/repo/node_modules/skills/dist/index.js",
      "add",
      ".trailstep/skills/project-review",
      "--agent",
      "*",
      "-y",
      "-g",
    ]);
  });

  it("rejects when skills CLI cannot be resolved", async () => {
    await expect(
      distributeWorkflowSkill({
        skillDirectory: ".trailstep/skills/project-review",
        target: "project",
        resolver: async () => {
          throw new Error("Cannot find module 'skills/package.json'");
        },
        runner: async () => ({ exitCode: 0 }),
      }),
    ).rejects.toThrow("Could not resolve skills CLI");
  });

  it("rejects when skills CLI exits non-zero", async () => {
    await expect(
      distributeWorkflowSkill({
        skillDirectory: ".trailstep/skills/project-review",
        target: "project",
        resolver: async () => "/repo/node_modules/skills/dist/index.js",
        runner: async () => ({ exitCode: 2 }),
      }),
    ).rejects.toThrow("skills CLI exited with code 2");
  });
});
