import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import { continueCommand } from "../continue/continue-command.js";
import {
  findPendingWaitById,
  readEventsForRun,
  readWaitAnswerFile,
  resolveRunDirectory,
} from "../wait-run-helpers.js";

export interface AnswerCommandArgs {
  readonly runNameOrRunDir: string;
  readonly waitId: string;
  readonly json?: string;
  readonly jsonFile?: string;
  readonly continueAfterAnswer?: boolean;
}

export const answerCommand: CliCommand<AnswerCommandArgs> = {
  name: "answer",
  parseArgs(argv: readonly string[]): AnswerCommandArgs {
    return parseAnswerInvocation(argv);
  },
  async run(args: AnswerCommandArgs, context: CliCommandContext): Promise<number> {
    const resolvedRun = await resolveRunDirectory(args.runNameOrRunDir, context);
    const events = await readEventsForRun(resolvedRun.runDir);
    const waitStarted = findPendingWaitById(events, args.waitId);

    if (!waitStarted) {
      context.io.writeError(
        `Pending wait not found: ${args.waitId} in run ${args.runNameOrRunDir}.`,
      );
      return 1;
    }

    const answerFile = readWaitAnswerFile(waitStarted);
    if (!answerFile) {
      context.io.writeError(
        `Wait ${args.waitId} in run ${args.runNameOrRunDir} has no answer artifact.`,
      );
      return 1;
    }

    const answer = await loadAnswerJson(args, context.cwd);
    const outputPath = join(resolvedRun.runDir, answerFile);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(answer, null, 2)}\n`, "utf8");
    context.io.writeLine(`Wrote wait answer: ${outputPath}`);

    if (args.continueAfterAnswer) {
      return await continueCommand.run(
        { mode: "run", runNameOrRunDir: args.runNameOrRunDir },
        context,
      );
    }

    return 0;
  },
};

function parseAnswerInvocation(argv: readonly string[]): AnswerCommandArgs {
  const [, runNameOrRunDir, waitId, ...rest] = argv;
  if (!runNameOrRunDir || !waitId) {
    throw new CliUsageError("trailstep answer requires <runNameOrRunDir> <waitId>.");
  }

  let json: string | undefined;
  let jsonFile: string | undefined;
  let continueAfterAnswer = false;
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
    if (arg === "--continue") {
      continueAfterAnswer = true;
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
    runNameOrRunDir,
    waitId,
    ...(json === undefined ? {} : { json }),
    ...(jsonFile === undefined ? {} : { jsonFile }),
    ...(continueAfterAnswer ? { continueAfterAnswer } : {}),
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
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch (error) {
    throw new CliUsageError(
      `Wait answer JSON is invalid: ${error instanceof Error ? error.message : "parse failed"}`,
    );
  }

  if (!isPlainObject(answer)) {
    throw new CliUsageError("Wait answer JSON must be a plain JSON object.");
  }

  return answer;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
