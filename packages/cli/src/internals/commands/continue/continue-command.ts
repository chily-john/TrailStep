import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { jsonSchema, type PlainObject } from "@stepkit/core";

import type { CliCommand } from "../../command.types.js";
import { CliInputError } from "../run/load-run-input.js";
import type { ContinueCommandArgs } from "./continue-command.types.js";
import { parseContinueInvocation } from "./parse-continue-invocation.js";

interface InteractiveSessionProtocol {
  readonly raw: Record<string, unknown>;
  readonly status: string;
  readonly stepDir: string;
  readonly outputFile: string;
  readonly interactiveFile?: string;
  readonly outputSchema: Record<string, unknown>;
  readonly outputMode?: string;
  readonly runDir?: string;
  readonly runRelativeStepDir?: string;
}

export const continueCommand: CliCommand<ContinueCommandArgs> = {
  name: "continue",
  parseArgs: parseContinueInvocation,
  async run(args, context) {
    const interactiveFile = context.env?.STEPKIT_INTERACTIVE_FILE;
    if (!interactiveFile) {
      throw new CliInputError(
        "STEPKIT_INTERACTIVE_FILE is required to continue an active interactive StepKit session.",
      );
    }

    const interactive = await loadInteractiveSession(interactiveFile);
    const output = await loadSubmittedOutput(args, interactive);
    validateOutput(output, interactive.outputSchema);

    await safeWriteJson(interactive.outputFile, output);
    await safeWriteJson(interactiveFile, { ...interactive.raw, status: "completed" });
    context.io.writeLine(
      args.mode === "session-file"
        ? `Interactive session completed: ${output.sessionFile as string}`
        : "Interactive session completed.",
    );
    return 0;
  },
};

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
  args: ContinueCommandArgs,
  interactive: InteractiveSessionProtocol,
): Promise<PlainObject> {
  if (args.mode === "session-file") {
    requireOutputMode(interactive, "session-file");
    const sessionFile = resolveAgainstStepDir(interactive.stepDir, args.path);
    const sessionFileContents = await readSessionFile(sessionFile, args.path);
    if (sessionFileContents.trim().length === 0) {
      throw new CliInputError(`Session file is empty: ${args.path}`);
    }

    const runDir = interactive.runDir ?? inferRunDir(interactive);
    return { sessionFile: toRunRelativePath(runDir, sessionFile) };
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

async function safeWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
