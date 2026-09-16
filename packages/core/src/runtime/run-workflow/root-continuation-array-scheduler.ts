import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TrailStepConfig } from "../../agent-targeting/targeting.types.js";
import type { ContinuationResult } from "../../authoring/step/continuation.types.js";
import { isStepNode } from "../../authoring/step/step-node.js";
import type { WorkflowAgentRole } from "../../contracts/agents/agent-role.types.js";
import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import type { Event, RunWorkflowOptions } from "./run-workflow.types.js";
import { resolveStepArtifactPaths } from "../artifacts/step-artifacts.js";
import { runContinuation, type RunContinuationResult } from "../continuation/run-continuation/run-continuation.js";
import type { TimeoutPolicyInput } from "../timeout/timeout-policy.js";

interface RunRootContinuationArraySchedulerOptions {
  readonly nodes: readonly ContinuationResult[];
  readonly runId: string;
  readonly workflowId: string;
  readonly emit: (event: Event) => Promise<void>;
  readonly maxSteps: number;
  readonly initialSource: string;
  readonly workers: number;
  readonly workflowAgents: Readonly<Record<string, WorkflowAgentRole>>;
  readonly workflowTimeout?: TimeoutPolicyInput;
  readonly runDir: string;
  readonly projectCwd?: string;
  readonly cwd: string;
  readonly trailstepConfig?: TrailStepConfig;
  readonly workingAgentProcessRunner?: RunWorkflowOptions["workingAgentProcessRunner"];
  readonly providerWorkingRunner?: RunWorkflowOptions["providerWorkingRunner"];
  readonly processRunner?: RunWorkflowOptions["processRunner"];
}

interface BranchState {
  readonly branchId: string;
  readonly parentBranchId: string;
  readonly workflowId: string;
  readonly createdAt: string;
  status: "running" | "done" | "failed" | "waiting" | "cancelled";
  output?: PlainObject;
  updatedAt: string;
  latestStepIndex: number;
}

export async function runRootContinuationArrayScheduler(
  options: RunRootContinuationArraySchedulerOptions,
): Promise<RunContinuationResult> {
  if (!options.nodes.every(isStepNode)) {
    return {
      status: "failure",
      failure: {
        code: "unsupported_continuation",
        message: `${options.initialSource} returned a continuation array containing unsupported branch candidates.`,
      },
    };
  }

  const rootBranchId = "root";
  const branchStates: BranchState[] = options.nodes.map((_, index) => {
    const now = new Date().toISOString();
    return {
      branchId: `branch-${index + 1}`,
      parentBranchId: rootBranchId,
      workflowId: options.workflowId,
      createdAt: now,
      updatedAt: now,
      status: "running",
      latestStepIndex: 0,
    };
  });
  let nextStepIndex = 0;
  const allocateStepIndex = (branch: BranchState): number => {
    if (nextStepIndex >= options.maxSteps) {
      throw new Error(`workflow exceeded maxSteps guard (${options.maxSteps})`);
    }
    nextStepIndex += 1;
    branch.latestStepIndex = nextStepIndex;
    branch.updatedAt = new Date().toISOString();
    return nextStepIndex;
  };

  await persistTrack(options, rootBranchId, branchStates, "running");

  for (const [index, node] of options.nodes.entries()) {
    const branch = branchStates[index];
    if (branch === undefined) {
      throw new Error(`missing scheduler branch state for branch ${index + 1}`);
    }
    const branchResult = await runContinuation({
      node,
      runId: options.runId,
      workflowId: options.workflowId,
      emit: async (event) => {
        if (event.type === "step.started" && event.stepId !== undefined) {
          const stepArtifacts = resolveStepArtifactPaths({
            runDir: options.runDir,
            stepId: event.stepId,
            stepIndex: branch.latestStepIndex,
          });
          await mkdir(stepArtifacts.stepDir, { recursive: true });
        }
        await options.emit(decorateBranchEvent(event, options.runId, branch.branchId));
      },
      maxSteps: options.maxSteps,
      initialSource: `${options.initialSource} branch ${branch.branchId}`,
      allocateStepIndex: () => allocateStepIndex(branch),
      workflowAgents: options.workflowAgents,
      workflowTimeout: options.workflowTimeout,
      runDir: options.runDir,
      projectCwd: options.projectCwd,
      cwd: options.cwd,
      trailstepConfig: options.trailstepConfig,
      workingAgentProcessRunner: options.workingAgentProcessRunner,
      providerWorkingRunner: options.providerWorkingRunner,
      processRunner: options.processRunner,
    });

    branch.updatedAt = new Date().toISOString();
    if (branchResult.status === "success") {
      branch.status = "done";
      branch.output = branchResult.output;
      await persistBranch(options.runDir, branch);
      continue;
    }

    branch.status = branchResult.status === "failure" ? "failed" : branchResult.status;
    await persistBranch(options.runDir, branch);
    await persistTrack(options, rootBranchId, branchStates, branchResult.status);
    return branchResult;
  }

  await Promise.all(branchStates.map((branch) => persistBranch(options.runDir, branch)));
  await persistTrack(options, rootBranchId, branchStates, "completed");

  return {
    status: "success",
    output: {
      status: "completed",
      branches: Object.fromEntries(
        branchStates.map((branch) => [
          branch.branchId,
          {
            status: branch.status,
            output: branch.output ?? {},
          },
        ]),
      ),
    },
  };
}

function decorateBranchEvent(event: Event, trackId: string, branchId: string): Event {
  if (event.type !== "step.started" && event.type !== "step.completed") {
    return event;
  }

  return {
    ...event,
    payload: {
      ...event.payload,
      trackId,
      branchId,
    },
  };
}

async function persistTrack(
  options: RunRootContinuationArraySchedulerOptions,
  rootBranchId: string,
  branches: readonly BranchState[],
  status: string,
): Promise<void> {
  await writeJson(join(options.runDir, "track.json"), {
    runId: options.runId,
    status,
    workers: options.workers,
    failurePolicy: "fail-fast",
    rootBranchId,
    splitOccurred: true,
    branches: branches.map((branch) => branch.branchId),
  });
}

async function persistBranch(runDir: string, branch: BranchState): Promise<void> {
  await writeJson(join(runDir, "branches", `${branch.branchId}.json`), {
    branchId: branch.branchId,
    parentBranchId: branch.parentBranchId,
    status: branch.status,
    workflowId: branch.workflowId,
    output: branch.output ?? {},
    createdAt: branch.createdAt,
    updatedAt: branch.updatedAt,
    latestStepIndex: branch.latestStepIndex,
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
