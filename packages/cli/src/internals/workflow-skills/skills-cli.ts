import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export type SkillsCliDistributionTarget = "project" | "user";

export type SkillsCliResolver = () => Promise<string>;

export interface SkillsCliRunResult {
  readonly exitCode: number;
}

export type SkillsCliProcessRunner = (
  command: string,
  args: readonly string[],
) => Promise<SkillsCliRunResult>;

export interface DistributeWorkflowSkillInput {
  readonly skillDirectory: string;
  readonly target: SkillsCliDistributionTarget;
  readonly resolver?: SkillsCliResolver;
  readonly runner?: SkillsCliProcessRunner;
}

export async function distributeWorkflowSkill(input: DistributeWorkflowSkillInput): Promise<void> {
  const resolver = input.resolver ?? resolveInstalledSkillsCliPath;
  const runner = input.runner ?? spawnSkillsCliProcess;
  const cliPath = await resolveSkillsCliPath(resolver);
  const args = [
    cliPath,
    "add",
    input.skillDirectory,
    "--agent",
    "*",
    "-y",
    ...(input.target === "user" ? ["-g"] : []),
  ];

  const result = await runner(process.execPath, args);
  if (result.exitCode !== 0) {
    throw new Error(`skills CLI exited with code ${result.exitCode}.`);
  }
}

export async function resolveInstalledSkillsCliPath(): Promise<string> {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("skills/package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    readonly bin?: string | Record<string, string>;
  };
  const bin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.skills;

  if (bin === undefined) {
    throw new Error("skills package does not declare a skills bin.");
  }

  return join(dirname(packageJsonPath), bin);
}

async function resolveSkillsCliPath(resolver: SkillsCliResolver): Promise<string> {
  try {
    return await resolver();
  } catch {
    throw new Error("Could not resolve skills CLI.");
  }
}

async function spawnSkillsCliProcess(
  command: string,
  args: readonly string[],
): Promise<SkillsCliRunResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1 }));
  });
}
