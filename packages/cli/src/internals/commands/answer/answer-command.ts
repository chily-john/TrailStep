import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readRunEvents } from "@trailstep/core";

import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import { resolveRunsRoot } from "../../runs-root.js";

export interface AnswerCommandArgs {
  readonly runName: string;
  readonly waitId: string;
  readonly json?: string;
  readonly jsonFile?: string;
}

export const answerCommand: CliCommand<AnswerCommandArgs> = {
  name: "answer",
  parseArgs(argv: readonly string[]): AnswerCommandArgs {
    return parseAnswerInvocation(argv);
  },
  async run(args: AnswerCommandArgs, context: CliCommandContext): Promise<number> {
    const runDir = join(resolveRunsRoot(context), args.runName);
    const events = await readRunEvents(runDir);
    const waitStarted = events
      .slice()
      .reverse()
      .find(
        (event) =>
          event.type === "wait.started" &&
          typeof event.payload.waitId === "string" &&
          event.payload.waitId === args.waitId,
      );

    if (!waitStarted) {
      context.io.writeError(`Wait not found: ${args.waitId} in run ${args.runName}.`);
      return 1;
    }

    const artifactPaths = waitStarted.payload.artifactPaths;
    const answerFile =
      isArtifactPaths(artifactPaths) && typeof artifactPaths.answerFile === "string"
        ? artifactPaths.answerFile
        : undefined;
    if (!answerFile) {
      context.io.writeError(`Wait ${args.waitId} in run ${args.runName} has no answer artifact.`);
      return 1;
    }

    const answer = await loadAnswerJson(args, context.cwd);
    const outputPath = join(runDir, answerFile);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(answer, null, 2)}\n`, "utf8");
    context.io.writeLine(`Wrote wait answer: ${outputPath}`);
    return 0;
  },
};

function parseAnswerInvocation(argv: readonly string[]): AnswerCommandArgs {
  const [, runName, waitId, ...rest] = argv;
  if (!runName || !waitId) {
    throw new CliUsageError("trailstep answer requires <runName> <waitId>.");
  }

  let json: string | undefined;
  let jsonFile: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") {
      json = requireValue(rest, index, "--json");
      index += 1;
      continue;
    }
    if (arg === "--json-file") {
      jsonFile = requireValue(rest, index, "--json-file");
      index += 1;
      continue;
    }
    throw new CliUsageError(`Unknown trailstep answer option: ${arg}`);
  }

  if (
    (json === undefined && jsonFile === undefined) ||
    (json !== undefined && jsonFile !== undefined)
  ) {
    throw new CliUsageError("trailstep answer requires exactly one of --json or --json-file.");
  }

  return {
    runName,
    waitId,
    ...(json === undefined ? {} : { json }),
    ...(jsonFile === undefined ? {} : { jsonFile }),
  };
}

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value) {
    throw new CliUsageError(`${flag} requires a value.`);
  }
  return value;
}

async function loadAnswerJson(args: AnswerCommandArgs, cwd: string): Promise<unknown> {
  const text = args.json ?? (await readFile(join(cwd, args.jsonFile ?? ""), "utf8"));
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliUsageError(
      `Wait answer JSON is invalid: ${error instanceof Error ? error.message : "parse failed"}`,
    );
  }
}

function isArtifactPaths(value: unknown): value is { readonly answerFile: string } {
  return typeof value === "object" && value !== null && "answerFile" in value;
}
