import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWorkflow } from "@trailstep/core";
import { describe, expect, it } from "vitest";

import { delegateParallel, normalizeDelegateParallelTasks } from "./workflow.js";

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

  it("fans out to mode-specific delegate workflows with task-based requested branches", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-delegate-parallel-"));
    const requestedBranches: string[] = [];

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
        await writeFile(
          request.outputFile,
          JSON.stringify({
            status: "completed",
            summary: "Done",
            result: "ok",
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
    expect(Object.values(result.output.branches ?? {})).toHaveLength(2);
    expect(requestedBranches).toEqual(expect.arrayContaining(["delegate-map", "delegate-fix"]));
  });
});
