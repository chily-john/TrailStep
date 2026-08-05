#!/usr/bin/env node
import { spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const [, , workflowId, inputFile, ...flags] = process.argv;

if (!workflowId || !inputFile || flags.includes("--help") || flags.includes("-h")) {
  printUsage();
  process.exit(workflowId || inputFile ? 0 : 1);
}

const openPr = flags.includes("--pr") && !flags.includes("--no-pr");
const repoRoot = await commandStdout("git", ["rev-parse", "--show-toplevel"], process.cwd()).catch(
  (error) => fail(`Could not find a git repository root: ${error.message}`),
);
const resolvedInput = resolve(process.cwd(), inputFile);
const relativeInput = toPosixPath(relative(repoRoot, resolvedInput));

if (relativeInput.startsWith("../") || relativeInput === ".." || isAbsolute(relativeInput)) {
  fail(`Input file must live inside the repository: ${resolvedInput}`);
}

const timestamp = new Date()
  .toISOString()
  .replaceAll(/[-:]/g, "")
  .replace(/\.\d{3}Z$/, "Z");
const slug = slugify(workflowId);
const branch = `stepkit/${slug}-${timestamp}`;
const worktree = resolve(repoRoot, ".stepkit", "worktrees", `${slug}-${timestamp}`);
const runsRoot = resolve(repoRoot, ".stepkit", "runs");

console.log(`Creating isolated StepKit worktree: ${worktree}`);
console.log(`Branch: ${branch}`);
console.log(`Central StepKit runs root: ${runsRoot}`);
await mkdir(dirname(worktree), { recursive: true });
await run("git", ["worktree", "add", "-b", branch, worktree, "HEAD"], repoRoot);

const worktreeInput = resolve(worktree, relativeInput);
await mkdir(dirname(worktreeInput), { recursive: true });
await copyFile(resolvedInput, worktreeInput);

const stepkitEnv = {
  ...process.env,
  STEPKIT_BRANCH: branch,
  STEPKIT_GIT_ISOLATED: "worktree",
  STEPKIT_RUNS_ROOT: runsRoot,
  STEPKIT_SOURCE_REPO: repoRoot,
  STEPKIT_STORY_COMMIT_MODE: "enabled",
  STEPKIT_WORKTREE: worktree,
};

const stepkitResult = await run("stepkit", [workflowId, "--input-file", relativeInput], worktree, {
  allowFailure: true,
  env: stepkitEnv,
});

if (stepkitResult.exitCode !== 0) {
  console.error(`StepKit workflow failed in isolated worktree: ${worktree}`);
  process.exit(stepkitResult.exitCode);
}

console.log(`StepKit workflow completed on ${branch}.`);

if (openPr) {
  await pushAndOpenPr(worktree, branch);
} else {
  console.log(
    `PR creation skipped. To open one later: cd ${worktree} && gh pr create --fill --head ${branch}`,
  );
}

async function pushAndOpenPr(cwd, branchName) {
  if (!(await commandExists("gh"))) {
    console.warn(`GitHub CLI not found; skipping PR creation for ${branchName}.`);
    return;
  }

  const remotes = await commandStdout("git", ["remote"], cwd).catch(() => "");
  const remote = chooseRemote(remotes);
  if (!remote) {
    console.warn(`No git remote configured; skipping push and PR creation for ${branchName}.`);
    return;
  }

  const push = await run("git", ["push", "-u", remote, branchName], cwd, { allowFailure: true });
  if (push.exitCode !== 0) {
    console.warn(`Could not push ${branchName} to ${remote}; skipping PR creation.`);
    return;
  }

  const pr = await run("gh", ["pr", "create", "--fill", "--head", branchName], cwd, {
    allowFailure: true,
  });
  if (pr.exitCode !== 0) {
    console.warn(`Workflow succeeded, but GitHub PR creation failed for ${branchName}.`);
  }
}

function chooseRemote(remotesOutput) {
  const remotes = remotesOutput
    .split("\n")
    .map((remote) => remote.trim())
    .filter((remote) => remote.length > 0);
  return remotes.includes("origin") ? "origin" : remotes[0];
}

async function commandExists(command) {
  const result = await run(command, ["--version"], process.cwd(), {
    allowFailure: true,
    silent: true,
  });
  return result.exitCode === 0;
}

async function commandStdout(command, args, cwd) {
  let stdout = "";
  const result = await run(command, args, cwd, {
    allowFailure: true,
    silent: true,
    onStdout: (chunk) => {
      stdout += chunk;
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${result.exitCode}`);
  }
  return stdout.trim();
}

function run(command, args, cwd, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: options.env ?? process.env,
      shell: process.platform === "win32",
      stdio: options.silent || options.onStdout ? ["inherit", "pipe", "pipe"] : "inherit",
    });

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        options.onStdout?.(text);
        if (!options.silent) process.stdout.write(text);
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        if (!options.silent) process.stderr.write(chunk);
      });
    }

    child.on("error", (error) => {
      if (options.allowFailure) {
        resolveRun({ exitCode: 1 });
        return;
      }
      rejectRun(error);
    });

    child.on("close", (exitCode) => {
      const normalizedExitCode = exitCode ?? 1;
      if (normalizedExitCode !== 0 && !options.allowFailure) {
        rejectRun(new Error(`${command} ${args.join(" ")} exited with code ${normalizedExitCode}`));
        return;
      }
      resolveRun({ exitCode: normalizedExitCode });
    });
  });
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function toPosixPath(value) {
  return value.replaceAll("\\", "/");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function printUsage() {
  console.log(`Usage: node scripts/run-stepkit-isolated.mjs <workflow-id> <input-file> [--pr|--no-pr]

Creates a git worktree under .stepkit/worktrees/, copies the input file into it,
runs the StepKit workflow there, enables per-story commits after successful
reviews, and optionally pushes/opens a GitHub PR with gh.`);
}
