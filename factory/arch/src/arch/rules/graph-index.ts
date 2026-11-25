import path from "node:path";
import type { ArchGraph, GraphEdge, GraphFile } from "../engine/types.js";
import type { ArchManifest } from "../manifest.js";

/** Direct children of one folder, split into files and subfolders. */
export interface FolderChildren {
  readonly files: readonly string[];
  readonly folders: readonly string[];
}

/**
 * A read-only view rules share: the package source root, folder tree, and the
 * production/test split. Paths are the engine's `/`-separated paths, so all
 * operations use `path.posix` and never split a native filesystem path.
 */
export interface RuleIndex {
  readonly graph: ArchGraph;
  readonly manifest: ArchManifest;
  readonly packageRoot: string;
  readonly allFiles: readonly GraphFile[];
  readonly productionFiles: readonly GraphFile[];
  readonly testFiles: readonly GraphFile[];
  readonly productionEdges: readonly GraphEdge[];
  readonly folders: readonly string[];
  readonly folderSet: ReadonlySet<string>;
  readonly children: ReadonlyMap<string, FolderChildren>;
}

/** The package source root: the common ancestor of every declared group root. */
export function packageRootOf(manifest: ArchManifest, graph: ArchGraph): string {
  const roots = [
    ...manifest.ranks.flatMap((layer) => layer.groups.map((group) => group.root)),
    ...manifest.unrankedGroups.map((group) => group.root),
  ];
  if (roots.length > 0) {
    return commonAncestor(roots);
  }
  return commonAncestor(graph.files.map((file) => path.posix.dirname(file.path)));
}

function commonAncestor(paths: readonly string[]): string {
  if (paths.length === 0) {
    return "";
  }
  const segmentLists = paths.map((value) => value.split("/"));
  const first = segmentLists[0] ?? [];
  const common: string[] = [];
  for (const [index, segment] of first.entries()) {
    if (segmentLists.every((segments) => segments[index] === segment)) {
      common.push(segment);
    } else {
      break;
    }
  }
  return common.join("/");
}

/** True when `file` is strictly inside `folder`. */
export function isInsideFolder(folder: string, file: string): boolean {
  return file.startsWith(`${folder}/`);
}

/**
 * How a folder participates in the `<folder>.types.ts` family convention:
 * `materialized` when the door exists and the folder is declared in
 * `typeOnlyFamilies`; `pending` when it is one of W6's declared targets in
 * `contractFamilyRoots`. `null` for every other folder, whose front door is
 * `<folder>.ts` (V-6/G8). The two manifest lists are disjoint, so a folder has
 * exactly one kind and there is no duplicate family source.
 */
export type TypeDoorFamily = "materialized" | "pending";

export function typeDoorFamily(index: RuleIndex, folder: string): TypeDoorFamily | null {
  if (index.manifest.typeOnlyFamilies.includes(folder)) {
    return "materialized";
  }
  if (index.manifest.contractFamilyRoots.includes(folder)) {
    return "pending";
  }
  return null;
}

/**
 * The owner folder's front door: `<owner>.ts`, or `<owner>.types.ts` when the
 * folder is a declared type-only family (materialized or W6-pending). G8 uses
 * it for reach-ins; G4 uses it to tell deliberate module composition from a
 * private-helper reach-in. What the door exports is S-7's concern, not this
 * filename check's.
 */
export function frontDoorBasename(index: RuleIndex, folder: string): string {
  const owner = path.posix.basename(folder);
  return typeDoorFamily(index, folder) === null
    ? `${owner}.ts`
    : `${owner}${index.manifest.conventions.typeOnlySuffix}`;
}

/** The folder that directly contains `file`. */
export function folderOf(file: string): string {
  return path.posix.dirname(file);
}

/** The first path segment of `file` relative to `folder`. */
export function directChild(folder: string, file: string): string {
  const relative = path.posix.relative(folder, file);
  const [first = relative] = relative.split("/");
  return first;
}

/** Folder depth below the package root; the root itself is depth 0. */
export function folderDepth(packageRoot: string, folder: string): number {
  const relative = path.posix.relative(packageRoot, folder);
  return relative === "" ? 0 : relative.split("/").length;
}

/** Builds the shared index once per rule invocation. */
export function buildRuleIndex(graph: ArchGraph, manifest: ArchManifest): RuleIndex {
  const conventions = manifest.conventions;
  const packageRoot = packageRootOf(manifest, graph);
  const isTestFile = (file: string): boolean => file.endsWith(conventions.testSuffix);

  const folderSet = new Set<string>();
  for (const file of graph.files) {
    let folder = folderOf(file.path);
    while (folder === packageRoot || isInsideFolder(packageRoot, folder)) {
      folderSet.add(folder);
      if (folder === packageRoot) {
        break;
      }
      folder = folderOf(folder);
    }
  }

  const fileChildren = new Map<string, string[]>();
  const folderChildren = new Map<string, Set<string>>();
  for (const file of graph.files) {
    const folder = folderOf(file.path);
    const files = fileChildren.get(folder) ?? [];
    files.push(file.path);
    fileChildren.set(folder, files);
  }
  for (const folder of folderSet) {
    if (folder === packageRoot) {
      continue;
    }
    const parent = folderOf(folder);
    const children = folderChildren.get(parent) ?? new Set<string>();
    children.add(path.posix.basename(folder));
    folderChildren.set(parent, children);
  }

  const children = new Map<string, FolderChildren>();
  for (const folder of folderSet) {
    children.set(folder, {
      files: [...(fileChildren.get(folder) ?? [])].sort(),
      folders: [...(folderChildren.get(folder) ?? [])].sort(),
    });
  }

  const productionFiles = graph.files.filter((file) => !isTestFile(file.path));
  const testFiles = graph.files.filter((file) => isTestFile(file.path));
  const productionEdges = graph.edges.filter(
    (edge) => !isTestFile(edge.from) && !isTestFile(edge.to),
  );

  return {
    graph,
    manifest,
    packageRoot,
    allFiles: graph.files,
    productionFiles,
    testFiles,
    productionEdges,
    folders: [...folderSet].sort(),
    folderSet,
    children,
  };
}

/** True when any path segment names a fixtures folder. */
export function isFixturePath(index: RuleIndex, value: string): boolean {
  return value
    .split("/")
    .some((segment) => index.manifest.conventions.fixtureFolderNames.includes(segment));
}

/** The folder's direct children, excluding fixture entries (G5). */
export function countedChildren(index: RuleIndex, folder: string): FolderChildren {
  const children = index.children.get(folder);
  if (children === undefined) {
    return { files: [], folders: [] };
  }
  const fixtures = new Set(index.manifest.conventions.fixtureFolderNames);
  return {
    files: children.files.filter((file) => !fixtures.has(path.posix.basename(file))),
    folders: children.folders.filter((name) => !fixtures.has(name)),
  };
}

/** A production file's folder membership; test files are the T rules' input. */
export function productionFilesIn(index: RuleIndex, folder: string): readonly string[] {
  return index.productionFiles
    .filter((file) => folderOf(file.path) === folder)
    .map((file) => file.path);
}
