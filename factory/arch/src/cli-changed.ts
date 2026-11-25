/**
 * The `--changed` seam: which files a working tree or branch touches, and
 * which diagnostics belong to them.
 *
 * The git subprocess is injectable so the CLI tests never mutate the repo. The
 * base rule (dirty → HEAD; clean → merge base; no merge base → HEAD) is
 * documented in `cli-args.ts`'s help text and asserted here.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import type { ArchGraph } from "./arch/engine/types.js";
import { manifest } from "./arch/manifest.js";
import { buildRuleIndex, type RuleIndex } from "./arch/rules/graph-index.js";
import { type Diagnostic, isStrictRuleId, type StrictRuleId } from "./arch/rules/index.js";
import { isG4ReachIn, isG4ScopeFolder } from "./arch/rules/rule-g4.js";
import { stronglyConnectedComponents } from "./arch/rules/scc.js";

export interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export type GitRunner = (args: readonly string[]) => GitResult;

/** Spawns git with NUL-safe, argument-array (never shell) invocation. */
export function createGitRunner(cwd: string): GitRunner {
  return (args) => {
    const result = spawnSync("git", [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return {
      ok: result.status === 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
}

export interface ChangedFiles {
  /** Human label for the diff base, printed by `--changed`. */
  readonly base: string;
  readonly dirty: boolean;
  /** Touched TypeScript source files, sorted and unique (deleted excluded). */
  readonly touched: readonly string[];
  /** Deleted paths, excluded from the check: a deleted file cannot violate. */
  readonly deleted: readonly string[];
  /** Changed paths excluded as non-source. */
  readonly nonSource: readonly string[];
}

export interface ParsedNameStatus {
  readonly changed: readonly string[];
  readonly deleted: readonly string[];
}

const SOURCE_SUFFIXES = [".ts", ".tsx", ".mts", ".cts"] as const;

/** True for TypeScript source; docs, JSON, config and shell files never count. */
export function isSourceFile(filePath: string): boolean {
  return SOURCE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

function requireGit(result: GitResult, command: string): string {
  if (!result.ok) {
    throw new Error(`${command} failed: ${result.stderr.trim() || "git exited non-zero"}`);
  }
  return result.stdout;
}

function splitNul(output: string): string[] {
  return output.split("\0").filter((entry) => entry !== "");
}

/**
 * Parses `git diff --name-status -z`: `status\0path\0`, where a rename/copy
 * carries both paths (`R100\0old\0new\0`). Deletions are returned separately.
 */
export function parseNameStatus(output: string): ParsedNameStatus {
  const tokens = splitNul(output);
  const changed: string[] = [];
  const deleted: string[] = [];

  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index] ?? "";
    index += 1;
    if (status === "") {
      continue;
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      index += 1; // the old path; a rename is one touched new path
      const nextPath = tokens[index] ?? "";
      index += 1;
      if (nextPath !== "") {
        changed.push(nextPath);
      }
      continue;
    }
    const filePath = tokens[index] ?? "";
    index += 1;
    if (filePath === "") {
      continue;
    }
    if (status.startsWith("D")) {
      deleted.push(filePath);
    } else {
      changed.push(filePath);
    }
  }

  return { changed, deleted };
}

interface DiffSelection {
  readonly base: string;
  readonly args: readonly string[];
  readonly includeUntracked: boolean;
}

function firstMergeBase(git: GitRunner, target: string): string | null {
  const verify = git(["rev-parse", "--verify", "--quiet", `${target}^{commit}`]);
  if (!verify.ok) {
    return null;
  }
  const mergeBase = git(["merge-base", "HEAD", target]);
  if (!mergeBase.ok) {
    return null;
  }
  const sha = mergeBase.stdout.trim();
  return sha === "" ? null : sha;
}

function cleanSelection(git: GitRunner): DiffSelection {
  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const candidates = [
    upstream.ok ? upstream.stdout.trim() : "",
    "origin/main",
    "main",
    "origin/master",
    "master",
  ];

  for (const candidate of candidates) {
    if (candidate === "") {
      continue;
    }
    const mergeBase = firstMergeBase(git, candidate);
    if (mergeBase === null) {
      continue;
    }
    return {
      base: `merge-base HEAD ${candidate} (${mergeBase.slice(0, 12)})`,
      args: ["diff", "--name-status", "-z", `${mergeBase}...HEAD`, "--"],
      includeUntracked: false,
    };
  }

  return {
    base: "HEAD (no merge base)",
    args: ["diff", "--name-status", "-z", "HEAD", "--"],
    includeUntracked: false,
  };
}

function dirtySelection(): DiffSelection {
  return {
    base: "HEAD (dirty working tree)",
    args: ["diff", "--name-status", "-z", "HEAD", "--"],
    includeUntracked: true,
  };
}

/**
 * Lists the touched source files and names the base. A dirty tree always wins:
 * uncommitted work (including the protected docs drift) is compared against
 * HEAD, so a local `--changed` answers "what did I touch", not "what has this
 * long-lived branch accumulated".
 */
export function listChangedFiles(
  repoRoot: string,
  git: GitRunner = createGitRunner(repoRoot),
): ChangedFiles {
  const status = requireGit(
    git(["status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
    "git status",
  );
  const dirty = status.length > 0;
  const selection = dirty ? dirtySelection() : cleanSelection(git);
  const parsed = parseNameStatus(requireGit(git(selection.args), "git diff"));

  const paths = [...parsed.changed];
  if (selection.includeUntracked) {
    const untracked = requireGit(
      git(["ls-files", "--others", "--exclude-standard", "-z"]),
      "git ls-files",
    );
    paths.push(...splitNul(untracked));
  }

  const unique = [...new Set(paths)].sort();
  return {
    base: selection.base,
    dirty,
    touched: unique.filter(isSourceFile),
    deleted: parsed.deleted,
    nonSource: unique.filter((entry) => !isSourceFile(entry)),
  };
}

/**
 * How a rule's diagnostic maps onto the changed-files scope. This table is the
 * normative ratchet: only a touched file's own edges and own folder can block,
 * never an ancestor folder or a pre-existing folder-shape diagnostic.
 */
type ChangedScope =
  | "file"
  | "own-folder"
  | "folder-budget"
  | "folder-importer"
  | "edge-cycle"
  | "never";

const CHANGED_SCOPE: Readonly<Record<StrictRuleId, ChangedScope>> = {
  G1: "edge-cycle",
  G2: "file",
  G4: "folder-importer",
  G5: "folder-budget",
  G8: "file",
  "S-5": "own-folder",
  "S-6": "file",
  "S-9": "never",
  "V-4": "never",
  "V-6": "never",
  "N-1": "file",
  "M-6": "file",
  "T-1": "file",
  "T-2": "file",
};

export interface ScopeOptions {
  /** The analyzed graph; G1 edge participation and G4 importers need it. */
  readonly graph?: ArchGraph;
  /** Test-file suffix; defaults to the manifest convention. */
  readonly testSuffix?: string;
}

/** The touched file's own folder: the only folder budget that can block. */
function ownFolders(touched: readonly string[]): ReadonlySet<string> {
  return new Set(touched.map((file) => path.posix.dirname(file)));
}

function isInside(folder: string, file: string): boolean {
  return file.startsWith(`${folder}/`);
}

function isTestPath(file: string, testSuffix: string): boolean {
  return file.endsWith(testSuffix);
}

/**
 * G4 blocks only when the touched file is a qualifying non-front-door importer
 * of the flagged folder under that folder's parent — exactly the edge set
 * `g4NcaViolations` counts. A front-door import is composition, an intra-owner
 * import is the owner's implementation, an importer outside the parent is a
 * G2/G8 case, and a top-level group is not a G4 folder; none can make the NCA
 * span.
 */
function importsFlaggedFolder(
  index: RuleIndex,
  testSuffix: string,
  touchedFile: string,
  folder: string,
): boolean {
  if (isTestPath(touchedFile, testSuffix) || !isG4ScopeFolder(index, folder)) {
    return false;
  }
  const parent = path.posix.dirname(folder);
  const importerFolder = path.posix.dirname(touchedFile);
  if (importerFolder !== parent && !isInside(parent, importerFolder)) {
    return false;
  }
  return index.productionEdges.some(
    (edge) => edge.from === touchedFile && isG4ReachIn(index, folder, edge),
  );
}

/**
 * The files on a value-or-type cycle inside one G1 SCC. The diagnostic names
 * either groups or owner folders; the ratchet needs the file-level component
 * so a file that merely lives in a cyclic group or owner folder does not block.
 * The diagnostic's structured `targetKind` selects the namespace; the target
 * text is never inspected.
 */
function cycleParticipantFiles(
  graph: ArchGraph,
  members: ReadonlySet<string>,
  kind: "group" | "owner",
  testSuffix: string,
): ReadonlySet<string> {
  const files = graph.files
    .filter((file) => {
      if (isTestPath(file.path, testSuffix)) {
        return false;
      }
      return kind === "owner"
        ? members.has(path.posix.dirname(file.path))
        : file.group !== null && members.has(file.group);
    })
    .map((file) => file.path);
  const nodes = new Set(files);
  const edges: (readonly [string, string])[] = [];
  for (const edge of graph.edges) {
    if (isTestPath(edge.from, testSuffix) || isTestPath(edge.to, testSuffix)) {
      continue;
    }
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      continue;
    }
    edges.push([edge.from, edge.to]);
  }
  return new Set(stronglyConnectedComponents(files, edges).flat());
}

function touchesCycle(
  diagnostic: Diagnostic,
  touched: readonly string[],
  graph: ArchGraph,
  testSuffix: string,
): boolean {
  const members = new Set(
    diagnostic.target
      .split(",")
      .map((member) => member.trim())
      .filter((member) => member !== ""),
  );
  if (members.size === 0) {
    return false;
  }
  // A G1 diagnostic without a structured kind cannot be scoped safely; only
  // the rule itself sets the field, so this is defensive, never a fallback.
  if (diagnostic.targetKind === undefined) {
    return false;
  }
  const participants = cycleParticipantFiles(graph, members, diagnostic.targetKind, testSuffix);
  return touched.some((file) => participants.has(file));
}

function scopeMayBlock(
  diagnostic: Diagnostic,
  touched: readonly string[],
  touchedSet: ReadonlySet<string>,
  folders: ReadonlySet<string>,
  graph: ArchGraph | undefined,
  index: RuleIndex | undefined,
  testSuffix: string,
): boolean {
  if (diagnostic.set !== "hard") {
    return false;
  }
  // Unknown rules keep the safe file-level default: a diagnostic names a
  // touched file, never an ancestor folder.
  const scope = isStrictRuleId(diagnostic.rule) ? CHANGED_SCOPE[diagnostic.rule] : "file";
  if (scope === "file") {
    return touchedSet.has(diagnostic.file);
  }
  if (scope === "own-folder" || scope === "folder-budget") {
    return folders.has(diagnostic.file);
  }
  if (scope === "never") {
    return false;
  }
  if (graph === undefined || index === undefined) {
    return false;
  }
  if (scope === "folder-importer") {
    return touched.some((file) => importsFlaggedFolder(index, testSuffix, file, diagnostic.file));
  }
  return touchesCycle(diagnostic, touched, graph, testSuffix);
}

/**
 * The strict set scoped to the touched files. Rules map through
 * `CHANGED_SCOPE`: file-level diagnostics must name a touched file, folder
 * budgets and S-5 must name the touched file's own folder, G4 needs a touched
 * importer, G1 needs the touched file on a file cycle, and the folder-shape
 * rules (V-4, V-6, S-9) never block here. Report/review diagnostics never
 * enter `--changed`.
 */
export function scopeDiagnosticsToTouched(
  diagnostics: readonly Diagnostic[],
  touched: readonly string[],
  options: ScopeOptions = {},
): Diagnostic[] {
  if (touched.length === 0) {
    return [];
  }
  const touchedSet = new Set(touched);
  const folders = ownFolders(touched);
  const testSuffix = options.testSuffix ?? manifest.conventions.testSuffix;
  const index = options.graph === undefined ? undefined : buildRuleIndex(options.graph, manifest);
  return diagnostics.filter((diagnostic) =>
    scopeMayBlock(diagnostic, touched, touchedSet, folders, options.graph, index, testSuffix),
  );
}

export function hasStrictViolations(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.set === "hard");
}
