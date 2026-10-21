import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Event, Workflow, WorkingAgentProcessRequest } from "@trailstep/core";
import { defineWorkflow, done, step } from "@trailstep/core";
import { describe, expect, it } from "vitest";

import {
  cleanupTmpProjects,
  expectEventSequence,
  fakeOutputFileHandler,
  runWorkflowWithStubs,
  stubSubWorkflow,
  tmpGitRepo,
  tmpProject,
} from "./index.js";

function agentRequest(outputFile: string): WorkingAgentProcessRequest {
  return {
    command: "stub-agent",
    args: [],
    cwd: dirname(dirname(outputFile)),
    shell: false,
    stdio: "pipe",
    promptFile: join(dirname(outputFile), "prompt.txt"),
    outputFile,
  };
}

function eventsFor(
  ...types: readonly Event["type"][]
): readonly { readonly type: Event["type"] }[] {
  return types.map((type) => ({ type }));
}

const agentWorkflow: Workflow<{ task: string }, { answer: string }> = {
  id: "stubbed-agent-workflow",
  inputShape: { task: "string" },
  outputShape: { answer: "string" },
  agents: { reviewer: { size: "small" } },
  start(input) {
    return step({ id: "review" })
      .prompt(({ input }) => `Review ${input.task}.`, {
        agent: "reviewer",
        output: { answer: "string" },
      })
      .do((output) => done(output))(input);
  },
};

describe("sandbox helpers", () => {
  it("tmpProject creates unique sandbox directories", () => {
    const first = tmpProject("trailtest-check-");
    const second = tmpProject("trailtest-check-");
    expect(first).not.toBe(second);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
  });

  it("tmpGitRepo creates a committed, clean git worktree", () => {
    const repo = tmpGitRepo("trailtest-repo-check-");
    expect(existsSync(join(repo, ".git"))).toBe(true);
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(status.trim()).toBe("");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
    expect(head.trim()).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("fakeOutputFileHandler", () => {
  it("writes object outputs as JSON and returns the route exit code", async () => {
    const outputFile = join(tmpProject(), "steps", "0001-review-story", "output.json");
    mkdirSync(dirname(outputFile), { recursive: true });
    const handler = fakeOutputFileHandler({ "review-story": { output: { summary: "ok" } } });

    const result = await handler(agentRequest(outputFile));

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(outputFile, "utf8"))).toEqual({ summary: "ok" });
  });

  it("writes string outputs verbatim and honors non-zero exit codes without writing", async () => {
    const project = tmpProject();
    const stringFile = join(project, "steps", "0001-explore", "output.json");
    const failFile = join(project, "steps", "0001-implement", "output.json");
    mkdirSync(dirname(stringFile), { recursive: true });
    mkdirSync(dirname(failFile), { recursive: true });
    const handler = fakeOutputFileHandler({
      explore: "# Notes",
      implement: { exitCode: 1 },
    });

    const stringResult = await handler(agentRequest(stringFile));
    const failResult = await handler(agentRequest(failFile));

    expect(stringResult.exitCode).toBe(0);
    expect(readFileSync(stringFile, "utf8")).toBe("# Notes");
    expect(failResult.exitCode).toBe(1);
    expect(existsSync(failFile)).toBe(false);
  });

  it("prefers the longest matching substring", async () => {
    const outputFile = join(tmpProject(), "steps", "0001-story-router", "output.json");
    const handler = fakeOutputFileHandler({
      story: { output: { route: "broad" } },
      "story-router": { output: { route: "specific" } },
    });

    await handler(agentRequest(outputFile));

    expect(JSON.parse(readFileSync(outputFile, "utf8"))).toEqual({ route: "specific" });
  });

  it("throws for requests that match no route", async () => {
    const outputFile = join(tmpProject(), "steps", "0001-unmatched", "output.json");
    const handler = fakeOutputFileHandler({});

    await expect(handler(agentRequest(outputFile))).rejects.toThrow(
      "Unexpected working-agent request",
    );
  });
});

describe("expectEventSequence", () => {
  const actual = eventsFor(
    "workflow.started",
    "step.started",
    "step.display",
    "step.completed",
    "workflow.completed",
  );

  it("passes for an ordered subsequence with interleaved events", () => {
    expect(() =>
      expectEventSequence(actual, ["workflow.started", "step.completed", "workflow.completed"]),
    ).not.toThrow();
    expect(() => expectEventSequence(actual, [])).not.toThrow();
  });

  it("fails with the expected index, expected type, and actual types", () => {
    const attempt = () =>
      expectEventSequence(actual, ["workflow.started", "step.failed", "workflow.completed"]);

    expect(attempt).toThrow(/expected index 1 of 3: expected "step.failed"/);
    expect(attempt).toThrow(/Matched prefix: \["workflow.started"\]/);
    expect(attempt).toThrow(/"step.display"/);
    expect(attempt).toThrow(/"workflow.completed"/);
  });
});

describe("runWorkflowWithStubs", () => {
  // These tests run a real workflow (sandbox creation, event writes, artifact
  // output), so they can exceed Vitest's 5s default when the suite runs under
  // parallel load. Give them room instead of letting them flake.
  const WORKFLOW_TIMEOUT_MS = 30_000;

  it("answers agent steps by stepId with canned outputs and no subprocess", {
    timeout: WORKFLOW_TIMEOUT_MS,
  }, async () => {
    const result = await runWorkflowWithStubs(
      agentWorkflow,
      { task: "hello" },
      {
        stubs: { review: { output: { answer: "stubbed answer" } } },
      },
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ answer: "stubbed answer" });
    expectEventSequence(result.events, [
      "workflow.started",
      "step.started",
      "step.completed",
      "workflow.completed",
    ]);
  });

  it("fails the workflow when a stub returns a non-zero exit code", {
    timeout: WORKFLOW_TIMEOUT_MS,
  }, async () => {
    const result = await runWorkflowWithStubs(
      agentWorkflow,
      { task: "hello" },
      {
        stubs: { review: { exitCode: 1 } },
      },
    );

    expect(result.status).toBe("failure");
  });

  it("fails the workflow when an agent step has no stub", {
    timeout: WORKFLOW_TIMEOUT_MS,
  }, async () => {
    const result = await runWorkflowWithStubs(agentWorkflow, { task: "hello" }, { stubs: {} });

    expect(result.status).toBe("failure");
  });

  it("runs wrapper workflows against a stubbed sub-workflow", {
    timeout: WORKFLOW_TIMEOUT_MS,
  }, async () => {
    const sub = stubSubWorkflow<{ ok: boolean }>("inner-workflow", { ok: true });
    const wrapper = defineWorkflow<{ rounds: number }, { ok: boolean }>({
      id: "wrapper-workflow",
      inputShape: { rounds: "number" },
      outputShape: { ok: "boolean" },
      start: (input) => sub(input),
    });

    const result = await runWorkflowWithStubs(wrapper, { rounds: 2 }, { stubs: {} });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ ok: true });
    expectEventSequence(result.events, ["workflow.started", "workflow.completed"]);
  });
});

describe("auto-cleanup", () => {
  it("cleanupTmpProjects removes every sandbox directory", () => {
    const project = tmpProject("trailtest-cleanup-");
    const repo = tmpGitRepo("trailtest-cleanup-repo-");
    expect(existsSync(project)).toBe(true);
    expect(existsSync(repo)).toBe(true);

    cleanupTmpProjects();

    expect(existsSync(project)).toBe(false);
    expect(existsSync(repo)).toBe(false);
  });
});
