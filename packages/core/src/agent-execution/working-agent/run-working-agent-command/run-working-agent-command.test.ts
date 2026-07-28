import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  Document,
  done,
  jsonSchema,
  parseStepKitConfig,
  runWorkflow,
  step,
  type Workflow,
  type WorkingAgentProcessRequest,
} from "../../../index.js";
import { createRunDirectory } from "../../../runtime/artifacts/run-storage.js";
import { createRunContext } from "../../../runtime/run-context/create-run-context.js";
import { runContextStorage } from "../../../runtime/run-context/run-context-storage.js";
import { withStepContext } from "../../../runtime/run-context/with-step-context.js";
import {
  buildProviderWorkingPrompt,
  buildWorkingAgentPrompt,
  readWorkingAgentOutput,
  runWorkingAgentCommand,
} from "./run-working-agent-command.js";

describe("runWorkingAgentCommand", () => {
  it("writes repeated working-agent outputs to distinct ordered step directories", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-working-agent-ordered-"));
    const requests: WorkingAgentProcessRequest[] = [];

    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "working-agent-ordered-artifacts-workflow",
      inputShape: { task: "string" },
      outputShape: { answer: "string" },
      agents: { reviewer: { size: "medium" } },
      start(input) {
        return step({ id: "prepare" }).do(() =>
          step({ id: "review" })
            .prompt(({ input }) => `First review for ${input.task}.`, {
              output: { answer: "string" },
              agent: "reviewer",
            })
            .do((first) =>
              step({ id: "record" }).do(() =>
                step({ id: "review" })
                  .prompt("Second review.", {
                    output: { answer: "string" },
                    agent: "reviewer",
                  })
                  .do((second) => done({ answer: `${first.answer}/${second.answer}` }))({}),
              )(first),
            )({ task: input.task }),
        )(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "repeat" },
      runName: "working-agent-ordered-artifacts-run",
      cwd,
      stepkitConfig: parseStepKitConfig({
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: { medium: [{ provider: "worker" }] },
      }),
      workingAgentProcessRunner: async (request) => {
        requests.push(request);
        await writeFile(
          request.outputFile,
          JSON.stringify({
            answer: request.outputFile.includes("0002-review") ? "first" : "second",
          }),
          "utf8",
        );
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    const firstOutputFile = join(result.runDir, "steps", "0002-review", "output.json");
    const secondOutputFile = join(result.runDir, "steps", "0004-review", "output.json");
    expect(requests.map((request) => request.outputFile)).toEqual([
      firstOutputFile,
      secondOutputFile,
    ]);
    expect(firstOutputFile).not.toBe(secondOutputFile);
    await expect(readFile(firstOutputFile, "utf8")).resolves.toContain("first");
    await expect(readFile(secondOutputFile, "utf8")).resolves.toContain("second");
    await expect(readdir(join(result.runDir, "steps"))).resolves.toEqual([
      "0002-review",
      "0004-review",
    ]);
    await expect(
      readFile(join(result.runDir, "steps", "0002-review", "prompt.md"), "utf8"),
    ).resolves.toContain(firstOutputFile);
    expect(
      result.events.filter((event) => event.type === "step.started").map((event) => event.stepId),
    ).toEqual(["prepare", "review", "record", "review"]);
  });

  it("falls back to the next working target and reports exhausted attempts when all targets fail", async () => {
    expect(runWorkingAgentCommand).toBeTypeOf("function");

    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-working-agent-exhausted-"));
    const requests: WorkingAgentProcessRequest[] = [];

    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "working-agent-exhausted-workflow",
      inputShape: { task: "string" },
      outputShape: { answer: "string" },
      agents: { reviewer: { size: "medium" } },
      start(input) {
        return step({
          id: "review",
        })
          .prompt(({ input }) => `Review ${input.task}.`, {
            output: { answer: "string" },
            agent: "reviewer",
          })
          .do((output) => done(output))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "fallback" },
      runName: "working-agent-exhausted-run",
      cwd,
      stepkitConfig: parseStepKitConfig({
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
        if (request.model === "second-model") {
          await writeFile(request.outputFile, JSON.stringify({ wrong: "shape" }), "utf8");
          return { exitCode: 0 };
        }
        return { exitCode: 7 };
      },
    });

    expect(requests.map((request) => request.model)).toEqual(["first-model", "second-model"]);
    for (const request of requests) {
      expect(request.cwd).toBe(cwd);
      expect(request.cwd).not.toBe(result.runDir);
    }
    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected all working targets to fail");
    }
    expect(result.failure.code).toBe("agent_target_exhausted");
    expect(result.failure.details).toMatchObject({
      roleName: "reviewer",
      attempts: [
        { target: "first", model: "first-model", code: "agent_provider_failed" },
        { target: "second", model: "second-model", code: "validation_failed" },
      ],
    });
  });
});

describe("raw-text capture mode", () => {
  describe("buildWorkingAgentPrompt", () => {
    it("swaps in document-writing instructions when captureMode is raw-text", () => {
      const prompt = buildWorkingAgentPrompt({
        prompt: "Write the changelog.",
        outputFile: "/run/steps/0001-doc/output.json",
        outputSchema: { type: "string" },
        captureMode: "raw-text",
      });

      expect(prompt).toContain("write the document content to the output file");
      expect(prompt).toContain("no JSON wrapper");
      expect(prompt).toContain("/run/steps/0001-doc/output.json");
      expect(prompt).toContain("Write the changelog.");
      expect(prompt).not.toContain("JSON object");
      expect(prompt).not.toContain("```json");
    });

    it("keeps the JSON-object instructions completely unchanged when captureMode is absent (regression)", () => {
      const prompt = buildWorkingAgentPrompt({
        prompt: "Summarize the PR.",
        outputFile: "/run/steps/0001-review/output.json",
        outputSchema: { type: "object", properties: { summary: { type: "string" } } },
      });

      expect(prompt).toContain("write exactly one JSON object");
      expect(prompt).toContain('"summary"');
      expect(prompt).toContain("Summarize the PR.");
      expect(prompt).not.toContain("document content");
    });
  });

  describe("buildProviderWorkingPrompt", () => {
    it("swaps in document-writing instructions when captureMode is raw-text", () => {
      const prompt = buildProviderWorkingPrompt({
        prompt: "Write the changelog.",
        outputSchema: { type: "string" },
        captureMode: "raw-text",
      });

      expect(prompt).toContain("Print the document content directly");
      expect(prompt).toContain("Do not write output to a file.");
      expect(prompt).not.toContain("JSON object");
    });

    it("keeps the JSON-envelope instructions completely unchanged when captureMode is absent (regression)", () => {
      const prompt = buildProviderWorkingPrompt({
        prompt: "Summarize the PR.",
        outputSchema: { type: "object", properties: { summary: { type: "string" } } },
      });

      expect(prompt).toContain("Respond with exactly one JSON object");
      expect(prompt).toContain('"summary"');
      expect(prompt).not.toContain("document content");
    });
  });

  describe("readWorkingAgentOutput", () => {
    it("writes a document artifact under the current step's directory and returns an asserted Document, skipping JSON.parse", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-working-agent-rawtext-"));
      const { runId, runDir } = await createRunDirectory({ cwd, runName: "write-doc-run" });
      const runContext = createRunContext({ runId, runName: "write-doc-run", runDir });
      const stepDir = join(runDir, "steps", "0001-write-doc");
      const outputFile = join(cwd, "output.json");
      await writeFile(outputFile, "# Not JSON\n\nJust markdown prose.", "utf8");

      const doc = await runContextStorage.run(runContext, () =>
        withStepContext("write-doc", stepDir, () =>
          readWorkingAgentOutput({
            stepId: "write-doc",
            outputFile,
            step: {
              id: "write-doc",
              output: Document,
              prompt: "unused",
              requirements: { size: "default" },
            },
          }),
        ),
      );

      expect(doc).toBeInstanceOf(Document);
      expect(doc).toMatchObject({
        content: "# Not JSON\n\nJust markdown prose.",
        path: join(stepDir, "document-1.md"),
      });
      await expect(readFile(join(stepDir, "document-1.md"), "utf8")).resolves.toBe(
        "# Not JSON\n\nJust markdown prose.",
      );
    });

    it("still requires JSON.parse to succeed when captureMode is absent (regression)", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-working-agent-json-regression-"));
      const outputFile = join(cwd, "output.json");
      await writeFile(outputFile, "this is not JSON", "utf8");

      await expect(
        readWorkingAgentOutput({
          stepId: "summarize",
          outputFile,
          step: {
            id: "summarize",
            output: jsonSchema({
              type: "object",
              properties: { summary: { type: "string" } },
              required: ["summary"],
            }),
            prompt: "unused",
            requirements: { size: "default" },
          },
        }),
      ).rejects.toMatchObject({
        failure: { code: "agent_output_invalid_json" },
      });

      await expect(readdir(cwd)).resolves.not.toContain("documents");
    });
  });

  describe("runWorkingAgentCommand end-to-end", () => {
    it("captures a working agent's raw stdout as a Document under the step's own artifact directory", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-working-agent-doc-e2e-"));

      const workflow: Workflow<{ topic: string }, { path: string; content: string }> = {
        id: "working-agent-document-workflow",
        inputShape: { topic: "string" },
        outputShape: { path: "string", content: "string" },
        agents: { writer: { size: "medium" } },
        start(input) {
          return step({ id: "write" })
            .prompt(({ input }) => `Write notes about ${input.topic}.`, {
              output: Document,
              agent: "writer",
            })
            .do((doc) => done({ path: doc.path, content: doc.content }))(input);
        },
      };

      const result = await runWorkflow({
        workflow,
        input: { topic: "raw-text capture" },
        runName: "working-agent-document-run",
        cwd,
        stepkitConfig: parseStepKitConfig({
          version: 1,
          customProviders: { worker: { binary: "worker-agent" } },
          agents: { medium: [{ provider: "worker" }] },
        }),
        workingAgentProcessRunner: async (request) => {
          await writeFile(request.outputFile, "# Notes\n\nSome free-form prose, not JSON.", "utf8");
          return { exitCode: 0 };
        },
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        throw new Error(result.failure.message);
      }

      const documentPath = join(result.runDir, "steps", "0001-write", "document-1.md");
      expect(result.output).toEqual({
        path: documentPath,
        content: "# Notes\n\nSome free-form prose, not JSON.",
      });

      await expect(readFile(documentPath, "utf8")).resolves.toBe(
        "# Notes\n\nSome free-form prose, not JSON.",
      );
    });
  });
});
