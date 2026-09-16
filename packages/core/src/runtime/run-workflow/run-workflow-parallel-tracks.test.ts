import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { done, runWorkflow, step, type Event, type PlainObject, type Workflow } from "../../index.js";

function readJsonObject(path: string): Promise<Record<string, unknown>> {
  return readFile(path, "utf8").then((contents) => JSON.parse(contents) as Record<string, unknown>);
}

describe("runWorkflow parallel tracks", () => {
  it("executes a root continuation array as branch candidates with aggregate output, unique artifacts, persisted state, and branch event metadata", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-parallel-"));

    const stepA = step({ id: "same-id" }).do(() => done({ value: "a" }));
    const stepB = step({ id: "same-id" }).do(() => done({ value: "b" }));

    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "parallel-root-array-workflow",
      start() {
        return [stepA(), stepB()];
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "parallel-root-array",
      cwd,
      scheduler: { workers: 2 },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    expect(result.output).toMatchObject({
      status: "completed",
      branches: expect.any(Object),
    });
    const aggregateBranches = (result.output.branches ?? {}) as Record<
      string,
      { readonly status?: unknown; readonly output?: unknown }
    >;
    expect(Object.values(aggregateBranches)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "done", output: { value: "a" } }),
        expect.objectContaining({ status: "done", output: { value: "b" } }),
      ]),
    );

    const stepDirs = await readdir(join(result.runDir, "steps"));
    expect(stepDirs).toEqual(expect.arrayContaining(["0001-same-id", "0002-same-id"]));

    const track = await readJsonObject(join(result.runDir, "track.json"));
    expect(track).toMatchObject({
      runId: result.runId,
      status: "completed",
      workers: 2,
      failurePolicy: expect.any(String),
      rootBranchId: expect.any(String),
      splitOccurred: true,
    });
    expect(track.branches).toEqual(expect.arrayContaining(Object.keys(aggregateBranches)));

    const branchIds = track.branches as readonly string[];
    expect(branchIds).toHaveLength(2);
    for (const branchId of branchIds) {
      const branch = await readJsonObject(join(result.runDir, "branches", `${branchId}.json`));
      expect(branch).toMatchObject({
        branchId,
        parentBranchId: track.rootBranchId,
        status: "done",
        workflowId: workflow.id,
        output: expect.any(Object),
        latestStepIndex: expect.any(Number),
      });
      expect(branch.createdAt).toEqual(expect.any(String));
      expect(branch.updatedAt).toEqual(expect.any(String));
    }

    const branchStepEvents = result.events.filter(
      (event): event is Event =>
        (event.type === "step.started" || event.type === "step.completed") &&
        event.stepId === "same-id",
    );
    expect(branchStepEvents).toHaveLength(4);
    for (const event of branchStepEvents) {
      expect(event.payload).toMatchObject({
        trackId: result.runId,
        branchId: expect.any(String),
      });
    }
  });
});
