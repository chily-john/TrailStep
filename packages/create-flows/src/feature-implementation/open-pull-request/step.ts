import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Document } from "@trailstep/authoring";
import { done, state, step } from "@trailstep/authoring";
import type { ContinuationResult } from "@trailstep/core";
import { runGit } from "../commit-reviewed-story/run-git.js";
import {
  defaultTakeItAwayWorkflowOptions,
  type TakeItAwayWorkflowOptions,
} from "../shared/input-schema.js";
import type { TakeItAwayOutput, TakeItAwayPullRequestOutput } from "../shared/output-schema.js";
import { STORY_STATE_KEYS } from "../shared/story-state.js";

const execFileAsync = promisify(execFile);

export const openPullRequestStep = step({ id: "open-pull-request" }).do(
  async (output: TakeItAwayOutput): Promise<ContinuationResult> => {
    const pullRequest = await openPullRequest(output);
    const warnings = await loadWorkflowWarnings();
    const pullRequestWarning = pullRequest.warning;
    const finalWarnings =
      pullRequestWarning === undefined ? warnings : [...warnings, pullRequestWarning];

    return done({
      ...output,
      ...(finalWarnings.length === 0 ? {} : { warnings: finalWarnings }),
      pullRequest,
    });
  },
);

async function openPullRequest(output: TakeItAwayOutput): Promise<TakeItAwayPullRequestOutput> {
  const options = await loadWorkflowOptions();
  const prOptions = options.pullRequest;
  if (!prOptions.enabled) {
    return { status: "disabled" };
  }

  const cwd = state.cwd;
  if (!cwd) {
    return skipped("Workflow cwd is unavailable, so TrailStep could not safely create a PR.", {
      branch: "<branch>",
      base: prOptions.base,
      remote: prOptions.remote,
    });
  }

  const insideWorkTree = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  if (!insideWorkTree.ok || insideWorkTree.stdout !== "true") {
    return skipped(
      "The workflow cwd is not a git worktree, so TrailStep could not safely create a PR.",
      { branch: "<branch>", base: prOptions.base, remote: prOptions.remote },
    );
  }

  const branch = await currentBranch(cwd);
  if (!branch.ok) {
    return skipped(branch.warning, {
      branch: "<branch>",
      base: prOptions.base,
      remote: prOptions.remote,
    });
  }

  const status = await runGit(["status", "--short"], cwd);
  if (!status.ok) {
    return skipped(
      `TrailStep could not inspect \`git status --short\`, so it did not create a PR: ${status.error}`,
      { branch: branch.name, base: prOptions.base, remote: prOptions.remote },
    );
  }

  if (status.stdout.trim().length > 0) {
    return skipped(
      "The working tree is dirty, so TrailStep did not create a PR. Review and commit the remaining changes, then run the suggested commands.",
      { branch: branch.name, base: prOptions.base, remote: prOptions.remote },
    );
  }

  const remote = await runGit(["remote", "get-url", prOptions.remote], cwd);
  if (!remote.ok) {
    return skipped(
      `Git remote \`${prOptions.remote}\` is not configured, so TrailStep could not push and create a PR: ${remote.error}`,
      { branch: branch.name, base: prOptions.base, remote: prOptions.remote },
    );
  }

  const existing = await existingPullRequest(cwd, branch.name);
  if (existing.ok && existing.url) {
    return { status: "existing", url: existing.url };
  }

  const push = await runGit(["push", "--set-upstream", prOptions.remote, branch.name], cwd);
  if (!push.ok) {
    return skipped(`TrailStep could not push \`${branch.name}\`: ${push.error}`, {
      branch: branch.name,
      base: prOptions.base,
      remote: prOptions.remote,
    });
  }

  const title = prOptions.title ?? (await defaultPullRequestTitle(output));
  const body = prOptions.body ?? defaultPullRequestBody(output);
  const createArgs = [
    "pr",
    "create",
    "--base",
    prOptions.base,
    "--head",
    branch.name,
    "--title",
    title,
    "--body",
    body,
  ];
  if (prOptions.draft) {
    createArgs.push("--draft");
  }

  const created = await runGh(createArgs, cwd);
  if (!created.ok) {
    return skipped(
      `TrailStep pushed \`${branch.name}\` but could not create a PR: ${created.error}`,
      {
        branch: branch.name,
        base: prOptions.base,
        remote: prOptions.remote,
      },
    );
  }

  return { status: "created", url: extractUrl(created.stdout) };
}

async function loadWorkflowOptions(): Promise<TakeItAwayWorkflowOptions> {
  return (
    (await state.get<TakeItAwayWorkflowOptions | null>(STORY_STATE_KEYS.workflowOptions)) ??
    defaultTakeItAwayWorkflowOptions()
  );
}

async function loadWorkflowWarnings(): Promise<string[]> {
  return (await state.get<string[] | null>(STORY_STATE_KEYS.workflowWarnings)) ?? [];
}

async function currentBranch(
  cwd: string,
): Promise<
  { readonly ok: true; readonly name: string } | { readonly ok: false; readonly warning: string }
> {
  const branch = await runGit(["branch", "--show-current"], cwd);
  if (!branch.ok || branch.stdout.trim().length === 0) {
    return {
      ok: false,
      warning: branch.ok
        ? "Git is in a detached HEAD state, so TrailStep could not safely create a PR."
        : `TrailStep could not determine the current branch: ${branch.error}`,
    };
  }
  return { ok: true, name: branch.stdout.trim() };
}

async function existingPullRequest(
  cwd: string,
  branch: string,
): Promise<{ readonly ok: true; readonly url?: string } | { readonly ok: false }> {
  const result = await runGh(
    ["pr", "list", "--head", branch, "--state", "open", "--json", "url", "--jq", '.[0].url // ""'],
    cwd,
  );
  if (!result.ok) {
    return { ok: false };
  }

  const url = extractUrl(result.stdout);
  return url ? { ok: true, url } : { ok: true };
}

async function defaultPullRequestTitle(output: TakeItAwayOutput): Promise<string> {
  const featureDoc = await state.get<Document | null>("featureDoc");
  const featureTitle = extractHeading(featureDoc?.content ?? "");
  if (featureTitle) {
    return truncateTitle(featureTitle);
  }

  return truncateTitle(output.completedStories[0] ?? "TrailStep implementation");
}

function defaultPullRequestBody(output: TakeItAwayOutput): string {
  return [
    output.summary,
    "",
    "## TrailStep artifacts",
    `- Feature doc: ${output.featureDocPath}`,
    `- Implementation doc: ${output.implementationDocPath}`,
    "",
    "## Completed stories",
    ...output.completedStories.map((story) => `- ${story}`),
  ].join("\n");
}

function skipped(
  warning: string,
  options: { readonly branch: string; readonly base: string; readonly remote: string },
): TakeItAwayPullRequestOutput {
  return {
    status: "skipped",
    warning,
    commands: suggestedCommands(options),
  };
}

function suggestedCommands({
  branch,
  base,
  remote,
}: {
  readonly branch: string;
  readonly base: string;
  readonly remote: string;
}): string[] {
  return [
    "git status --short",
    'git add -A && git commit -m "trailstep: finalize reviewed changes"',
    `git push --set-upstream ${shellQuote(remote)} ${shellQuote(branch)}`,
    `gh pr create --fill --base ${shellQuote(base)} --head ${shellQuote(branch)}`,
  ];
}

async function runGh(
  args: readonly string[],
  cwd: string,
): Promise<
  { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly error: string }
> {
  try {
    const { stdout } = await execFileAsync("gh", [...args], {
      cwd,
      maxBuffer: 1024 * 1024 * 10,
    });
    return { ok: true, stdout: stdout.trimEnd() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

function extractHeading(content: string): string | undefined {
  return /^#{1,6}\s+(.+)$/m.exec(content)?.[1]?.trim();
}

function truncateTitle(title: string): string {
  return title.length <= 72 ? title : `${title.slice(0, 69)}...`;
}

function extractUrl(stdout: string): string | undefined {
  return /https?:\/\/\S+/u.exec(stdout)?.[0];
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/u.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
