import {
  type DefinedWorkflow,
  defineWorkflow,
  done,
  type PlainObject,
  type Result,
  runWorkflow,
  type Workflow,
} from "@trailstep/core";

import { type FakeOutputRouteInput, fakeOutputFileHandler } from "./fake-output-file-handler.js";
import { tmpProject } from "./sandbox.js";

export interface RunWorkflowWithStubsOptions {
  /** Canned agent-step outputs keyed by step id (matched against the step's `outputFile` path). */
  readonly stubs: Readonly<Record<string, FakeOutputRouteInput>>;
  /** Sandbox cwd; defaults to a fresh auto-cleaned `tmpProject()`. */
  readonly cwd?: string;
  readonly runName?: string;
  /** Replaces the default stub config (custom `stub` provider with a `default` agent mapping). */
  readonly trailstepConfig?: Readonly<Record<string, unknown>>;
}

const defaultStubTrailstepConfig = {
  version: 1,
  customProviders: { stub: { binary: "trailstep-stub-agent" } },
  agents: { default: [{ provider: "stub" }] },
};

/**
 * Thin wrapper over `runWorkflow`: agent (`.prompt(...)`) steps are answered in
 * process by canned outputs keyed by step id instead of spawning a subprocess.
 * Unstubbed agent steps fail the run loudly.
 */
export async function runWorkflowWithStubs<TInput extends PlainObject, TOutput extends PlainObject>(
  workflow: Workflow<TInput, TOutput>,
  input: TInput,
  options: RunWorkflowWithStubsOptions,
): Promise<Result<TOutput>> {
  return runWorkflow({
    workflow,
    input,
    runName: options.runName ?? `${workflow.id}-stubbed-run`,
    cwd: options.cwd ?? tmpProject("trailtest-run-"),
    trailstepConfig: options.trailstepConfig ?? defaultStubTrailstepConfig,
    workingAgentProcessRunner: fakeOutputFileHandler(options.stubs),
  });
}

/**
 * A minimal stand-in for a child workflow that immediately returns `output`,
 * for testing wrapper workflows whose step normally runs a real sub-workflow
 * (inject this in place of the real workflow definition). Keeps the
 * sub-workflow id so event streams stay comparable.
 */
export function stubSubWorkflow<TOutput extends PlainObject = PlainObject>(
  id: string,
  output: TOutput,
): DefinedWorkflow<PlainObject, TOutput> {
  return defineWorkflow<PlainObject, TOutput>({
    id,
    start: () => done(output),
  });
}
