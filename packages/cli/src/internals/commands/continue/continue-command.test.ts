import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../../index.js";
import type { TrailStepCliPrompts } from "../../command.types.js";
import { continueCommand } from "./continue-command.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function nodeTmpContinueTestsDir(name: string): string {
  return join("node_modules", ".tmp-trailstep-continue-tests", name);
}

async function writeWaitingWorkflowFile(
  cwd: string,
  options: { dynamicWait?: boolean; promptBeforeWait?: boolean } = {},
): Promise<void> {
  await rm(cwd, { recursive: true, force: true });
  const workflowDir = join(cwd, "workflows");
  await mkdir(workflowDir, { recursive: true });
  await writeFile(
    join(workflowDir, "waiting.mjs"),
    `import { readFile, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { done, step } from '@trailstep/core';
    const schema = {
      validate: (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
      diagnostics: () => [],
      assert: (value) => value,
    };
    async function incrementCount(cwd, file) {
      const path = join(cwd, file);
      let count = 0;
      try { count = Number(await readFile(path, 'utf8')); } catch {}
      await writeFile(path, String(count + 1), 'utf8');
    }
    async function incrementPromptCount(cwd) {
      await incrementCount(cwd, 'prompt-count.txt');
    }
    async function incrementWaitCount(cwd) {
      await incrementCount(cwd, 'wait-count.txt');
    }
    export default {
      id: 'waiting',
      input: schema,
      output: schema,
      start: (input) => ${
        options.promptBeforeWait
          ? `step({ id: 'publish' })
        .prompt(() => 'Draft release notes.', {
          output: { draft: 'string' },
          adapter: async ({ input, tools }) => {
            await incrementPromptCount(input.cwd);
            await tools[0]?.call({ draft: 'v1' });
          },
        })
        .wait({ id: 'approval', kind: 'input', message: 'Approve this change?', output: { approved: 'boolean' } })
        .do(({ output, waits }) => done({ ok: waits.approval.approved, draft: output.draft }))(input)`
          : `step({ id: 'publish' })
        .wait(${
          options.dynamicWait
            ? `async () => {
          await incrementWaitCount(input.cwd);
          return { id: 'approval', kind: 'input', message: 'Approve this change?', output: { approved: 'boolean' } };
        }`
            : `{ id: 'approval', kind: 'input', message: 'Approve this change?', output: { approved: 'boolean' } }`
        })
        .do(({ waits }) => done({ ok: waits.approval.approved }))(input)`
      },
    };`,
    "utf8",
  );
}

async function writeCheckWaitingWorkflowFile(cwd: string): Promise<void> {
  await rm(cwd, { recursive: true, force: true });
  const workflowDir = join(cwd, "workflows");
  await mkdir(workflowDir, { recursive: true });
  await writeFile(
    join(workflowDir, "check-waiting.mjs"),
    `import { readFile, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { done, step } from '@trailstep/core';
    const schema = {
      validate: (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
      diagnostics: () => [],
      assert: (value) => value,
    };
    async function incrementCount(cwd) {
      const path = join(cwd, 'check-count.txt');
      let count = 0;
      try { count = Number(await readFile(path, 'utf8')); } catch {}
      await writeFile(path, String(count + 1), 'utf8');
      return count + 1;
    }
    export default {
      id: 'check-waiting',
      input: schema,
      output: schema,
      start: (input) => step({ id: 'ci' })
        .wait(async ({ wait }) => {
          const count = await incrementCount(input.cwd);
          if (count === 1) {
            return wait.pending({ id: 'ci', message: 'Waiting for CI', retryAfterSeconds: 30 });
          }
          return wait.done({ ok: true });
        }, { output: { ok: 'boolean' } })
        .do(({ waits }) => done({ ok: waits.ci.ok }))(input),
    };`,
    "utf8",
  );
}

function interactiveProtocol(options: {
  runDir: string;
  stepDir: string;
  outputMode?: "session-file" | "json";
}) {
  const outputMode = options.outputMode ?? "session-file";
  const outputSchema =
    outputMode === "json"
      ? {
          type: "object",
          properties: { approved: { type: "boolean" }, notes: { type: "string" } },
          required: ["approved", "notes"],
          additionalProperties: false,
        }
      : {
          type: "object",
          properties: { sessionFile: { type: "string" } },
          required: ["sessionFile"],
          additionalProperties: false,
        };

  return {
    status: "active",
    stepId: "discuss-feature",
    artifactStepId: "0001-discuss-feature",
    outputMode,
    stepDir: options.stepDir,
    promptFile: join(options.stepDir, "prompt.txt"),
    outputFile: join(options.stepDir, "output.json"),
    interactiveFile: join(options.stepDir, "interactive.json"),
    sessionDescriptionFile: join(options.stepDir, "session-description.md"),
    runRelativeStepDir: "steps/0001-discuss-feature",
    runRelativeSessionDescriptionFile: "steps/0001-discuss-feature/session-description.md",
    outputSchema,
    runDir: options.runDir,
  };
}

describe("continue command", () => {
  it("answers and continues a waiting workflow run", async ({ task }) => {
    const cwd = join(nodeTmpContinueTestsDir(task.id), "wait-success");
    await writeWaitingWorkflowFile(cwd);
    await expect(
      main({
        argv: ["./workflows/waiting.mjs", "wait-run", "--input", JSON.stringify({ cwd })],
        cwd,
        env: {},
        io: { writeLine: () => undefined, writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    await expect(
      main({
        argv: ["answer", "wait-run", "approval", "--json", '{"approved":true}', "--continue"],
        cwd,
        env: {},
        io: { writeLine: () => undefined, writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    const events = await readFile(
      join(cwd, ".trailstep", "runs", "wait-run", "events.jsonl"),
      "utf8",
    );
    await expect(
      readFile(
        join(
          cwd,
          ".trailstep",
          "runs",
          "wait-run",
          "steps",
          "0001-publish",
          "waits",
          "approval",
          "answer.json",
        ),
        "utf8",
      ),
    ).resolves.toContain('"approved": true');
    expect(events).toContain("wait.satisfied");
    expect(events).toContain("workflow.completed");
    expect(events).toContain('"ok":true');
  });

  it("rejects invalid answer JSON before writing an answer", async ({ task }) => {
    const cwd = join(nodeTmpContinueTestsDir(task.id), "wait-invalid-json");
    await writeWaitingWorkflowFile(cwd);
    await main({
      argv: ["./workflows/waiting.mjs", "wait-run", "--input", JSON.stringify({ cwd })],
      cwd,
      env: {},
      io: { writeLine: () => undefined, writeError: () => undefined },
    });
    const errors: string[] = [];

    await expect(
      main({
        argv: ["answer", "wait-run", "approval", "--json", "{"],
        cwd,
        env: {},
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expect(errors.join("\n")).toMatch(/invalid/i);
  });

  it("fails clearly when a wait answer does not match the wait schema", async ({ task }) => {
    const cwd = join(nodeTmpContinueTestsDir(task.id), "wait-schema-invalid");
    await writeWaitingWorkflowFile(cwd);
    await main({
      argv: ["./workflows/waiting.mjs", "wait-run", "--input", JSON.stringify({ cwd })],
      cwd,
      env: {},
      io: { writeLine: () => undefined, writeError: () => undefined },
    });
    await main({
      argv: ["answer", "wait-run", "approval", "--json", '{"approved":"yes"}'],
      cwd,
      env: {},
      io: { writeLine: () => undefined, writeError: () => undefined },
    });
    const errors: string[] = [];

    await expect(
      main({
        argv: ["continue", "wait-run"],
        cwd,
        env: {},
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expect(errors.join("\n")).toMatch(/schema validation|must be boolean/i);
  });

  it("leaves a waiting workflow waiting when no answer exists", async ({ task }) => {
    const cwd = join(nodeTmpContinueTestsDir(task.id), "wait-no-answer");
    await writeWaitingWorkflowFile(cwd);
    await main({
      argv: ["./workflows/waiting.mjs", "wait-run", "--input", JSON.stringify({ cwd })],
      cwd,
      env: {},
      io: { writeLine: () => undefined, writeError: () => undefined },
    });
    const lines: string[] = [];

    await expect(
      main({
        argv: ["continue", "wait-run"],
        cwd,
        env: {},
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    expect(lines.join("\n")).toMatch(/still waiting|missing answer/i);
  });

  it("reports a cancelled waiting workflow without resuming", async ({ task }) => {
    const cwd = join(nodeTmpContinueTestsDir(task.id), "wait-cancelled");
    await writeWaitingWorkflowFile(cwd, { dynamicWait: true });
    await main({
      argv: ["./workflows/waiting.mjs", "wait-run", "--input", JSON.stringify({ cwd })],
      cwd,
      env: {},
      io: { writeLine: () => undefined, writeError: () => undefined },
    });
    await expect(readFile(join(cwd, "wait-count.txt"), "utf8")).resolves.toBe("1");
    await main({
      argv: ["cancel", "wait-run"],
      cwd,
      env: {},
      io: { writeLine: () => undefined, writeError: () => undefined },
    });
    const lines: string[] = [];

    await expect(
      main({
        argv: ["continue", "wait-run"],
        cwd,
        env: {},
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    expect(lines.join("\n")).toContain("Workflow cancelled: wait-run");
    await expect(readFile(join(cwd, "wait-count.txt"), "utf8")).resolves.toBe("1");
    const events = await readFile(
      join(cwd, ".trailstep", "runs", "wait-run", "events.jsonl"),
      "utf8",
    );
    expect(events).toContain("workflow.cancelRequested");
    expect(events).toContain("workflow.cancelled");
    expect(events).not.toContain("workflow.completed");
  });

  it("reruns a check wait without requiring an answer file", async ({ task }) => {
    const cwd = join(nodeTmpContinueTestsDir(task.id), "check-wait");
    await writeCheckWaitingWorkflowFile(cwd);
    await main({
      argv: ["./workflows/check-waiting.mjs", "wait-run", "--input", JSON.stringify({ cwd })],
      cwd,
      env: {},
      io: { writeLine: () => undefined, writeError: () => undefined },
    });
    await expect(readFile(join(cwd, "check-count.txt"), "utf8")).resolves.toBe("1");
    const lines: string[] = [];

    await expect(
      main({
        argv: ["continue", "wait-run"],
        cwd,
        env: {},
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    await expect(readFile(join(cwd, "check-count.txt"), "utf8")).resolves.toBe("2");
    expect(lines.join("\n")).toContain("Workflow completed:");
    expect(lines.join("\n")).toContain("check-waiting.mjs");
    const events = await readFile(
      join(cwd, ".trailstep", "runs", "wait-run", "events.jsonl"),
      "utf8",
    );
    expect(events).toContain('"retryAfterSeconds":30');
    expect(events).toContain("wait.satisfied");
    expect(events).toContain("workflow.completed");
  });

  it("does not rerun a wait callback while continuing", async ({ task }) => {
    const cwd = join(nodeTmpContinueTestsDir(task.id), "wait-callback");
    await writeWaitingWorkflowFile(cwd, { dynamicWait: true });
    await main({
      argv: ["./workflows/waiting.mjs", "wait-run", "--input", JSON.stringify({ cwd })],
      cwd,
      env: {},
      io: { writeLine: () => undefined, writeError: () => undefined },
    });
    await expect(readFile(join(cwd, "wait-count.txt"), "utf8")).resolves.toBe("1");

    await expect(
      main({
        argv: ["answer", "wait-run", "approval", "--json", '{"approved":true}', "--continue"],
        cwd,
        env: {},
        io: { writeLine: () => undefined, writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    await expect(readFile(join(cwd, "wait-count.txt"), "utf8")).resolves.toBe("1");
  });

  it("does not rerun a prompt before a wait while continuing", async ({ task }) => {
    const cwd = join(nodeTmpContinueTestsDir(task.id), "wait-after-prompt");
    await writeWaitingWorkflowFile(cwd, { promptBeforeWait: true });
    await main({
      argv: ["./workflows/waiting.mjs", "wait-run", "--input", JSON.stringify({ cwd })],
      cwd,
      env: {},
      io: { writeLine: () => undefined, writeError: () => undefined },
    });
    await expect(readFile(join(cwd, "prompt-count.txt"), "utf8")).resolves.toBe("1");

    await expect(
      main({
        argv: ["answer", "wait-run", "approval", "--json", '{"approved":true}', "--continue"],
        cwd,
        env: {},
        io: { writeLine: () => undefined, writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    await expect(readFile(join(cwd, "prompt-count.txt"), "utf8")).resolves.toBe("1");
    const events = await readFile(
      join(cwd, ".trailstep", "runs", "wait-run", "events.jsonl"),
      "utf8",
    );
    expect(events).toContain('"draft":"v1"');
  });

  it("fails clearly when answering a nonexistent wait", async ({ task }) => {
    const cwd = join(nodeTmpContinueTestsDir(task.id), "wait-missing");
    await writeWaitingWorkflowFile(cwd);
    await main({
      argv: ["./workflows/waiting.mjs", "wait-run", "--input", JSON.stringify({ cwd })],
      cwd,
      env: {},
      io: { writeLine: () => undefined, writeError: () => undefined },
    });
    const errors: string[] = [];

    await expect(
      main({
        argv: ["answer", "wait-run", "missing", "--json", '{"approved":true}'],
        cwd,
        env: {},
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expect(errors.join("\n")).toMatch(/pending wait not found/i);
  });

  it("continues from inline JSON when it matches the stored schema", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-continue-tests", `${task.id}-json`);
    const runDir = join(cwd, ".trailstep", "runs", "interactive-run");
    const stepDir = join(runDir, "steps", "0001-approve-plan");
    const interactiveFile = join(stepDir, "interactive.json");
    await mkdir(stepDir, { recursive: true });
    await writeJson(interactiveFile, interactiveProtocol({ runDir, stepDir, outputMode: "json" }));
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["continue", "--json", '{"approved":true,"notes":"Approved."}'],
      env: { TRAILSTEP_INTERACTIVE_FILE: interactiveFile },
      io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
    });

    expect(exitCode).toBe(0);
    await expect(readFile(join(stepDir, "output.json"), "utf8")).resolves.toBe(
      `${JSON.stringify({ approved: true, notes: "Approved." }, null, 2)}\n`,
    );
    await expect(readFile(interactiveFile, "utf8")).resolves.toContain('"status": "completed"');
    expect(errors).toEqual([]);
  });

  it("continues from a JSON file when it matches the stored schema", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-continue-tests", `${task.id}-json-file`);
    const runDir = join(cwd, ".trailstep", "runs", "interactive-run");
    const stepDir = join(runDir, "steps", "0001-approve-plan");
    const interactiveFile = join(stepDir, "interactive.json");
    await mkdir(stepDir, { recursive: true });
    await writeJson(interactiveFile, interactiveProtocol({ runDir, stepDir, outputMode: "json" }));
    await writeJson(join(stepDir, "answer.json"), { approved: true, notes: "Approved from file." });
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["continue", "--json-file", "answer.json"],
      cwd: join(cwd, "not-the-step-dir"),
      env: { TRAILSTEP_INTERACTIVE_FILE: interactiveFile },
      io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
    });

    expect(exitCode).toBe(0);
    await expect(readFile(join(stepDir, "output.json"), "utf8")).resolves.toBe(
      `${JSON.stringify({ approved: true, notes: "Approved from file." }, null, 2)}\n`,
    );
    await expect(readFile(interactiveFile, "utf8")).resolves.toContain('"status": "completed"');
    expect(errors).toEqual([]);
  });

  it("rejects an already completed session", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-continue-tests", `${task.id}-completed`);
    const runDir = join(cwd, ".trailstep", "runs", "interactive-run");
    const stepDir = join(runDir, "steps", "0001-approve-plan");
    const interactiveFile = join(stepDir, "interactive.json");
    await mkdir(stepDir, { recursive: true });
    await writeJson(interactiveFile, {
      ...interactiveProtocol({ runDir, stepDir, outputMode: "json" }),
      status: "completed",
    });
    await writeJson(join(stepDir, "output.json"), { approved: true, notes: "Original." });
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["continue", "--json", '{"approved":true,"notes":"Replacement."}'],
      env: { TRAILSTEP_INTERACTIVE_FILE: interactiveFile },
      io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
    });

    expect(exitCode).toBe(1);
    await expect(readFile(join(stepDir, "output.json"), "utf8")).resolves.toContain("Original.");
    await expect(readFile(interactiveFile, "utf8")).resolves.toContain('"status": "completed"');
    expect(errors.join("\n")).toMatch(/not active|already completed/i);
  });

  it("leaves the session active when submitted JSON fails schema validation", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-continue-tests", `${task.id}-invalid-json`);
    const runDir = join(cwd, ".trailstep", "runs", "interactive-run");
    const stepDir = join(runDir, "steps", "0001-approve-plan");
    const interactiveFile = join(stepDir, "interactive.json");
    await mkdir(stepDir, { recursive: true });
    await writeJson(interactiveFile, interactiveProtocol({ runDir, stepDir, outputMode: "json" }));
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["continue", "--json", '{"approved":true,"notes":"Approved.","extra":true}'],
      env: { TRAILSTEP_INTERACTIVE_FILE: interactiveFile },
      io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
    });

    expect(exitCode).toBe(1);
    await expect(readFile(join(stepDir, "output.json"), "utf8")).rejects.toThrow();
    await expect(readFile(interactiveFile, "utf8")).resolves.toContain('"status": "active"');
    expect(errors.join("\n")).toMatch(/schema validation/i);
  });

  it("rejects an interactive protocol that would write output outside the step directory", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-continue-tests", `${task.id}-unsafe-path`);
    const runDir = join(cwd, ".trailstep", "runs", "interactive-run");
    const stepDir = join(runDir, "steps", "0001-approve-plan");
    const interactiveFile = join(stepDir, "interactive.json");
    const outsideOutput = join(cwd, "outside-output.json");
    await mkdir(stepDir, { recursive: true });
    await writeJson(interactiveFile, {
      ...interactiveProtocol({ runDir, stepDir, outputMode: "json" }),
      outputFile: outsideOutput,
    });
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["continue", "--json", '{"approved":true,"notes":"Approved."}'],
      env: { TRAILSTEP_INTERACTIVE_FILE: interactiveFile },
      io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
    });

    expect(exitCode).toBe(1);
    await expect(readFile(outsideOutput, "utf8")).rejects.toThrow();
    await expect(readFile(interactiveFile, "utf8")).resolves.toContain('"status": "active"');
    expect(errors.join("\n")).toMatch(/unsafe outputFile/i);
  });

  it("does not replace output.json when validation fails", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-continue-tests", `${task.id}-no-replace`);
    const runDir = join(cwd, ".trailstep", "runs", "interactive-run");
    const stepDir = join(runDir, "steps", "0001-approve-plan");
    const interactiveFile = join(stepDir, "interactive.json");
    await mkdir(stepDir, { recursive: true });
    await writeJson(interactiveFile, interactiveProtocol({ runDir, stepDir, outputMode: "json" }));
    await writeJson(join(stepDir, "output.json"), { approved: true, notes: "Still valid." });
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["continue", "--json", '{"approved":true,"notes":"Replacement.","extra":true}'],
      env: { TRAILSTEP_INTERACTIVE_FILE: interactiveFile },
      io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
    });

    expect(exitCode).toBe(1);
    await expect(readFile(join(stepDir, "output.json"), "utf8")).resolves.toContain("Still valid.");
    await expect(readFile(interactiveFile, "utf8")).resolves.toContain('"status": "active"');
    expect(errors.join("\n")).toMatch(/schema validation/i);
  });

  it("continues an active interactive session from a non-empty session file", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-continue-tests", task.id);
    const runDir = join(cwd, ".trailstep", "runs", "interactive-run");
    const stepDir = join(runDir, "steps", "0001-discuss-feature");
    const interactiveFile = join(stepDir, "interactive.json");
    const lines: string[] = [];
    const errors: string[] = [];
    await mkdir(stepDir, { recursive: true });
    await writeJson(interactiveFile, interactiveProtocol({ runDir, stepDir }));
    await writeFile(join(stepDir, "session-description.md"), "Session notes\n", "utf8");

    const exitCode = await main({
      argv: ["continue", "--session-file", "session-description.md"],
      cwd: join(cwd, "not-the-step-dir"),
      env: { TRAILSTEP_INTERACTIVE_FILE: interactiveFile },
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
    });

    expect(exitCode).toBe(0);
    await expect(readFile(join(stepDir, "output.json"), "utf8")).resolves.toBe(
      `${JSON.stringify({ sessionFile: "steps/0001-discuss-feature/session-description.md" }, null, 2)}\n`,
    );
    await expect(readFile(interactiveFile, "utf8")).resolves.toContain('"status": "completed"');
    expect(lines.join("\n")).toMatch(/interactive session completed/i);
    expect(errors).toEqual([]);
  });

  it("requires TRAILSTEP_INTERACTIVE_FILE for explicit output modes", async () => {
    const errors: string[] = [];

    await expect(
      continueCommand.run(
        { mode: "session-file", path: "session-description.md" },
        {
          cwd: ".",
          env: {},
          io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        },
      ),
    ).rejects.toThrow(/TRAILSTEP_INTERACTIVE_FILE/i);

    expect(errors).toEqual([]);
  });

  it("prompts to select an active session when continue has no arguments", async ({ task }) => {
    const cwd = join(nodeTmpContinueTestsDir(task.id), "select-active");
    const runDirA = join(cwd, ".trailstep", "runs", "alpha-run");
    const stepDirA = join(runDirA, "steps", "0001-discuss-feature");
    const runDirB = join(cwd, ".trailstep", "runs", "beta-run");
    const stepDirB = join(runDirB, "steps", "0002-approve-plan");
    await mkdir(stepDirA, { recursive: true });
    await mkdir(stepDirB, { recursive: true });
    await writeJson(
      join(stepDirA, "interactive.json"),
      interactiveProtocol({ runDir: runDirA, stepDir: stepDirA }),
    );
    await writeJson(join(stepDirB, "interactive.json"), {
      ...interactiveProtocol({ runDir: runDirB, stepDir: stepDirB }),
      stepId: "approve-plan",
      artifactStepId: "0002-approve-plan",
      runRelativeStepDir: "steps/0002-approve-plan",
      runRelativeSessionDescriptionFile: "steps/0002-approve-plan/session-description.md",
    });
    await writeFile(join(stepDirA, "session-description.md"), "Alpha notes\n", "utf8");
    await writeFile(join(stepDirB, "session-description.md"), "Beta notes\n", "utf8");
    const selectCalls: Array<{ prompt: string; choices: readonly string[] }> = [];
    const prompts: TrailStepCliPrompts = {
      text: async () => "",
      select: async (prompt, choices) => {
        selectCalls.push({ prompt, choices });
        return choices.find((choice) => choice.includes("alpha-run")) ?? choices[0] ?? "";
      },
      confirm: async () => true,
    };

    const exitCode = await main({
      argv: ["continue"],
      cwd,
      env: {},
      prompts,
      io: { writeLine: () => undefined, writeError: () => undefined },
    });

    expect(exitCode).toBe(0);
    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0]?.choices).toEqual(
      expect.arrayContaining([
        expect.stringContaining("run alpha-run"),
        expect.stringContaining("step discuss-feature"),
        expect.stringContaining("artifact 0001-discuss-feature"),
        expect.stringContaining("mode session-file"),
      ]),
    );
    await expect(readFile(join(stepDirA, "interactive.json"), "utf8")).resolves.toContain(
      '"status": "completed"',
    );
    await expect(readFile(join(stepDirB, "interactive.json"), "utf8")).resolves.toContain(
      '"status": "active"',
    );
  });

  it("fails safely with no target in non-interactive no-arg usage", async ({ task }) => {
    const cwd = nodeTmpContinueTestsDir(`${task.id}-noninteractive`);
    const errors: string[] = [];

    await expect(
      main({
        argv: ["continue"],
        cwd,
        env: {},
        prompts: undefined,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expect(errors.join("\n")).toMatch(/requires prompts|non-interactive/i);
  });

  it("prompts for JSON text when the selected no-argument session uses JSON output", async ({
    task,
  }) => {
    const cwd = nodeTmpContinueTestsDir(`${task.id}-json-select`);
    const runDir = join(cwd, ".trailstep", "runs", "json-run");
    const stepDir = join(runDir, "steps", "0001-approve-plan");
    await mkdir(stepDir, { recursive: true });
    await writeJson(
      join(stepDir, "interactive.json"),
      interactiveProtocol({ runDir, stepDir, outputMode: "json" }),
    );
    const prompts: TrailStepCliPrompts = {
      text: async () => '{"approved":true,"notes":"Approved interactively."}',
      select: async (_prompt, choices) => choices[0] ?? "",
      confirm: async () => true,
    };

    await expect(
      main({
        argv: ["continue"],
        cwd,
        env: {},
        prompts,
        io: { writeLine: () => undefined, writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    await expect(readFile(join(stepDir, "output.json"), "utf8")).resolves.toBe(
      `${JSON.stringify({ approved: true, notes: "Approved interactively." }, null, 2)}\n`,
    );
  });

  it("ignores completed and cancelled interactive sessions during selection", async ({ task }) => {
    const cwd = nodeTmpContinueTestsDir(`${task.id}-filter`);
    const activeRunDir = join(cwd, ".trailstep", "runs", "active-run");
    const activeStepDir = join(activeRunDir, "steps", "0001-discuss-feature");
    const completedRunDir = join(cwd, ".trailstep", "runs", "completed-run");
    const completedStepDir = join(completedRunDir, "steps", "0001-discuss-feature");
    const cancelledRunDir = join(cwd, ".trailstep", "runs", "cancelled-run");
    const cancelledStepDir = join(cancelledRunDir, "steps", "0001-discuss-feature");
    await mkdir(activeStepDir, { recursive: true });
    await mkdir(completedStepDir, { recursive: true });
    await mkdir(cancelledStepDir, { recursive: true });
    await writeJson(
      join(activeStepDir, "interactive.json"),
      interactiveProtocol({ runDir: activeRunDir, stepDir: activeStepDir }),
    );
    await writeJson(join(completedStepDir, "interactive.json"), {
      ...interactiveProtocol({ runDir: completedRunDir, stepDir: completedStepDir }),
      status: "completed",
    });
    await writeJson(join(cancelledStepDir, "interactive.json"), {
      ...interactiveProtocol({ runDir: cancelledRunDir, stepDir: cancelledStepDir }),
      status: "cancelled",
    });
    await writeFile(join(activeStepDir, "session-description.md"), "Active notes\n", "utf8");
    const selectedChoices: string[] = [];
    const prompts: TrailStepCliPrompts = {
      text: async () => "",
      select: async (_prompt, choices) => {
        selectedChoices.push(...choices);
        return choices[0] ?? "";
      },
      confirm: async () => true,
    };

    await expect(
      main({
        argv: ["continue"],
        cwd,
        env: {},
        prompts,
        io: { writeLine: () => undefined, writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    expect(selectedChoices).toHaveLength(1);
    expect(selectedChoices.join("\n")).toContain("active-run");
    expect(selectedChoices.join("\n")).not.toContain("completed-run");
    expect(selectedChoices.join("\n")).not.toContain("cancelled-run");
  });

  it("leaves the session active when the session file is empty", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-continue-tests", `${task.id}-empty`);
    const runDir = join(cwd, ".trailstep", "runs", "interactive-run");
    const stepDir = join(runDir, "steps", "0001-discuss-feature");
    const interactiveFile = join(stepDir, "interactive.json");
    await mkdir(stepDir, { recursive: true });
    await writeJson(interactiveFile, interactiveProtocol({ runDir, stepDir }));
    await writeFile(join(stepDir, "session-description.md"), "   \n", "utf8");
    const errors: string[] = [];

    await expect(
      main({
        argv: ["continue", "--session-file", "session-description.md"],
        env: { TRAILSTEP_INTERACTIVE_FILE: interactiveFile },
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    await expect(readFile(join(stepDir, "output.json"), "utf8")).rejects.toThrow();
    await expect(readFile(interactiveFile, "utf8")).resolves.toContain('"status": "active"');
    expect(errors.join("\n")).toMatch(/session file.*empty/i);
  });
});
