import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWorkflow } from "@trailstep/core";
import { describe, expect, it } from "vitest";

import { delegate } from "./workflow.js";

const trailstepConfig = {
  version: 1,
  customProviders: { local: { binary: "local-agent" } },
  agents: { medium: [{ provider: "local" }] },
} as const;

async function readState(runDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(runDir, "state.json"), "utf8")) as Record<string, unknown>;
}

describe("delegate", () => {
  it("completes in one turn with typed output and observable display/notify events", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-delegate-single-"));

    const result = await runWorkflow({
      workflow: delegate,
      input: { task: "Summarize parser failures", mode: "general" },
      runName: "delegate-single-run",
      cwd,
      trailstepConfig,
      workingAgentProcessRunner: async (request) => {
        await writeFile(
          request.outputFile,
          JSON.stringify({
            status: "completed",
            summary: "Found the failing parser area.",
            result: "Parser fixtures need path normalization.",
            memoryPatch: "Parser failures point at Windows separators.",
            changedFiles: ["packages/parser/src/index.ts"],
            artifacts: [{ name: "Notes", path: "notes/parser.md", mediaType: "text/markdown" }],
          }),
          "utf8",
        );
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({
      status: "completed",
      summary: "Found the failing parser area.",
      result: "Parser fixtures need path normalization.",
      changedFiles: ["packages/parser/src/index.ts"],
      artifacts: [{ name: "Notes", path: "notes/parser.md", mediaType: "text/markdown" }],
      questionsAsked: 0,
      turns: 1,
    });
    expect(result.events.some((event) => event.type === "step.display")).toBe(true);
    expect(result.events.some((event) => event.type === "step.progress")).toBe(true);
    expect(result.events.some((event) => event.type === "step.artifact")).toBe(true);
  });

  it("asks multiple questions within one run and returns to delegate turns after answers", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-delegate-questions-"));
    let turns = 0;

    const first = await runWorkflow({
      workflow: delegate,
      input: { task: "Update generated snapshots?", maxTurns: 5 },
      runName: "delegate-question-run",
      cwd,
      trailstepConfig,
      workingAgentProcessRunner: async (request) => {
        turns += 1;
        const outputs = [
          {
            status: "question",
            question: "Should I update generated snapshots?",
            summary: "Tests pass only if snapshots are updated.",
            memoryPatch: "Snapshots are stale.",
          },
          {
            status: "question",
            question: "Should I include fixture docs?",
            summary: "Fixture docs may need matching updates.",
            memoryPatch: "Parent allowed snapshot updates.",
          },
          {
            status: "completed",
            summary: "Updated snapshots and fixture docs.",
            result: "All requested generated assets are aligned.",
            memoryPatch: "Parent also requested fixture docs.",
          },
        ];
        await writeFile(request.outputFile, JSON.stringify(outputs[turns - 1]), "utf8");
        return { exitCode: 0 };
      },
    });

    expect(first.status).toBe("waiting");
    if (first.status !== "waiting") {
      throw new Error("Expected first run to wait.");
    }
    expect(first.wait).toMatchObject({ stepId: "ask-parent", waitId: "parent-answer" });
    await writeFile(
      join(first.runDir, first.wait.artifactPaths.answerFile),
      JSON.stringify({ answer: "Yes, update snapshots." }),
      "utf8",
    );

    const second = await runWorkflow({
      workflow: delegate,
      continue: { runDir: first.runDir },
      cwd,
      trailstepConfig,
      workingAgentProcessRunner: async (request) => {
        turns += 1;
        await writeFile(
          request.outputFile,
          JSON.stringify({
            status: "question",
            question: "Should I include fixture docs?",
            summary: "Fixture docs may need matching updates.",
            memoryPatch: "Parent allowed snapshot updates.",
          }),
          "utf8",
        );
        return { exitCode: 0 };
      },
    });

    expect(second.status).toBe("waiting");
    if (second.status !== "waiting") {
      throw new Error("Expected second run to wait.");
    }
    await writeFile(
      join(second.runDir, second.wait.artifactPaths.answerFile),
      JSON.stringify({ answer: "Yes, include fixture docs." }),
      "utf8",
    );

    const third = await runWorkflow({
      workflow: delegate,
      continue: { runDir: second.runDir },
      cwd,
      trailstepConfig,
      workingAgentProcessRunner: async (request) => {
        turns += 1;
        await writeFile(
          request.outputFile,
          JSON.stringify({
            status: "completed",
            summary: "Updated snapshots and fixture docs.",
            result: "All requested generated assets are aligned.",
            memoryPatch: "Parent also requested fixture docs.",
          }),
          "utf8",
        );
        return { exitCode: 0 };
      },
    });

    expect(third.status).toBe("success");
    if (third.status !== "success") {
      throw new Error(third.failure.message);
    }
    expect(third.output).toMatchObject({ questionsAsked: 2, turns: 3, status: "completed" });
    expect(turns).toBe(3);

    const state = await readState(third.runDir);
    expect(state["delegate.memory"]).toEqual(expect.stringContaining("Snapshots are stale."));
    expect(state["delegate.memory"]).toEqual(expect.stringContaining("Yes, update snapshots."));
    expect(state["delegate.memory"]).toEqual(expect.stringContaining("Parent also requested"));
    expect(state["delegate.answers"]).toEqual([
      { question: "Should I update generated snapshots?", answer: "Yes, update snapshots." },
      { question: "Should I include fixture docs?", answer: "Yes, include fixture docs." },
    ]);
  });

  it("does not share delegate memory across separate runs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-delegate-memory-"));
    let secondPrompt = "";

    const first = await runWorkflow({
      workflow: delegate,
      input: { task: "First task" },
      runName: "delegate-first-memory-run",
      cwd,
      trailstepConfig,
      workingAgentProcessRunner: async (request) => {
        await writeFile(
          request.outputFile,
          JSON.stringify({
            status: "completed",
            summary: "First run done.",
            memoryPatch: "first-run-secret-memory",
          }),
          "utf8",
        );
        return { exitCode: 0 };
      },
    });
    expect(first.status).toBe("success");

    const second = await runWorkflow({
      workflow: delegate,
      input: { task: "Second task" },
      runName: "delegate-second-memory-run",
      cwd,
      trailstepConfig,
      workingAgentProcessRunner: async (request) => {
        secondPrompt = await readFile(request.promptFile, "utf8");
        await writeFile(
          request.outputFile,
          JSON.stringify({ status: "completed", summary: "Second run done." }),
          "utf8",
        );
        return { exitCode: 0 };
      },
    });

    expect(second.status).toBe("success");
    expect(secondPrompt).toContain("No prior delegate memory.");
    expect(secondPrompt).not.toContain("first-run-secret-memory");
  });

  it("blocks clearly when maxTurns would be exceeded", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-delegate-max-turns-"));
    let calls = 0;

    const result = await runWorkflow({
      workflow: delegate,
      input: { task: "Loop forever", maxTurns: 1 },
      runName: "delegate-max-turns-run",
      cwd,
      trailstepConfig,
      workingAgentProcessRunner: async (request) => {
        calls += 1;
        await writeFile(
          request.outputFile,
          JSON.stringify({
            status: "continue",
            summary: "Need another turn.",
            memoryPatch: "Still investigating.",
          }),
          "utf8",
        );
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(calls).toBe(1);
    expect(result.output).toMatchObject({
      status: "blocked",
      summary: "Delegate exceeded maxTurns without completing.",
      turns: 1,
      questionsAsked: 0,
    });
  });

  it("honors optional cwd for delegate agent turns", async () => {
    const projectCwd = await mkdtemp(join(tmpdir(), "trailstep-delegate-cwd-"));
    const delegateCwd = join(projectCwd, "delegate-cwd");
    await mkdir(delegateCwd, { recursive: true });
    const seenCwds: string[] = [];

    const result = await runWorkflow({
      workflow: delegate,
      input: { task: "Inspect subproject", cwd: delegateCwd },
      runName: "delegate-cwd-run",
      projectCwd,
      trailstepConfig,
      workingAgentProcessRunner: async (request) => {
        seenCwds.push(request.cwd);
        await writeFile(
          request.outputFile,
          JSON.stringify({ status: "completed", summary: "Inspected subproject." }),
          "utf8",
        );
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    expect(seenCwds).toEqual([delegateCwd]);
  });

  it("validates delegate turn output shape", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-delegate-invalid-output-"));

    const result = await runWorkflow({
      workflow: delegate,
      input: { task: "Return invalid output" },
      runName: "delegate-invalid-output-run",
      cwd,
      trailstepConfig,
      workingAgentProcessRunner: async (request) => {
        await writeFile(
          request.outputFile,
          JSON.stringify({ status: "done", summary: "Invalid status." }),
          "utf8",
        );
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected output shape validation to fail.");
    }
    expect(result.failure.message).toContain("Working agent step delegate-turn");
    expect(JSON.stringify(result.failure.details)).toContain(
      "step delegate-turn output failed schema validation",
    );
  });
});
