import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { done, step } from "../../authoring/authoring.js";
import type { Workflow } from "../../authoring/workflow/workflow.types.js";
import { runWorkflow } from "./run-workflow.js";
import { createWorkflowStartedProvenance } from "./workflow-started-provenance.js";

async function makeDir(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  await mkdir(path, { recursive: true });
  return path;
}

describe("createWorkflowStartedProvenance", () => {
  it("records distinct project and execution cwd under schema version 1", () => {
    expect(createWorkflowStartedProvenance({ projectCwd: "/repo", cwd: "/repo/worktree" })).toEqual(
      { schemaVersion: 1, projectCwd: "/repo", executionCwd: "/repo/worktree" },
    );
  });

  it("is absent when there is no project cwd to record", () => {
    expect(createWorkflowStartedProvenance({ projectCwd: "  ", cwd: "/repo" })).toBeUndefined();
  });

  it("falls back to the project cwd when the execution cwd is empty", () => {
    expect(createWorkflowStartedProvenance({ projectCwd: "/repo", cwd: "" })).toEqual({
      schemaVersion: 1,
      projectCwd: "/repo",
      executionCwd: "/repo",
    });
  });
});

describe("workflow.started provenance", () => {
  it("records distinct project vs execution cwd without touching payload.input", async () => {
    const projectCwd = await mkdtemp(join(tmpdir(), "trailstep-core-provenance-"));
    const executionCwd = await makeDir(projectCwd, "worktree");
    const workflow: Workflow<{ sha: string }, { ok: boolean }> = {
      id: "provenance-workflow",
      inputShape: { sha: "string" },
      outputShape: { ok: "boolean" },
      start(input) {
        return step({ id: "observe" }).do(() => done({ ok: input.sha === "abc" }))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { sha: "abc" },
      runName: "provenance-run",
      projectCwd,
      cwd: executionCwd,
    });

    expect(result.status).toBe("success");
    const started = result.events.find((event) => event.type === "workflow.started");
    expect(started).toBeDefined();
    expect(started?.schemaVersion).toBe("v0");
    expect(started?.payload).toEqual({
      input: { sha: "abc" },
      provenance: { schemaVersion: 1, projectCwd, executionCwd },
    });
  });

  it("keeps the original workflow.started unchanged across continue", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-provenance-continue-"));
    let checks = 0;
    const workflow: Workflow<{ sha: string }, { status: string }> = {
      id: "provenance-continue",
      inputShape: { sha: "string" },
      outputShape: { status: "string" },
      start(input) {
        return step({ id: "ci" })
          .wait(
            async ({ wait }) => {
              checks += 1;
              return checks === 1
                ? wait.pending({ id: "ci", message: "Waiting" })
                : wait.done({ status: "passed" });
            },
            { output: { status: "string" } },
          )
          .do(({ waits }) => done({ status: String(waits.ci?.status) }))(input);
      },
    };

    const first = await runWorkflow({
      workflow,
      input: { sha: "abc" },
      runName: "provenance-continue-run",
      cwd,
    });
    expect(first.status).toBe("waiting");
    const originalStarted = first.events.find((event) => event.type === "workflow.started");
    expect(originalStarted?.payload).toMatchObject({
      input: { sha: "abc" },
      provenance: { schemaVersion: 1, projectCwd: cwd, executionCwd: cwd },
    });

    if (first.status !== "waiting") {
      throw new Error("Expected waiting.");
    }
    const second = await runWorkflow({ workflow, continue: { runDir: first.runDir }, cwd });
    expect(second.status).toBe("success");

    const startedEvents = second.events.filter((event) => event.type === "workflow.started");
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0]).toEqual(originalStarted);
  });

  it("leaves legacy workflow.started payloads (no provenance) untouched across retry", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-provenance-legacy-"));
    let fail = true;
    const workflow: Workflow<Record<string, never>, { ok: boolean }> = {
      id: "provenance-legacy",
      inputShape: {},
      outputShape: { ok: "boolean" },
      start() {
        return step({ id: "prepare" }).do(() => {
          if (fail) {
            throw new Error("boom");
          }
          return done({ ok: true });
        })();
      },
    };

    const first = await runWorkflow({
      workflow,
      input: {},
      runName: "provenance-legacy-run",
      cwd,
    });
    expect(first.status).toBe("failure");
    const originalStarted = first.events.find((event) => event.type === "workflow.started");
    expect(originalStarted?.payload).toMatchObject({
      input: {},
      provenance: { schemaVersion: 1, projectCwd: cwd, executionCwd: cwd },
    });
    // Simulate a legacy trail: strip the provenance field as pre-A2a runs have none.
    if (first.status !== "failure") {
      throw new Error("Expected failure.");
    }
    const started = first.events.find((event) => event.type === "workflow.started");
    expect(started).toBeDefined();
    if (started === undefined) {
      throw new Error("Missing started event.");
    }
    const legacyEvents = first.events.map((event) =>
      event.type === "workflow.started" ? { ...event, payload: { input: {} } } : event,
    );
    const legacyStarted = legacyEvents.find((event) => event.type === "workflow.started");
    await writeFile(
      join(first.runDir, "events.jsonl"),
      `${legacyEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );

    fail = false;
    const retried = await runWorkflow({
      workflow,
      retry: { runDir: first.runDir, kind: "manual" },
      cwd,
    });
    expect(retried.status).toBe("success");

    const startedEvents = retried.events.filter((event) => event.type === "workflow.started");
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0]).toEqual(legacyStarted);
    expect(startedEvents[0]?.payload).toEqual({ input: {} });
  });

  it("keeps the original workflow.started unchanged across resume", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-provenance-resume-"));
    let fail = true;
    const workflow: Workflow<Record<string, never>, { ok: boolean }> = {
      id: "provenance-resume",
      inputShape: {},
      outputShape: { ok: "boolean" },
      start() {
        return step({ id: "prepare" }).do(() => {
          if (fail) {
            throw new Error("boom");
          }
          return done({ ok: true });
        })();
      },
    };

    const first = await runWorkflow({
      workflow,
      input: {},
      runName: "provenance-resume-run",
      cwd,
    });
    expect(first.status).toBe("failure");
    const originalStarted = first.events.find((event) => event.type === "workflow.started");
    if (first.status !== "failure" || originalStarted === undefined) {
      throw new Error("Expected failed run with a started event.");
    }

    fail = false;
    const resumed = await runWorkflow({
      workflow,
      resume: { runDir: first.runDir },
      cwd,
    });
    expect(resumed.status).toBe("success");

    const startedEvents = resumed.events.filter((event) => event.type === "workflow.started");
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0]).toEqual(originalStarted);
  });
});
