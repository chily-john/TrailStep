import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  defineWorkflow,
  done,
  fail,
  runWorkflow,
  step,
  type Event,
  type PlainObject,
  type Workflow,
} from "../../index.js";

function readJsonObject(path: string): Promise<Record<string, unknown>> {
  return readFile(path, "utf8").then((contents) => JSON.parse(contents) as Record<string, unknown>);
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function createDeferred(): Deferred {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: resolvePromise,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runWorkflow parallel tracks", () => {
  it("executes a workflow invocation on the same branch without creating a branch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-invocation-same-branch-"));
    const branchIds: string[] = [];

    const childStep = step({ id: "child-step" }).do((input: { value: number }) =>
      done({ value: input.value + 1 }),
    );
    const ChildWorkflow = defineWorkflow<{ value: number }, { value: number }>({
      id: "same-branch-child-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return childStep(input);
      },
    });
    const parentStep = step({ id: "parent-step" }).do((input: { value: number }) =>
      ChildWorkflow({ value: input.value }),
    );
    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "same-branch-parent-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return parentStep(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { value: 41 },
      runName: "invocation-same-branch",
      cwd,
      eventSink(event) {
        if (event.type === "step.started") {
          branchIds.push(String(event.payload.branchId));
        }
      },
      scheduler: { workers: 2 },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ value: 42 });
    expect(branchIds).toEqual(["root", "root"]);

    const track = await readJsonObject(join(result.runDir, "track.json"));
    expect(track).toMatchObject({ splitOccurred: false, branches: ["root"] });
    const rootBranch = await readJsonObject(join(result.runDir, "branches", "root.json"));
    expect(rootBranch).toMatchObject({ branchId: "root", status: "done", output: { value: 42 } });
  });

  it("routes invocation onDone on the same branch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-invocation-ondone-same-branch-"));
    const observedOutputs: PlainObject[] = [];
    const branchIds: string[] = [];

    const childStep = step({ id: "child-on-done-step" }).do((input: { value: number }) =>
      done({ value: input.value + 1 }),
    );
    const followUpStep = step({ id: "follow-up-on-done-step" }).do((input: { value: number }) =>
      done({ value: input.value + 1 }),
    );
    const ChildWorkflow = defineWorkflow<{ value: number }, { value: number }>({
      id: "on-done-child-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return childStep(input);
      },
    });
    const parentStep = step({ id: "parent-on-done-step" }).do((input: { value: number }) =>
      ChildWorkflow(input, {
        onDone(output) {
          observedOutputs.push(output);
          return followUpStep(output);
        },
      }),
    );
    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "on-done-parent-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return parentStep(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { value: 40 },
      runName: "invocation-on-done-same-branch",
      cwd,
      eventSink(event) {
        if (event.type === "step.started") {
          branchIds.push(String(event.payload.branchId));
        }
      },
      scheduler: { workers: 2 },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(observedOutputs).toEqual([{ value: 41 }]);
    expect(result.output).toEqual({ value: 42 });
    expect(branchIds).toEqual(["root", "root", "root"]);

    const track = await readJsonObject(join(result.runDir, "track.json"));
    expect(track).toMatchObject({ splitOccurred: false, branches: ["root"] });
    await expect(readdir(join(result.runDir, "branches"))).resolves.toEqual(["root.json"]);
    const rootBranch = await readJsonObject(join(result.runDir, "branches", "root.json"));
    expect(rootBranch).toMatchObject({
      branchId: "root",
      status: "done",
      output: { value: 42 },
      latestStepIndex: 3,
    });
  });

  it("schedules an onDone continuation array after same-branch workflow invocation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-invocation-ondone-array-"));
    const observed: string[] = [];
    const branchIds: string[] = [];
    const gates = new Map(["a", "b"].map((branch) => [branch, createDeferred()]));
    let active = 0;
    let maxActive = 0;

    const childStep = step({ id: "on-done-array-child-step" }).do((input: { value: number }) => {
      observed.push("child");
      return done({ value: input.value + 1 });
    });
    const branchA = step({ id: "on-done-array-branch-a" }).do(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      observed.push("a");
      await gates.get("a")?.promise;
      active -= 1;
      return done({ branch: "a" });
    });
    const branchB = step({ id: "on-done-array-branch-b" }).do(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      observed.push("b");
      await gates.get("b")?.promise;
      active -= 1;
      return done({ branch: "b" });
    });
    const ChildWorkflow = defineWorkflow<{ value: number }, { value: number }>({
      id: "on-done-array-child-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return childStep(input);
      },
    });
    const parentStep = step({ id: "on-done-array-parent-step" }).do((input: { value: number }) =>
      ChildWorkflow(input, {
        onDone(output) {
          observed.push(`onDone:${output.value}`);
          return [branchA(), branchB()];
        },
      }),
    );
    const workflow: Workflow<{ value: number }, PlainObject> = {
      id: "on-done-array-parent-workflow",
      inputShape: { value: "number" },
      start(input) {
        return parentStep(input);
      },
    };

    const run = runWorkflow({
      workflow,
      input: { value: 40 },
      runName: "invocation-on-done-array",
      cwd,
      eventSink(event) {
        if (event.type === "step.started") {
          branchIds.push(String(event.payload.branchId));
        }
      },
      scheduler: { workers: 1 },
    });

    try {
      await expect.poll(() => observed).toEqual(["child", "onDone:41", "a"]);
      await delay(25);
      expect(observed).toEqual(["child", "onDone:41", "a"]);
      gates.get("a")?.resolve();
      await expect.poll(() => observed).toEqual(["child", "onDone:41", "a", "b"]);
      gates.get("b")?.resolve();
    } catch (error) {
      gates.get("a")?.resolve();
      gates.get("b")?.resolve();
      await run.catch(() => undefined);
      throw error;
    }

    const result = await run;
    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    expect(maxActive).toBe(1);
    expect(branchIds).toEqual(["root", "root", "branch-1", "branch-2"]);
    expect(result.output).toMatchObject({
      status: "completed",
      branches: expect.any(Object),
    });
    expect(Object.values(result.output.branches ?? {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "done", output: { branch: "a" } }),
        expect.objectContaining({ status: "done", output: { branch: "b" } }),
      ]),
    );

    const track = await readJsonObject(join(result.runDir, "track.json"));
    expect(track).toMatchObject({ splitOccurred: true, branches: ["root", "branch-1", "branch-2"] });
    const rootBranch = await readJsonObject(join(result.runDir, "branches", "root.json"));
    expect(rootBranch).toMatchObject({
      branchId: "root",
      status: "split",
      splitSource: "onDone for workflow invocation on-done-array-child-workflow",
      latestStepId: "on-done-array-child-step",
    });
    for (const branchId of ["branch-1", "branch-2"]) {
      const branch = await readJsonObject(join(result.runDir, "branches", `${branchId}.json`));
      expect(branch).toMatchObject({
        branchId,
        parentBranchId: "root",
        source: "onDone for workflow invocation on-done-array-child-workflow",
        status: "done",
      });
    }

    const stepDirs = await readdir(join(result.runDir, "steps"));
    expect(stepDirs).toEqual(expect.arrayContaining(["0002-on-done-array-child-step"]));
    expect(stepDirs).toContainEqual(expect.stringMatching(/^000[34]-on-done-array-branch-a$/));
    expect(stepDirs).toContainEqual(expect.stringMatching(/^000[34]-on-done-array-branch-b$/));
    expect(new Set(stepDirs).size).toBe(stepDirs.length);
  });

  it("terminalizes the same branch when invocation onDone returns done", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-invocation-ondone-done-"));
    const observedOutputs: PlainObject[] = [];
    const branchIds: string[] = [];

    const childStep = step({ id: "child-on-done-terminal-step" }).do((input: { value: number }) =>
      done({ value: input.value + 1 }),
    );
    const ChildWorkflow = defineWorkflow<{ value: number }, { value: number }>({
      id: "on-done-terminal-child-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return childStep(input);
      },
    });
    const parentStep = step({ id: "parent-on-done-terminal-step" }).do((input: { value: number }) =>
      ChildWorkflow(input, {
        onDone(output) {
          observedOutputs.push(output);
          return done({ value: output.value + 1 });
        },
      }),
    );
    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "on-done-terminal-parent-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return parentStep(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { value: 40 },
      runName: "invocation-on-done-terminal-same-branch",
      cwd,
      eventSink(event) {
        if (event.type === "step.started") {
          branchIds.push(String(event.payload.branchId));
        }
      },
      scheduler: { workers: 2 },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(observedOutputs).toEqual([{ value: 41 }]);
    expect(result.output).toEqual({ value: 42 });
    expect(branchIds).toEqual(["root", "root"]);

    const track = await readJsonObject(join(result.runDir, "track.json"));
    expect(track).toMatchObject({ splitOccurred: false, branches: ["root"] });
    const rootBranch = await readJsonObject(join(result.runDir, "branches", "root.json"));
    expect(rootBranch).toMatchObject({
      branchId: "root",
      status: "done",
      output: { value: 42 },
    });
  });

  it("bounds branch concurrency by the scheduler worker limit", async () => {
    async function runScenario(workers: number): Promise<{
      readonly result: Awaited<ReturnType<typeof runWorkflow>>;
      readonly maxActive: number;
      readonly starts: readonly string[];
    }> {
      const cwd = await mkdtemp(join(tmpdir(), `trailstep-core-parallel-workers-${workers}-`));
      const branches = ["a", "b", "c"] as const;
      const gates = new Map<string, Deferred>(branches.map((branch) => [branch, createDeferred()]));
      const starts: string[] = [];
      let active = 0;
      let maxActive = 0;

      const branchSteps = branches.map((branch) =>
        step({ id: `branch-${branch}` }).do(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          starts.push(branch);
          await gates.get(branch)?.promise;
          active -= 1;
          return done({ branch });
        }),
      );

      const workflow: Workflow<Record<string, never>, PlainObject> = {
        id: `parallel-worker-limit-${workers}-workflow`,
        start() {
          return branchSteps.map((branchStep) => branchStep({}));
        },
      };

      const run = runWorkflow({
        workflow,
        input: {},
        runName: `parallel-worker-limit-${workers}`,
        cwd,
        scheduler: { workers },
      });

      try {
        if (workers === 1) {
          await expect.poll(() => starts.length).toBe(1);
          await delay(25);
          expect(starts).toHaveLength(1);
          gates.get(starts[0]!)?.resolve();

          await expect.poll(() => starts.length).toBe(2);
          await delay(25);
          expect(starts).toHaveLength(2);
          gates.get(starts[1]!)?.resolve();

          await expect.poll(() => starts.length).toBe(3);
          await delay(25);
          expect(starts).toHaveLength(3);
          gates.get(starts[2]!)?.resolve();
        } else {
          await expect.poll(() => starts.length).toBe(2);
          gates.get(starts[0]!)?.resolve();
          gates.get(starts[1]!)?.resolve();
          await expect.poll(() => starts.length).toBe(3);
          gates.get(starts[2]!)?.resolve();
        }
      } catch (error) {
        for (const gate of gates.values()) {
          gate.resolve();
        }
        await run.catch(() => undefined);
        throw error;
      }

      const result = await run;
      return { result, maxActive, starts };
    }

    const serial = await runScenario(1);
    expect(serial.result.status).toBe("success");
    if (serial.result.status !== "success") {
      throw new Error(serial.result.failure.message);
    }
    expect(serial.maxActive).toBe(1);
    expect(serial.result.output).toMatchObject({
      status: "completed",
      branches: expect.any(Object),
    });
    expect(Object.values(serial.result.output.branches ?? {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ output: { branch: "a" } }),
        expect.objectContaining({ output: { branch: "b" } }),
        expect.objectContaining({ output: { branch: "c" } }),
      ]),
    );

    const parallel = await runScenario(2);
    expect(parallel.result.status).toBe("success");
    if (parallel.result.status !== "success") {
      throw new Error(parallel.result.failure.message);
    }
    expect(parallel.maxActive).toBe(2);
    expect(parallel.result.output).toMatchObject({
      status: "completed",
      branches: expect.any(Object),
    });
    expect(Object.values(parallel.result.output.branches ?? {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ output: { branch: "a" } }),
        expect.objectContaining({ output: { branch: "b" } }),
        expect.objectContaining({ output: { branch: "c" } }),
      ]),
    );
  });

  it("normal done completes only the current branch and waits for siblings", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-branch-done-waits-"));
    const slowGate = createDeferred();
    const observed: string[] = [];
    let settled = false;

    const fastBranch = step({ id: "done-waits-fast" }).do(() => {
      observed.push("fast");
      return done({ branch: "fast" });
    });
    const slowBranch = step({ id: "done-waits-slow" }).do(async () => {
      observed.push("slow-start");
      await slowGate.promise;
      observed.push("slow-done");
      return done({ branch: "slow" });
    });
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "branch-done-waits-workflow",
      start() {
        return [fastBranch(), slowBranch()];
      },
    };

    const run = runWorkflow({
      workflow,
      input: {},
      runName: "branch-done-waits",
      cwd,
      scheduler: { workers: 2 },
    }).then((result) => {
      settled = true;
      return result;
    });

    try {
      await expect.poll(() => observed).toHaveLength(2);
      expect(observed).toEqual(expect.arrayContaining(["fast", "slow-start"]));
      await delay(25);
      expect(settled).toBe(false);
      slowGate.resolve();
    } catch (error) {
      slowGate.resolve();
      await run.catch(() => undefined);
      throw error;
    }

    const result = await run;
    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(observed).toEqual(expect.arrayContaining(["fast", "slow-start", "slow-done"]));
    expect(Object.values(result.output.branches ?? {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "done", output: { branch: "fast" } }),
        expect.objectContaining({ status: "done", output: { branch: "slow" } }),
      ]),
    );
  });

  it("branch fail triggers fail-fast and preserves completed sibling state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-branch-fail-fast-"));
    const observed: string[] = [];

    const completedBranch = step({ id: "fail-fast-completed" }).do(() => {
      observed.push("completed");
      return done({ branch: "completed" });
    });
    const failingBranch = step({ id: "fail-fast-failing" }).do(() => {
      observed.push("failing");
      return fail({ code: "branch_failed", message: "branch failed intentionally" });
    });
    const queuedBranch = step({ id: "fail-fast-queued" }).do(() => {
      observed.push("queued");
      return done({ branch: "queued" });
    });
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "branch-fail-fast-workflow",
      start() {
        return [completedBranch(), failingBranch(), queuedBranch()];
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "branch-fail-fast",
      cwd,
      scheduler: { workers: 1 },
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("expected fail-fast run to fail");
    }
    expect(result.failure).toMatchObject({
      code: "branch_failed",
      message: "branch failed intentionally",
    });
    expect(observed).toEqual(["completed", "failing"]);

    const track = await readJsonObject(join(result.runDir, "track.json"));
    expect(track).toMatchObject({
      status: "failed",
      failure: { code: "branch_failed", message: "branch failed intentionally" },
    });
    const branchIds = track.branches as readonly string[];
    const branches = await Promise.all(
      branchIds.map((branchId) => readJsonObject(join(result.runDir, "branches", `${branchId}.json`))),
    );
    expect(branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "done", output: { branch: "completed" } }),
        expect.objectContaining({
          status: "failed",
          failure: { code: "branch_failed", message: "branch failed intentionally" },
        }),
        expect.objectContaining({ status: "cancelled", latestStepIndex: 0 }),
      ]),
    );
  });

  it.each([0, 1.5, Infinity])(
    "fails clearly when scheduler.workers is invalid (%s)",
    async (workers) => {
      const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-parallel-invalid-workers-"));
      const branchStep = step({ id: "branch" }).do(() => done({ value: "unused" }));
      const workflow: Workflow<Record<string, never>, PlainObject> = {
        id: "parallel-invalid-workers-workflow",
        start() {
          return [branchStep({})];
        },
      };

      const result = await runWorkflow({
        workflow,
        input: {},
        runName: "parallel-invalid-workers",
        cwd,
        scheduler: { workers },
      });

      expect(result.status).toBe("failure");
      if (result.status !== "failure") {
        throw new Error("expected invalid scheduler workers to fail");
      }
      expect(result.failure).toMatchObject({
        code: "invalid_scheduler_workers",
        message: expect.stringContaining(
          "scheduler.workers must be an integer greater than or equal to 1",
        ),
      });
    },
  );

  it("uses and persists the default scheduler worker count when omitted", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-parallel-default-workers-"));
    const branchStep = step({ id: "default-worker-branch" }).do(() => done({ value: "ok" }));
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "parallel-default-workers-workflow",
      start() {
        return [branchStep({})];
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "parallel-default-workers",
      cwd,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    const track = await readJsonObject(join(result.runDir, "track.json"));
    expect(track).toMatchObject({
      runId: result.runId,
      status: "completed",
      workers: Math.max(1, Math.floor(availableParallelism() / 2)),
      splitOccurred: true,
    });
  });

  it("schedules an array returned by a non-root step", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-parallel-non-root-"));
    const observed: string[] = [];

    const branchA = step({ id: "branch-a" }).do(() => {
      observed.push("a");
      return done({ value: "a" });
    });
    const branchB = step({ id: "branch-b" }).do(() => {
      observed.push("b");
      return done({ value: "b" });
    });
    const starter = step({ id: "starter" }).do(() => {
      observed.push("starter");
      return [branchA(), branchB()];
    });

    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "parallel-non-root-array-workflow",
      start() {
        return starter();
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "parallel-non-root-array",
      cwd,
      scheduler: { workers: 2 },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    expect(observed[0]).toBe("starter");
    expect(observed).toEqual(expect.arrayContaining(["starter", "a", "b"]));
    expect(result.output).toMatchObject({
      status: "completed",
      branches: expect.any(Object),
    });
    expect(Object.values(result.output.branches ?? {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "done", output: { value: "a" } }),
        expect.objectContaining({ status: "done", output: { value: "b" } }),
      ]),
    );

    const stepDirs = await readdir(join(result.runDir, "steps"));
    expect(stepDirs).toEqual(expect.arrayContaining(["0001-starter"]));
    expect(stepDirs).toContainEqual(expect.stringMatching(/^000[23]-branch-a$/));
    expect(stepDirs).toContainEqual(expect.stringMatching(/^000[23]-branch-b$/));
    expect(new Set(stepDirs).size).toBe(stepDirs.length);
  });

  it("schedules an array returned by a later branch step", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-parallel-nested-split-"));
    const observed: string[] = [];

    const leafC = step({ id: "leaf-c" }).do(() => {
      observed.push("c");
      return done({ value: "c" });
    });
    const leafD = step({ id: "leaf-d" }).do(() => {
      observed.push("d");
      return done({ value: "d" });
    });
    const splitter = step({ id: "splitter" }).do(() => {
      observed.push("splitter");
      return [leafC(), leafD()];
    });
    const linearStart = step({ id: "linear-start" }).do(() => {
      observed.push("linear-start");
      return splitter();
    });
    const immediate = step({ id: "immediate" }).do(() => {
      observed.push("immediate");
      return done({ value: "immediate" });
    });
    const starter = step({ id: "nested-starter" }).do(() => {
      observed.push("starter");
      return [linearStart(), immediate()];
    });

    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "parallel-nested-array-workflow",
      start() {
        return starter();
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "parallel-nested-array",
      cwd,
      scheduler: { workers: 2 },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    expect(observed).toEqual(
      expect.arrayContaining(["starter", "linear-start", "splitter", "immediate", "c", "d"]),
    );
    expect(result.output).toMatchObject({
      status: "completed",
      branches: expect.any(Object),
    });
    expect(Object.values(result.output.branches ?? {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "done", output: { value: "immediate" } }),
        expect.objectContaining({ status: "done", output: { value: "c" } }),
        expect.objectContaining({ status: "done", output: { value: "d" } }),
      ]),
    );

    const stepDirs = await readdir(join(result.runDir, "steps"));
    expect(new Set(stepDirs).size).toBe(stepDirs.length);
  });

  it("schedules workflow invocations inside continuation arrays as branch candidates", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-array-invocations-"));
    const branchStepsByValue = new Map<string, string[]>();

    const workerStepA = step({ id: "array-invocation-worker-a" }).do((input: { value: string }) =>
      done({ value: `${input.value}-done` }),
    );
    const workerStepB = step({ id: "array-invocation-worker-b" }).do((input: { value: string }) =>
      done({ value: `${input.value}-done` }),
    );
    const WorkerWorkflowA = defineWorkflow<{ value: string }, { value: string }>({
      id: "array-invocation-worker-workflow-a",
      inputShape: { value: "string" },
      outputShape: { value: "string" },
      start(input) {
        return workerStepA(input);
      },
    });
    const WorkerWorkflowB = defineWorkflow<{ value: string }, { value: string }>({
      id: "array-invocation-worker-workflow-b",
      inputShape: { value: "string" },
      outputShape: { value: "string" },
      start(input) {
        return workerStepB(input);
      },
    });
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "array-invocation-parent-workflow",
      start() {
        return [WorkerWorkflowA({ value: "a" }), WorkerWorkflowB({ value: "b" })];
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "array-invocations",
      cwd,
      eventSink(event) {
        if (event.type === "step.started") {
          const branchId = String(event.payload.branchId);
          const observed = branchStepsByValue.get(branchId) ?? [];
          observed.push(event.stepId ?? "");
          branchStepsByValue.set(branchId, observed);
        }
      },
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
    expect(Object.values(result.output.branches ?? {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "done", output: { value: "a-done" } }),
        expect.objectContaining({ status: "done", output: { value: "b-done" } }),
      ]),
    );

    expect(branchStepsByValue.size).toBe(2);
    for (const stepIds of branchStepsByValue.values()) {
      expect(stepIds).toHaveLength(1);
    }
  });

  it("persists requested branch identifiers for array candidates", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-array-requested-branches-"));
    const stepEvents: Event[] = [];

    const workerStep = step({ id: "requested-branch-worker-step" }).do((input: { value: string }) =>
      done({ value: input.value }),
    );
    const WorkerWorkflow = defineWorkflow<{ value: string }, { value: string }>({
      id: "requested-branch-worker-workflow",
      inputShape: { value: "string" },
      outputShape: { value: "string" },
      start(input) {
        return workerStep(input);
      },
    });
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "requested-branch-parent-workflow",
      start() {
        return [
          WorkerWorkflow({ value: "a" }, { branch: "human-readable-a" }),
          WorkerWorkflow({ value: "b" }, { branch: "human-readable-b" }),
          WorkerWorkflow({ value: "duplicate" }, { branch: "human-readable-a" }),
        ];
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "array-requested-branches",
      cwd,
      eventSink(event) {
        if (event.type === "step.started" || event.type === "step.completed") {
          stepEvents.push(event);
        }
      },
      scheduler: { workers: 2 },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    const track = await readJsonObject(join(result.runDir, "track.json"));
    const branchIds = track.branches as readonly string[];
    expect(new Set(branchIds).size).toBe(branchIds.length);

    const requestedByBranch = new Map<string, unknown>();
    for (const branchId of branchIds) {
      const branch = await readJsonObject(join(result.runDir, "branches", `${branchId}.json`));
      requestedByBranch.set(branchId, branch.requestedBranchId);
    }
    expect([...requestedByBranch.values()]).toEqual(
      expect.arrayContaining(["human-readable-a", "human-readable-b", "human-readable-a"]),
    );

    expect(stepEvents).toHaveLength(6);
    for (const event of stepEvents) {
      const branchId = String(event.payload.branchId);
      expect(event.payload).toMatchObject({
        branchId,
        requestedBranchId: requestedByBranch.get(branchId),
      });
    }
  });

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
