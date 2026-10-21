import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Event } from "@trailstep/core";
import { describe, expect, it } from "vitest";
import type { CliCommandContext, TrailStepCliIo } from "../../command-framework/command.types.js";
import { answerCommand } from "./answer-command.js";

function waitEvent(options: {
  readonly type: Event["type"];
  readonly stepId?: string;
  readonly waitId?: string;
  readonly branchId?: string;
  readonly answerFile?: string;
}): Event {
  return {
    id: `evt-${options.type}-${options.branchId ?? "root"}-${options.waitId ?? "none"}`,
    runId: "run",
    workflowId: "workflow",
    stepId: options.stepId,
    type: options.type,
    timestamp: new Date().toISOString(),
    schemaVersion: "v0",
    payload: {
      ...(options.waitId === undefined ? {} : { waitId: options.waitId }),
      ...(options.branchId === undefined ? {} : { branchId: options.branchId }),
      ...(options.answerFile === undefined
        ? {}
        : { artifactPaths: { answerFile: options.answerFile } }),
    },
  };
}

function tmpRunDir(name: string): string {
  return join("node_modules", ".tmp-trailstep-answer-tests", name);
}

function createIo(): TrailStepCliIo & { readonly errors: string[]; readonly lines: string[] } {
  const errors: string[] = [];
  const lines: string[] = [];
  return {
    errors,
    lines,
    writeLine: (line: string) => lines.push(line),
    writeError: (line: string) => errors.push(line),
  };
}

function createContext(cwd: string, io: ReturnType<typeof createIo>): CliCommandContext {
  return { cwd, io, env: {} };
}

async function writeRunEvents(runDir: string, events: readonly Event[]): Promise<void> {
  await rm(runDir, { recursive: true, force: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "events.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n"),
    "utf8",
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const threeBranchWaits = [
  waitEvent({ type: "workflow.started" }),
  waitEvent({
    type: "wait.started",
    stepId: "ask",
    waitId: "ask",
    branchId: "branch-a",
    answerFile: "steps/0002-ask/waits/ask/answer.json",
  }),
  waitEvent({
    type: "wait.started",
    stepId: "ask",
    waitId: "ask",
    branchId: "branch-b",
    answerFile: "steps/0003-ask/waits/ask/answer.json",
  }),
  waitEvent({
    type: "wait.started",
    stepId: "ask",
    waitId: "ask",
    branchId: "branch-c",
    answerFile: "steps/0004-ask/waits/ask/answer.json",
  }),
];

describe("answer command branch addressing", () => {
  it("errors with waiting branchIds for a bare ambiguous waitId and writes nothing", async () => {
    const runDir = tmpRunDir("ambiguous");
    await writeRunEvents(runDir, threeBranchWaits);
    const io = createIo();

    const exitCode = await answerCommand.run(
      { runNameOrRunDir: runDir, waitId: "ask", json: '{"approved":true}' },
      createContext(process.cwd(), io),
    );

    expect(exitCode).toBe(1);
    expect(io.errors.join("\n")).toContain("branch-a");
    expect(io.errors.join("\n")).toContain("branch-b");
    expect(io.errors.join("\n")).toContain("branch-c");
    expect(io.errors.join("\n")).toContain("--branch");
    await expect(pathExists(join(runDir, "steps"))).resolves.toBe(false);
  });

  it("answers only the addressed branch via --branch", async () => {
    const runDir = tmpRunDir("branch-addressed");
    await writeRunEvents(runDir, threeBranchWaits);
    const io = createIo();

    const exitCode = await answerCommand.run(
      {
        runNameOrRunDir: runDir,
        waitId: "ask",
        branchId: "branch-b",
        json: '{"approved":"branch-b"}',
      },
      createContext(process.cwd(), io),
    );

    expect(exitCode).toBe(0);
    await expect(
      readFile(join(runDir, "steps/0003-ask/waits/ask/answer.json"), "utf8"),
    ).resolves.toContain("branch-b");
    await expect(pathExists(join(runDir, "steps/0002-ask/waits/ask/answer.json"))).resolves.toBe(
      false,
    );
    await expect(pathExists(join(runDir, "steps/0004-ask/waits/ask/answer.json"))).resolves.toBe(
      false,
    );
  });

  it("errors and writes nothing for an unknown --branch", async () => {
    const runDir = tmpRunDir("unknown-branch");
    await writeRunEvents(runDir, threeBranchWaits);
    const io = createIo();

    const exitCode = await answerCommand.run(
      {
        runNameOrRunDir: runDir,
        waitId: "ask",
        branchId: "branch-missing",
        json: '{"approved":true}',
      },
      createContext(process.cwd(), io),
    );

    expect(exitCode).toBe(1);
    expect(io.errors.join("\n")).toContain("branch-missing");
    await expect(pathExists(join(runDir, "steps"))).resolves.toBe(false);
  });

  it("still answers an unbranched wait by bare waitId", async () => {
    const runDir = tmpRunDir("root-wait");
    await writeRunEvents(runDir, [
      waitEvent({ type: "workflow.started" }),
      waitEvent({
        type: "wait.started",
        stepId: "ask",
        waitId: "ask",
        answerFile: "steps/0001-ask/waits/ask/answer.json",
      }),
    ]);
    const io = createIo();

    const exitCode = await answerCommand.run(
      { runNameOrRunDir: runDir, waitId: "ask", json: '{"approved":true}' },
      createContext(process.cwd(), io),
    );

    expect(exitCode).toBe(0);
    await expect(
      readFile(join(runDir, "steps/0001-ask/waits/ask/answer.json"), "utf8"),
    ).resolves.toContain('"approved": true');
  });

  it("does not treat a resolved branch wait as pending for a bare waitId", async () => {
    const runDir = tmpRunDir("resolved-branch");
    await writeRunEvents(runDir, [
      ...threeBranchWaits,
      waitEvent({
        type: "wait.satisfied",
        stepId: "ask",
        waitId: "ask",
        branchId: "branch-a",
        answerFile: "steps/0002-ask/waits/ask/answer.json",
      }),
    ]);
    const io = createIo();

    const exitCode = await answerCommand.run(
      {
        runNameOrRunDir: runDir,
        waitId: "ask",
        branchId: "branch-a",
        json: '{"approved":true}',
      },
      createContext(process.cwd(), io),
    );

    expect(exitCode).toBe(1);
    expect(io.errors.join("\n")).toContain("branch-a");
    await expect(pathExists(join(runDir, "steps"))).resolves.toBe(false);
  });

  it("writes the wait answer atomically so a concurrent reader never sees a partial file", async () => {
    const runDir = tmpRunDir("atomic-answer");
    const answerFile = "steps/0001-ask/waits/ask/answer.json";
    await writeRunEvents(runDir, [
      waitEvent({ type: "workflow.started" }),
      waitEvent({ type: "wait.started", stepId: "ask", waitId: "ask", answerFile }),
    ]);

    // Seed a sizeable previous answer so the concurrent reader has something
    // to observe before the replacement lands.
    const answerPath = join(runDir, answerFile);
    const oldAnswer = { blob: "old".repeat(200_000) };
    const oldText = `${JSON.stringify(oldAnswer, null, 2)}\n`;
    await mkdir(dirname(answerPath), { recursive: true });
    await writeFile(answerPath, oldText, "utf8");

    const newAnswer = { approved: true, blob: "new".repeat(200_000) };
    const newText = `${JSON.stringify(newAnswer, null, 2)}\n`;

    // Poll the answer file for the whole duration of the command. With a
    // tmp+rename write every observed snapshot must be one of the two complete
    // documents; a partial (in-place) write would show up as anything else.
    const observed: string[] = [];
    let reading = true;
    const concurrentReader = (async () => {
      while (reading) {
        try {
          const content = await readFile(answerPath, "utf8");
          if (observed.length < 50) {
            observed.push(content);
          }
        } catch {
          // A transiently missing file mid-replace is not a partial read.
        }
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
    })();

    const io = createIo();
    const exitCode = await answerCommand.run(
      { runNameOrRunDir: runDir, waitId: "ask", json: JSON.stringify(newAnswer) },
      createContext(process.cwd(), io),
    );
    reading = false;
    await concurrentReader;

    expect(exitCode).toBe(0);
    expect(io.errors).toEqual([]);
    expect(observed.length).toBeGreaterThan(0);
    for (const content of observed) {
      expect(content === oldText || content === newText).toBe(true);
    }
    await expect(readFile(answerPath, "utf8")).resolves.toBe(newText);

    // Atomic tmp+rename: no temporary file survives anywhere in the run.
    const leftovers = await readdir(runDir, { recursive: true });
    expect(leftovers.filter((file) => file.includes(".tmp"))).toEqual([]);
  });
});
