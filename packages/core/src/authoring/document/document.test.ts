import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRunDirectory } from "../../runtime/artifacts/run-storage.js";
import { createRunContext } from "../../runtime/run-context/create-run-context.js";
import { runContextStorage } from "../../runtime/run-context/run-context-storage.js";
import { withStepContext } from "../../runtime/run-context/with-step-context.js";
import { Document, document, documentOutput } from "./document.js";

describe("document(content)", () => {
  it("writes content under the current step's directory as document-1.md and returns a matching Document", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-document-"));
    const { runId, runDir } = await createRunDirectory({ cwd, runName: "document-run" });
    const runContext = createRunContext({ runId, runName: "document-run", runDir });
    const stepDir = join(runDir, "steps", "0001-draft");

    const doc = await runContextStorage.run(runContext, () =>
      withStepContext("draft", stepDir, () => document("# Summary\n\nHello world.")),
    );

    expect(doc).toBeInstanceOf(Document);
    expect(doc.content).toBe("# Summary\n\nHello world.");
    expect(doc.path).toBe(join(stepDir, "document-1.md"));

    await expect(readFile(doc.path, "utf8")).resolves.toBe("# Summary\n\nHello world.");
  });

  it("auto-numbers repeated calls within the same step (document-1.md, document-2.md, ...)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-document-multi-"));
    const { runId, runDir } = await createRunDirectory({ cwd, runName: "document-multi-run" });
    const runContext = createRunContext({ runId, runName: "document-multi-run", runDir });
    const stepDir = join(runDir, "steps", "0001-report");

    const [first, second, third] = await runContextStorage.run(runContext, () =>
      withStepContext("report", stepDir, async () => {
        const firstDoc = await document("# Part one");
        const secondDoc = await document("# Part two");
        const thirdDoc = await document("# Part three");
        return [firstDoc, secondDoc, thirdDoc];
      }),
    );

    expect(first.path).toBe(join(stepDir, "document-1.md"));
    expect(second.path).toBe(join(stepDir, "document-2.md"));
    expect(third.path).toBe(join(stepDir, "document-3.md"));

    await expect(readFile(first.path, "utf8")).resolves.toBe("# Part one");
    await expect(readFile(second.path, "utf8")).resolves.toBe("# Part two");
    await expect(readFile(third.path, "utf8")).resolves.toBe("# Part three");
  });

  it("resets the index counter for each new step's context", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-document-reset-"));
    const { runId, runDir } = await createRunDirectory({ cwd, runName: "document-reset-run" });
    const runContext = createRunContext({ runId, runName: "document-reset-run", runDir });
    const firstStepDir = join(runDir, "steps", "0001-first");
    const secondStepDir = join(runDir, "steps", "0002-second");

    const firstDoc = await runContextStorage.run(runContext, () =>
      withStepContext("first", firstStepDir, () => document("first step content")),
    );
    const secondDoc = await runContextStorage.run(runContext, () =>
      withStepContext("second", secondStepDir, () => document("second step content")),
    );

    expect(firstDoc.path).toBe(join(firstStepDir, "document-1.md"));
    expect(secondDoc.path).toBe(join(secondStepDir, "document-1.md"));
  });

  it("throws when called within an active run but outside any step context", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-document-no-step-"));
    const { runId, runDir } = await createRunDirectory({ cwd, runName: "document-no-step-run" });
    const runContext = createRunContext({ runId, runName: "document-no-step-run", runDir });

    await expect(runContextStorage.run(runContext, () => document("content"))).rejects.toThrow(
      /document\(\.\.\.\) must be called from within a step's `\.do\(\)` callback/,
    );
  });

  it("throws when called outside an active StepKit run entirely", async () => {
    await expect(document("content")).rejects.toThrow(
      /state\.\* called outside an active StepKit run/,
    );
  });
});

describe("documentOutput", () => {
  it("validates a live Document instance and any content/path-shaped plain object alike", () => {
    const doc = new Document("hello", "/tmp/report.md");

    expect(documentOutput.validate(doc)).toBe(true);
    expect(documentOutput.validate({ content: "hello", path: "/tmp/report.md" })).toBe(true);
    expect(documentOutput.validate({ content: "hello" })).toBe(false);
    expect(documentOutput.validate(undefined)).toBe(false);
    expect(documentOutput.validate("not a document")).toBe(false);
  });

  it("reports diagnostics only for non-document-shaped values", () => {
    const doc = new Document("hello", "/tmp/report.md");

    expect(documentOutput.diagnostics(doc)).toEqual([]);
    expect(documentOutput.diagnostics({ content: "hello", path: "/tmp/report.md" })).toEqual([]);
    expect(documentOutput.diagnostics("not a document")).toEqual([
      { path: "/", message: "must be a document (an object with string content and path fields)" },
    ]);
  });

  it("asserts a live Document through as a freshly reconstructed Document instance", () => {
    const doc = new Document("hello", "/tmp/report.md");
    const asserted = documentOutput.assert(doc, "step output");

    expect(asserted).toBeInstanceOf(Document);
    expect(asserted.content).toBe("hello");
    expect(asserted.path).toBe("/tmp/report.md");
  });

  it("reconstructs a real Document from a plain duck-typed object, as replayed from events.jsonl on resume", () => {
    // A resumed step's recorded output is `JSON.parse`'d from events.jsonl -- a
    // plain object, never a live Document instance. `assert` must accept it and
    // hand back a working Document, not throw an `instanceof` mismatch.
    const replayedPlainOutput: unknown = JSON.parse(
      JSON.stringify(new Document("hello", "/tmp/report.md")),
    );

    expect(replayedPlainOutput).not.toBeInstanceOf(Document);

    const asserted = documentOutput.assert(replayedPlainOutput, "step output");

    expect(asserted).toBeInstanceOf(Document);
    expect(asserted.content).toBe("hello");
    expect(asserted.path).toBe("/tmp/report.md");
  });

  it("throws a validation failure for a value that is not document-shaped", () => {
    expect(() => documentOutput.assert({ not: "a document" }, "step output")).toThrow(
      /failed schema validation/,
    );
  });

  it("declares raw-text captureMode and a string jsonSchema", () => {
    expect(documentOutput.captureMode).toBe("raw-text");
    expect(documentOutput.jsonSchema).toEqual({
      type: "string",
      description: "Document content, captured as raw text.",
    });
  });
});
