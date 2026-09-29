import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { runWorkflow } from "@trailstep/core";
import { describe, expect, it } from "vitest";

import { delegateParallel, normalizeDelegateParallelTasks } from "./workflow.js";

const execFileAsync = promisify(execFile);

const trailstepConfig = {
  version: 1,
  customProviders: { local: { binary: "local-agent" } },
  agents: { medium: [{ provider: "local" }] },
} as const;

describe("delegateParallel", () => {
  it("normalizes tasks deterministically with shared defaults and per-task worktrees", () => {
    const normalized = normalizeDelegateParallelTasks(
      {
        context: "Shared context",
        maxTurns: 4,
        summarize: true,
        worktree: { enabled: true, baseRef: "main" },
        tasks: [
          {
            id: "api client",
            mode: "explore",
            task: " Map API client ",
            context: "Task context",
          },
          {
            id: "review-1",
            mode: "review",
            task: "Review patch",
            maxTurns: 2,
            worktree: { enabled: true, path: "custom/path" },
          },
        ],
      },
      "parallel-run",
    );

    expect(normalized.status).toBe("ready");
    if (normalized.status !== "ready") {
      throw new Error(normalized.summary);
    }
    expect(normalized.tasks).toEqual([
      {
        id: "api client",
        mode: "explore",
        branchId: "delegate-api-client",
        input: {
          task: "Map API client",
          mode: "explore",
          context: "Shared context\n\nTask context",
          maxTurns: 4,
          summarize: true,
          worktree: {
            enabled: true,
            baseRef: "main",
            path: ".trailstep/worktrees/parallel-run/api-client",
            branch: "trailstep/delegate/parallel-run/api-client",
          },
        },
      },
      {
        id: "review-1",
        mode: "review",
        branchId: "delegate-review-1",
        input: {
          task: "Review patch",
          mode: "review",
          context: "Shared context",
          maxTurns: 2,
          summarize: true,
          worktree: {
            enabled: true,
            baseRef: "main",
            path: "custom/path",
            branch: "trailstep/delegate/parallel-run/review-1",
          },
        },
      },
    ]);
  });

  it("blocks duplicate task ids before fanning out", () => {
    const normalized = normalizeDelegateParallelTasks(
      {
        tasks: [
          { id: "same", mode: "explore", task: "one" },
          { id: "same", mode: "implement", task: "two" },
        ],
      },
      "parallel-run",
    );

    expect(normalized).toEqual({
      status: "blocked",
      summary: "delegateParallel task id 'same' is duplicated.",
    });
  });

  it("fans out to mode-specific delegate workflows with task-based requested branches and aggregate output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-delegate-parallel-"));
    const requestedBranches: string[] = [];
    const promptFiles: string[] = [];

    const result = await runWorkflow({
      workflow: delegateParallel,
      input: {
        context: "Shared",
        maxTurns: 1,
        tasks: [
          { id: "map", mode: "explore", task: "Map area" },
          { id: "fix", mode: "implement", task: "Fix issue" },
        ],
      },
      runName: "delegate-parallel-run",
      cwd,
      trailstepConfig,
      scheduler: { workers: 2 },
      eventSink(event) {
        if (event.type === "step.started" && event.payload.requestedBranchId !== undefined) {
          requestedBranches.push(String(event.payload.requestedBranchId));
        }
      },
      workingAgentProcessRunner: async (request) => {
        promptFiles.push(request.promptFile);
        const prompt = await readFile(request.promptFile, "utf8");
        const task = prompt.includes("Map area") ? "map" : "fix";
        await writeFile(
          request.outputFile,
          JSON.stringify({
            status: "completed",
            summary: `Done ${task}`,
            result: `ok:${task}`,
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
    expect(result.output.status).toBe("completed");
    expect(Object.keys(result.output.branches ?? {})).toEqual(["branch-1", "branch-2"]);
    expect(Object.values(result.output.branches ?? {})).toEqual(
      expect.arrayContaining([
        {
          status: "done",
          output: {
            status: "completed",
            summary: "Done map",
            result: "ok:map",
            questionsAsked: 0,
            turns: 1,
          },
        },
        {
          status: "done",
          output: {
            status: "completed",
            summary: "Done fix",
            result: "ok:fix",
            questionsAsked: 0,
            turns: 1,
          },
        },
      ]),
    );
    expect(requestedBranches).toEqual(expect.arrayContaining(["delegate-map", "delegate-fix"]));
    expect(promptFiles).toHaveLength(2);
  });

  it("fails fast when a delegated branch fails under current scheduler semantics", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-delegate-parallel-fail-fast-"));
    const requestedBranches: string[] = [];
    const attempts: string[] = [];

    const result = await runWorkflow({
      workflow: delegateParallel,
      input: {
        maxTurns: 1,
        tasks: [
          { id: "bad", mode: "implement", task: "Fail this task" },
          { id: "queued", mode: "review", task: "Should not start" },
        ],
      },
      runName: "delegate-parallel-fail-fast",
      cwd,
      trailstepConfig,
      scheduler: { workers: 1 },
      eventSink(event) {
        if (event.type === "step.started" && event.payload.requestedBranchId !== undefined) {
          requestedBranches.push(String(event.payload.requestedBranchId));
        }
      },
      workingAgentProcessRunner: async (request) => {
        attempts.push(request.promptFile);
        return { exitCode: 1, stdout: "agent failed" };
      },
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("expected delegateParallel to fail fast");
    }
    expect(result.failure).toMatchObject({
      code: "agent_target_exhausted",
      message: "Working agent step delegate-turn for role delegateAgent exhausted 1 target(s).",
    });
    expect(attempts).toHaveLength(1);
    expect(requestedBranches).toEqual(expect.arrayContaining(["delegate-bad"]));
    expect(requestedBranches).not.toContain("delegate-queued");

    const track = await readJson(join(result.runDir, "track.json"));
    const branchIds = track.branches as readonly string[];
    const branches = await Promise.all(
      branchIds.map((branchId) => readJson(join(result.runDir, "branches", `${branchId}.json`))),
    );
    expect(branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestedBranchId: "delegate-bad", status: "failed" }),
        expect.objectContaining({ requestedBranchId: "delegate-queued", status: "cancelled" }),
      ]),
    );
  });

  it("propagates managed worktree defaults to each task before delegate execution", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-delegate-parallel-worktrees-"));
    await initializeGitRepository(cwd);
    const executionCwds: string[] = [];

    const result = await runWorkflow({
      workflow: delegateParallel,
      input: {
        maxTurns: 1,
        worktree: { enabled: true, cleanup: "never" },
        tasks: [
          { id: "first task", mode: "explore", task: "Inspect first" },
          { id: "second", mode: "review", task: "Inspect second" },
        ],
      },
      runName: "delegate-parallel-worktrees",
      cwd,
      trailstepConfig,
      scheduler: { workers: 2 },
      workingAgentProcessRunner: async (request) => {
        executionCwds.push(request.cwd);
        await writeFile(
          request.outputFile,
          JSON.stringify({ status: "completed", summary: "Done" }),
          "utf8",
        );
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    const firstPath = join(
      cwd,
      ".trailstep",
      "worktrees",
      "delegate-parallel-worktrees",
      "first-task",
    );
    const secondPath = join(
      cwd,
      ".trailstep",
      "worktrees",
      "delegate-parallel-worktrees",
      "second",
    );
    expect(executionCwds).toEqual(expect.arrayContaining([firstPath, secondPath]));
    expect(Object.values(result.output.branches ?? {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "done",
          output: expect.objectContaining({
            status: "completed",
            worktreePath: firstPath,
            worktreeBranch: "trailstep/delegate/delegate-parallel-worktrees/first-task",
            worktreeCleanup: expect.objectContaining({ requested: "never", status: "kept" }),
          }),
        }),
        expect.objectContaining({
          status: "done",
          output: expect.objectContaining({
            status: "completed",
            worktreePath: secondPath,
            worktreeBranch: "trailstep/delegate/delegate-parallel-worktrees/second",
            worktreeCleanup: expect.objectContaining({ requested: "never", status: "kept" }),
          }),
        }),
      ]),
    );
  });
});

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function initializeGitRepository(cwd: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.email", "trailstep@example.test"], { cwd });
  await execFileAsync("git", ["config", "user.name", "TrailStep Test"], { cwd });
  await writeFile(join(cwd, "README.md"), "# fixture\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd });
}
