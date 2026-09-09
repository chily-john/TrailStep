import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { type Event, jsonSchema, type PlainObject, runWorkflow } from "@trailstep/core";

import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { loadTrailStepConfig } from "../../config/config.js";
import { resolveWorkflowReference } from "../../workflow-resolution/workflow-resolution.js";
import { CliInputError } from "../run/load-run-input.js";
import { createTerminalEventLogger } from "../run/terminal-event-logger.js";
import {
  findLatestPendingWait,
  readEventsForRun,
  readRunWorkflowRef,
  readWaitAnswerFile,
  resolveRunDirectory,
} from "../wait-run-helpers.js";
import { findActiveInteractiveSessions } from "./active-interactive-sessions.js";
import type { ContinueCommandArgs } from "./continue-command.types.js";
import { parseContinueInvocation } from "./parse-continue-invocation.js";

interface InteractiveSessionProtocol {
  readonly raw: Record<string, unknown>;
  readonly status: string;
  readonly stepDir: string;
  readonly outputFile: string;
  readonly interactiveFile: string;
  readonly outputSchema: Record<string, unknown>;
  readonly outputMode?: string;
  readonly runDir?: string;
  readonly runRelativeStepDir?: string;
  readonly sessionDescriptionFile?: string;
}

type SubmittedOutputArgs = Extract<
  ContinueCommandArgs,
  { readonly mode: "session-file" } | { readonly mode: "json-file" } | { readonly mode: "json" }
>;

interface ContinueTarget {
  readonly interactiveFile: string;
  readonly outputArgs: SubmittedOutputArgs | { readonly mode: "selected" };
}

export const continueCommand: CliCommand<ContinueCommandArgs> = {
  name: "continue",
  parseArgs: parseContinueInvocation,
  async run(args, context) {
    if (args.mode === "run") {
      return await continueWaitingRun(args.runNameOrRunDir, context);
    }

    const target = await resolveContinueTarget(args, context);
    const interactive = await loadInteractiveSession(target.interactiveFile);
    validateInteractiveSessionPaths(target.interactiveFile, interactive);
    const output = await loadSubmittedOutput(target.outputArgs, interactive, context);
    validateOutput(output, interactive.outputSchema);

    await safeWriteJson(interactive.outputFile, output);
    await safeWriteJson(target.interactiveFile, { ...interactive.raw, status: "completed" });
    context.io.writeLine(
      interactive.outputMode === "session-file"
        ? `Interactive session completed: ${output.sessionFile as string}`
        : "Interactive session completed.",
    );
    return 0;
  },
};

async function continueWaitingRun(
  runNameOrRunDir: string,
  context: CliCommandContext,
): Promise<number> {
  const resolvedRun = await resolveRunDirectory(runNameOrRunDir, context);
  const events = await readEventsForRun(resolvedRun.runDir);
  const startedEvent = events.find((event) => event.type === "workflow.started");
  if (!startedEvent) {
    context.io.writeError(`Run has no workflow.started event: ${resolvedRun.runDir}`);
    return 1;
  }

  const pendingWait = findLatestPendingWait(events);
  if (!pendingWait) {
    context.io.writeError(`Run is not waiting: ${resolvedRun.runDir}`);
    return 1;
  }

  const answerFile = readWaitAnswerFile(pendingWait);
  if (!answerFile) {
    context.io.writeError(
      `Pending wait ${String(pendingWait.payload.waitId ?? "<missing>")} has no answer artifact.`,
    );
    return 1;
  }

  try {
    await readFile(resolve(resolvedRun.runDir, answerFile), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      context.io.writeLine(
        `Workflow still waiting: ${basename(resolvedRun.runDir)} (${String(
          pendingWait.payload.waitId ?? "<missing>",
        )})`,
      );
      context.io.writeLine(`Missing answer: ${answerFile}`);
      return 0;
    }
    throw error;
  }

  const workflowRef =
    (await readRunWorkflowRef(resolvedRun.runDir)) ?? readWorkflowRef(startedEvent);
  if (!workflowRef) {
    context.io.writeError(
      `Run ${basename(resolvedRun.runDir)} does not record a workflowRef and cannot be continued.`,
    );
    return 1;
  }

  const trailstepConfig = await loadTrailStepConfig(context.cwd, { homeDir: context.homeDir });
  const resolvedWorkflow = await resolveWorkflowReference(workflowRef, {
    cwd: context.cwd,
    homeDir: context.homeDir,
  });
  if (!resolvedWorkflow) {
    context.io.writeError(
      `Workflow not found for continue: ${workflowRef}. Run trailstep workflows to see available workflows.`,
    );
    return 1;
  }

  const terminalEventLogger = createTerminalEventLogger(context.io);
  const eventSink = (event: Event): void | Promise<void> => {
    terminalEventLogger(event);
    return context.eventSink?.(event);
  };
  const result = await runWorkflow({
    workflow: resolvedWorkflow.workflow,
    cwd: context.cwd,
    eventSink,
    ...(context.processRunner === undefined ? {} : { processRunner: context.processRunner }),
    ...(context.workingAgentProcessRunner === undefined
      ? {}
      : { workingAgentProcessRunner: context.workingAgentProcessRunner }),
    ...(trailstepConfig === undefined ? {} : { trailstepConfig }),
    continue: { runDir: resolvedRun.runDir },
  });

  if (result.status === "success") {
    context.io.writeLine(`Workflow completed: ${resolvedWorkflow.id} at ${result.runDir}`);
    return 0;
  }

  if (result.status === "waiting") {
    context.io.writeLine(`Workflow waiting: ${result.runId}`);
    context.io.writeLine("");
    context.io.writeLine(`Waiting for ${result.wait.waitId}:`);
    context.io.writeLine(`  ${result.wait.message}`);
    return 0;
  }

  context.io.writeError(
    `Workflow failed: ${resolvedWorkflow.id} at ${result.runDir}: ${result.failure.message}`,
  );
  return 1;
}

function readWorkflowRef(startedEvent: Event): string | undefined {
  const workflowRef = startedEvent.payload.workflowRef;
  if (typeof workflowRef === "string" && workflowRef.length > 0) {
    return workflowRef;
  }

  return startedEvent.workflowId;
}

async function resolveContinueTarget(
  args: ContinueCommandArgs,
  context: CliCommandContext,
): Promise<ContinueTarget> {
  if (args.mode === "select") {
    const interactiveFile = await promptForInteractiveSession(context);
    return { interactiveFile, outputArgs: { mode: "selected" } };
  }

  if (args.mode === "interactive-file") {
    return { interactiveFile: args.path, outputArgs: { mode: "selected" } };
  }

  if (args.mode === "run") {
    throw new CliInputError("Run continue is handled before interactive continue resolution.");
  }

  const interactiveFile = context.env?.TRAILSTEP_INTERACTIVE_FILE;
  if (!interactiveFile) {
    throw new CliInputError(
      "TRAILSTEP_INTERACTIVE_FILE is required to continue an active interactive TrailStep session.",
    );
  }

  return { interactiveFile, outputArgs: args };
}

async function promptForInteractiveSession(context: CliCommandContext): Promise<string> {
  if (!context.prompts) {
    throw new CliInputError(
      "No-argument continue requires prompts and cannot run non-interactively.",
    );
  }

  const sessions = await findActiveInteractiveSessions(context.cwd);
  if (sessions.length === 0) {
    throw new CliInputError(
      "No active interactive TrailStep sessions found under .trailstep/runs.",
    );
  }

  const labels = sessions.map((session) => session.label);
  const selectedLabel = await context.prompts.select(
    "Select an active interactive session",
    labels,
  );
  const selected = sessions.find((session) => session.label === selectedLabel);
  if (!selected) {
    throw new CliInputError("Selected interactive session was not found.");
  }

  if (!context.prompts.confirm) {
    throw new CliInputError("No-argument continue requires confirmation prompts.");
  }

  const confirmed = await context.prompts.confirm(
    `Complete selected interactive session? ${selected.label}`,
  );
  if (!confirmed) {
    throw new CliInputError("Interactive session completion was not confirmed.");
  }

  return selected.interactiveFile;
}

async function loadInteractiveSession(
  interactiveFile: string,
): Promise<InteractiveSessionProtocol> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(interactiveFile, "utf8"));
  } catch (error) {
    throw new CliInputError(`Unable to read active interactive session: ${interactiveFile}`, {
      cause: error,
    });
  }

  if (!isPlainObject(parsed)) {
    throw new CliInputError("Active interactive session file must contain a JSON object.");
  }

  const protocol = parsed as Record<string, unknown>;
  if (protocol.status !== "active") {
    throw new CliInputError("Active interactive session is not active.");
  }

  const stepDir = requireString(protocol.stepDir, "stepDir");
  const outputFile = requireString(protocol.outputFile, "outputFile");
  const protocolInteractiveFile = requireString(protocol.interactiveFile, "interactiveFile");
  const outputMode = requireOutputModeField(protocol.outputMode);
  const outputSchema = protocol.outputSchema;
  if (!isPlainObject(outputSchema)) {
    throw new CliInputError("Active interactive session is missing outputSchema.");
  }

  return {
    raw: protocol,
    status: "active",
    stepDir,
    outputFile,
    outputSchema,
    outputMode,
    interactiveFile: protocolInteractiveFile,
    runDir: typeof protocol.runDir === "string" ? protocol.runDir : undefined,
    runRelativeStepDir:
      typeof protocol.runRelativeStepDir === "string" ? protocol.runRelativeStepDir : undefined,
    sessionDescriptionFile:
      typeof protocol.sessionDescriptionFile === "string"
        ? protocol.sessionDescriptionFile
        : undefined,
  };
}

function requireOutputModeField(value: unknown): "session-file" | "json" {
  if (value === "session-file" || value === "json") {
    return value;
  }

  throw new CliInputError("Active interactive session is missing outputMode.");
}

function requireString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new CliInputError(`Active interactive session is missing ${field}.`);
}

function resolveAgainstStepDir(stepDir: string, userPath: string): string {
  return isAbsolute(userPath) ? userPath : resolve(stepDir, userPath);
}

async function loadSubmittedOutput(
  args: ContinueTarget["outputArgs"],
  interactive: InteractiveSessionProtocol,
  context: CliCommandContext,
): Promise<PlainObject> {
  if (args.mode === "selected") {
    if (interactive.outputMode === "session-file") {
      if (!interactive.sessionDescriptionFile) {
        throw new CliInputError("Active interactive session is missing sessionDescriptionFile.");
      }
      return loadSessionFileOutput(
        interactive,
        interactive.sessionDescriptionFile,
        interactive.sessionDescriptionFile,
      );
    }

    requireOutputMode(interactive, "json");
    if (!context.prompts) {
      throw new CliInputError("JSON interactive continue requires prompts for JSON text.");
    }
    return parsePlainJsonObject(
      "interactive JSON",
      await context.prompts.text("Enter JSON output"),
    );
  }

  if (args.mode === "session-file") {
    requireOutputMode(interactive, "session-file");
    return loadSessionFileOutput(
      interactive,
      resolveAgainstStepDir(interactive.stepDir, args.path),
      args.path,
    );
  }

  requireOutputMode(interactive, "json");
  if (args.mode === "json") {
    return parsePlainJsonObject("--json", args.json);
  }

  const jsonFile = resolveAgainstStepDir(interactive.stepDir, args.path);
  let contents: string;
  try {
    contents = await readFile(jsonFile, "utf8");
  } catch (error) {
    throw new CliInputError(`Unable to read JSON file: ${args.path}`, { cause: error });
  }
  return parsePlainJsonObject(`JSON file ${args.path}`, contents);
}

async function loadSessionFileOutput(
  interactive: InteractiveSessionProtocol,
  sessionFile: string,
  displayPath: string,
): Promise<PlainObject> {
  const sessionFileContents = await readSessionFile(sessionFile, displayPath);
  if (sessionFileContents.trim().length === 0) {
    throw new CliInputError(`Session file is empty: ${displayPath}`);
  }

  const runDir = interactive.runDir ?? inferRunDir(interactive);
  return { sessionFile: toRunRelativePath(runDir, sessionFile) };
}

function requireOutputMode(
  interactive: InteractiveSessionProtocol,
  expected: "session-file" | "json",
): void {
  if (interactive.outputMode !== undefined && interactive.outputMode !== expected) {
    throw new CliInputError(
      `Active interactive session expects ${interactive.outputMode} output, not ${expected}.`,
    );
  }
}

function parsePlainJsonObject(label: string, source: string): PlainObject {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new CliInputError(`${label} must be valid JSON.`, { cause: error });
  }

  if (!isPlainObject(value)) {
    throw new CliInputError(`${label} must contain a plain JSON object.`);
  }

  return value;
}

function validateOutput(output: PlainObject, outputSchema: Record<string, unknown>): void {
  const schema = jsonSchema<PlainObject>(outputSchema);
  const diagnostics = schema.diagnostics(output);
  if (diagnostics.length > 0) {
    throw new CliInputError(
      `Interactive output failed schema validation: ${diagnostics
        .map((diagnostic) => `${diagnostic.path} ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
}

async function readSessionFile(path: string, displayPath: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new CliInputError(`Unable to read session file: ${displayPath}`, { cause: error });
  }
}

function inferRunDir(interactive: InteractiveSessionProtocol): string {
  if (!interactive.runRelativeStepDir) {
    throw new CliInputError("Active interactive session is missing runDir.");
  }

  return resolve(interactive.stepDir, ...interactive.runRelativeStepDir.split("/").map(() => ".."));
}

function toRunRelativePath(runDir: string, absolutePath: string): string {
  return relative(runDir, absolutePath).replaceAll("\\", "/");
}

function validateInteractiveSessionPaths(
  targetInteractiveFile: string,
  interactive: InteractiveSessionProtocol,
): void {
  if (resolve(targetInteractiveFile) !== resolve(interactive.interactiveFile)) {
    throw new CliInputError("Active interactive session path does not match interactiveFile.");
  }

  assertPathInside(interactive.stepDir, targetInteractiveFile, "interactiveFile");
  assertPathInside(interactive.stepDir, interactive.outputFile, "outputFile");
  if (interactive.sessionDescriptionFile !== undefined) {
    assertPathInside(
      interactive.stepDir,
      interactive.sessionDescriptionFile,
      "sessionDescriptionFile",
    );
  }
  if (interactive.runDir !== undefined) {
    assertPathInside(interactive.runDir, interactive.stepDir, "stepDir");
  }
}

function assertPathInside(parent: string, child: string, field: string): void {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  const relativePath = relative(normalizedParent, normalizedChild);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    return;
  }

  throw new CliInputError(`Active interactive session has unsafe ${field}.`);
}

async function safeWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
