import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ArchGraph } from "./arch/engine/index.js";
import { manifest } from "./arch/manifest.js";
import { createDiagnostic } from "./arch/rules/index.js";
import {
  createGitRunner,
  type GitResult,
  type GitRunner,
  hasStrictViolations,
  isSourceFile,
  listChangedFiles,
  parseNameStatus,
  scopeDiagnosticsToTouched,
} from "./cli-changed.js";

function gitResponse(stdout: string): GitResult {
  return { ok: true, stdout, stderr: "" };
}

function fakeGit(handler: (command: string) => GitResult): GitRunner {
  return (args) => handler(args.join(" "));
}

interface GraphEdgeInput {
  readonly from: string;
  readonly to: string;
  readonly fromGroup: string | null;
  readonly toGroup: string | null;
}

interface GraphGroupInput {
  readonly name: string;
  readonly root: string;
}

/** The minimal graph shape the scope needs; no rules or scorecard fields. */
function graphFixture(options: {
  readonly files: readonly { readonly path: string; readonly group: string | null }[];
  readonly edges?: readonly GraphEdgeInput[];
  readonly groups?: readonly GraphGroupInput[];
}): ArchGraph {
  const edges = options.edges ?? [];
  return {
    projectRoot: "/repo",
    files: options.files.map((file) => ({
      path: file.path,
      group: file.group,
      rank: null,
      layerIndex: null,
      targetGroup: null,
    })),
    edges: edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      specifier: "./next.js",
      kind: "value",
      line: 1,
      column: 1,
      fromGroup: edge.fromGroup,
      toGroup: edge.toGroup,
    })),
    groups: (options.groups ?? []).map((group) => ({
      name: group.name,
      root: group.root,
      rank: null,
      layerIndex: null,
      targetGroup: group.name,
    })),
    resolutionErrors: [],
    stats: {
      files: options.files.length,
      edges: edges.length,
      valueEdges: edges.length,
      typeEdges: 0,
      resolutionErrors: 0,
    },
  };
}

const STATUS = "status --porcelain=v1 -z --untracked-files=normal";

/** Real-git fixture helper: fail loudly with git's stderr when a setup step fails. */
function runGit(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Arch Test",
      GIT_AUTHOR_EMAIL: "arch@example.test",
      GIT_COMMITTER_NAME: "Arch Test",
      GIT_COMMITTER_EMAIL: "arch@example.test",
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

describe("changed-file parsing", () => {
  it("parses name-status -z with deletions and renames", () => {
    const parsed = parseNameStatus(
      "R100\0src/old.ts\0src/new.ts\0M\0src/keep.ts\0D\0src/gone.ts\0",
    );
    expect(parsed.changed).toEqual(["src/new.ts", "src/keep.ts"]);
    expect(parsed.deleted).toEqual(["src/gone.ts"]);
  });

  it("recognises TypeScript source only", () => {
    expect(isSourceFile("src/a.ts")).toBe(true);
    expect(isSourceFile("src/a.tsx")).toBe(true);
    expect(isSourceFile("src/a.mts")).toBe(true);
    expect(isSourceFile("docs/readme.md")).toBe(false);
    expect(isSourceFile("package.json")).toBe(false);
  });
});

describe("listChangedFiles", () => {
  it("uses HEAD in a dirty tree and includes untracked source", () => {
    const git = fakeGit((command) => {
      if (command === STATUS) {
        return gitResponse(" M src/a.ts\0?? src/b.ts\0");
      }
      if (command === "diff --name-status -z HEAD --") {
        return gitResponse("M\0src/a.ts\0D\0src/gone.ts\0");
      }
      if (command === "ls-files --others --exclude-standard -z") {
        return gitResponse("src/b.ts\0README.md\0");
      }
      return { ok: false, stdout: "", stderr: `unexpected: ${command}` };
    });

    expect(listChangedFiles("/repo", git)).toEqual({
      base: "HEAD (dirty working tree)",
      dirty: true,
      touched: ["src/a.ts", "src/b.ts"],
      deleted: ["src/gone.ts"],
      nonSource: ["README.md"],
    });
  });

  it("uses the merge base in a clean tree", () => {
    const git = fakeGit((command) => {
      if (command === STATUS) {
        return gitResponse("");
      }
      if (command === "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") {
        return gitResponse("origin/main\n");
      }
      if (command === "rev-parse --verify --quiet origin/main^{commit}") {
        return gitResponse("sha\n");
      }
      if (command === "merge-base HEAD origin/main") {
        return gitResponse("abcdef1234567890\n");
      }
      if (command === "diff --name-status -z abcdef1234567890...HEAD --") {
        return gitResponse("A\0src/new.ts\0");
      }
      return { ok: false, stdout: "", stderr: `unexpected: ${command}` };
    });

    const changed = listChangedFiles("/repo", git);
    expect(changed.base).toBe("merge-base HEAD origin/main (abcdef123456)");
    expect(changed.dirty).toBe(false);
    expect(changed.touched).toEqual(["src/new.ts"]);
  });

  it("uses an explicit base in a dirty tree without widening to untracked files", () => {
    const git = fakeGit((command) => {
      if (command === STATUS) {
        return gitResponse(" M src/committed.ts\0?? src/untracked.ts\0");
      }
      if (command === "rev-parse --verify --quiet origin/main^{commit}") {
        return gitResponse("base-sha\n");
      }
      if (command === "merge-base HEAD origin/main") {
        return gitResponse("abcdef1234567890\n");
      }
      if (command === "diff --name-status -z abcdef1234567890...HEAD --") {
        return gitResponse("M\0src/committed.ts\0");
      }
      return { ok: false, stdout: "", stderr: `unexpected: ${command}` };
    });

    const changed = listChangedFiles("/repo", git, { base: "origin/main" });
    expect(changed.base).toBe("merge-base HEAD origin/main (abcdef123456)");
    expect(changed.dirty).toBe(true);
    expect(changed.touched).toEqual(["src/committed.ts"]);
  });

  it("fails closed when an explicit base does not resolve", () => {
    const commands: string[] = [];
    const git = fakeGit((command) => {
      commands.push(command);
      if (command === STATUS) {
        return gitResponse("");
      }
      return { ok: false, stdout: "", stderr: "unknown revision" };
    });

    expect(() => listChangedFiles("/repo", git, { base: "origin/main" })).toThrow(
      /does not resolve to a commit.*refusing a HEAD-only diff/,
    );
    expect(commands).not.toContain("diff --name-status -z HEAD --");
  });

  it("fails closed when an explicit base has no merge base", () => {
    const commands: string[] = [];
    const git = fakeGit((command) => {
      commands.push(command);
      if (command === STATUS) {
        return gitResponse("");
      }
      if (command === "rev-parse --verify --quiet origin/main^{commit}") {
        return gitResponse("base-sha\n");
      }
      return { ok: false, stdout: "", stderr: "no common ancestor" };
    });

    expect(() => listChangedFiles("/repo", git, { base: "origin/main" })).toThrow(
      /has no merge base with HEAD.*refusing a HEAD-only diff/,
    );
    expect(commands).not.toContain("diff --name-status -z HEAD --");
  });

  it("pins an explicit base after a pushed branch upstream would produce an empty diff", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "trailstep-arch-base-"));
    try {
      runGit(directory, ["init", "-q"]);
      runGit(directory, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      writeFileSync(path.join(directory, "base.ts"), "export const base = 1;\n");
      runGit(directory, ["add", "."]);
      runGit(directory, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"]);
      const baseSha = runGit(directory, ["rev-parse", "HEAD"]);

      runGit(directory, ["checkout", "-q", "-b", "feature"]);
      mkdirSync(path.join(directory, "src"));
      writeFileSync(path.join(directory, "src/feature.ts"), "export const feature = 1;\n");
      runGit(directory, ["add", "."]);
      runGit(directory, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "feature"]);

      // Simulate a pushed PR branch that tracks itself: the default clean-tree
      // selection merges against that upstream and sees no changes.
      runGit(directory, ["remote", "add", "origin", directory]);
      runGit(directory, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
      runGit(directory, ["update-ref", "refs/remotes/origin/main", baseSha]);
      runGit(directory, ["update-ref", "refs/remotes/origin/feature", "HEAD"]);
      runGit(directory, ["branch", "--set-upstream-to=origin/feature", "feature"]);

      const git = createGitRunner(directory);
      const localDefault = listChangedFiles(directory, git);
      expect(localDefault.base).toContain("origin/feature");
      expect(localDefault.touched).toEqual([]);

      const explicit = listChangedFiles(directory, git, { base: "origin/main" });
      expect(explicit.base).toBe(`merge-base HEAD origin/main (${baseSha.slice(0, 12)})`);
      expect(explicit.touched).toEqual(["src/feature.ts"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("falls back to HEAD when no merge base exists", () => {
    const git = fakeGit((command) => {
      if (command === STATUS) {
        return gitResponse("");
      }
      if (command === "diff --name-status -z HEAD --") {
        return gitResponse("");
      }
      return { ok: false, stdout: "", stderr: "" };
    });

    const changed = listChangedFiles("/repo", git);
    expect(changed.base).toBe("HEAD (no merge base)");
    expect(changed.touched).toEqual([]);
  });
});

describe("changed-file diagnostic scope", () => {
  const fileDiagnostic = createDiagnostic(manifest, "G8", {
    file: "src/authoring/consumer.ts",
    target: "src/contracts/owner/private.ts",
    message: "reach-in",
    line: 1,
    column: 1,
  });
  const folderDiagnostic = createDiagnostic(manifest, "G5", {
    file: "src/runtime/wide",
    target: "13 direct children",
    message: "too wide",
  });
  const reportDiagnostic = createDiagnostic(manifest, "G3", {
    file: "src/authoring/consumer.ts",
    target: "src/contracts/contracts.ts",
    message: "trend",
  });

  it("keeps a file-level diagnostic for a touched file", () => {
    expect(
      scopeDiagnosticsToTouched(
        [fileDiagnostic, folderDiagnostic, reportDiagnostic],
        ["src/authoring/consumer.ts"],
      ),
    ).toEqual([fileDiagnostic]);
  });

  it("keeps a G5 diagnostic only for the touched file's own folder", () => {
    const ancestor = createDiagnostic(manifest, "G5", {
      file: "src/runtime",
      target: "13 direct children",
      message: "too wide",
    });
    expect(scopeDiagnosticsToTouched([folderDiagnostic], ["src/runtime/wide/part-01.ts"])).toEqual([
      folderDiagnostic,
    ]);
    expect(scopeDiagnosticsToTouched([ancestor], ["src/runtime/wide/part-01.ts"])).toEqual([]);
  });

  it("keeps S-5 only for the touched file's own banned folder", () => {
    const banned = createDiagnostic(manifest, "S-5", {
      file: "src/runtime/utils",
      target: "utils",
      message: "banned folder name",
    });
    expect(scopeDiagnosticsToTouched([banned], ["src/runtime/utils/helper.ts"])).toEqual([banned]);
    expect(scopeDiagnosticsToTouched([banned], ["src/runtime/utils/nested/helper.ts"])).toEqual([]);
  });

  it("keeps G4 only when the touched file is a non-front-door importer under the folder's parent", () => {
    const nca = createDiagnostic(manifest, "G4", {
      file: "src/runtime/scope/helper",
      target: "alpha, beta",
      message: "nca",
    });
    const graph = graphFixture({
      groups: [{ name: "runtime", root: "src/runtime" }],
      files: [
        { path: "src/runtime/scope/alpha/a.ts", group: "runtime" },
        { path: "src/runtime/scope/beta/b.ts", group: "runtime" },
        { path: "src/runtime/scope/helper/helper.ts", group: "runtime" },
        { path: "src/runtime/scope/helper/private.ts", group: "runtime" },
        { path: "src/authoring/consumer.ts", group: "authoring" },
      ],
      edges: [
        {
          from: "src/runtime/scope/alpha/a.ts",
          to: "src/runtime/scope/helper/private.ts",
          fromGroup: "runtime",
          toGroup: "runtime",
        },
        {
          from: "src/authoring/consumer.ts",
          to: "src/runtime/scope/helper/private.ts",
          fromGroup: "authoring",
          toGroup: "runtime",
        },
      ],
    });
    expect(scopeDiagnosticsToTouched([nca], ["src/runtime/scope/alpha/a.ts"], { graph })).toEqual([
      nca,
    ]);
    expect(scopeDiagnosticsToTouched([nca], ["src/authoring/consumer.ts"], { graph })).toEqual([]);
    expect(scopeDiagnosticsToTouched([nca], ["src/runtime/scope/beta/b.ts"], { graph })).toEqual(
      [],
    );
  });

  it("does not keep G4 for a front-door importer (composition is not a reach-in)", () => {
    const nca = createDiagnostic(manifest, "G4", {
      file: "src/runtime/scope/helper",
      target: "alpha, beta",
      message: "nca",
    });
    const graph = graphFixture({
      groups: [{ name: "runtime", root: "src/runtime" }],
      files: [
        { path: "src/runtime/scope/alpha/a.ts", group: "runtime" },
        { path: "src/runtime/scope/helper/helper.ts", group: "runtime" },
        { path: "src/runtime/scope/helper/private.ts", group: "runtime" },
      ],
      edges: [
        {
          from: "src/runtime/scope/alpha/a.ts",
          to: "src/runtime/scope/helper/helper.ts",
          fromGroup: "runtime",
          toGroup: "runtime",
        },
      ],
    });

    expect(scopeDiagnosticsToTouched([nca], ["src/runtime/scope/alpha/a.ts"], { graph })).toEqual(
      [],
    );
  });

  it("keeps G1 only when the touched file's own edge is on a file cycle", () => {
    const cycle = createDiagnostic(manifest, "G1", {
      file: "src/agent-execution",
      target: "agent-execution, runtime",
      targetKind: "group",
      message: "cycle",
    });
    const graph = graphFixture({
      files: [
        { path: "src/runtime/a.ts", group: "runtime" },
        { path: "src/runtime/clean.ts", group: "runtime" },
        { path: "src/agent-execution/b.ts", group: "agent-execution" },
      ],
      edges: [
        {
          from: "src/runtime/a.ts",
          to: "src/agent-execution/b.ts",
          fromGroup: "runtime",
          toGroup: "agent-execution",
        },
        {
          from: "src/agent-execution/b.ts",
          to: "src/runtime/a.ts",
          fromGroup: "agent-execution",
          toGroup: "runtime",
        },
      ],
    });
    expect(scopeDiagnosticsToTouched([cycle], ["src/runtime/a.ts"], { graph })).toEqual([cycle]);
    expect(scopeDiagnosticsToTouched([cycle], ["src/runtime/clean.ts"], { graph })).toEqual([]);
  });

  it("does not treat a one-way edge into a cycle as G1 participation", () => {
    const cycle = createDiagnostic(manifest, "G1", {
      file: "src/agent-execution",
      target: "agent-execution, runtime",
      targetKind: "group",
      message: "cycle",
    });
    const graph = graphFixture({
      files: [
        { path: "src/runtime/a.ts", group: "runtime" },
        { path: "src/agent-execution/b.ts", group: "agent-execution" },
        { path: "src/authoring/consumer.ts", group: "authoring" },
      ],
      edges: [
        {
          from: "src/runtime/a.ts",
          to: "src/agent-execution/b.ts",
          fromGroup: "runtime",
          toGroup: "agent-execution",
        },
        {
          from: "src/agent-execution/b.ts",
          to: "src/runtime/a.ts",
          fromGroup: "agent-execution",
          toGroup: "runtime",
        },
        {
          from: "src/authoring/consumer.ts",
          to: "src/runtime/a.ts",
          fromGroup: "authoring",
          toGroup: "runtime",
        },
      ],
    });
    expect(scopeDiagnosticsToTouched([cycle], ["src/authoring/consumer.ts"], { graph })).toEqual(
      [],
    );
  });

  it("keeps a same-group owner-cycle G1 only for files on its file cycle", () => {
    const ownerCycle = createDiagnostic(manifest, "G1", {
      file: "src/contracts/agents",
      target: "src/contracts/agents, src/contracts/run-context",
      targetKind: "owner",
      message: "owner-folder cycle",
    });
    const graph = graphFixture({
      files: [
        { path: "src/contracts/agents/agents.ts", group: "contracts" },
        { path: "src/contracts/agents/clean.ts", group: "contracts" },
        { path: "src/contracts/run-context/run-context.ts", group: "contracts" },
      ],
      edges: [
        {
          from: "src/contracts/agents/agents.ts",
          to: "src/contracts/run-context/run-context.ts",
          fromGroup: "contracts",
          toGroup: "contracts",
        },
        {
          from: "src/contracts/run-context/run-context.ts",
          to: "src/contracts/agents/agents.ts",
          fromGroup: "contracts",
          toGroup: "contracts",
        },
      ],
    });

    expect(
      scopeDiagnosticsToTouched([ownerCycle], ["src/contracts/agents/agents.ts"], { graph }),
    ).toEqual([ownerCycle]);
    // Merely living in a cyclic owner folder is not file-cycle participation.
    expect(
      scopeDiagnosticsToTouched([ownerCycle], ["src/contracts/agents/clean.ts"], { graph }),
    ).toEqual([]);
  });

  it("scopes G1 by the structured target kind, never by target text", () => {
    const untyped = createDiagnostic(manifest, "G1", {
      file: "src/contracts/agents",
      target: "src/contracts/agents, src/contracts/run-context",
      message: "legacy diagnostic",
    });
    const graph = graphFixture({
      files: [
        { path: "src/contracts/agents/agents.ts", group: "contracts" },
        { path: "src/contracts/run-context/run-context.ts", group: "contracts" },
      ],
      edges: [
        {
          from: "src/contracts/agents/agents.ts",
          to: "src/contracts/run-context/run-context.ts",
          fromGroup: "contracts",
          toGroup: "contracts",
        },
        {
          from: "src/contracts/run-context/run-context.ts",
          to: "src/contracts/agents/agents.ts",
          fromGroup: "contracts",
          toGroup: "contracts",
        },
      ],
    });

    expect(
      scopeDiagnosticsToTouched([untyped], ["src/contracts/agents/agents.ts"], { graph }),
    ).toEqual([]);
  });

  it("does not keep G4 for an intra-owner importer (owner implementation, not a reach-in)", () => {
    const nca = createDiagnostic(manifest, "G4", {
      file: "src/runtime/scope/helper",
      target: "alpha, helper",
      message: "nca",
    });
    const graph = graphFixture({
      groups: [{ name: "runtime", root: "src/runtime" }],
      files: [
        { path: "src/runtime/scope/alpha/a.ts", group: "runtime" },
        { path: "src/runtime/scope/helper/helper.ts", group: "runtime" },
        { path: "src/runtime/scope/helper/private.ts", group: "runtime" },
      ],
      edges: [
        {
          from: "src/runtime/scope/helper/helper.ts",
          to: "src/runtime/scope/helper/private.ts",
          fromGroup: "runtime",
          toGroup: "runtime",
        },
        {
          from: "src/runtime/scope/alpha/a.ts",
          to: "src/runtime/scope/helper/private.ts",
          fromGroup: "runtime",
          toGroup: "runtime",
        },
      ],
    });

    expect(
      scopeDiagnosticsToTouched([nca], ["src/runtime/scope/helper/helper.ts"], { graph }),
    ).toEqual([]);
    expect(scopeDiagnosticsToTouched([nca], ["src/runtime/scope/alpha/a.ts"], { graph })).toEqual([
      nca,
    ]);
  });

  it("never blocks folder-existence diagnostics in changed mode", () => {
    const frontDoor = createDiagnostic(manifest, "V-6", {
      file: "src/runtime/owner",
      target: "owner.ts",
      message: "no front door",
    });
    expect(scopeDiagnosticsToTouched([frontDoor], ["src/runtime/owner/private.ts"])).toEqual([]);
  });

  it("drops unrelated folders, report-only diagnostics, and the empty case", () => {
    expect(scopeDiagnosticsToTouched([fileDiagnostic, folderDiagnostic], ["src/other.ts"])).toEqual(
      [],
    );
    expect(scopeDiagnosticsToTouched([reportDiagnostic], ["src/authoring/consumer.ts"])).toEqual(
      [],
    );
    expect(scopeDiagnosticsToTouched([fileDiagnostic], [])).toEqual([]);
  });

  it("treats only the hard set as blocking", () => {
    expect(hasStrictViolations([reportDiagnostic])).toBe(false);
    expect(hasStrictViolations([fileDiagnostic])).toBe(true);
  });
});
