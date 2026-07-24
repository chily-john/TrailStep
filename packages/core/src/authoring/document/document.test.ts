import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRunDirectory } from "../../runtime/artifacts/run-storage.js";
import { createRunContext } from "../../runtime/run-context/create-run-context.js";
import { runContextStorage } from "../../runtime/run-context/run-context-storage.js";
import { Document, document } from "./document.js";

describe("document", () => {
  describe("no-content overload", () => {
    it("returns a Schema-shaped object with captureMode raw-text and the given documentName", () => {
      const schema = document("report");

      expect(schema.captureMode).toBe("raw-text");
      expect(schema.documentName).toBe("report");
      expect(schema.jsonSchema).toEqual({
        type: "string",
        description: "Document content, captured as raw text.",
      });
      expect(typeof schema.validate).toBe("function");
      expect(typeof schema.diagnostics).toBe("function");
      expect(typeof schema.assert).toBe("function");
    });

    it("validates Document instances and rejects anything else", () => {
      const schema = document("report");
      const doc = new Document("report", "content", "/tmp/report.md");

      expect(schema.validate(doc)).toBe(true);
      expect(schema.validate({ name: "report", content: "content" })).toBe(false);
      expect(schema.validate(undefined)).toBe(false);

      expect(schema.diagnostics(doc)).toEqual([]);
      expect(schema.diagnostics("not a document")).toEqual([
        { path: "/", message: "must be a Document" },
      ]);
    });

    it("asserts a Document through and throws a validation failure otherwise", () => {
      const schema = document("report");
      const doc = new Document("report", "content", "/tmp/report.md");

      expect(schema.assert(doc, "step output")).toBe(doc);
      expect(() => schema.assert({ not: "a document" }, "step output")).toThrow(
        /failed schema validation/,
      );
    });
  });

  describe("content overload", () => {
    it("writes a file under <runDir>/documents/<name>.md and returns a matching Document", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-document-"));
      const { runId, runDir } = await createRunDirectory({ cwd, runName: "document-run" });
      const runContext = createRunContext({ runId, runName: "document-run", runDir });

      const doc = await runContextStorage.run(runContext, () =>
        document("summary", "# Summary\n\nHello world."),
      );

      expect(doc).toBeInstanceOf(Document);
      expect(doc.name).toBe("summary");
      expect(doc.content).toBe("# Summary\n\nHello world.");
      expect(doc.path).toBe(join(runDir, "documents", "summary.md"));

      await expect(readFile(doc.path, "utf8")).resolves.toBe("# Summary\n\nHello world.");
    });

    it("throws when called outside an active StepKit run", async () => {
      await expect(document("summary", "content")).rejects.toThrow(
        /state\.\* called outside an active StepKit run/,
      );
    });
  });
});
