import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadBundleWorkflow,
  parseManifestTarget,
  readBundleWorkflowManifest,
} from "./bundle-resolver.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const workflowModuleSource = [
  "const schema = { validate: () => true, diagnostics: () => [], assert: (value) => value };",
  "export const reviewWorkflow = { id: 'reviewWorkflow', inputShape: schema, start: (input) => ({ kind: 'done', output: input }) };",
].join("\n");

describe("loadBundleWorkflow", () => {
  it("exports a bundle manifest reader used by loadBundleWorkflow", () => {
    const manifest = readBundleWorkflowManifest(
      { trailstep: { workflows: { review: "./index.mjs#reviewWorkflow" } } },
      "@acme/workflows",
    );

    expect(manifest).toEqual({ review: "./index.mjs#reviewWorkflow" });
    const target = manifest.review;
    expect(target).toBeDefined();
    expect(parseManifestTarget(target ?? "", "@acme/workflows", "review")).toEqual({
      modulePath: "./index.mjs",
      exportName: "reviewWorkflow",
    });
  });

  it("pins valid and invalid bundle manifest target parsing", () => {
    expect(
      parseManifestTarget("./flows/review.mjs#reviewWorkflow", "@acme/workflows", "review"),
    ).toEqual({ modulePath: "./flows/review.mjs", exportName: "reviewWorkflow" });
    expect(() =>
      parseManifestTarget("flows/review.mjs#reviewWorkflow", "@acme/workflows", "review"),
    ).toThrow(/<relative-module-path>#<exportName>/i);
    expect(() => parseManifestTarget("./flows/review.mjs", "@acme/workflows", "review")).toThrow(
      /<relative-module-path>#<exportName>/i,
    );
  });

  it("resolves a scoped package manifest workflow to the named export", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-bundle-resolver-tests", task.id);
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      name: "consumer",
      dependencies: { "@acme/workflows": "1.0.0" },
    });
    await writeJson(join(packageDir, "package.json"), {
      name: "@acme/workflows",
      type: "module",
      trailstep: { workflows: { review: "./index.mjs#reviewWorkflow" } },
    });
    await writeFile(join(packageDir, "index.mjs"), workflowModuleSource, "utf8");

    await expect(
      loadBundleWorkflow({ packageName: "@acme/workflows", workflowName: "review" }, { cwd }),
    ).resolves.toEqual({
      id: "@acme/workflows#review",
      workflow: expect.objectContaining({ id: "reviewWorkflow" }),
      workflowRef: {
        kind: "bundle",
        packageName: "@acme/workflows",
        workflowName: "review",
        exportName: "reviewWorkflow",
      },
    });
  });

  it("resolves a local package manifest workflow to the named export", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-bundle-resolver-tests", task.id);
    const packageDir = join(cwd, "local-workflows");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(packageDir, "package.json"), {
      name: "local-workflows",
      type: "module",
      trailstep: { workflows: { review: "./index.mjs#reviewWorkflow" } },
    });
    await writeFile(join(packageDir, "index.mjs"), workflowModuleSource, "utf8");

    await expect(
      loadBundleWorkflow({ packageName: "./local-workflows", workflowName: "review" }, { cwd }),
    ).resolves.toMatchObject({
      id: "./local-workflows#review",
      workflow: { id: "reviewWorkflow" },
      workflowRef: { packageName: "./local-workflows", workflowName: "review" },
    });
  });

  it("fails clearly when the package is missing", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-bundle-resolver-tests", task.id);
    await mkdir(cwd, { recursive: true });
    await writeJson(join(cwd, "package.json"), { name: "consumer" });

    await expect(
      loadBundleWorkflow({ packageName: "@acme/missing", workflowName: "review" }, { cwd }),
    ).rejects.toThrow(/package not found.*@acme\/missing/i);
  });

  it("fails clearly when the manifest metadata is missing", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-bundle-resolver-tests", task.id);
    const packageDir = join(cwd, "local-workflows");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(packageDir, "package.json"), {
      name: "local-workflows",
      type: "module",
    });

    await expect(
      loadBundleWorkflow({ packageName: "./local-workflows", workflowName: "review" }, { cwd }),
    ).rejects.toThrow(/missing trailstep\.workflows/i);
  });

  it("fails clearly when the manifest module is missing", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-bundle-resolver-tests", task.id);
    const packageDir = join(cwd, "local-workflows");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(packageDir, "package.json"), {
      name: "local-workflows",
      type: "module",
      trailstep: { workflows: { review: "./missing.mjs#reviewWorkflow" } },
    });

    await expect(
      loadBundleWorkflow({ packageName: "./local-workflows", workflowName: "review" }, { cwd }),
    ).rejects.toThrow(/unable to import bundle workflow module/i);
  });

  it("fails clearly when the manifest workflow key is missing", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-bundle-resolver-tests", task.id);
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(cwd, "package.json"), { name: "consumer" });
    await writeJson(join(packageDir, "package.json"), {
      name: "@acme/workflows",
      type: "module",
      trailstep: { workflows: { review: "./index.mjs#reviewWorkflow" } },
    });

    await expect(
      loadBundleWorkflow({ packageName: "@acme/workflows", workflowName: "missing" }, { cwd }),
    ).rejects.toThrow(/workflow key.*missing/i);
  });

  it("fails clearly when the manifest export is not a workflow", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-bundle-resolver-tests", task.id);
    const packageDir = join(cwd, "local-workflows");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(packageDir, "package.json"), {
      name: "local-workflows",
      type: "module",
      trailstep: { workflows: { review: "./index.mjs#notWorkflow" } },
    });
    await writeFile(join(packageDir, "index.mjs"), "export const notWorkflow = {};", "utf8");

    await expect(
      loadBundleWorkflow({ packageName: "./local-workflows", workflowName: "review" }, { cwd }),
    ).rejects.toThrow(/invalid workflow export.*notWorkflow/i);
  });

  it("fails clearly when the manifest target is malformed", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-bundle-resolver-tests", task.id);
    const packageDir = resolve(cwd, "local-workflows");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(packageDir, "package.json"), {
      name: "local-workflows",
      type: "module",
      trailstep: { workflows: { review: "./index.mjs" } },
    });

    await expect(
      loadBundleWorkflow({ packageName: "./local-workflows", workflowName: "review" }, { cwd }),
    ).rejects.toThrow(/manifest target.*<relative-module-path>#<exportName>/i);
  });
});
