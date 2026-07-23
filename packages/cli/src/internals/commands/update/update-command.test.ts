import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../../../index.js";

describe("updateCommand", () => {
  it("blocks StepKit self-updates on removed-symbol findings before package.json mutation", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-update-command-tests", task.id);
    const packageDir = join(cwd, "node_modules", "@acme", "stepkit-workflows");
    await mkdir(packageDir, { recursive: true });
    await mkdir(join(cwd, ".stepkit"), { recursive: true });
    const packageJsonPath = join(cwd, "package.json");
    await writeFile(
      packageJsonPath,
      JSON.stringify({ dependencies: { "@stepkit/core": "0.1.0", "@stepkit/sdk": "0.1.0" } }),
      "utf8",
    );
    await writeFile(
      join(cwd, ".stepkit", "config.json"),
      JSON.stringify({ workflows: { project: { review: "@acme/stepkit-workflows" } } }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "@acme/stepkit-workflows", version: "1.0.0", main: "index.mjs" }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "index.mjs"),
      "import { removedStep } from '@stepkit/sdk';\nexport const review = {};\n",
      "utf8",
    );
    const originalPackageJson = await readFile(packageJsonPath, "utf8");
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["update", "--yes"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      packageCommandRunner: latestStepkitOne,
      deprecationManifest: [removedSdkSymbol],
    });

    expect(exitCode).toBe(1);
    expect(lines.join("\n")).toContain("@stepkit/sdk/removedStep");
    expect(errors.join("\n")).toMatch(/blocking deprecation findings/i);
    expect(await readFile(packageJsonPath, "utf8")).toBe(originalPackageJson);
  });

  it("allows a blocked StepKit self-update preflight with --force and prints a warning", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-update-command-tests", task.id);
    const packageDir = join(cwd, "node_modules", "@acme", "stepkit-workflows");
    await mkdir(packageDir, { recursive: true });
    await mkdir(join(cwd, ".stepkit"), { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ dependencies: { "@stepkit/core": "0.1.0", "@stepkit/sdk": "0.1.0" } }),
      "utf8",
    );
    await writeFile(
      join(cwd, ".stepkit", "config.json"),
      JSON.stringify({ workflows: { project: { review: "@acme/stepkit-workflows" } } }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "@acme/stepkit-workflows", version: "1.0.0", main: "index.mjs" }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "index.mjs"),
      "import { removedStep } from '@stepkit/sdk';\nexport const review = {};\n",
      "utf8",
    );
    const lines: string[] = [];

    const exitCode = await main({
      argv: ["update", "--yes", "--force"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      packageCommandRunner: latestStepkitOne,
      deprecationManifest: [removedSdkSymbol],
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toMatch(/Warning: --force/);
    expect(lines.join("\n")).toContain("Planned StepKit package updates:");
  });

  it("allows warning-only findings and still prints them", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-update-command-tests", task.id);
    const packageDir = join(cwd, "node_modules", "@acme", "stepkit-workflows");
    await mkdir(packageDir, { recursive: true });
    await mkdir(join(cwd, ".stepkit"), { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ dependencies: { "@stepkit/core": "0.1.0", "@stepkit/sdk": "0.1.0" } }),
      "utf8",
    );
    await writeFile(
      join(cwd, ".stepkit", "config.json"),
      JSON.stringify({ workflows: { project: { review: "@acme/stepkit-workflows" } } }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "@acme/stepkit-workflows", version: "1.0.0", main: "index.mjs" }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "index.mjs"),
      "import { oldStep } from '@stepkit/sdk';\nexport const review = {};\n",
      "utf8",
    );
    const lines: string[] = [];

    const exitCode = await main({
      argv: ["update", "--yes"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      packageCommandRunner: latestStepkitOne,
      deprecationManifest: [{ ...removedSdkSymbol, symbol: "oldStep", removedIn: undefined }],
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("warning @stepkit/sdk/oldStep");
    expect(lines.join("\n")).toContain("Planned StepKit package updates:");
  });

  it("excludes directly registered workflow files from StepKit self-update preflight scanning", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-update-command-tests", task.id);
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await mkdir(join(cwd, ".stepkit"), { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ dependencies: { "@stepkit/core": "0.1.0", "@stepkit/sdk": "0.1.0" } }),
      "utf8",
    );
    await writeFile(
      join(cwd, ".stepkit", "config.json"),
      JSON.stringify({ workflows: { project: { review: "./workflows/review.mjs" } } }),
      "utf8",
    );
    await writeFile(
      join(cwd, "workflows", "review.mjs"),
      "import { removedStep } from '@stepkit/sdk';\nexport const review = {};\n",
      "utf8",
    );
    const lines: string[] = [];

    // Direct-file registered workflows have no npm version and are excluded from deprecation
    // scan targets entirely (per design) — self-update's preflight scan never reads this file's
    // source text, even though the entry itself is still reported as a skip elsewhere.
    const exitCode = await main({
      argv: ["update", "--yes"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      packageCommandRunner: latestStepkitOne,
      deprecationManifest: [removedSdkSymbol],
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).not.toContain("workflows/review.mjs");
    expect(lines.join("\n")).not.toContain("removedStep");
  });

  it("prints all findings before the blocking error line", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-update-command-tests", task.id);
    const packageDir = join(cwd, "node_modules", "@acme", "stepkit-workflows");
    await mkdir(packageDir, { recursive: true });
    await mkdir(join(cwd, ".stepkit"), { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ dependencies: { "@stepkit/core": "0.1.0", "@stepkit/sdk": "0.1.0" } }),
      "utf8",
    );
    await writeFile(
      join(cwd, ".stepkit", "config.json"),
      JSON.stringify({ workflows: { project: { review: "@acme/stepkit-workflows" } } }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "@acme/stepkit-workflows", version: "1.0.0", main: "index.mjs" }),
      "utf8",
    );
    await writeFile(
      join(packageDir, "index.mjs"),
      "import { removedStep, removedWorkflow } from '@stepkit/sdk';\nexport const review = {};\n",
      "utf8",
    );
    const output: string[] = [];

    await main({
      argv: ["update", "--yes"],
      cwd,
      io: {
        writeLine: (line) => output.push(`line:${line}`),
        writeError: (line) => output.push(`error:${line}`),
      },
      packageCommandRunner: latestStepkitOne,
      deprecationManifest: [removedSdkSymbol, { ...removedSdkSymbol, symbol: "removedWorkflow" }],
    });

    const rendered = output.join("\n");
    expect(rendered.indexOf("removedStep")).toBeLessThan(rendered.indexOf("blocking deprecation"));
    expect(rendered.indexOf("removedWorkflow")).toBeLessThan(
      rendered.indexOf("blocking deprecation"),
    );
  });

  it("returns a no-op result without running workflow fallback", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-update-command-tests", task.id);
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "consumer" }), "utf8");
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["update"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toMatch(/no changes needed/i);
    expect(errors).toEqual([]);
  });

  it("prints planned StepKit self-update package changes without writing files", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-update-command-tests", task.id);
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        dependencies: {
          "@stepkit/core": "^0.0.1",
          "@stepkit/sdk": "^0.0.1",
          "@stepkit/cli": "^0.0.1",
        },
      }),
      "utf8",
    );
    const lines: string[] = [];

    const exitCode = await main({
      argv: ["update"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      prompts: { text: async () => "", select: async () => "", confirm: async () => false },
      packageCommandRunner: async (request) => {
        const metadata: Record<string, unknown> = {
          "@stepkit/core": [{ version: "1.0.0" }],
          "@stepkit/sdk": [{ version: "1.0.0", peerDependencies: { "@stepkit/core": "^1.0.0" } }],
          "@stepkit/cli": [{ version: "1.0.0", peerDependencies: { "@stepkit/core": "^1.0.0" } }],
        };
        const packageName = String(request.args[1]).replace(/@\*$/u, "");
        return { exitCode: 0, stdout: JSON.stringify(metadata[packageName]) };
      },
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("@stepkit/core: ^0.0.1 -> 1.0.0");
    expect(
      await import("node:fs/promises").then((fs) => fs.readFile(join(cwd, "package.json"), "utf8")),
    ).toContain("^0.0.1");
  });

  it("prints workflow package update targets and local-file skips without writing files", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-update-command-tests", task.id);
    await mkdir(join(cwd, ".stepkit"), { recursive: true });
    await writeFile(
      join(cwd, ".stepkit", "config.json"),
      JSON.stringify({
        workflows: {
          project: {
            review: "./workflows/review.mjs",
            release: "@acme/workflows#release",
          },
        },
      }),
      "utf8",
    );
    const lines: string[] = [];

    const exitCode = await main({
      argv: ["update", "--workflows", "--yes"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain(
      "Skipped project/review: local file source, no version to update.",
    );
    expect(lines.join("\n")).toContain("@acme/workflows");
    expect(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(join(cwd, ".stepkit", "config.json"), "utf8"),
      ),
    ).toContain("@acme/workflows#release");
  });

  it("applies self update with --yes, prints version changes, and runs detected install", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-update-command-tests", task.id);
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "pnpm-lock.yaml"), "", "utf8");
    await writeFile(
      join(cwd, "package.json"),
      `${JSON.stringify(
        { dependencies: { "@stepkit/core": "^1.0.0", "@stepkit/sdk": "~1.0.0" } },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const lines: string[] = [];
    const installRequests: Array<{ command: string; args: readonly string[]; cwd: string }> = [];

    const exitCode = await main({
      argv: ["update", "--yes"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      packageCommandRunner: async (request) => {
        if (request.args[0] === "install") {
          installRequests.push(request);
          return { exitCode: 0, stdout: "installed" };
        }
        return latestStepkitTwo(request);
      },
    });

    const packageJson = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("@stepkit/core: ^1.0.0 -> 2.0.0");
    expect(packageJson.dependencies["@stepkit/core"]).toBe("^2.0.0");
    expect(packageJson.dependencies["@stepkit/sdk"]).toBe("~2.0.0");
    expect(installRequests).toEqual([{ command: "pnpm", args: ["install"], cwd }]);
  });

  it("prints direct-file skip lines before prompting for confirmation", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-update-command-tests", task.id);
    await mkdir(join(cwd, ".stepkit"), { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      `${JSON.stringify({ dependencies: { "@stepkit/core": "^1.0.0" } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(cwd, ".stepkit", "config.json"),
      JSON.stringify({ workflows: { project: { review: "./workflows/review.mjs" } } }),
      "utf8",
    );
    const events: string[] = [];

    const exitCode = await main({
      argv: ["update", "--all"],
      cwd,
      io: { writeLine: (line) => events.push(`line:${line}`), writeError: () => undefined },
      prompts: {
        text: async () => "",
        select: async () => "",
        confirm: async () => {
          events.push("prompt:confirm");
          return true;
        },
      },
      packageCommandRunner: async (request) => {
        if (request.args[0] === "install") {
          return { exitCode: 0 };
        }
        return latestStepkitTwo(request);
      },
    });

    expect(exitCode).toBe(0);
    expect(events.findIndex((event) => event.includes("Skipped project/review"))).toBeLessThan(
      events.indexOf("prompt:confirm"),
    );
  });

  it("fails before writing when confirmation is required but no confirm prompt seam exists", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-update-command-tests", task.id);
    await mkdir(cwd, { recursive: true });
    const packageJsonPath = join(cwd, "package.json");
    await writeFile(
      packageJsonPath,
      `${JSON.stringify({ dependencies: { "@stepkit/core": "^1.0.0" } }, null, 2)}\n`,
      "utf8",
    );
    const original = await readFile(packageJsonPath, "utf8");
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["update"],
      cwd,
      io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      prompts: { text: async () => "", select: async () => "" },
      packageCommandRunner: latestStepkitTwo,
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/--yes or an interactive confirm prompt/i);
    expect(await readFile(packageJsonPath, "utf8")).toBe(original);
  });

  it("exits cleanly without writing or installing when confirmation is declined", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-update-command-tests", task.id);
    await mkdir(cwd, { recursive: true });
    const packageJsonPath = join(cwd, "package.json");
    await writeFile(
      packageJsonPath,
      `${JSON.stringify({ dependencies: { "@stepkit/core": "^1.0.0" } }, null, 2)}\n`,
      "utf8",
    );
    const original = await readFile(packageJsonPath, "utf8");
    const installRequests: unknown[] = [];

    const exitCode = await main({
      argv: ["update"],
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: { text: async () => "", select: async () => "", confirm: async () => false },
      packageCommandRunner: async (request) => {
        if (request.args[0] === "install") {
          installRequests.push(request);
          return { exitCode: 0 };
        }
        return latestStepkitTwo(request);
      },
    });

    expect(exitCode).toBe(0);
    expect(await readFile(packageJsonPath, "utf8")).toBe(original);
    expect(installRequests).toEqual([]);
  });

  it("reports failed installs without claiming success", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-update-command-tests", task.id);
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      `${JSON.stringify({ dependencies: { "@stepkit/core": "^1.0.0" } }, null, 2)}\n`,
      "utf8",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["update", "--yes"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      packageCommandRunner: async (request) => {
        if (request.args[0] === "install") {
          return { exitCode: 7, stderr: "lockfile conflict" };
        }
        return latestStepkitTwo(request);
      },
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Install failed with exit code 7");
    expect(errors.join("\n")).toContain("lockfile conflict");
    expect(lines.join("\n")).not.toMatch(/update complete/i);
  });

  it("reports registry resolution failures as CLI errors", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-update-command-tests", task.id);
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ dependencies: { "@stepkit/core": "^0.0.1" } }),
      "utf8",
    );
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["update"],
      cwd,
      io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      packageCommandRunner: async () => ({ exitCode: 0, stdout: "not json" }),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/Malformed npm view JSON for @stepkit\/core/);
  });
});

const removedSdkSymbol = {
  packageName: "@stepkit/sdk",
  symbol: "removedStep",
  deprecatedSince: "0.5.0",
  removedIn: "1.0.0",
  message: "removedStep was removed.",
  replacement: "step",
};

async function latestStepkitTwo(request: { readonly args: readonly string[] }) {
  const metadata: Record<string, unknown> = {
    "@stepkit/core": [{ version: "2.0.0" }],
    "@stepkit/sdk": [{ version: "2.0.0", peerDependencies: { "@stepkit/core": "^2.0.0" } }],
    "@stepkit/cli": [{ version: "2.0.0", peerDependencies: { "@stepkit/core": "^2.0.0" } }],
  };
  const packageName = String(request.args[1]).replace(/@\*$/u, "");
  return { exitCode: 0, stdout: JSON.stringify(metadata[packageName]) };
}

async function latestStepkitOne(request: { readonly args: readonly string[] }) {
  const metadata: Record<string, unknown> = {
    "@stepkit/core": [{ version: "1.0.0" }],
    "@stepkit/sdk": [{ version: "1.0.0", peerDependencies: { "@stepkit/core": "^1.0.0" } }],
    "@stepkit/cli": [{ version: "1.0.0", peerDependencies: { "@stepkit/core": "^1.0.0" } }],
  };
  const packageName = String(request.args[1]).replace(/@\*$/u, "");
  return { exitCode: 0, stdout: JSON.stringify(metadata[packageName]) };
}
