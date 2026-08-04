import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { tsImport } from "tsx/esm/api";
import { describe, expect, it } from "vitest";

import { done, step } from "../../authoring/step/step-node.js";
import type { Workflow } from "../../authoring/workflow/workflow.types.js";
import { runWorkflow } from "../run-workflow/run-workflow.js";

const stateModuleUrl = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../authoring/state/state.ts"),
).href;

/**
 * Regression test for the real bug: the CLI's direct-file workflow resolver
 * loads a workflow's own TypeScript source through `tsx`'s `tsImport` (see
 * `packages/cli/src/internals/workflow-resolution/direct-file-resolver.ts`).
 * `tsImport` re-transpiles and re-evaluates every module reachable from that
 * entry point -- including this package's own `run-context-storage.ts` --
 * as a second, independent module instantiation, distinct from the one
 * `run-workflow.ts`/`with-step-context.ts` use. Without the `globalThis`-keyed
 * singleton in `run-context-storage.ts`, a step's `.do()` callback authored in
 * such a dynamically loaded module would call `state.*` against an
 * `AsyncLocalStorage` that was never `.run(...)`'d, throwing "state.* called
 * outside an active StepKit run." even though the run is very much active --
 * exactly the failure this test would reproduce on a revert of that fix.
 */
describe("runContextStorage singleton survives duplicate module instantiation", () => {
  it("lets a tsImport-loaded step's .do() call state.* successfully", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-run-context-storage-"));

    const dynamicStepFile = join(cwd, "dynamic-step.ts");
    await writeFile(
      dynamicStepFile,
      [
        `import { state } from "${stateModuleUrl}";`,
        "",
        "export async function recordSeenValue(input: { value: number }): Promise<{ value: number }> {",
        '  await state.set("seen", input.value);',
        "  return { value: input.value };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const dynamicModule = await tsImport(pathToFileURL(dynamicStepFile).href, import.meta.url);
    const recordSeenValue = dynamicModule.recordSeenValue as (input: {
      value: number;
    }) => Promise<{ value: number }>;

    const dynamicStep = step({ id: "dynamic" }).do(async (input: { value: number }) => {
      const output = await recordSeenValue(input);
      return done(output);
    });

    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "run-context-storage-regression",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return dynamicStep(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { value: 7 },
      runName: "run-context-storage-regression-run",
      cwd,
    });

    if (result.status !== "success") {
      throw new Error(`workflow failed: ${result.failure.message}`);
    }

    expect(result.output).toEqual({ value: 7 });

    const stateContents = JSON.parse(
      await readFile(join(result.runDir, "state.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(stateContents.seen).toBe(7);
  }, 15_000);
});
