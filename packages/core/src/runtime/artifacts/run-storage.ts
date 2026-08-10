import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { StepKitFailureError } from "../../contracts/failures/failure.js";
import type { Event } from "../../runtime/run-workflow/run-workflow.types.js";

export type RunState = Record<string, unknown>;

export function defaultRunsRoot(cwd: string): string {
  return join(cwd, ".trailstep", "runs");
}

export async function createRunDirectory(options: {
  readonly cwd: string;
  readonly runName: string;
  readonly runsRoot?: string;
}): Promise<{ runId: string; runDir: string }> {
  const runsRoot = options.runsRoot ?? defaultRunsRoot(options.cwd);
  await mkdir(runsRoot, { recursive: true });
  await ensureStepkitGitignoreForRunsRoot(runsRoot);

  for (let suffix = 1; ; suffix += 1) {
    const runId = suffix === 1 ? options.runName : `${options.runName}-${suffix}`;
    const runDir = join(runsRoot, runId);

    try {
      await mkdir(runDir);
      return { runId, runDir };
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        continue;
      }

      throw error;
    }
  }
}

export async function appendEvent(runDir: string, event: Event): Promise<void> {
  await appendFile(join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}

export async function readRunEvents(runDir: string): Promise<Event[]> {
  let contents: string;
  try {
    contents = await readFile(join(runDir, "events.jsonl"), "utf8");
  } catch (error) {
    if (isNodeError(error)) {
      throw new StepKitFailureError({
        code: "resume_target_not_found",
        message: `Resume target not found or unreadable: ${join(runDir, "events.jsonl")}.`,
        details: { runDir, causeCode: error.code },
      });
    }

    throw error;
  }

  const rawLines = contents.split("\n");
  const lines = rawLines.filter((line, index) => line.length > 0 || index < rawLines.length - 1);
  const events: Event[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }

    try {
      events.push(JSON.parse(line) as Event);
    } catch (error) {
      const isTrailingLine = index === lines.length - 1;
      if (isTrailingLine) {
        return events;
      }

      throw error;
    }
  }

  return events;
}

export async function persistEvents(runDir: string, events: readonly Event[]): Promise<void> {
  const jsonl = events.map((event) => JSON.stringify(event)).join("\n");
  await writeFile(join(runDir, "events.jsonl"), `${jsonl}\n`, "utf8");
}

export async function writeDocumentArtifact(
  dir: string,
  filename: string,
  content: string,
): Promise<string> {
  await mkdir(dir, { recursive: true });

  const documentPath = join(dir, filename);
  await writeFile(documentPath, content, "utf8");

  return documentPath;
}

export async function readRunState(runDir: string): Promise<RunState> {
  try {
    const contents = await readFile(join(runDir, "state.json"), "utf8");
    const parsed: unknown = JSON.parse(contents);

    if (!isRunState(parsed)) {
      throw new Error("run state must be a JSON object");
    }

    return parsed;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

export async function writeRunState(runDir: string, state: RunState): Promise<void> {
  await writeFile(join(runDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRunState(value: unknown): value is RunState {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

async function ensureStepkitGitignoreForRunsRoot(runsRoot: string): Promise<void> {
  const stepkitRoot = dirname(runsRoot);
  if (basename(stepkitRoot) !== ".trailstep") {
    return;
  }

  await ensureStepkitGitignore(stepkitRoot);
}

async function ensureStepkitGitignore(stepkitRoot: string): Promise<void> {
  try {
    await writeFile(join(stepkitRoot, ".gitignore"), "*\n!.gitignore\n", { flag: "wx" });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return;
    }

    throw error;
  }
}
