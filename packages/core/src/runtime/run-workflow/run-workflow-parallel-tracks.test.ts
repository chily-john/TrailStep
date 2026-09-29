import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import * as Core from "../../index.js";
import {
  absoluteDone,
  absoluteFail,
  defineWorkflow,
  done,
  type Event,
  fail,
  type PlainObject,
  parallel,
  runWorkflow,
  state,
  step,
  type Workflow,
} from "../../index.js";

function readJsonObject(path: string): Promise<Record<string, unknown>> {
  return readFile(path, "utf8").then((contents) => JSON.parse(contents) as Record<string, unknown>);
}

async function readJsonLines(path: string): Promise<readonly Record<string, unknown>[]> {
  const contents = await readFile(path, "utf8");
  return contents
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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

function expectDefinedValue<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  if (value === undefined) {
    throw new Error("Expected value to be defined.");
  }
  return value;
}

function resolveStartedGate(
  starts: readonly string[],
  gates: ReadonlyMap<string, Deferred>,
  index: number,
): void {
  gates.get(expectDefinedValue(starts[index]))?.resolve();
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

  it("routes invocation post on the same branch", async () => {
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
      ChildWorkflow(input).post((output) => {
        observedOutputs.push(output);
        return followUpStep(output);
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

  it("runs workflow invocation post after invoked workflow parallel branches join", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-invocation-post-child-parallel-"));
    const observed: string[] = [];

    const branchStep = step({ id: "child-parallel-post-branch" }).do(
      (input: { readonly branch: string; readonly value: number }) => {
        observed.push(input.branch);
        return done({ value: input.value });
      },
    );
    const childFinalizeStep = step({ id: "child-parallel-post-finalize" }).do(
      (input: {
        readonly status: string;
        readonly branches: Record<string, { readonly value: number }>;
      }) => {
        observed.push(`child-post:${Object.keys(input.branches).length}`);
        return done({
          total: Object.values(input.branches).reduce((sum, output) => sum + output.value, 0),
        });
      },
    );
    const parentFinalizeStep = step({ id: "parent-post-after-child-parallel-post" }).do(
      (input: { readonly total: number }) => {
        observed.push(`parent-post:${input.total}`);
        return done({ doubled: input.total * 2 });
      },
    );
    const ChildWorkflow = defineWorkflow<Record<string, never>, PlainObject>({
      id: "child-parallel-post-child-workflow",
      start() {
        return parallel<{ readonly status: string; readonly branches: PlainObject }>([
          branchStep({ branch: "a", value: 2 }),
          branchStep({ branch: "b", value: 3 }),
        ]).post((output) =>
          childFinalizeStep(
            output as {
              readonly status: string;
              readonly branches: Record<string, { value: number }>;
            },
          ),
        );
      },
    });
    const parentStep = step({ id: "child-parallel-post-parent-step" }).do(() =>
      ChildWorkflow({}).post((output) => parentFinalizeStep(output as { readonly total: number })),
    );
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "child-parallel-post-parent-workflow",
      start() {
        return parentStep();
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "invocation-post-child-parallel",
      cwd,
      scheduler: { workers: 2 },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ doubled: 10 });
    expect(observed).toEqual(expect.arrayContaining(["a", "b", "child-post:2", "parent-post:5"]));
  });

  it("preserves parent invocation post when a nested child parallel post joins", async () => {
    const cwd = await mkdtemp(
      join(tmpdir(), "trailstep-core-nested-invocation-post-child-parallel-"),
    );
    const observed: string[] = [];

    const branchStep = step({ id: "nested-child-parallel-branch" }).do(
      (input: { readonly value: number }) => done({ value: input.value }),
    );
    const childPostStep = step({ id: "nested-child-post" }).do(
      (input: {
        readonly status: string;
        readonly branches: Record<string, { value: number }>;
      }) => {
        observed.push("child-post");
        return done({
          total: Object.values(input.branches).reduce((sum, item) => sum + item.value, 0),
        });
      },
    );
    const parentPostStep = step({ id: "nested-parent-post" }).do(
      (input: { readonly total: number }) => {
        observed.push("parent-post");
        return done({ total: input.total + 1 });
      },
    );
    const ChildWorkflow = defineWorkflow<Record<string, never>, PlainObject>({
      id: "nested-post-child-workflow",
      start() {
        return parallel<{ readonly status: string; readonly branches: PlainObject }>([
          branchStep({ value: 2 }),
          branchStep({ value: 3 }),
        ]).post((output) =>
          childPostStep(
            output as {
              readonly status: string;
              readonly branches: Record<string, { value: number }>;
            },
          ),
        );
      },
    });
    const ParentWorkflow = defineWorkflow<Record<string, never>, PlainObject>({
      id: "nested-post-parent-workflow",
      start() {
        return ChildWorkflow({}).post((output) => parentPostStep(output as { total: number }));
      },
    });
    const grandparentStep = step({ id: "nested-grandparent-step" }).do(() => ParentWorkflow({}));
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "nested-post-grandparent-workflow",
      start() {
        return grandparentStep();
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "nested-invocation-post-child-parallel",
      cwd,
      scheduler: { workers: 2 },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ total: 6 });
    expect(observed).toEqual(["child-post", "parent-post"]);
  });

  it("schedules an post continuation array after same-branch workflow invocation", async () => {
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
      ChildWorkflow(input).post((output) => {
        observed.push(`post:${output.value}`);
        return [branchA(), branchB()];
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
      await expect.poll(() => observed).toEqual(["child", "post:41", "a"]);
      await delay(25);
      expect(observed).toEqual(["child", "post:41", "a"]);
      gates.get("a")?.resolve();
      await expect.poll(() => observed).toEqual(["child", "post:41", "a", "b"]);
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
    expect(branchIds).toEqual([
      "root",
      "root",
      "on-done-array-branch-a-1",
      "on-done-array-branch-b-1",
    ]);
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
    expect(track).toMatchObject({
      splitOccurred: true,
      branches: ["root", "on-done-array-branch-a-1", "on-done-array-branch-b-1"],
    });
    const rootBranch = await readJsonObject(join(result.runDir, "branches", "root.json"));
    expect(rootBranch).toMatchObject({
      branchId: "root",
      status: "split",
      splitSource: "post for workflow invocation on-done-array-child-workflow",
      latestStepId: "on-done-array-child-step",
    });
    for (const branchId of ["on-done-array-branch-a-1", "on-done-array-branch-b-1"]) {
      const branch = await readJsonObject(join(result.runDir, "branches", `${branchId}.json`));
      expect(branch).toMatchObject({
        branchId,
        parentBranchId: "root",
        source: "post for workflow invocation on-done-array-child-workflow",
        status: "done",
      });
    }

    const stepDirs = await readdir(join(result.runDir, "steps"));
    expect(stepDirs).toEqual(expect.arrayContaining(["0002-on-done-array-child-step"]));
    expect(stepDirs).toContainEqual(expect.stringMatching(/^000[34]-on-done-array-branch-a$/));
    expect(stepDirs).toContainEqual(expect.stringMatching(/^000[34]-on-done-array-branch-b$/));
    expect(new Set(stepDirs).size).toBe(stepDirs.length);
  });

  it("terminalizes the same branch when invocation post returns done", async () => {
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
      ChildWorkflow(input).post((output) => {
        observedOutputs.push(output);
        return done({ value: output.value + 1 });
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
          resolveStartedGate(starts, gates, 0);

          await expect.poll(() => starts.length).toBe(2);
          await delay(25);
          expect(starts).toHaveLength(2);
          resolveStartedGate(starts, gates, 1);

          await expect.poll(() => starts.length).toBe(3);
          await delay(25);
          expect(starts).toHaveLength(3);
          resolveStartedGate(starts, gates, 2);
        } else {
          await expect.poll(() => starts.length).toBe(2);
          resolveStartedGate(starts, gates, 0);
          resolveStartedGate(starts, gates, 1);
          await expect.poll(() => starts.length).toBe(3);
          resolveStartedGate(starts, gates, 2);
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
      terminalKind: "failure",
      terminalBranchId: expect.any(String),
      failure: { code: "branch_failed", message: "branch failed intentionally" },
    });
    const branchIds = track.branches as readonly string[];
    const branches = await Promise.all(
      branchIds.map((branchId) =>
        readJsonObject(join(result.runDir, "branches", `${branchId}.json`)),
      ),
    );
    expect(branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "done", output: { branch: "completed" } }),
        expect.objectContaining({
          branchId: track.terminalBranchId,
          status: "failed",
          failure: { code: "branch_failed", message: "branch failed intentionally" },
        }),
        expect.objectContaining({ status: "cancelled", latestStepIndex: 0 }),
      ]),
    );
  });

  it("absoluteDone completes the whole track and cancels queued siblings", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-absolute-done-"));
    const observed: string[] = [];

    const winningBranch = step({ id: "absolute-done-winner" }).do(() => {
      observed.push("winner");
      return absoluteDone({ value: "winner" });
    });
    const queuedBranch = step({ id: "absolute-done-queued" }).do(() => {
      observed.push("queued");
      return done({ value: "queued" });
    });
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "absolute-done-workflow",
      start() {
        return [winningBranch(), queuedBranch()];
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "absolute-done-track-terminal",
      cwd,
      scheduler: { workers: 1 },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ value: "winner" });
    expect(observed).toEqual(["winner"]);

    const track = await readJsonObject(join(result.runDir, "track.json"));
    expect(track).toMatchObject({
      status: "completed",
      terminalKind: "absoluteDone",
      terminalBranchId: expect.any(String),
      terminalOutput: { value: "winner" },
    });
    const branchIds = track.branches as readonly string[];
    const branches = await Promise.all(
      branchIds.map((branchId) =>
        readJsonObject(join(result.runDir, "branches", `${branchId}.json`)),
      ),
    );
    expect(branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "done",
          output: { value: "winner" },
          terminalKind: "absoluteDone",
        }),
        expect.objectContaining({ status: "cancelled", latestStepIndex: 0 }),
      ]),
    );
  });

  it("absoluteFail fails the whole track and cancels queued siblings", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-absolute-fail-"));
    const observed: string[] = [];
    const failure = { code: "absolute_failed", message: "absolute failure" };

    const failingBranch = step({ id: "absolute-fail-loser" }).do(() => {
      observed.push("loser");
      return absoluteFail(failure);
    });
    const queuedBranch = step({ id: "absolute-fail-queued" }).do(() => {
      observed.push("queued");
      return done({ value: "queued" });
    });
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "absolute-fail-workflow",
      start() {
        return [failingBranch(), queuedBranch()];
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "absolute-fail-track-terminal",
      cwd,
      scheduler: { workers: 1 },
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("expected absoluteFail run to fail");
    }
    expect(result.failure).toMatchObject(failure);
    expect(observed).toEqual(["loser"]);

    const track = await readJsonObject(join(result.runDir, "track.json"));
    expect(track).toMatchObject({
      status: "failed",
      failure,
      terminalKind: "absoluteFail",
      terminalBranchId: expect.any(String),
    });
    const branchIds = track.branches as readonly string[];
    const branches = await Promise.all(
      branchIds.map((branchId) =>
        readJsonObject(join(result.runDir, "branches", `${branchId}.json`)),
      ),
    );
    expect(branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "failed", failure, terminalKind: "absoluteFail" }),
        expect.objectContaining({ status: "cancelled", latestStepIndex: 0 }),
      ]),
    );
  });

  it("concurrent fail-fast prevents a running sibling from queuing split children", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-concurrent-fail-fast-"));
    const failGate = createDeferred();
    const splitGate = createDeferred();
    const observed: string[] = [];

    const failingBranch = step({ id: "concurrent-fail-fast-failing" }).do(async () => {
      observed.push("failing-start");
      await failGate.promise;
      observed.push("failing-done");
      return fail({ code: "concurrent_branch_failed", message: "concurrent failure" });
    });
    const splitChildA = step({ id: "concurrent-fail-fast-child-a" }).do(() => {
      observed.push("child-a");
      return done({ branch: "child-a" });
    });
    const splitChildB = step({ id: "concurrent-fail-fast-child-b" }).do(() => {
      observed.push("child-b");
      return done({ branch: "child-b" });
    });
    const splittingBranch = step({ id: "concurrent-fail-fast-splitter" }).do(async () => {
      observed.push("splitter-start");
      await splitGate.promise;
      observed.push("splitter-done");
      return [splitChildA(), splitChildB()];
    });
    const queuedBranch = step({ id: "concurrent-fail-fast-queued" }).do(() => {
      observed.push("queued");
      return done({ branch: "queued" });
    });
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "concurrent-branch-fail-fast-workflow",
      start() {
        return [failingBranch(), splittingBranch(), queuedBranch()];
      },
    };

    const run = runWorkflow({
      workflow,
      input: {},
      runName: "concurrent-branch-fail-fast",
      cwd,
      scheduler: { workers: 2 },
    });

    try {
      await expect
        .poll(() => observed)
        .toEqual(expect.arrayContaining(["failing-start", "splitter-start"]));
      failGate.resolve();
      await expect
        .poll(async () => {
          const queued = await readJsonObject(
            join(
              cwd,
              ".trailstep",
              "runs",
              "concurrent-branch-fail-fast",
              "branches",
              "concurrent-fail-fast-queued-1.json",
            ),
          );
          return queued.status;
        })
        .toBe("cancelled");
      splitGate.resolve();
    } catch (error) {
      failGate.resolve();
      splitGate.resolve();
      await run.catch(() => undefined);
      throw error;
    }

    const result = await run;
    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("expected fail-fast run to fail");
    }
    expect(result.failure).toMatchObject({
      code: "concurrent_branch_failed",
      message: "concurrent failure",
    });
    expect(observed).not.toEqual(expect.arrayContaining(["child-a", "child-b", "queued"]));

    const track = await readJsonObject(join(result.runDir, "track.json"));
    expect(track).toMatchObject({
      status: "failed",
      terminalKind: "failure",
      terminalBranchId: expect.any(String),
      failure: { code: "concurrent_branch_failed", message: "concurrent failure" },
    });
    const branchIds = track.branches as readonly string[];
    const branches = await Promise.all(
      branchIds.map((branchId) =>
        readJsonObject(join(result.runDir, "branches", `${branchId}.json`)),
      ),
    );
    expect(branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          failure: { code: "concurrent_branch_failed", message: "concurrent failure" },
        }),
      ]),
    );
    expect(branches.every((branch) => branch.status !== "queued")).toBe(true);
    expect(
      branches.filter((branch) => branch.status === "cancelled").length,
    ).toBeGreaterThanOrEqual(2);
    expect(branches).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "step concurrent-fail-fast-splitter" }),
      ]),
    );
  });

  it("manual retry preserves completed sibling branches and retries the failed branch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-parallel-retry-preserve-sibling-"));
    const globalState = (
      Core as unknown as {
        readonly globalState?: {
          get<T>(key: string): Promise<T | undefined>;
          update<T>(key: string, updater: (current: T | undefined) => T | Promise<T>): Promise<T>;
        };
      }
    ).globalState;
    const sideEffects: string[] = [];
    let shouldFailBranchB = true;

    const branchAStep = step({ id: "retry-preserved-branch-a" }).do(async () => {
      expect(globalState).toBeDefined();
      sideEffects.push("branch-a-dispatched");
      await state.set("branch-local", "a-only");
      const sharedLog = await expectDefinedValue(globalState).update<readonly string[]>(
        "shared-log",
        (current) => [...(current ?? []), "a"],
      );
      return done({ branch: "a", branchLocal: await state.get<string>("branch-local"), sharedLog });
    });
    const branchBStep = step({ id: "retry-failed-branch-b" }).do(async () => {
      expect(globalState).toBeDefined();
      sideEffects.push("branch-b-dispatched");
      if (shouldFailBranchB) {
        return fail({ code: "branch_b_failed", message: "branch B failed on first attempt" });
      }
      await state.set("branch-local", "b-only");
      const sharedLogBefore =
        await expectDefinedValue(globalState).get<readonly string[]>("shared-log");
      const sharedLogAfter = await expectDefinedValue(globalState).update<readonly string[]>(
        "shared-log",
        (current) => [...(current ?? []), "b"],
      );
      return done({
        branch: "b",
        branchLocal: await state.get<string>("branch-local"),
        sharedLogBefore,
        sharedLogAfter,
      });
    });
    const BranchAWorkflow = defineWorkflow<Record<string, never>, PlainObject>({
      id: "retry-preserved-branch-a-workflow",
      start() {
        return branchAStep({});
      },
    });
    const BranchBWorkflow = defineWorkflow<Record<string, never>, PlainObject>({
      id: "retry-failed-branch-b-workflow",
      start() {
        return branchBStep({});
      },
    });
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "parallel-retry-preserve-sibling-workflow",
      start() {
        return [
          BranchAWorkflow({}, { branchId: "preserved-a" }),
          BranchBWorkflow({}, { branchId: "retried-b" }),
        ];
      },
    };

    const failed = await runWorkflow({
      workflow,
      input: {},
      runName: "parallel-retry-preserve-sibling",
      cwd,
      scheduler: { workers: 1 },
    });

    expect(failed.status).toBe("failure");
    expect(sideEffects).toEqual(["branch-a-dispatched", "branch-b-dispatched"]);
    const failedTrack = await readJsonObject(join(failed.runDir, "track.json"));
    const failedBranches = await Promise.all(
      (failedTrack.branches as readonly string[]).map((branchId) =>
        readJsonObject(join(failed.runDir, "branches", `${branchId}.json`)),
      ),
    );
    expect(failedBranches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestedBranchId: "preserved-a",
          status: "done",
          output: expect.objectContaining({ branch: "a", branchLocal: "a-only" }),
        }),
        expect.objectContaining({
          requestedBranchId: "retried-b",
          status: "failed",
          failure: { code: "branch_b_failed", message: "branch B failed on first attempt" },
        }),
      ]),
    );

    shouldFailBranchB = false;
    const retried = await runWorkflow({
      workflow,
      retry: { runDir: failed.runDir, kind: "manual" },
      cwd,
      scheduler: { workers: 1 },
    });

    expect(retried.status).toBe("success");
    if (retried.status !== "success") {
      throw new Error(retried.failure.message);
    }
    expect(sideEffects.filter((effect) => effect === "branch-a-dispatched")).toHaveLength(1);
    expect(sideEffects.filter((effect) => effect === "branch-b-dispatched")).toHaveLength(2);
    expect(Object.values(retried.output.branches ?? {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "done",
          output: expect.objectContaining({ branch: "a", branchLocal: "a-only" }),
        }),
        expect.objectContaining({
          status: "done",
          output: expect.objectContaining({
            branch: "b",
            branchLocal: "b-only",
            sharedLogBefore: ["a"],
            sharedLogAfter: ["a", "b"],
          }),
        }),
      ]),
    );

    const retriedTrack = await readJsonObject(join(retried.runDir, "track.json"));
    expect(retriedTrack).toMatchObject({ status: "completed", splitOccurred: true });
    const retriedBranches = await Promise.all(
      (retriedTrack.branches as readonly string[]).map((branchId) =>
        readJsonObject(join(retried.runDir, "branches", `${branchId}.json`)),
      ),
    );
    expect(retriedBranches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestedBranchId: "preserved-a",
          status: "done",
          output: expect.objectContaining({ branch: "a", branchLocal: "a-only" }),
        }),
        expect.objectContaining({
          requestedBranchId: "retried-b",
          status: "done",
          output: expect.objectContaining({ branch: "b", branchLocal: "b-only" }),
        }),
      ]),
    );
    await expect(readJsonObject(join(retried.runDir, "global-state.json"))).resolves.toMatchObject({
      "shared-log": ["a", "b"],
    });
  });

  it("manual retry supports a root parallel node without a post join", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-root-parallel-node-retry-"));
    const observed: string[] = [];
    let failBranchB = true;

    const branchAStep = step({ id: "root-parallel-node-retry-a" }).do(() => {
      observed.push("a");
      return done({ branch: "a" });
    });
    const branchBStep = step({ id: "root-parallel-node-retry-b" }).do(() => {
      observed.push("b");
      return failBranchB
        ? fail({ code: "root_parallel_b_failed", message: "root parallel B failed" })
        : done({ branch: "b" });
    });
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "root-parallel-node-retry-workflow",
      start() {
        return parallel([branchAStep(), branchBStep()]);
      },
    };

    const failed = await runWorkflow({
      workflow,
      input: {},
      runName: "root-parallel-node-retry",
      cwd,
      scheduler: { workers: 1 },
    });
    expect(failed.status).toBe("failure");
    expect(observed).toEqual(["a", "b"]);

    failBranchB = false;
    const retried = await runWorkflow({
      workflow,
      retry: { runDir: failed.runDir, kind: "manual" },
      cwd,
      scheduler: { workers: 1 },
    });

    expect(retried.status).toBe("success");
    if (retried.status !== "success") {
      throw new Error(retried.failure.message);
    }
    expect(observed).toEqual(["a", "b", "b"]);
    expect(Object.values(retried.output.branches ?? {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "done", output: { branch: "a" } }),
        expect.objectContaining({ status: "done", output: { branch: "b" } }),
      ]),
    );
  });

  it("rejects retry for root parallel post joins with a clear unsupported error", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-root-parallel-post-retry-"));
    let failBranchB = true;

    const branchAStep = step({ id: "root-parallel-post-retry-a" }).do(() => done({ branch: "a" }));
    const branchBStep = step({ id: "root-parallel-post-retry-b" }).do(() =>
      failBranchB
        ? fail({ code: "root_parallel_post_b_failed", message: "root parallel post B failed" })
        : done({ branch: "b" }),
    );
    const postStep = step({ id: "root-parallel-post-retry-post" }).do((input: PlainObject) =>
      done(input),
    );
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "root-parallel-post-retry-workflow",
      start() {
        return parallel([branchAStep(), branchBStep()]).post(postStep);
      },
    };

    const failed = await runWorkflow({
      workflow,
      input: {},
      runName: "root-parallel-post-retry",
      cwd,
      scheduler: { workers: 1 },
    });
    expect(failed.status).toBe("failure");

    failBranchB = false;
    const retried = await runWorkflow({
      workflow,
      retry: { runDir: failed.runDir, kind: "manual" },
      cwd,
      scheduler: { workers: 1 },
    });

    expect(retried.status).toBe("failure");
    if (retried.status !== "failure") {
      throw new Error("expected root parallel post retry to fail");
    }
    expect(retried.failure).toMatchObject({
      code: "retry_parallel_post_join_unsupported",
      message: expect.stringContaining("parallel .post joins is not yet supported"),
    });
  });

  it("failed-only track retry retries failed branches while preserving completed and cancelled siblings", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-parallel-retry-failed-only-"));
    const sideEffects: string[] = [];
    let shouldFailBranchB = true;

    const branchAStep = step({ id: "retry-failed-only-preserved-a" }).do(() => {
      sideEffects.push("branch-a-dispatched");
      return done({ branch: "a" });
    });
    const branchBStep = step({ id: "retry-failed-only-failed-b" }).do(() => {
      sideEffects.push("branch-b-dispatched");
      if (shouldFailBranchB) {
        return fail({
          code: "branch_b_failed",
          message: "branch B failed before failed-only retry",
        });
      }
      return done({ branch: "b" });
    });
    const branchCStep = step({ id: "retry-failed-only-cancelled-c" }).do(() => {
      sideEffects.push("branch-c-dispatched");
      return done({ branch: "c" });
    });
    const BranchAWorkflow = defineWorkflow<Record<string, never>, PlainObject>({
      id: "retry-failed-only-preserved-a-workflow",
      start() {
        return branchAStep({});
      },
    });
    const BranchBWorkflow = defineWorkflow<Record<string, never>, PlainObject>({
      id: "retry-failed-only-failed-b-workflow",
      start() {
        return branchBStep({});
      },
    });
    const BranchCWorkflow = defineWorkflow<Record<string, never>, PlainObject>({
      id: "retry-failed-only-cancelled-c-workflow",
      start() {
        return branchCStep({});
      },
    });
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "parallel-retry-failed-only-workflow",
      start() {
        return [
          BranchAWorkflow({}, { branchId: "preserved-a" }),
          BranchBWorkflow({}, { branchId: "retried-b" }),
          BranchCWorkflow({}, { branchId: "retried-c" }),
        ];
      },
    };

    const failed = await runWorkflow({
      workflow,
      input: {},
      runName: "parallel-retry-failed-only",
      cwd,
      scheduler: { workers: 1 },
    });

    expect(failed.status).toBe("failure");
    expect(sideEffects).toEqual(["branch-a-dispatched", "branch-b-dispatched"]);

    shouldFailBranchB = false;
    const retried = await runWorkflow({
      workflow,
      retry: { runDir: failed.runDir, kind: "manual", track: { mode: "failed-only" } },
      cwd,
      scheduler: { workers: 1 },
    } as never);

    expect(retried.status).toBe("success");
    if (retried.status !== "success") {
      throw new Error(retried.failure.message);
    }
    expect(sideEffects).toEqual([
      "branch-a-dispatched",
      "branch-b-dispatched",
      "branch-b-dispatched",
    ]);
    expect(Object.values(retried.output.branches ?? {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "done",
          output: expect.objectContaining({ branch: "a" }),
        }),
        expect.objectContaining({
          status: "done",
          output: expect.objectContaining({ branch: "b" }),
        }),
        expect.objectContaining({
          status: "cancelled",
          output: {},
        }),
      ]),
    );
  });

  it("branch-specific track retry dispatches only the selected persisted branch id", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-parallel-retry-branch-id-"));
    const sideEffects: string[] = [];
    let allowBranchB = false;

    const branchAStep = step({ id: "retry-branch-id-failed-a" }).do(() => {
      sideEffects.push("branch-a-dispatched");
      return fail({ code: "branch_a_failed", message: "branch A should not rerun" });
    });
    const branchBStep = step({ id: "retry-branch-id-failed-b" }).do(() => {
      sideEffects.push("branch-b-dispatched");
      if (!allowBranchB) {
        return fail({ code: "branch_b_failed", message: "branch B failed before targeted retry" });
      }
      return done({ branch: "b" });
    });
    const BranchAWorkflow = defineWorkflow<Record<string, never>, PlainObject>({
      id: "retry-branch-id-failed-a-workflow",
      start() {
        return branchAStep({});
      },
    });
    const BranchBWorkflow = defineWorkflow<Record<string, never>, PlainObject>({
      id: "retry-branch-id-failed-b-workflow",
      start() {
        return branchBStep({});
      },
    });
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "parallel-retry-branch-id-workflow",
      start() {
        return [
          BranchAWorkflow({}, { branchId: "target-a" }),
          BranchBWorkflow({}, { branchId: "target-b" }),
        ];
      },
    };

    const failed = await runWorkflow({
      workflow,
      input: {},
      runName: "parallel-retry-branch-id",
      cwd,
      scheduler: { workers: 2 },
    });

    expect(failed.status).toBe("failure");
    const failedTrack = await readJsonObject(join(failed.runDir, "track.json"));
    const failedBranches = await Promise.all(
      (failedTrack.branches as readonly string[]).map((branchId) =>
        readJsonObject(join(failed.runDir, "branches", `${branchId}.json`)),
      ),
    );
    const targetBranch = failedBranches.find((branch) => branch.requestedBranchId === "target-b");
    expect(targetBranch?.branchId).toEqual(expect.any(String));
    const sideEffectsBeforeRetry = [...sideEffects];

    allowBranchB = true;
    const retried = await runWorkflow({
      workflow,
      retry: {
        runDir: failed.runDir,
        kind: "manual",
        track: { mode: "branch", branchId: targetBranch?.branchId },
      },
      cwd,
      scheduler: { workers: 2 },
    } as never);

    expect(retried.status).toBe("success");
    expect(sideEffects.slice(0, sideEffectsBeforeRetry.length)).toEqual(sideEffectsBeforeRetry);
    expect(sideEffects.slice(sideEffectsBeforeRetry.length)).toEqual(["branch-b-dispatched"]);
  });

  it("branch-specific track retry rejects an unknown persisted branch id", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-parallel-retry-missing-branch-id-"));
    const sideEffects: string[] = [];

    const branchStep = step({ id: "retry-missing-branch-id-failed" }).do(() => {
      sideEffects.push("branch-dispatched");
      return fail({ code: "branch_failed", message: "branch failed before missing-id retry" });
    });
    const BranchWorkflow = defineWorkflow<Record<string, never>, PlainObject>({
      id: "retry-missing-branch-id-workflow",
      start() {
        return branchStep({});
      },
    });
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "parallel-retry-missing-branch-id-workflow",
      start() {
        return [BranchWorkflow({}, { branchId: "target" })];
      },
    };

    const failed = await runWorkflow({
      workflow,
      input: {},
      runName: "parallel-retry-missing-branch-id",
      cwd,
    });

    expect(failed.status).toBe("failure");
    const retried = await runWorkflow({
      workflow,
      retry: {
        runDir: failed.runDir,
        kind: "manual",
        track: { mode: "branch", branchId: "branch-does-not-exist" },
      },
      cwd,
    } as never);

    expect(retried.status).toBe("failure");
    if (retried.status !== "failure") {
      throw new Error("Expected unknown branch retry to fail.");
    }
    expect(retried.failure).toMatchObject({
      code: "retry_track_branch_not_found",
      message: expect.stringContaining("branch-does-not-exist"),
    });
    expect(sideEffects).toEqual(["branch-dispatched"]);
  });

  it("thrown branch errors trigger fail-fast and persist branch failure", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-thrown-fail-fast-"));
    const observed: string[] = [];

    const throwingBranch = step({ id: "thrown-fail-fast-throwing" }).do(() => {
      observed.push("throwing");
      throw new Error("branch exploded");
    });
    const queuedBranch = step({ id: "thrown-fail-fast-queued" }).do(() => {
      observed.push("queued");
      return done({ branch: "queued" });
    });
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "thrown-branch-fail-fast-workflow",
      start() {
        return [throwingBranch(), queuedBranch()];
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "thrown-branch-fail-fast",
      cwd,
      scheduler: { workers: 1 },
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("expected thrown branch error to fail the track");
    }
    expect(result.failure.message).toContain("branch exploded");
    expect(observed).toEqual(["throwing"]);

    const track = await readJsonObject(join(result.runDir, "track.json"));
    expect(track).toMatchObject({
      status: "failed",
      terminalKind: "failure",
      terminalBranchId: expect.any(String),
      failure: expect.objectContaining({ message: expect.stringContaining("branch exploded") }),
    });
    const branchIds = track.branches as readonly string[];
    const branches = await Promise.all(
      branchIds.map((branchId) =>
        readJsonObject(join(result.runDir, "branches", `${branchId}.json`)),
      ),
    );
    expect(branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          failure: expect.objectContaining({ message: expect.stringContaining("branch exploded") }),
        }),
        expect.objectContaining({ status: "cancelled", latestStepIndex: 0 }),
      ]),
    );
  });

  it.each([
    ["done", () => done({ value: "not-runnable" })],
    ["fail", () => fail({ code: "not_runnable", message: "not runnable" })],
    ["malformed", () => ({ nope: true }) as never],
  ])(
    "rejects arrays containing non-runnable candidates clearly (%s)",
    async (_label, makeCandidate) => {
      const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-invalid-array-candidate-"));
      const runnable = step({ id: "valid-array-candidate" }).do(() => done({ value: "ok" }));
      const workflow: Workflow<Record<string, never>, PlainObject> = {
        id: "invalid-array-candidate-workflow",
        start() {
          return [runnable(), makeCandidate()] as never;
        },
      };

      const result = await runWorkflow({
        workflow,
        input: {},
        runName: `invalid-array-candidate-${_label}`,
        cwd,
        scheduler: { workers: 2 },
      });

      expect(result.status).toBe("failure");
      if (result.status !== "failure") {
        throw new Error("expected invalid array candidate to fail");
      }
      expect(result.failure).toMatchObject({
        code: "invalid_continuation",
        message: expect.stringContaining("array candidates must be runnable"),
      });
    },
  );

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

  it("runs parallel post after all branches finish with aggregate output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-parallel-post-"));
    const observed: string[] = [];
    const branchStep = step({ id: "parallel-post-branch" }).do(
      (input: { readonly branch: string; readonly value: number }) => {
        observed.push(input.branch);
        return done({ value: input.value });
      },
    );
    const finalizeStep = step({ id: "parallel-post-finalize" }).do(
      (input: {
        readonly status: string;
        readonly branches: Record<string, { value: number }>;
      }) => {
        observed.push(`post:${Object.keys(input.branches).length}`);
        return done({
          total: Object.values(input.branches).reduce((sum, output) => sum + output.value, 0),
        });
      },
    );
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "parallel-post-workflow",
      start() {
        return parallel<{
          readonly status: string;
          readonly branches: Record<string, { value: number }>;
        }>([branchStep({ branch: "a", value: 2 }), branchStep({ branch: "b", value: 3 })]).post(
          (output) => finalizeStep(output),
        );
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "parallel-post",
      cwd,
      scheduler: { workers: 2 },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ total: 5 });
    expect(observed).toEqual(expect.arrayContaining(["a", "b", "post:2"]));
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
          WorkerWorkflow({ value: "a" }, { branchId: "human-readable-a" }),
          WorkerWorkflow({ value: "b" }, { branchId: "human-readable-b" }),
          WorkerWorkflow({ value: "c" }, { branchId: "human-readable-c" }),
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
      expect.arrayContaining(["human-readable-a", "human-readable-b", "human-readable-c"]),
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

  it("returns waiting for the track when a parallel branch reaches an external wait", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-parallel-wait-"));
    const observed: string[] = [];

    const waitingStep = step({ id: "parallel-waiting-branch" })
      .wait({
        id: "approval",
        kind: "input",
        message: "Approve parallel branch?",
        output: { approved: "boolean" },
      })
      .do(() => done({ value: "approved" }));
    const queuedSiblingStep = step({ id: "parallel-queued-sibling" }).do(() => {
      observed.push("queued-sibling-ran");
      return done({ value: "sibling" });
    });
    const WaitingWorkflow = defineWorkflow<Record<string, never>, { value: string }>({
      id: "parallel-waiting-workflow",
      outputShape: { value: "string" },
      start() {
        observed.push("waiting-started");
        return waitingStep({});
      },
    });
    const SiblingWorkflow = defineWorkflow<Record<string, never>, { value: string }>({
      id: "parallel-queued-sibling-workflow",
      outputShape: { value: "string" },
      start() {
        return queuedSiblingStep({});
      },
    });
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "parallel-wait-parent-workflow",
      start() {
        return [
          WaitingWorkflow({}, { branchId: "waiting-human-branch" }),
          SiblingWorkflow({}, { branchId: "queued-human-branch" }),
        ];
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "parallel-wait",
      cwd,
      scheduler: { workers: 1 },
    });

    expect(result.status).toBe("waiting");
    if (result.status !== "waiting") {
      throw new Error("expected waiting result");
    }
    expect(result.wait).toMatchObject({
      stepId: "parallel-waiting-branch",
      waitId: "approval",
      message: "Approve parallel branch?",
    });
    expect(observed).toEqual(["waiting-started"]);

    const track = await readJsonObject(join(result.runDir, "track.json"));
    expect(track).toMatchObject({
      status: "waiting",
      terminalKind: "waiting",
      terminalBranchId: expect.any(String),
      splitOccurred: true,
    });

    const branchIds = track.branches as readonly string[];
    const branches = await Promise.all(
      branchIds.map((branchId) =>
        readJsonObject(join(result.runDir, "branches", `${branchId}.json`)),
      ),
    );
    expect(branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestedBranchId: "waiting-human-branch",
          status: "waiting",
          wait: expect.objectContaining({
            stepId: "parallel-waiting-branch",
            waitId: "approval",
            message: "Approve parallel branch?",
          }),
        }),
        expect.objectContaining({
          requestedBranchId: "queued-human-branch",
          status: "cancelled",
          output: {},
        }),
      ]),
    );
  });

  it("rejects continue from a waiting parallel track with a clear unsupported error", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-parallel-wait-continue-"));

    const waitingStep = step({ id: "parallel-wait-continue-branch" })
      .wait({
        id: "approval",
        kind: "input",
        message: "Approve parallel branch continue?",
        output: { approved: "boolean" },
      })
      .do(() => done({ value: "approved" }));
    const siblingStep = step({ id: "parallel-wait-continue-sibling" }).do(() =>
      done({ value: "sibling" }),
    );
    const WaitingWorkflow = defineWorkflow<Record<string, never>, { value: string }>({
      id: "parallel-wait-continue-waiting-workflow",
      outputShape: { value: "string" },
      start() {
        return waitingStep({});
      },
    });
    const SiblingWorkflow = defineWorkflow<Record<string, never>, { value: string }>({
      id: "parallel-wait-continue-sibling-workflow",
      outputShape: { value: "string" },
      start() {
        return siblingStep({});
      },
    });
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "parallel-wait-continue-parent-workflow",
      start() {
        return [
          WaitingWorkflow({}, { branchId: "waiting" }),
          SiblingWorkflow({}, { branchId: "sibling" }),
        ];
      },
    };

    const waiting = await runWorkflow({
      workflow,
      input: {},
      runName: "parallel-wait-continue",
      cwd,
      scheduler: { workers: 1 },
    });

    expect(waiting.status).toBe("waiting");
    const continued = await runWorkflow({ workflow, continue: { runDir: waiting.runDir }, cwd });

    expect(continued.status).toBe("failure");
    if (continued.status !== "failure") {
      throw new Error("expected parallel wait continue to fail");
    }
    expect(continued.failure).toMatchObject({
      code: "continue_parallel_track_unsupported",
      message: expect.stringContaining("Continuing a waiting parallel track is not yet supported"),
    });
  });

  it("persists observable branch and track lifecycle state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-observable-track-state-"));

    const slowStep = step({ id: "observable-slow-branch" }).do(async () => {
      await delay(50);
      return done({ value: "too-late" });
    });
    const failingStep = step({ id: "observable-failing-branch" }).do(() =>
      fail({ code: "observable_branch_failed", message: "observable failure" }),
    );
    const SlowWorkflow = defineWorkflow<Record<string, never>, { value: string }>({
      id: "observable-slow-workflow",
      outputShape: { value: "string" },
      start() {
        return slowStep();
      },
    });
    const FailingWorkflow = defineWorkflow<Record<string, never>, PlainObject>({
      id: "observable-failing-workflow",
      start() {
        return failingStep();
      },
    });
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "observable-parent-workflow",
      start() {
        return [
          SlowWorkflow({}, { branchId: "slow-human-branch" }),
          FailingWorkflow({}, { branchId: "failing-human-branch" }),
        ];
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "observable-track-state",
      cwd,
      scheduler: { workers: 2 },
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("expected failure result");
    }

    const track = await readJsonObject(join(result.runDir, "track.json"));
    expect(track).toMatchObject({
      runId: result.runId,
      status: "failed",
      workers: 2,
      failurePolicy: "fail-fast",
      rootBranchId: "root",
      splitOccurred: true,
      terminalKind: "failure",
      terminalBranchId: expect.any(String),
      failure: { code: "observable_branch_failed", message: "observable failure" },
    });
    expect(track.branches).toEqual(
      expect.arrayContaining([expect.any(String), expect.any(String)]),
    );

    const branchIds = track.branches as readonly string[];
    const branches = await Promise.all(
      branchIds.map((branchId) =>
        readJsonObject(join(result.runDir, "branches", `${branchId}.json`)),
      ),
    );
    expect(branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branchId: expect.any(String),
          parentBranchId: "root",
          requestedBranchId: "failing-human-branch",
          workflowId: "observable-failing-workflow",
          status: "failed",
          latestStepIndex: expect.any(Number),
          failure: { code: "observable_branch_failed", message: "observable failure" },
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        }),
        expect.objectContaining({
          branchId: expect.any(String),
          parentBranchId: "root",
          requestedBranchId: "slow-human-branch",
          workflowId: "observable-slow-workflow",
          status: "cancelled",
          latestStepIndex: expect.any(Number),
          output: {},
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        }),
      ]),
    );
  });

  it("emits branch-aware step metadata without changing event names", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-branch-event-metadata-"));
    const stepEvents: Event[] = [];

    const workerStep = step({ id: "metadata-worker-step" }).do((input: { value: string }) =>
      done({ value: input.value }),
    );
    const WorkerWorkflow = defineWorkflow<{ value: string }, { value: string }>({
      id: "metadata-worker-workflow",
      inputShape: { value: "string" },
      outputShape: { value: "string" },
      start(input) {
        return workerStep(input);
      },
    });
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "metadata-parent-workflow",
      start() {
        return [
          WorkerWorkflow({ value: "a" }, { branchId: "requested-a" }),
          WorkerWorkflow({ value: "b" }, { branchId: "requested-b" }),
        ];
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "branch-event-metadata",
      cwd,
      eventSink(event) {
        if (event.type === "step.started" || event.type === "step.completed") {
          stepEvents.push(event);
        }
      },
      scheduler: { workers: 2 },
    });

    expect(result.status).toBe("success");
    expect(stepEvents.map((event) => event.type).sort()).toEqual([
      "step.completed",
      "step.completed",
      "step.started",
      "step.started",
    ]);
    for (const event of stepEvents) {
      expect(event.payload).toMatchObject({
        trackId: result.runId,
        branchId: expect.any(String),
        requestedBranchId: expect.stringMatching(/^requested-[ab]$/),
        stepIndex: expect.any(Number),
        stepArtifactId: expect.stringMatching(/^000[12]-metadata-worker-step$/),
        stepArtifactPath: expect.stringMatching(/^steps\/000[12]-metadata-worker-step$/),
      });
    }
  });

  it("allocates unique step artifact directories under concurrent branch execution", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-concurrent-artifacts-"));

    const sameIdStepA = step({ id: "concurrent-same-id" }).do(async () => {
      await delay(25);
      return done({ value: "a" });
    });
    const sameIdStepB = step({ id: "concurrent-same-id" }).do(async () => {
      await delay(25);
      return done({ value: "b" });
    });
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "concurrent-artifact-workflow",
      start() {
        return [sameIdStepA(), sameIdStepB()];
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "concurrent-artifacts",
      cwd,
      scheduler: { workers: 2 },
    });

    expect(result.status).toBe("success");
    const stepDirs = await readdir(join(result.runDir, "steps"));
    expect(stepDirs).toEqual(
      expect.arrayContaining(["0001-concurrent-same-id", "0002-concurrent-same-id"]),
    );
    expect(new Set(stepDirs).size).toBe(stepDirs.length);
  });

  it("lets parallel branches atomically claim unique shared items with globalState.update", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-global-state-claims-"));
    const globalState = (
      Core as unknown as {
        readonly globalState?: {
          get<T>(key: string): Promise<T | undefined>;
          set(key: string, value: unknown): Promise<void>;
          update<T>(key: string, updater: (current: T | undefined) => T | Promise<T>): Promise<T>;
        };
      }
    ).globalState;

    type ClaimState = {
      readonly remaining: readonly string[];
      readonly claimed: readonly string[];
    };

    const claimStep = step({ id: "claim-shared-item" }).do(
      async (input: { readonly branch: string }) => {
        expect(globalState).toBeDefined();
        const next = await expectDefinedValue(globalState).update<ClaimState>(
          "claims",
          async (current) => {
            await delay(25);
            const stateValue = current ?? {
              remaining: ["item-1", "item-2", "item-3", "item-4"],
              claimed: [],
            };
            const [claim, ...remaining] = stateValue.remaining;
            expect(claim).toBeDefined();
            return { remaining, claimed: [...stateValue.claimed, expectDefinedValue(claim)] };
          },
        );
        return done({ branch: input.branch, claimed: next.claimed.at(-1) });
      },
    );

    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "global-state-claim-workflow",
      start() {
        return ["a", "b", "c", "d"].map((branch) => claimStep({ branch }));
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "global-state-claims",
      cwd,
      scheduler: { workers: 4 },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    const aggregateBranches = (result.output.branches ?? {}) as Record<
      string,
      { readonly output?: { readonly claimed?: string } }
    >;
    const claimed = Object.values(aggregateBranches).map((branch) => branch.output?.claimed);
    expect(claimed).toHaveLength(4);
    expect(new Set(claimed)).toEqual(new Set(["item-1", "item-2", "item-3", "item-4"]));

    const persisted = (await readJsonObject(join(result.runDir, "global-state.json"))) as {
      readonly claims?: ClaimState;
    };
    expect(persisted.claims?.remaining).toEqual([]);
    expect(persisted.claims?.claimed).toHaveLength(4);
    expect(new Set(persisted.claims?.claimed)).toEqual(
      new Set(["item-1", "item-2", "item-3", "item-4"]),
    );
  });

  it("shares globalState between a parent branch step and a workflow invocation branch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-global-state-invocation-"));
    const globalState = (
      Core as unknown as {
        readonly globalState?: {
          get<T>(key: string): Promise<T | undefined>;
          set(key: string, value: unknown): Promise<void>;
          update<T>(key: string, updater: (current: T | undefined) => T | Promise<T>): Promise<T>;
        };
      }
    ).globalState;

    const childStep = step({ id: "child-global-state-step" }).do(async () => {
      expect(globalState).toBeDefined();
      const sharedLog = await expectDefinedValue(globalState).update<readonly string[]>(
        "shared-log",
        (current) => [...(current ?? []), "child"],
      );
      return done({ childSaw: sharedLog });
    });
    const ChildWorkflow = defineWorkflow<
      Record<string, never>,
      { readonly childSaw: readonly string[] }
    >({
      id: "global-state-child-workflow",
      start() {
        return childStep({});
      },
    });
    const parentReadStep = step({ id: "parent-global-state-read-step" }).do(async () => {
      expect(globalState).toBeDefined();
      return done({
        parentSaw: await expectDefinedValue(globalState).get<readonly string[]>("shared-log"),
      });
    });
    const parentStep = step({ id: "parent-global-state-step" }).do(async () => {
      expect(globalState).toBeDefined();
      await expectDefinedValue(globalState).set("shared-log", ["parent"]);
      return [parentReadStep({}), ChildWorkflow({}, { branchId: "child-invocation" })];
    });
    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "global-state-parent-workflow",
      start() {
        return parentStep({});
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "global-state-invocation",
      cwd,
      scheduler: { workers: 2 },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(await readJsonObject(join(result.runDir, "global-state.json"))).toMatchObject({
      "shared-log": ["parent", "child"],
    });
  });

  it("keeps state branch-local while sibling branches share globalState", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-branch-local-state-"));
    const globalState = (
      Core as unknown as {
        readonly globalState?: {
          get<T>(key: string): Promise<T | undefined>;
          set(key: string, value: unknown): Promise<void>;
          update<T>(key: string, updater: (current: T | undefined) => T | Promise<T>): Promise<T>;
        };
      }
    ).globalState;

    const setAndReadStep = step({ id: "set-and-read-branch-state" }).do(
      async (input: { readonly branch: string }) => {
        expect(globalState).toBeDefined();
        await state.set("branchValue", input.branch);
        const sharedBranches = await expectDefinedValue(globalState).update<readonly string[]>(
          "branches",
          (current) => [...(current ?? []), input.branch],
        );
        await delay(25);
        return done({
          branch: input.branch,
          branchValue: await state.get<string>("branchValue"),
          sharedBranches,
        });
      },
    );

    const workflow: Workflow<Record<string, never>, PlainObject> = {
      id: "branch-local-state-global-state-workflow",
      start() {
        return [setAndReadStep({ branch: "a" }), setAndReadStep({ branch: "b" })];
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "branch-local-state-global-state",
      cwd,
      scheduler: { workers: 2 },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    const aggregateBranches = (result.output.branches ?? {}) as Record<
      string,
      {
        readonly output?: {
          readonly branch?: string;
          readonly branchValue?: string;
          readonly sharedBranches?: readonly string[];
        };
      }
    >;
    const outputs = Object.values(aggregateBranches).map((branch) => branch.output);
    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ branch: "a", branchValue: "a" }),
        expect.objectContaining({ branch: "b", branchValue: "b" }),
      ]),
    );
    expect(new Set(outputs.flatMap((output) => output?.sharedBranches ?? []))).toEqual(
      new Set(["a", "b"]),
    );
  });

  it("proves the main parallel track path end-to-end with artifacts and sequential compatibility", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-parallel-tracer-bullet-"));
    const globalState = Core.globalState;
    type ClaimState = {
      readonly remaining: readonly string[];
      readonly claimed: readonly string[];
    };

    const childStep = step({ id: "tracer-child-step" }).do(
      async (input: { readonly seed: number }) => {
        await globalState.update<readonly string[]>("timeline", (current) => [
          ...(current ?? []),
          `child:${input.seed}`,
        ]);
        return done({ seed: input.seed + 1 });
      },
    );
    const ChildWorkflow = defineWorkflow<{ readonly seed: number }, { readonly seed: number }>({
      id: "tracer-child-workflow",
      inputShape: { seed: "number" },
      outputShape: { seed: "number" },
      start(input) {
        return childStep(input);
      },
    });

    const finalizeStep = step({ id: "tracer-finalize-step" }).do(
      (input: { readonly branch: string; readonly claim: string }) =>
        done({ branch: input.branch, claim: input.claim, finalized: true }),
    );
    const claimStep = step({ id: "tracer-claim-step" }).do(
      async (input: { readonly branch: string; readonly seed: number }) => {
        const claims = await globalState.update<ClaimState>("claims", (current) => {
          const stateValue = current ?? { remaining: ["one", "two"], claimed: [] };
          const [claim, ...remaining] = stateValue.remaining;
          expect(claim).toBeDefined();
          return {
            remaining,
            claimed: [...stateValue.claimed, `${input.branch}:${expectDefinedValue(claim)}`],
          };
        });
        const claim = claims.claimed.at(-1)?.split(":").at(1);
        return done({ branch: input.branch, seed: input.seed, claim });
      },
    );
    const WorkerWorkflow = defineWorkflow<
      { readonly branch: string; readonly seed: number },
      { readonly branch: string; readonly seed: number; readonly claim: string }
    >({
      id: "tracer-worker-workflow",
      inputShape: { branch: "string", seed: "number" },
      outputShape: { branch: "string", seed: "number", claim: "string" },
      start(input) {
        return claimStep(input);
      },
    });

    const rootStep = step({ id: "tracer-root-step" }).do((input: { readonly seed: number }) =>
      ChildWorkflow(input).post((output) => {
        return [
          WorkerWorkflow({ branch: "a", seed: output.seed }, { branchId: "requested-a" }),
          WorkerWorkflow({ branch: "b", seed: output.seed }, { branchId: "requested-b" }).post(
            (workerOutput) => finalizeStep(workerOutput),
          ),
        ];
      }),
    );
    const workflow: Workflow<{ readonly seed: number }, PlainObject> = {
      id: "parallel-tracer-bullet-workflow",
      inputShape: { seed: "number" },
      start(input) {
        return rootStep(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { seed: 1 },
      runName: "parallel-tracer-bullet",
      cwd,
      scheduler: { workers: 2 },
    });

    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.status).toBe("success");
    expect(result.output).toMatchObject({ status: "completed", branches: expect.any(Object) });
    expect(Object.values(result.output.branches ?? {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "done",
          output: expect.objectContaining({
            branch: "a",
            claim: expect.stringMatching(/^(one|two)$/),
          }),
        }),
        expect.objectContaining({
          status: "done",
          output: { branch: "b", claim: expect.stringMatching(/^(one|two)$/), finalized: true },
        }),
      ]),
    );

    const track = await readJsonObject(join(result.runDir, "track.json"));
    expect(track).toMatchObject({
      runId: result.runId,
      status: "completed",
      splitOccurred: true,
      rootBranchId: "root",
      branches: ["root", expect.any(String), expect.any(String)],
    });
    const branchIds = track.branches as readonly string[];
    const branches = await Promise.all(
      branchIds.map((branchId) =>
        readJsonObject(join(result.runDir, "branches", `${branchId}.json`)),
      ),
    );
    expect(branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branchId: "root",
          status: "split",
          latestStepId: "tracer-child-step",
        }),
        expect.objectContaining({ requestedBranchId: "requested-a", status: "done" }),
        expect.objectContaining({ requestedBranchId: "requested-b", status: "done" }),
      ]),
    );

    const startedByBranch = new Map<string, string[]>();
    for (const event of result.events) {
      if (event.type !== "step.started") {
        continue;
      }
      const branchId = String(event.payload.branchId);
      startedByBranch.set(branchId, [...(startedByBranch.get(branchId) ?? []), event.stepId ?? ""]);
    }
    expect(startedByBranch.get("root")).toEqual(["tracer-root-step", "tracer-child-step"]);
    expect([...startedByBranch.values()]).toContainEqual(["tracer-claim-step"]);
    expect([...startedByBranch.values()]).toContainEqual([
      "tracer-claim-step",
      "tracer-finalize-step",
    ]);
    expect(await readJsonLines(join(result.runDir, "events.jsonl"))).toHaveLength(
      result.events.length,
    );
    const persistedGlobalState = (await readJsonObject(
      join(result.runDir, "global-state.json"),
    )) as {
      readonly timeline?: readonly string[];
      readonly claims?: ClaimState;
    };
    expect(persistedGlobalState.timeline).toEqual(["child:1"]);
    expect(persistedGlobalState.claims?.remaining).toEqual([]);
    const persistedClaims = persistedGlobalState.claims?.claimed ?? [];
    expect(new Set(persistedClaims.map((claim) => claim.split(":")[0]))).toEqual(
      new Set(["a", "b"]),
    );
    expect(new Set(persistedClaims.map((claim) => claim.split(":")[1]))).toEqual(
      new Set(["one", "two"]),
    );

    const sequentialFirst = step({ id: "tracer-sequential-first" }).do(
      (input: { readonly value: number }) => done({ value: input.value + 1 }),
    );
    const sequentialWorkflow: Workflow<{ readonly value: number }, { readonly value: number }> = {
      id: "tracer-sequential-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return sequentialFirst(input);
      },
    };
    const sequential = await runWorkflow({
      workflow: sequentialWorkflow,
      input: { value: 41 },
      runName: "parallel-tracer-sequential-regression",
      cwd,
      scheduler: { workers: 2 },
    });
    expect(sequential.status).toBe("success");
    if (sequential.status !== "success") {
      throw new Error(sequential.failure.message);
    }
    expect(sequential.output).toEqual({ value: 42 });
    await expect(readJsonObject(join(sequential.runDir, "track.json"))).resolves.toMatchObject({
      splitOccurred: false,
      branches: ["root"],
    });

    const absoluteDoneStep = step({ id: "tracer-absolute-done" }).do(() =>
      absoluteDone({ terminal: "winner" }),
    );
    const absoluteFailStep = step({ id: "tracer-absolute-fail" }).do(() =>
      absoluteFail({ code: "tracer_absolute_failed", message: "absolute loser" }),
    );
    const queuedStep = step({ id: "tracer-absolute-queued" }).do(() =>
      done({ terminal: "queued" }),
    );
    const absoluteDoneWorkflow: Workflow<Record<string, never>, PlainObject> = {
      id: "tracer-absolute-done-workflow",
      start() {
        return [absoluteDoneStep(), queuedStep()];
      },
    };
    const absoluteFailWorkflow: Workflow<Record<string, never>, PlainObject> = {
      id: "tracer-absolute-fail-workflow",
      start() {
        return [absoluteFailStep(), queuedStep()];
      },
    };
    const absoluteDoneResult = await runWorkflow({
      workflow: absoluteDoneWorkflow,
      input: {},
      runName: "parallel-tracer-absolute-done",
      cwd,
      scheduler: { workers: 1 },
    });
    const absoluteFailResult = await runWorkflow({
      workflow: absoluteFailWorkflow,
      input: {},
      runName: "parallel-tracer-absolute-fail",
      cwd,
      scheduler: { workers: 1 },
    });
    expect(absoluteDoneResult.status).toBe("success");
    expect(absoluteFailResult.status).toBe("failure");
    await expect(
      readJsonObject(join(absoluteDoneResult.runDir, "track.json")),
    ).resolves.toMatchObject({
      terminalKind: "absoluteDone",
      terminalOutput: { terminal: "winner" },
    });
    await expect(
      readJsonObject(join(absoluteFailResult.runDir, "track.json")),
    ).resolves.toMatchObject({
      terminalKind: "absoluteFail",
      failure: { code: "tracer_absolute_failed", message: "absolute loser" },
    });

    const summaries = await Core.listRunSummaries({ cwd });
    const doneSummary = summaries.find((summary) => summary.runId === absoluteDoneResult.runId);
    const failSummary = summaries.find((summary) => summary.runId === absoluteFailResult.runId);
    expect(doneSummary?.track).toMatchObject({
      terminalKind: "absoluteDone",
      terminalOutput: { terminal: "winner" },
    });
    expect(failSummary?.track).toMatchObject({
      terminalKind: "absoluteFail",
      failure: { code: "tracer_absolute_failed", message: "absolute loser" },
    });
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
        stepIndex: expect.any(Number),
        stepArtifactId: expect.stringMatching(/^000[12]-same-id$/),
        stepArtifactPath: expect.stringMatching(/^steps\/000[12]-same-id$/),
      });
    }
  });
});
