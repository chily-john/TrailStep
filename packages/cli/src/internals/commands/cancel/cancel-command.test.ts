import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../../../index.js";
import { cancelCommand } from "./cancel-command.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function interactiveProtocol(options: { runDir: string; stepDir: string }) {
  return {
    status: "active",
    stepId: "discuss-feature",
    artifactStepId: "0001-discuss-feature",
    outputMode: "json",
    stepDir: options.stepDir,
    promptFile: join(options.stepDir, "prompt.txt"),
    outputFile: join(options.stepDir, "output.json"),
    interactiveFile: join(options.stepDir, "interactive.json"),
    runRelativeStepDir: "steps/0001-discuss-feature",
    outputSchema: {
      type: "object",
      properties: { approved: { type: "boolean" }, notes: { type: "string" } },
      required: ["approved", "notes"],
      additionalProperties: false,
    },
    runDir: options.runDir,
  };
}

describe("cancel command", () => {
  it("cancels an active interactive session", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-cancel-tests", `${task.id}-active`);
    const runDir = join(cwd, ".trailstep", "runs", "interactive-run");
    const stepDir = join(runDir, "steps", "0001-approve-plan");
    const interactiveFile = join(stepDir, "interactive.json");
    await mkdir(stepDir, { recursive: true });
    await writeJson(interactiveFile, interactiveProtocol({ runDir, stepDir }));
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["cancel"],
      env: { TRAILSTEP_INTERACTIVE_FILE: interactiveFile },
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
    });

    expect(exitCode).toBe(0);
    await expect(readFile(interactiveFile, "utf8")).resolves.toContain('"status": "cancelled"');
    expect(lines.join("\n")).toMatch(/interactive session cancelled/i);
    expect(errors).toEqual([]);
  });

  it("records an optional cancellation reason", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-cancel-tests", `${task.id}-reason`);
    const runDir = join(cwd, ".trailstep", "runs", "interactive-run");
    const stepDir = join(runDir, "steps", "0001-approve-plan");
    const interactiveFile = join(stepDir, "interactive.json");
    await mkdir(stepDir, { recursive: true });
    await writeJson(interactiveFile, interactiveProtocol({ runDir, stepDir }));
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["cancel", "--reason", "Requirements changed."],
      env: { TRAILSTEP_INTERACTIVE_FILE: interactiveFile },
      io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
    });

    expect(exitCode).toBe(0);
    await expect(readFile(interactiveFile, "utf8")).resolves.toContain('"status": "cancelled"');
    await expect(readFile(interactiveFile, "utf8")).resolves.toContain("Requirements changed.");
    expect(errors).toEqual([]);
  });

  it("rejects an already completed session", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-cancel-tests", `${task.id}-completed`);
    const runDir = join(cwd, ".trailstep", "runs", "interactive-run");
    const stepDir = join(runDir, "steps", "0001-approve-plan");
    const interactiveFile = join(stepDir, "interactive.json");
    await mkdir(stepDir, { recursive: true });
    await writeJson(interactiveFile, {
      ...interactiveProtocol({ runDir, stepDir }),
      status: "completed",
    });
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["cancel"],
      env: { TRAILSTEP_INTERACTIVE_FILE: interactiveFile },
      io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
    });

    expect(exitCode).toBe(1);
    await expect(readFile(interactiveFile, "utf8")).resolves.toContain('"status": "completed"');
    expect(errors.join("\n")).toMatch(/not active/i);
  });

  it("rejects an already cancelled session", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-cancel-tests", `${task.id}-cancelled`);
    const runDir = join(cwd, ".trailstep", "runs", "interactive-run");
    const stepDir = join(runDir, "steps", "0001-approve-plan");
    const interactiveFile = join(stepDir, "interactive.json");
    await mkdir(stepDir, { recursive: true });
    await writeJson(interactiveFile, {
      ...interactiveProtocol({ runDir, stepDir }),
      status: "cancelled",
    });
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["cancel"],
      env: { TRAILSTEP_INTERACTIVE_FILE: interactiveFile },
      io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
    });

    expect(exitCode).toBe(1);
    await expect(readFile(interactiveFile, "utf8")).resolves.toContain('"status": "cancelled"');
    expect(errors.join("\n")).toMatch(/not active/i);
  });

  it("requires TRAILSTEP_INTERACTIVE_FILE", async () => {
    const errors: string[] = [];

    await expect(
      cancelCommand.run(
        {},
        {
          cwd: ".",
          env: {},
          io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        },
      ),
    ).rejects.toThrow(/TRAILSTEP_INTERACTIVE_FILE/i);

    expect(errors).toEqual([]);
  });

  it("intentionally rejects legacy STEPKIT_INTERACTIVE_FILE", async () => {
    const errors: string[] = [];

    await expect(
      cancelCommand.run(
        {},
        {
          cwd: ".",
          env: { STEPKIT_INTERACTIVE_FILE: "legacy-interactive.json" },
          io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        },
      ),
    ).rejects.toThrow(/TRAILSTEP_INTERACTIVE_FILE/i);

    expect(errors).toEqual([]);
  });
});
