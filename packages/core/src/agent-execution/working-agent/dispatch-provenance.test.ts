import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  done,
  type Event,
  parallel,
  parseTrailStepConfig,
  runWorkflow,
  step,
  subPrompt,
  type Workflow,
  type WorkingAgentProcessRequest,
} from "../../index.js";

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

beforeEach(() => {
  // Fake-runner working dispatch tests pin the platform so Windows CLI-shim
  // resolution does not rewrite commands based on the host machine's PATH.
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  if (originalPlatformDescriptor !== undefined) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
});

type Provenance = {
  readonly schemaVersion?: number;
  readonly branchId?: string;
  readonly stepIndex?: number;
  readonly stepArtifactId?: string;
  readonly stepAttempt?: number;
  readonly executionCwd?: string;
  readonly promptPhaseIndex?: number;
  readonly parentStepId?: string;
  readonly subPromptOrdinal?: number;
  readonly targetOrdinal?: number;
  readonly workSpawnTry?: number;
  readonly formatValidationAttempt?: number;
  readonly formatSpawnTry?: number;
  readonly spawnEventId?: string;
};

function provenanceOf(event: Event): Provenance {
  return (event.payload.provenance ?? {}) as Provenance;
}

function agentEvents(result: { readonly events: readonly Event[] }) {
  return result.events.filter((event) => event.type.startsWith("agent."));
}

function eventsOfType(result: { readonly events: readonly Event[] }, type: Event["type"]) {
  return result.events.filter((event) => event.type === type);
}

function expectLinkedSpawnChain(events: readonly Event[]): { readonly spawnedId: string } {
  const spawned = events.filter((event) => event.type === "agent.spawned");
  expect(spawned).toHaveLength(1);
  const spawnedId = spawned[0]?.id;
  expect(spawnedId).toBeTypeOf("string");
  // The spawn event itself is the anchor: it must not reference a spawn.
  expect(provenanceOf(spawned[0] as Event)).not.toHaveProperty("spawnEventId");
  for (const event of events) {
    if (event.type === "agent.spawned" || event.type === "agent.targetSelected") {
      continue;
    }
    // Every post-spawn sibling agent event links back to the spawn.
    expect(provenanceOf(event)).toMatchObject({ spawnEventId: spawnedId });
  }
  return { spawnedId: spawnedId as string };
}

function createLegacyCustomConfig() {
  return parseTrailStepConfig({
    version: 1,
    customProviders: { worker: { binary: "worker-agent" } },
    agents: { medium: [{ provider: "worker", model: "worker-model" }] },
  });
}

function promptStepWorkflow(workflowId: string): Workflow<{ task: string }, { answer: string }> {
  const workflow: Workflow<{ task: string }, { answer: string }> = {
    id: workflowId,
    inputShape: { task: "string" },
    outputShape: { answer: "string" },
    agents: { reviewer: { size: "medium" } },
    start(input) {
      return step({ id: "review" })
        .prompt(({ input }) => `Review ${input.task}.`, {
          output: { answer: "string" },
          agent: "reviewer",
        })
        .do((output) => done(output))(input);
    },
  };
  return workflow;
}

async function successfulWorkerRunner(request: WorkingAgentProcessRequest) {
  await writeFile(request.outputFile, JSON.stringify({ answer: "ok" }), "utf8");
  return { exitCode: 0 };
}

describe("A2b dispatch-context provenance", () => {
  it("links spawned→prompt→output with the step dispatch context (legacy custom provider)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-dispatch-provenance-serial-"));

    const result = await runWorkflow({
      workflow: promptStepWorkflow("dispatch-provenance-serial-workflow"),
      input: { task: "serial" },
      runName: "dispatch-provenance-serial-run",
      cwd,
      trailstepConfig: createLegacyCustomConfig(),
      workingAgentProcessRunner: successfulWorkerRunner,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    const spawned = eventsOfType(result, "agent.spawned");
    expect(spawned).toHaveLength(1);
    const spawnedEvent = spawned[0] as Event;
    expect(spawnedEvent).toMatchObject({
      stepId: "review",
      schemaVersion: "v0",
      payload: { provider: "worker", phase: "work" },
    });
    // Outer schema, existing fields and ordering are untouched; provenance is additive.
    expect(Object.keys(spawnedEvent.payload)).toEqual([
      "provider",
      "model",
      "phase",
      "promptFile",
      "outputFile",
      "provenance",
    ]);
    expect(provenanceOf(spawnedEvent)).toEqual({
      schemaVersion: 1,
      branchId: "root",
      stepIndex: 1,
      stepArtifactId: "0001-review",
      stepAttempt: 1,
      executionCwd: cwd,
      promptPhaseIndex: 0,
      targetOrdinal: 1,
      workSpawnTry: 1,
    });
    expectLinkedSpawnChain(agentEvents(result));

    // Scheduler branch decoration on step events is untouched: top-level payload fields.
    const started = eventsOfType(result, "step.started");
    expect(started[0]?.payload).toMatchObject({
      branchId: "root",
      stepIndex: 1,
      stepArtifactId: "0001-review",
    });
    expect(started[0]?.payload).not.toHaveProperty("provenance");
  });

  it("records the prompt phase index without changing output or ordering", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-dispatch-provenance-phase-"));
    const requests: WorkingAgentProcessRequest[] = [];

    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "dispatch-provenance-phase-workflow",
      inputShape: { task: "string" },
      outputShape: { answer: "string" },
      agents: { reviewer: { size: "medium" } },
      start(input) {
        return step({ id: "review" })
          .display(({ input }) => ({ message: `Reviewing ${input.task}` }))
          .prompt(({ input }) => `Review ${input.task}.`, {
            output: { answer: "string" },
            agent: "reviewer",
          })
          .do((output) => done(output))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "phase" },
      runName: "dispatch-provenance-phase-run",
      cwd,
      trailstepConfig: createLegacyCustomConfig(),
      workingAgentProcessRunner: async (request) => {
        requests.push(request);
        return await successfulWorkerRunner(request);
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ answer: "ok" });
    expect(requests).toHaveLength(1);

    const spawned = eventsOfType(result, "agent.spawned");
    expect(spawned).toHaveLength(1);
    // phases = [display, prompt, do]: the prompt phase index is 1.
    expect(provenanceOf(spawned[0] as Event)).toMatchObject({ promptPhaseIndex: 1 });
  });

  it("distinguishes target ordinals and spawn references across target fallback", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-dispatch-provenance-fallback-"));
    const requests: WorkingAgentProcessRequest[] = [];

    const result = await runWorkflow({
      workflow: promptStepWorkflow("dispatch-provenance-fallback-workflow"),
      input: { task: "fallback" },
      runName: "dispatch-provenance-fallback-run",
      cwd,
      trailstepConfig: parseTrailStepConfig({
        version: 1,
        customProviders: {
          first: { binary: "first-agent" },
          second: { binary: "second-agent" },
        },
        agents: {
          medium: [
            { provider: "first", model: "first-model" },
            { provider: "second", model: "second-model" },
          ],
        },
      }),
      workingAgentProcessRunner: async (request) => {
        requests.push(request);
        if (request.command === "first-agent") {
          return { exitCode: 7 };
        }
        await writeFile(request.outputFile, JSON.stringify({ answer: "second-wins" }), "utf8");
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ answer: "second-wins" });
    expect(requests.map((request) => request.command)).toEqual(["first-agent", "second-agent"]);

    const targetSelected = eventsOfType(result, "agent.targetSelected");
    expect(targetSelected.map((event) => provenanceOf(event))).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        branchId: "root",
        stepIndex: 1,
        stepArtifactId: "0001-review",
        stepAttempt: 1,
        executionCwd: cwd,
        promptPhaseIndex: 0,
        targetOrdinal: 1,
      }),
      expect.objectContaining({ targetOrdinal: 2 }),
    ]);
    for (const event of targetSelected) {
      // No spawn has happened yet at target selection: no fabricated reference.
      expect(provenanceOf(event)).not.toHaveProperty("spawnEventId");
    }

    const spawned = eventsOfType(result, "agent.spawned");
    expect(spawned).toHaveLength(2);
    expect(spawned.map((event) => event.id)).not.toEqual([spawned[1]?.id, spawned[0]?.id]);
    expect(spawned[0]?.id).not.toBe(spawned[1]?.id);
    expect(provenanceOf(spawned[0] as Event)).toMatchObject({ targetOrdinal: 1, workSpawnTry: 1 });
    expect(provenanceOf(spawned[1] as Event)).toMatchObject({ targetOrdinal: 2, workSpawnTry: 1 });

    const attemptFailed = eventsOfType(result, "agent.attemptFailed");
    expect(attemptFailed).toHaveLength(1);
    expect(provenanceOf(attemptFailed[0] as Event)).toMatchObject({
      targetOrdinal: 1,
      workSpawnTry: 1,
      spawnEventId: spawned[0]?.id,
    });

    const outputReceived = eventsOfType(result, "agent.outputReceived");
    expect(outputReceived).toHaveLength(1);
    expect(provenanceOf(outputReceived[0] as Event)).toMatchObject({
      targetOrdinal: 2,
      spawnEventId: spawned[1]?.id,
    });
  });

  it("distinguishes work spawn retries with distinct spawn IDs within one step attempt", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-dispatch-provenance-work-retry-"));
    let calls = 0;

    const result = await runWorkflow({
      workflow: promptStepWorkflow("dispatch-provenance-work-retry-workflow"),
      input: { task: "transient" },
      runName: "dispatch-provenance-work-retry-run",
      cwd,
      trailstepConfig: createLegacyCustomConfig(),
      workingAgentProcessRunner: async (request) => {
        calls += 1;
        if (calls === 1) {
          // Windows STATUS_DLL_INIT_FAILED family: transient process-level death.
          return { exitCode: 3221225794 };
        }
        await writeFile(request.outputFile, JSON.stringify({ answer: "after-retry" }), "utf8");
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(calls).toBe(2);

    const spawned = eventsOfType(result, "agent.spawned");
    expect(spawned).toHaveLength(2);
    expect(spawned[0]?.id).not.toBe(spawned[1]?.id);
    expect(provenanceOf(spawned[0] as Event)).toMatchObject({
      stepAttempt: 1,
      targetOrdinal: 1,
      workSpawnTry: 1,
    });
    expect(provenanceOf(spawned[1] as Event)).toMatchObject({
      stepAttempt: 1,
      targetOrdinal: 1,
      workSpawnTry: 2,
    });

    const attemptFailed = eventsOfType(result, "agent.attemptFailed");
    expect(attemptFailed).toHaveLength(1);
    expect(provenanceOf(attemptFailed[0] as Event)).toMatchObject({
      stepAttempt: 1,
      targetOrdinal: 1,
      workSpawnTry: 1,
      spawnEventId: spawned[0]?.id,
    });

    const outputReceived = eventsOfType(result, "agent.outputReceived");
    expect(provenanceOf(outputReceived[0] as Event)).toMatchObject({
      stepAttempt: 1,
      workSpawnTry: 2,
      spawnEventId: spawned[1]?.id,
    });
  });

  it("records stepAttempt 2 on retried attempts with the same allocated step identity", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-dispatch-provenance-step-retry-"));
    let calls = 0;

    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "dispatch-provenance-step-retry-workflow",
      inputShape: { task: "string" },
      outputShape: { answer: "string" },
      agents: { reviewer: { size: "medium" } },
      start(input) {
        return step({ id: "review", retry: { maxAttempts: 2, retryOn: "always" } })
          .prompt(({ input }) => `Review ${input.task}.`, {
            output: { answer: "string" },
            agent: "reviewer",
          })
          .do((output) => done(output))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "step-retry" },
      runName: "dispatch-provenance-step-retry-run",
      cwd,
      trailstepConfig: createLegacyCustomConfig(),
      workingAgentProcessRunner: async (request) => {
        calls += 1;
        if (calls === 1) {
          return { exitCode: 7 };
        }
        await writeFile(request.outputFile, JSON.stringify({ answer: "second-attempt" }), "utf8");
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(calls).toBe(2);

    const spawned = eventsOfType(result, "agent.spawned");
    expect(spawned).toHaveLength(2);
    expect(provenanceOf(spawned[0] as Event)).toMatchObject({
      stepIndex: 1,
      stepArtifactId: "0001-review",
      stepAttempt: 1,
    });
    expect(provenanceOf(spawned[1] as Event)).toMatchObject({
      stepIndex: 1,
      stepArtifactId: "0001-review",
      stepAttempt: 2,
    });

    const attemptFailed = eventsOfType(result, "agent.attemptFailed");
    expect(provenanceOf(attemptFailed[0] as Event)).toMatchObject({
      stepAttempt: 1,
      spawnEventId: spawned[0]?.id,
    });
    // Existing payload.attempt semantics preserved alongside provenance.
    expect(eventsOfType(result, "step.attemptFailed")).toHaveLength(1);
    expect(eventsOfType(result, "step.attemptFailed")[0]?.payload).toMatchObject({ attempt: 1 });
  });
});

describe("A2b dispatch-context provenance: manifest two-phase", () => {
  it("links work and successful format spawns across validation retries", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-dispatch-provenance-two-phase-"));
    const requests: WorkingAgentProcessRequest[] = [];
    let formatCalls = 0;

    const result = await runWorkflow({
      workflow: promptStepWorkflow("dispatch-provenance-two-phase-workflow"),
      input: { task: "two-phase" },
      runName: "dispatch-provenance-two-phase-run",
      cwd,
      trailstepConfig: parseTrailStepConfig({
        version: 1,
        providers: {
          "two-phase-agent": {
            source: { type: "local-manifest", path: "./two-phase-agent.trailstep-provider.json" },
            manifest: {
              schemaVersion: 1,
              id: "two-phase-agent",
              displayName: "Two Phase Agent",
              working: {
                supported: true,
                command: "two-phase-agent",
                args: ["--prompt-file", "{{promptFile}}", "--output-file", "{{outputFile}}"],
                prompt: { kind: "prompt-file" },
                output: { style: "provider-output-file" },
                followUp: {
                  supported: true,
                  sessionIdFlag: "--session",
                  resumeArgs: [
                    "--resume",
                    "{{sessionId}}",
                    "--prompt-file",
                    "{{promptFile}}",
                    "--output-file",
                    "{{outputFile}}",
                  ],
                },
              },
              interactive: { supported: false, reason: "No interactive mode" },
              model: { supported: false },
              thinking: { supported: false },
            },
          },
        },
        agents: { medium: [{ provider: "two-phase-agent" }] },
      }),
      workingAgentProcessRunner: async (request) => {
        requests.push(request);
        if (request.outputFile.endsWith(join("steps", "0001-review", "work.txt"))) {
          await writeFile(request.outputFile, "work report", "utf8");
          return { exitCode: 0 };
        }
        formatCalls += 1;
        if (formatCalls === 1) {
          // Valid exit, invalid payload: a format validation (not spawn) retry.
          await writeFile(request.outputFile, JSON.stringify({ wrong: "shape" }), "utf8");
          return { exitCode: 0 };
        }
        await writeFile(request.outputFile, JSON.stringify({ answer: "formatted" }), "utf8");
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(requests).toHaveLength(3);

    const spawned = eventsOfType(result, "agent.spawned");
    expect(spawned).toHaveLength(3);
    expect(new Set(spawned.map((event) => event.id)).size).toBe(3);

    const [workSpawned, formatSpawned1, formatSpawned2] = spawned as [Event, Event, Event, Event?];
    expect(provenanceOf(workSpawned)).toMatchObject({
      branchId: "root",
      stepIndex: 1,
      stepArtifactId: "0001-review",
      stepAttempt: 1,
      executionCwd: cwd,
      promptPhaseIndex: 0,
      targetOrdinal: 1,
      workSpawnTry: 1,
    });
    expect(provenanceOf(workSpawned)).not.toHaveProperty("formatSpawnTry");
    expect(provenanceOf(workSpawned)).not.toHaveProperty("formatValidationAttempt");

    // Format validation attempts are distinct from format spawn retries.
    expect(provenanceOf(formatSpawned1)).toMatchObject({
      targetOrdinal: 1,
      formatValidationAttempt: 1,
      formatSpawnTry: 1,
    });
    expect(provenanceOf(formatSpawned1)).not.toHaveProperty("workSpawnTry");
    expect(provenanceOf(formatSpawned2)).toMatchObject({
      formatValidationAttempt: 2,
      formatSpawnTry: 1,
    });

    // Same session across format attempts; existing attempt fields preserved.
    const sessionId = (workSpawned.payload.sessionId as string | undefined) ?? "";
    expect(sessionId).not.toBe("");
    expect(formatSpawned1.payload).toMatchObject({ attempt: 1, sessionId });
    expect(formatSpawned2.payload).toMatchObject({ attempt: 2, sessionId });

    const outputReceived = eventsOfType(result, "agent.outputReceived");
    expect(outputReceived).toHaveLength(2);
    expect(provenanceOf(outputReceived[0] as Event)).toMatchObject({
      spawnEventId: workSpawned.id,
      workSpawnTry: 1,
    });
    // The successful format output event propagates the successful format spawn reference.
    expect(provenanceOf(outputReceived[1] as Event)).toMatchObject({
      formatValidationAttempt: 2,
      spawnEventId: formatSpawned2.id,
    });

    const formatPromptSents = eventsOfType(result, "agent.promptSent").filter(
      (event) => event.payload.phase === "format",
    );
    expect(formatPromptSents.map((event) => provenanceOf(event))).toEqual([
      expect.objectContaining({
        formatValidationAttempt: 1,
        formatSpawnTry: 1,
        spawnEventId: formatSpawned1.id,
      }),
      expect.objectContaining({
        formatValidationAttempt: 2,
        formatSpawnTry: 1,
        spawnEventId: formatSpawned2.id,
      }),
    ]);
  });

  it("distinguishes format spawn retries from format validation attempts", async () => {
    const cwd = await mkdtemp(
      join(tmpdir(), "trailstep-core-dispatch-provenance-format-transient-"),
    );
    let formatCalls = 0;

    const result = await runWorkflow({
      workflow: promptStepWorkflow("dispatch-provenance-format-transient-workflow"),
      input: { task: "format-transient" },
      runName: "dispatch-provenance-format-transient-run",
      cwd,
      trailstepConfig: parseTrailStepConfig({
        version: 1,
        providers: {
          "two-phase-agent": {
            source: { type: "local-manifest", path: "./two-phase-agent.trailstep-provider.json" },
            manifest: {
              schemaVersion: 1,
              id: "two-phase-agent",
              displayName: "Two Phase Agent",
              working: {
                supported: true,
                command: "two-phase-agent",
                args: ["--prompt-file", "{{promptFile}}", "--output-file", "{{outputFile}}"],
                prompt: { kind: "prompt-file" },
                output: { style: "provider-output-file" },
                followUp: {
                  supported: true,
                  sessionIdFlag: "--session",
                  resumeArgs: [
                    "--resume",
                    "{{sessionId}}",
                    "--prompt-file",
                    "{{promptFile}}",
                    "--output-file",
                    "{{outputFile}}",
                  ],
                },
              },
              interactive: { supported: false, reason: "No interactive mode" },
              model: { supported: false },
              thinking: { supported: false },
            },
          },
        },
        agents: { medium: [{ provider: "two-phase-agent" }] },
      }),
      workingAgentProcessRunner: async (request) => {
        if (request.outputFile.endsWith(join("steps", "0001-review", "work.txt"))) {
          await writeFile(request.outputFile, "work report", "utf8");
          return { exitCode: 0 };
        }
        formatCalls += 1;
        if (formatCalls === 1) {
          return { exitCode: 3221225794 };
        }
        await writeFile(request.outputFile, JSON.stringify({ answer: "formatted" }), "utf8");
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    const formatSpawned = eventsOfType(result, "agent.spawned").filter(
      (event) => event.payload.phase === "format",
    );
    expect(formatSpawned).toHaveLength(2);
    expect(formatSpawned[0]?.id).not.toBe(formatSpawned[1]?.id);
    expect(provenanceOf(formatSpawned[0] as Event)).toMatchObject({
      formatValidationAttempt: 1,
      formatSpawnTry: 1,
    });
    expect(provenanceOf(formatSpawned[1] as Event)).toMatchObject({
      formatValidationAttempt: 1,
      formatSpawnTry: 2,
    });

    // The transient format failure references its failed spawn; the output
    // references the successful one.
    const attemptFailed = eventsOfType(result, "agent.attemptFailed");
    expect(attemptFailed).toHaveLength(1);
    expect(provenanceOf(attemptFailed[0] as Event)).toMatchObject({
      formatValidationAttempt: 1,
      formatSpawnTry: 1,
      spawnEventId: formatSpawned[0]?.id,
    });
    const formatOutput = eventsOfType(result, "agent.outputReceived").find(
      (event) => event.payload.phase === "format",
    );
    expect(provenanceOf(formatOutput as Event)).toMatchObject({
      formatValidationAttempt: 1,
      spawnEventId: formatSpawned[1]?.id,
    });
  });
});

describe("A2b dispatch-context provenance: parallel, subprompt, failures", () => {
  it("keeps branch, step identity, attempt, and cwd isolated across parallel branches with repeated step IDs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-dispatch-provenance-parallel-"));

    const reviewStep = (label: string) =>
      step({ id: "review" })
        .prompt(`Review ${label}.`, {
          output: { answer: "string" },
          agent: "reviewer",
        })
        .do((output: { answer: string }) => done(output));

    const workflow: Workflow<Record<string, never>, Record<string, unknown>> = {
      id: "dispatch-provenance-parallel-workflow",
      agents: { reviewer: { size: "medium" } },
      start() {
        // Root parallel node: two branches execute steps with the same logical
        // step id concurrently.
        return parallel([reviewStep("alpha")({}), reviewStep("beta")({})]);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "dispatch-provenance-parallel-run",
      cwd,
      trailstepConfig: createLegacyCustomConfig(),
      scheduler: { workers: 2 },
      workingAgentProcessRunner: async (request) => {
        const prompt = await readFile(request.promptFile, "utf8");
        const answer = prompt.includes("alpha") ? "alpha" : "beta";
        await writeFile(request.outputFile, JSON.stringify({ answer }), "utf8");
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    const spawned = eventsOfType(result, "agent.spawned");
    expect(spawned).toHaveLength(2);
    expect(new Set(spawned.map((event) => event.id)).size).toBe(2);

    const branchIds = new Set(spawned.map((event) => provenanceOf(event).branchId));
    expect(branchIds.size).toBe(2);
    expect(branchIds.has("root")).toBe(false);

    const stepStarted = eventsOfType(result, "step.started").filter(
      (event) => event.stepId === "review",
    );
    expect(stepStarted).toHaveLength(2);

    // Each dispatch's provenance matches its own branch's allocated step.
    const provenanceByStepIndex = new Map<number, Provenance>();
    for (const event of spawned) {
      const provenance = provenanceOf(event);
      expect(provenance.stepIndex).toBeTypeOf("number");
      provenanceByStepIndex.set(provenance.stepIndex as number, provenance);
      expect(provenance.executionCwd).toBe(cwd);
      expect(provenance.stepAttempt).toBe(1);
    }
    expect(provenanceByStepIndex.size).toBe(2);

    for (const startedEvent of stepStarted) {
      const stepIndex = startedEvent.payload.stepIndex as number;
      const provenance = provenanceByStepIndex.get(stepIndex);
      expect(provenance).toBeDefined();
      expect(provenance?.branchId).toBe(startedEvent.payload.branchId);
      expect(provenance?.stepArtifactId).toBe(startedEvent.payload.stepArtifactId);
    }
    const artifactIds = [...provenanceByStepIndex.values()].map((p) => p.stepArtifactId);
    expect(new Set(artifactIds).size).toBe(2);

    // No sibling leakage: agent event chains stay within one branch each.
    const promptSents = eventsOfType(result, "agent.promptSent");
    expect(promptSents).toHaveLength(2);
    const outputReceived = eventsOfType(result, "agent.outputReceived");
    expect(outputReceived).toHaveLength(2);
  });

  it("inherits parent step context into subprompt dispatch and reuses cache on resume without new dispatch evidence", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-dispatch-provenance-subprompt-"));
    let runnerCalls = 0;
    let shouldFailLater = true;

    const finalizeStep = step({ id: "finalize" }).do(({ answer }: { answer: string }) => {
      if (shouldFailLater) {
        throw new Error("later step fails on the first run");
      }
      return done({ final: answer });
    });

    const workflow: Workflow<{ topic: string }, { final: string }> = {
      id: "dispatch-provenance-subprompt-workflow",
      inputShape: { topic: "string" },
      outputShape: { final: "string" },
      agents: { reviewer: { size: "medium" } },
      start(input) {
        return step({ id: "orchestrate" }).do(async () => {
          const review = await subPrompt("Review alpha", {
            output: { answer: "string" },
            agent: "reviewer",
          })({});
          return finalizeStep(review as unknown as { answer: string });
        })(input);
      },
    };

    const runner = async (request: WorkingAgentProcessRequest) => {
      runnerCalls += 1;
      await writeFile(request.outputFile, JSON.stringify({ answer: "accepted" }), "utf8");
      return { exitCode: 0 };
    };

    const failed = await runWorkflow({
      workflow,
      input: { topic: "alpha" },
      runName: "dispatch-provenance-subprompt-run",
      cwd,
      trailstepConfig: createLegacyCustomConfig(),
      workingAgentProcessRunner: runner,
    });

    expect(failed.status).toBe("failure");
    expect(runnerCalls).toBe(1);

    const started = eventsOfType(failed, "subPrompt.started");
    expect(started).toHaveLength(1);
    expect(provenanceOf(started[0] as Event)).toEqual({
      schemaVersion: 1,
      branchId: "root",
      stepIndex: 1,
      stepArtifactId: "0001-orchestrate",
      stepAttempt: 1,
      executionCwd: cwd,
      parentStepId: "orchestrate",
      subPromptOrdinal: 1,
    });

    const spawned = eventsOfType(failed, "agent.spawned");
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.stepId).toBe("orchestrate.subPrompt.1");
    expect(provenanceOf(spawned[0] as Event)).toMatchObject({
      branchId: "root",
      stepIndex: 1,
      stepArtifactId: "0001-orchestrate",
      stepAttempt: 1,
      executionCwd: cwd,
      parentStepId: "orchestrate",
      subPromptOrdinal: 1,
      targetOrdinal: 1,
      workSpawnTry: 1,
    });
    expect(provenanceOf(spawned[0] as Event)).not.toHaveProperty("promptPhaseIndex");

    shouldFailLater = false;
    const resumed = await runWorkflow({
      workflow,
      resume: { runDir: failed.runDir },
      trailstepConfig: createLegacyCustomConfig(),
      workingAgentProcessRunner: runner,
    });

    expect(resumed.status).toBe("success");
    // Cached subprompt return: no new dispatch, no new spawn events.
    expect(runnerCalls).toBe(1);
    expect(eventsOfType(resumed, "agent.spawned")).toHaveLength(1);
    expect(eventsOfType(resumed, "subPrompt.started")).toHaveLength(1);
    expect(eventsOfType(resumed, "subPrompt.completed")).toHaveLength(1);
  });

  it("replays a completed prompt step without emitting new dispatch evidence", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-dispatch-provenance-replay-"));
    let runnerCalls = 0;
    let shouldFailLater = true;

    const finalizeStep = step({ id: "finalize" }).do(({ answer }: { answer: string }) => {
      if (shouldFailLater) {
        throw new Error("later step fails on the first run");
      }
      return done({ answer });
    });

    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "dispatch-provenance-replay-workflow",
      inputShape: { task: "string" },
      outputShape: { answer: "string" },
      agents: { reviewer: { size: "medium" } },
      start(input) {
        return step({ id: "review" })
          .prompt(({ input }) => `Review ${input.task}.`, {
            output: { answer: "string" },
            agent: "reviewer",
          })
          .do((output) => finalizeStep(output as unknown as { answer: string }))(input);
      },
    };

    const runner = async (request: WorkingAgentProcessRequest) => {
      runnerCalls += 1;
      await writeFile(request.outputFile, JSON.stringify({ answer: "replayed" }), "utf8");
      return { exitCode: 0 };
    };

    const failed = await runWorkflow({
      workflow,
      input: { task: "replay" },
      runName: "dispatch-provenance-replay-run",
      cwd,
      trailstepConfig: createLegacyCustomConfig(),
      workingAgentProcessRunner: runner,
    });

    expect(failed.status).toBe("failure");
    expect(runnerCalls).toBe(1);
    expect(eventsOfType(failed, "agent.spawned")).toHaveLength(1);

    shouldFailLater = false;
    const resumed = await runWorkflow({
      workflow,
      resume: { runDir: failed.runDir },
      trailstepConfig: createLegacyCustomConfig(),
      workingAgentProcessRunner: runner,
    });

    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") {
      throw new Error(resumed.failure.message);
    }
    expect(resumed.output).toEqual({ answer: "replayed" });
    // Replay reused the recorded prompt output: no new spawn attempts.
    expect(runnerCalls).toBe(1);
    expect(eventsOfType(resumed, "agent.spawned")).toHaveLength(1);
  });

  it("carries context without a spawn reference on pre-spawn failures", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-dispatch-provenance-prespawn-"));

    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "dispatch-provenance-prespawn-workflow",
      inputShape: { task: "string" },
      outputShape: { answer: "string" },
      agents: { reviewer: { size: "medium" } },
      start(input) {
        return step({ id: "review", retry: { maxAttempts: 1 } })
          .prompt(({ input }) => `Review ${input.task}.`, {
            output: { answer: "string" },
            agent: "reviewer",
          })
          .do((output) => done(output))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "prespawn" },
      runName: "dispatch-provenance-prespawn-run",
      cwd,
      trailstepConfig: parseTrailStepConfig({
        version: 1,
        providers: {
          unavailable: {
            source: { type: "local-manifest", path: "./unavailable.trailstep-provider.json" },
            manifest: {
              schemaVersion: 1,
              id: "unavailable",
              displayName: "Unavailable",
              working: { supported: false, reason: "No working mode" },
              interactive: { supported: false, reason: "No interactive mode" },
              model: { supported: false },
              thinking: { supported: false },
            },
          },
        },
        agents: { medium: [{ provider: "unavailable" }] },
      }),
      workingAgentProcessRunner: async () => ({ exitCode: 0 }),
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected pre-spawn failure");
    }
    expect(eventsOfType(result, "agent.spawned")).toHaveLength(0);

    const targetSelected = eventsOfType(result, "agent.targetSelected");
    expect(targetSelected).toHaveLength(1);
    expect(provenanceOf(targetSelected[0] as Event)).toMatchObject({
      branchId: "root",
      stepIndex: 1,
      stepArtifactId: "0001-review",
      stepAttempt: 1,
      executionCwd: cwd,
      targetOrdinal: 1,
    });

    const attemptFailed = eventsOfType(result, "agent.attemptFailed");
    expect(attemptFailed).toHaveLength(1);
    expect(provenanceOf(attemptFailed[0] as Event)).toMatchObject({
      stepAttempt: 1,
      targetOrdinal: 1,
      workSpawnTry: 1,
    });
    // No spawn happened, so no spawn reference may be invented.
    expect(provenanceOf(attemptFailed[0] as Event)).not.toHaveProperty("spawnEventId");
  });

  it("records the exact whitespace-bearing step cwd in provenance", async () => {
    if (process.platform === "win32") {
      expect(true).toBe(true);
      return;
    }
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-dispatch-provenance-cwd-"));
    const stepCwd = `${cwd} `;
    await mkdir(stepCwd, { recursive: true });

    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "dispatch-provenance-cwd-workflow",
      inputShape: { task: "string" },
      outputShape: { answer: "string" },
      agents: { reviewer: { size: "medium" } },
      start(input) {
        return step({ id: "review", cwd: stepCwd })
          .prompt(({ input }) => `Review ${input.task}.`, {
            output: { answer: "string" },
            agent: "reviewer",
          })
          .do((output) => done(output))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "cwd" },
      runName: "dispatch-provenance-cwd-run",
      cwd,
      trailstepConfig: createLegacyCustomConfig(),
      workingAgentProcessRunner: async (request) => {
        expect(request.cwd).toBe(stepCwd);
        await writeFile(request.outputFile, JSON.stringify({ answer: "ok" }), "utf8");
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    const spawned = eventsOfType(result, "agent.spawned");
    expect(spawned).toHaveLength(1);
    expect(provenanceOf(spawned[0] as Event)).toMatchObject({ executionCwd: stepCwd });
  });

  it("links spawn references on working-agent timeout failures", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-dispatch-provenance-timeout-"));

    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "dispatch-provenance-timeout-workflow",
      inputShape: { task: "string" },
      outputShape: { answer: "string" },
      timeout: 300,
      agents: { reviewer: { size: "medium" } },
      start(input) {
        return step({ id: "review" })
          .prompt(({ input }) => `Review ${input.task}.`, {
            output: { answer: "string" },
            agent: "reviewer",
          })
          .do((output) => done(output))(input);
      },
    };

    // A step timeout is a TRANSIENT failure, so automatic step retry re-runs
    // the step once (built-in maxAttempts 2) before it fails for good: each
    // attempt produces one working-agent attempt failure with its own spawn.
    const attemptFailures = (events: readonly Event[]) =>
      events.filter((event) => event.type === "agent.attemptFailed");

    const result = await runWorkflow({
      workflow,
      input: { task: "timeout" },
      runName: "dispatch-provenance-timeout-run",
      cwd,
      trailstepConfig: createLegacyCustomConfig(),
      workingAgentProcessRunner: async (request) => {
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) {
            resolve();
            return;
          }
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { exitCode: 1, stdout: "" };
      },
    });

    expect(result.status).toBe("failure");
    // The attempt-failure emit can land just after runWorkflow resolves;
    // poll the live events briefly before asserting (mirrors the existing
    // timeout suite).
    for (let waitedMs = 0; attemptFailures(result.events).length < 2 && waitedMs < 5_000; ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const spawned = eventsOfType(result, "agent.spawned");
    const attemptFailed = attemptFailures(result.events);
    expect(spawned.length).toBe(attemptFailed.length);
    expect(spawned.length).toBeGreaterThan(0);
    spawned.forEach((spawnedEvent, index) => {
      expect(provenanceOf(attemptFailed[index] as Event)).toMatchObject({
        targetOrdinal: 1,
        workSpawnTry: 1,
        spawnEventId: spawnedEvent.id,
      });
      expect(provenanceOf(attemptFailed[index] as Event).stepAttempt).toBe(index + 1);
    });
  });
});
