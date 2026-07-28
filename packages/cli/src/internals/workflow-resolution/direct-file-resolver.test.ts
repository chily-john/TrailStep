import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadDirectWorkflowFile } from "./direct-file-resolver.js";

const workflowSource = [
  "const schema = { validate: () => true, diagnostics: () => [], assert: (value) => value };",
  "export default { id: 'review', inputShape: schema, start: (input) => ({ kind: 'done', output: input }) };",
].join("\n");

const namedWorkflowSource = [
  "const schema = { validate: () => true, diagnostics: () => [], assert: (value) => value };",
  "export const notAWorkflow = { id: 'nope' };",
  "export const review = { id: 'review', inputShape: schema, start: (input) => ({ kind: 'done', output: input }) };",
].join("\n");

const multipleWorkflowSource = [
  "const schema = { validate: () => true, diagnostics: () => [], assert: (value) => value };",
  "export const review = { id: 'review', inputShape: schema, start: (input) => ({ kind: 'done', output: input }) };",
  "export const cleanup = { id: 'cleanup', inputShape: schema, start: (input) => ({ kind: 'done', output: input }) };",
].join("\n");

describe("loadDirectWorkflowFile", () => {
  it("accepts a workflow with no declared input shape", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-direct-file-resolver-tests", task.id);
    const workflowDir = join(cwd, "workflows");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, "review.mjs"),
      "export default { id: 'review', start: () => ({ kind: 'done', output: {} }) };",
      "utf8",
    );

    await expect(loadDirectWorkflowFile("./workflows/review.mjs", { cwd })).resolves.toEqual({
      id: resolve(cwd, "workflows", "review.mjs"),
      workflow: expect.objectContaining({ id: "review" }),
    });
  });

  it("loads a default-exported workflow from a relative local file path", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-direct-file-resolver-tests", task.id);
    const workflowDir = join(cwd, "workflows");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(join(workflowDir, "review.mjs"), workflowSource, "utf8");

    await expect(loadDirectWorkflowFile("./workflows/review.mjs", { cwd })).resolves.toEqual({
      id: resolve(cwd, "workflows", "review.mjs"),
      workflow: expect.objectContaining({ id: "review" }),
    });
  });

  it("loads exactly one valid named workflow when no valid default workflow exists", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-direct-file-resolver-tests", task.id);
    const workflowDir = join(cwd, "workflows");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(join(workflowDir, "review.mjs"), namedWorkflowSource, "utf8");

    await expect(loadDirectWorkflowFile("./workflows/review.mjs", { cwd })).resolves.toEqual({
      id: resolve(cwd, "workflows", "review.mjs"),
      workflow: expect.objectContaining({ id: "review" }),
    });
  });

  it("loads workflows from an absolute local file path", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-direct-file-resolver-tests", task.id);
    const workflowPath = resolve(cwd, "workflows", "review.mjs");
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(workflowPath, workflowSource, "utf8");

    await expect(loadDirectWorkflowFile(workflowPath, { cwd })).resolves.toEqual({
      id: workflowPath,
      workflow: expect.objectContaining({ id: "review" }),
    });
  });

  it("fails clearly for a missing direct file path", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-direct-file-resolver-tests", task.id);

    await expect(loadDirectWorkflowFile("./workflows/missing.mjs", { cwd })).rejects.toThrow(
      /Direct workflow file not found:/,
    );
  });

  it("rejects a direct file with multiple valid workflow exports", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-direct-file-resolver-tests", task.id);
    const workflowPath = resolve(cwd, "workflows", "review.mjs");
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(workflowPath, multipleWorkflowSource, "utf8");

    await expect(loadDirectWorkflowFile("./workflows/review.mjs", { cwd })).rejects.toThrow(
      /path#exportName.*bulk add/i,
    );
  });

  it("rejects a direct file with no valid workflow exports and includes the file path", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-direct-file-resolver-tests", task.id);
    const workflowPath = resolve(cwd, "workflows", "empty.mjs");
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(workflowPath, "export const value = 1;", "utf8");

    await expect(loadDirectWorkflowFile("./workflows/empty.mjs", { cwd })).rejects.toThrow(
      new RegExp(`no workflows found.*${workflowPath.replaceAll("\\", "\\\\")}`, "iu"),
    );
  });

  it("rejects default plus named valid workflows as ambiguous", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-direct-file-resolver-tests", task.id);
    const workflowPath = resolve(cwd, "workflows", "review.mjs");
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(
      workflowPath,
      `${`${workflowSource}\nexport const cleanup = { ...defaultExport, id: 'cleanup' };`.replace(
        "export default {",
        "const defaultExport = {",
      )}\nexport default defaultExport;`,
      "utf8",
    );

    await expect(loadDirectWorkflowFile("./workflows/review.mjs", { cwd })).rejects.toThrow(
      /path#exportName.*bulk add/i,
    );
  });

  it("selects a named workflow export from a direct source ref", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-direct-file-resolver-tests", task.id);
    const workflowDir = join(cwd, "workflows");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(join(workflowDir, "index.mjs"), multipleWorkflowSource, "utf8");

    await expect(loadDirectWorkflowFile("./workflows/index.mjs#cleanup", { cwd })).resolves.toEqual(
      {
        id: resolve(cwd, "workflows", "index.mjs"),
        workflow: expect.objectContaining({ id: "cleanup" }),
      },
    );
  });

  it("selects #default when default is a workflow", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-direct-file-resolver-tests", task.id);
    const workflowDir = join(cwd, "workflows");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(join(workflowDir, "index.mjs"), workflowSource, "utf8");

    await expect(loadDirectWorkflowFile("./workflows/index.mjs#default", { cwd })).resolves.toEqual(
      {
        id: resolve(cwd, "workflows", "index.mjs"),
        workflow: expect.objectContaining({ id: "review" }),
      },
    );
  });

  it("errors with available workflows when a direct named export is missing", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-direct-file-resolver-tests", task.id);
    const workflowDir = join(cwd, "workflows");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(join(workflowDir, "index.mjs"), multipleWorkflowSource, "utf8");

    await expect(
      loadDirectWorkflowFile("./workflows/index.mjs#dailyNote", { cwd }),
    ).rejects.toThrow(
      /missing workflow export dailyNote.*available workflow exports: cleanup, review/i,
    );
  });

  it("errors with available workflows when a named export is not a workflow", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-direct-file-resolver-tests", task.id);
    const workflowDir = join(cwd, "workflows");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(join(workflowDir, "index.mjs"), namedWorkflowSource, "utf8");

    await expect(
      loadDirectWorkflowFile("./workflows/index.mjs#notAWorkflow", { cwd }),
    ).rejects.toThrow(/invalid workflow export notAWorkflow.*available workflow exports: review/i);
  });

  it("preserves direct file import errors as the diagnostic cause", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-direct-file-resolver-tests", task.id);
    const workflowPath = resolve(cwd, "workflows", "broken.mjs");
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(workflowPath, "throw new Error('boom');", "utf8");

    await expect(loadDirectWorkflowFile("./workflows/broken.mjs", { cwd })).rejects.toMatchObject({
      message: expect.stringContaining(workflowPath),
      cause: expect.objectContaining({ message: "boom" }),
    });
  });

  it("loads a TypeScript workflow source with emitted-style .js specifiers", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-direct-file-resolver-tests", task.id);
    const workflowDir = join(cwd, "workflows");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, "daily-note.ts"),
      "const schema = { validate: () => true, diagnostics: () => [], assert: (value: unknown) => value };\nexport const dailyNote = { id: 'dailyNote', inputShape: schema, start: (input: unknown) => ({ kind: 'done', output: input }) };",
      "utf8",
    );
    await writeFile(
      join(workflowDir, "index.ts"),
      "export { dailyNote } from './daily-note.js';",
      "utf8",
    );

    await expect(
      loadDirectWorkflowFile("./workflows/index.ts#dailyNote", { cwd }),
    ).resolves.toEqual({
      id: resolve(cwd, "workflows", "index.ts"),
      workflow: expect.objectContaining({ id: "dailyNote" }),
    });
  });

  it("resolves extensionless direct source candidates", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-direct-file-resolver-tests", task.id);
    const workflowDir = join(cwd, "workflows");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(join(workflowDir, "review.ts"), workflowSource, "utf8");

    await expect(loadDirectWorkflowFile("./workflows/review", { cwd })).resolves.toEqual({
      id: resolve(cwd, "workflows", "review.ts"),
      workflow: expect.objectContaining({ id: "review" }),
    });
  });

  it("resolves direct source directories through index candidates", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-direct-file-resolver-tests", task.id);
    const workflowDir = join(cwd, "workflows");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(join(workflowDir, "index.ts"), workflowSource, "utf8");

    await expect(loadDirectWorkflowFile("./workflows", { cwd })).resolves.toEqual({
      id: resolve(cwd, "workflows", "index.ts"),
      workflow: expect.objectContaining({ id: "review" }),
    });
  });

  it("rejects .tsx direct source refs clearly", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-direct-file-resolver-tests", task.id);
    const workflowDir = join(cwd, "workflows");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(join(workflowDir, "review.tsx"), workflowSource, "utf8");

    await expect(loadDirectWorkflowFile("./workflows/review.tsx", { cwd })).rejects.toThrow(
      /unsupported.*\.tsx.*JSX/i,
    );
  });

  it("reports missing direct source refs before bundle mode", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-direct-file-resolver-tests", task.id);

    await expect(loadDirectWorkflowFile("./workflows/missing.ts#review", { cwd })).rejects.toThrow(
      /Direct workflow source not found:/,
    );
  });
});
