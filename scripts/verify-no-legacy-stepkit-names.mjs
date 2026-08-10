import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { sep } from "node:path";

const root = process.cwd();

const old = {
  product: "Step" + "Kit",
  lower: "step" + "kit",
  env: "STEP" + "KIT",
  scope: "@step" + "kit",
  dotDir: ".step" + "kit",
  workflowKeyword: "step" + "kit-workflow",
  skillPrefix: "s" + "k-",
};

const categories = new Set([
  "historical",
  "format-marker",
  "legacy-rejection-fixture",
  "external",
  "generated-excluded",
]);

const allowlist = [
  {
    path: `scripts/verify-no-legacy-${old.lower}-names.mjs`,
    target: "path",
    match: old.lower,
    occurrences: 1,
    category: "legacy-rejection-fixture",
    reason: "Verifier filename intentionally names the legacy term that it rejects.",
  },
  {
    path: "packages/create-flows/src/feature-implementation/shared/constants.ts",
    match: `<!-- ${old.lower}-story-boundary -->`,
    occurrences: 1,
    category: "format-marker",
    reason:
      "Mechanical story splitting marker retained for existing workflow format compatibility.",
  },
  {
    path: "packages/create-flows/src/feature-implementation/shared/implementation-doc-format.md",
    match: `<!-- ${old.lower}-story-boundary -->`,
    occurrences: 4,
    category: "format-marker",
    reason: "Authoring documentation must describe the current mechanical story boundary marker.",
  },
  {
    path: "packages/create-flows/src/feature-implementation/create-or-improve-implementation-doc/prompt.ts",
    match: `<!-- ${old.lower}-story-boundary -->`,
    occurrences: 1,
    category: "format-marker",
    reason: "Prompt instructs authors to keep the current mechanical story boundary marker.",
  },
  {
    path: "packages/create-flows/src/feature-implementation/review-implementation-doc/prompt.ts",
    match: `<!-- ${old.lower}-story-boundary -->`,
    occurrences: 1,
    category: "format-marker",
    reason: "Reviewer prompt validates the current mechanical story boundary marker.",
  },
  {
    path: "packages/create-flows/src/feature-implementation/implement-story/prompt.test.ts",
    match: `<!-- ${old.lower}-story-boundary -->`,
    occurrences: 1,
    category: "format-marker",
    reason:
      "Test fixture asserts documentation still contains the mechanical story boundary marker.",
  },
  {
    path: "packages/create-flows/src/take-it-away/workflow.test.ts",
    match: `<!-- ${old.lower}-story-boundary -->`,
    occurrences: 9,
    category: "format-marker",
    reason: "Workflow tests use the current mechanical story boundary marker in fixtures.",
  },
  {
    path: "packages/create-flows/src/grill-it-away/workflow.test.ts",
    match: `<!-- ${old.lower}-story-boundary -->`,
    occurrences: 1,
    category: "format-marker",
    reason: "Workflow tests use the current mechanical story boundary marker in fixtures.",
  },
  {
    path: "packages/cli/src/test/setup-clean-env.ts",
    match: `${old.env}_`,
    occurrences: 1,
    category: "legacy-rejection-fixture",
    reason:
      "Test setup removes migrated environment variables so legacy values cannot leak between tests.",
  },
  {
    path: "packages/core/src/agent-execution/interactive-agent/run-interactive-agent-command.ts",
    match: `${old.env}_`,
    occurrences: 1,
    category: "legacy-rejection-fixture",
    reason: "Runtime intentionally filters migrated environment variables from provider processes.",
  },
  {
    path: "packages/core/src/agent-execution/interactive-agent/run-interactive-agent-command.test.ts",
    match: `${old.env}_INTERACTIVE_FILE`,
    occurrences: 5,
    category: "legacy-rejection-fixture",
    reason: "Test proves the migrated interactive environment variable is not forwarded.",
  },
  {
    path: "packages/cli/src/internals/commands/cancel/cancel-command.test.ts",
    match: `${old.env}_INTERACTIVE_FILE`,
    occurrences: 2,
    category: "legacy-rejection-fixture",
    reason: "Command test proves migrated interactive environment variable is rejected.",
  },
  {
    path: "packages/cli/src/internals/commands/continue/continue-command.test.ts",
    match: `${old.env}_INTERACTIVE_FILE`,
    occurrences: 2,
    category: "legacy-rejection-fixture",
    reason: "Command test proves migrated interactive environment variable is rejected.",
  },
  {
    path: "packages/cli/src/internals/commands/run/run-command.test.ts",
    match: `${old.env}_RUNS_ROOT`,
    occurrences: 2,
    category: "legacy-rejection-fixture",
    reason: "Command test proves migrated runs-root environment override is ignored.",
  },
  {
    path: "packages/cli/src/internals/commands/run/run-command.test.ts",
    match: old.dotDir,
    occurrences: 2,
    category: "legacy-rejection-fixture",
    reason: "Command test proves migrated runtime directory is not created or used.",
  },
  {
    path: "packages/cli/src/e2e-continuation.test.ts",
    match: old.lower,
    occurrences: 2,
    category: "legacy-rejection-fixture",
    reason: "End-to-end test proves the migrated command name is absent from package bin metadata.",
  },
  {
    path: "packages/cli/src/e2e-continuation.test.ts",
    match: old.dotDir,
    occurrences: 1,
    category: "legacy-rejection-fixture",
    reason: "End-to-end test proves the migrated runtime directory is not created.",
  },
  {
    path: "packages/core/src/index.test.ts",
    match: old.product,
    occurrences: 3,
    category: "legacy-rejection-fixture",
    reason: "Export surface test proves migrated compatibility aliases are absent.",
  },
  ...[
    [".changeset/big-agents-schema-rollout.md", { scope: 2, lower: 2, product: 0 }],
    [".changeset/interactive-permission-bypass-default.md", { scope: 1, lower: 0, product: 0 }],
    [".changeset/rename-sdk-to-authoring.md", { scope: 6, lower: 0, product: 0 }],
    [
      `.changeset/${old.lower}-doctor-update-deps.md`,
      { scope: 4, lower: 3, product: 1, pathLower: 1 },
    ],
    [".changeset/workflow-skill-names.md", { scope: 1, lower: 0, product: 0 }],
  ].flatMap(([path, counts]) => [
    ...(counts.pathLower
      ? [
          {
            path,
            target: "path",
            match: old.lower,
            occurrences: counts.pathLower,
            category: "historical",
            reason: "Changeset filename records historical package naming from before the rename.",
          },
        ]
      : []),
    ...(counts.scope
      ? [
          {
            path,
            match: old.scope,
            occurrences: counts.scope,
            category: "historical",
            reason: "Changeset records historical package metadata from before the rename.",
          },
        ]
      : []),
    ...(counts.lower
      ? [
          {
            path,
            match: old.lower,
            occurrences: counts.lower,
            category: "historical",
            reason:
              "Changeset records historical command or package naming from before the rename.",
          },
        ]
      : []),
    ...(counts.product
      ? [
          {
            path,
            match: old.product,
            occurrences: counts.product,
            category: "historical",
            reason: "Changeset records historical product naming from before the rename.",
          },
        ]
      : []),
  ]),
];

for (const entry of allowlist) {
  if (!entry.path || !entry.match || !entry.reason || !entry.category) {
    throw new Error(`Invalid allowlist entry: ${JSON.stringify(entry)}`);
  }
  if (!Number.isInteger(entry.occurrences) || entry.occurrences < 1) {
    throw new Error(`Invalid allowlist occurrence count for ${entry.path}: ${entry.occurrences}`);
  }
  if (!categories.has(entry.category)) {
    throw new Error(`Invalid allowlist category for ${entry.path}: ${entry.category}`);
  }
  if (entry.target && !["content", "path"].includes(entry.target)) {
    throw new Error(`Invalid allowlist target for ${entry.path}: ${entry.target}`);
  }
}

const checks = [
  { label: old.scope, pattern: escapeRegExp(old.scope) },
  { label: old.workflowKeyword, pattern: escapeRegExp(old.workflowKeyword) },
  { label: old.dotDir, pattern: escapeRegExp(old.dotDir) },
  { label: old.env, pattern: escapeRegExp(old.env) },
  { label: old.product, pattern: escapeRegExp(old.product) },
  { label: old.lower, pattern: `(?<![@.])\\b${escapeRegExp(old.lower)}\\b(?!-workflow)` },
  { label: `${old.skillPrefix}*`, pattern: `\\b${escapeRegExp(old.skillPrefix)}[A-Za-z0-9_-]+` },
].map((check) => ({ ...check, regex: new RegExp(check.pattern, "g") }));

const excludedPathParts = [
  "node_modules",
  "dist",
  "coverage",
  ".turbo",
  "graphify-out",
  ".trailstep/runs",
  ".trailstep/inputs",
  ".trailstep/worktrees",
  "packages/dashboard/.tmp",
  ".git",
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function discoverFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root },
  );
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((path) => path.split(sep).join("/"))
    .filter((path) => !isExcluded(path) && existsSync(path) && statSync(path).isFile());
}

function isExcluded(path) {
  return excludedPathParts.some((part) => path === part || path.startsWith(`${part}/`));
}

function lineAndColumn(text, index) {
  const before = text.slice(0, index);
  const lines = before.split("\n");
  return { line: lines.length, column: lines.at(-1).length + 1 };
}

function createAllowanceTracker() {
  return allowlist.map((entry) => ({
    ...entry,
    target: entry.target ?? "content",
    remaining: entry.occurrences,
  }));
}

function consumeAllowance(remaining, target, path, text, index, matchedText) {
  const entry = remaining.find((candidate) => {
    if (candidate.target !== target || candidate.path !== path || candidate.remaining < 1) {
      return false;
    }
    for (const offset of matchOffsets(candidate.match, matchedText)) {
      const start = index - offset;
      if (start >= 0 && text.startsWith(candidate.match, start)) {
        return true;
      }
    }
    return false;
  });
  if (!entry) {
    return false;
  }
  entry.remaining -= 1;
  return true;
}

function matchOffsets(text, search) {
  const offsets = [];
  let index = text.indexOf(search);
  while (index !== -1) {
    offsets.push(index);
    index = text.indexOf(search, index + 1);
  }
  return offsets;
}

function scanText({ path, text, target, remaining }) {
  const violations = [];
  for (const check of checks) {
    check.regex.lastIndex = 0;
    for (const match of text.matchAll(check.regex)) {
      const matchedText = match[0];
      if (consumeAllowance(remaining, target, path, text, match.index ?? 0, matchedText)) {
        continue;
      }
      const location = target === "content" ? lineAndColumn(text, match.index ?? 0) : undefined;
      violations.push({
        path,
        line: location?.line,
        column: location?.column,
        target,
        check: check.label,
        matchedText,
      });
    }
  }
  return violations;
}

function scanFile(path, remaining) {
  const violations = scanText({ path, text: path, target: "path", remaining });

  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return violations;
  }

  violations.push(...scanText({ path, text, target: "content", remaining }));
  return violations;
}

export function verifyNoLegacyNames() {
  const remaining = createAllowanceTracker();
  const violations = discoverFiles().flatMap((path) => scanFile(path, remaining));

  if (violations.length > 0) {
    const details = violations
      .sort(
        (a, b) =>
          a.path.localeCompare(b.path) ||
          (a.line ?? 0) - (b.line ?? 0) ||
          (a.column ?? 0) - (b.column ?? 0) ||
          a.target.localeCompare(b.target),
      )
      .map((violation) => {
        const location =
          violation.target === "content" ? `:${violation.line}:${violation.column}` : "";
        return `${violation.path}${location} (${violation.target}) matched ${JSON.stringify(
          violation.matchedText,
        )} for ${JSON.stringify(violation.check)} without an exact allowlist occurrence`;
      })
      .join("\n");
    throw new Error(`Found active legacy TrailStep naming references:\n${details}`);
  }
}

verifyNoLegacyNames();
console.log("No active legacy TrailStep naming references found.");
