import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { done, promptTemplate, state, step } from "../../authoring/authoring.js";
import type { Workflow } from "../../authoring/workflow/workflow.types.js";
import { runWorkflow } from "./run-workflow.js";

async function makeDir(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  await mkdir(path, { recursive: true });
  return path;
}

describe("runWorkflow cwd resolution", () => {
  it("preserves cwd-only behavior for execution cwd and artifact root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-cwd-only-"));
    const workflow: Workflow<Record<string, never>, { cwd: string }> = {
      id: "cwd-only",
      outputShape: { cwd: "string" },
      start() {
        return step({ id: "observe" }).do(() => done({ cwd: state.cwd ?? "" }))();
      },
    };

    const result = await runWorkflow({ workflow, input: {}, runName: "cwd-only-run", cwd });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output.cwd).toBe(cwd);
    expect(result.runDir).toBe(join(cwd, ".trailstep", "runs", "cwd-only-run"));
  });

  it("uses callback step cwd for working agents while keeping artifacts and prompt templates under projectCwd", async () => {
    const projectCwd = await mkdtemp(join(tmpdir(), "trailstep-core-project-cwd-"));
    const executionCwd = await makeDir(projectCwd, "default-exec");
    const worktreeCwd = await makeDir(projectCwd, "worktree");
    await writeFile(join(projectCwd, "prompt.md"), "Project-scoped prompt.", "utf8");

    const seenCwds: string[] = [];
    const workflow: Workflow<{ worktreePath: string }, { cwd: string; prompt: string }> = {
      id: "working-step-cwd",
      inputShape: { worktreePath: "string" },
      outputShape: { cwd: "string", prompt: "string" },
      agents: { implementer: { size: "small" } },
      start(input) {
        return step({ id: "implement", cwd: ({ input }) => input.worktreePath })
          .prompt(promptTemplate("prompt.md"), {
            agent: "implementer",
            output: { cwd: "string", prompt: "string" },
          })
          .do((output) => done(output))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { worktreePath: worktreeCwd },
      runName: "working-step-cwd-run",
      projectCwd,
      cwd: executionCwd,
      trailstepConfig: {
        version: 1,
        customProviders: { local: { binary: "local-agent", args: ["{{promptFile}}"] } },
        agents: { small: [{ provider: "local" }] },
      },
      workingAgentProcessRunner: async (request) => {
        seenCwds.push(request.cwd);
        const prompt = await readFile(request.promptFile, "utf8");
        await writeFile(request.outputFile, JSON.stringify({ cwd: request.cwd, prompt }), "utf8");
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(seenCwds).toEqual([worktreeCwd]);
    expect(result.output.cwd).toBe(worktreeCwd);
    expect(result.output.prompt).toContain("Project-scoped prompt.");
    expect(result.runDir).toBe(join(projectCwd, ".trailstep", "runs", "working-step-cwd-run"));
  });

  it("uses step cwd for interactive agents", async () => {
    const projectCwd = await mkdtemp(join(tmpdir(), "trailstep-core-interactive-step-cwd-"));
    const executionCwd = await makeDir(projectCwd, "default-exec");
    const worktreeCwd = await makeDir(projectCwd, "interactive-worktree");
    const seenCwds: string[] = [];
    const workflow: Workflow<Record<string, never>, { notes: string }> = {
      id: "interactive-step-cwd",
      outputShape: { notes: "string" },
      agents: { reviewer: { size: "small" } },
      start() {
        return step({ id: "review", cwd: worktreeCwd })
          .prompt("Review the worktree.", {
            agent: "reviewer",
            mode: "interactive",
            output: { notes: "string" },
          })
          .do((output) => done(output))();
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "interactive-step-cwd-run",
      projectCwd,
      cwd: executionCwd,
      trailstepConfig: {
        version: 1,
        customProviders: {
          terminalAgent: { binary: "terminal-agent", interactiveArgs: ["{{promptFile}}"] },
        },
        agents: { small: [{ provider: "terminalAgent" }] },
      },
      processRunner: async (request) => {
        seenCwds.push(request.cwd);
        const interactiveFile = request.env?.TRAILSTEP_INTERACTIVE_FILE ?? "";
        const protocol = JSON.parse(await readFile(interactiveFile, "utf8"));
        await writeFile(protocol.outputFile, JSON.stringify({ notes: "Approved." }), "utf8");
        await writeFile(
          interactiveFile,
          `${JSON.stringify({ ...protocol, status: "completed" }, null, 2)}\n`,
          "utf8",
        );
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(seenCwds).toEqual([worktreeCwd]);
    expect(result.output).toEqual({ notes: "Approved." });
  });

  it("exposes resolved step cwd to code steps", async () => {
    const projectCwd = await mkdtemp(join(tmpdir(), "trailstep-core-code-step-cwd-"));
    const executionCwd = await makeDir(projectCwd, "default-exec");
    const worktreeCwd = await makeDir(projectCwd, "code-worktree");
    const workflow: Workflow<
      Record<string, never>,
      { cwd: string; executionCwd: string; projectCwd: string }
    > = {
      id: "code-step-cwd",
      outputShape: { cwd: "string", executionCwd: "string", projectCwd: "string" },
      start() {
        return step({ id: "observe", cwd: worktreeCwd }).do(() =>
          done({
            cwd: state.cwd ?? "",
            executionCwd: state.executionCwd ?? "",
            projectCwd: state.projectCwd ?? "",
          }),
        )();
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "code-step-cwd-run",
      projectCwd,
      cwd: executionCwd,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ cwd: worktreeCwd, executionCwd: worktreeCwd, projectCwd });
  });

  it("fails clearly when a step cwd does not exist", async () => {
    const projectCwd = await mkdtemp(join(tmpdir(), "trailstep-core-missing-step-cwd-"));
    const missingCwd = join(projectCwd, "missing-worktree");
    const workflow: Workflow<Record<string, never>, { ok: boolean }> = {
      id: "missing-step-cwd",
      outputShape: { ok: "boolean" },
      start() {
        return step({ id: "missing", cwd: missingCwd }).do(() => done({ ok: true }))();
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "missing-step-cwd-run",
      projectCwd,
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected failure.");
    }
    expect(result.failure.message).toContain("step missing cwd must be an existing directory");
    expect(result.failure.message).toContain(missingCwd);
  });
});
