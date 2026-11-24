import path from "node:path";
import type { ArchGraph, GraphFile } from "../engine/types.js";
import type { ArchManifest } from "../manifest.js";
import { createDiagnostic } from "./diagnostics.js";
import { buildRuleIndex, isFixturePath, isInsideFolder, type RuleIndex } from "./graph-index.js";
import type { Diagnostic } from "./types.js";

/**
 * Every unit kind a colocated test may sit beside (doc T-1: `foo.ts` +
 * `foo.test.ts`; N-2: `<family>.types.ts`; contract schemas `<stem>.schema.ts`).
 * The suffixes are manifest conventions, never repo names.
 */
function unitPathsFor(testFile: string, manifest: ArchManifest): readonly string[] {
  const { testSuffix, typeOnlySuffix, schemaSuffix } = manifest.conventions;
  const stem = testFile.slice(0, -testSuffix.length);
  return [".ts", typeOnlySuffix, schemaSuffix].map((suffix) => `${stem}${suffix}`);
}

function crossCuttingTestRoot(index: RuleIndex): string {
  return path.posix.join(
    path.posix.dirname(index.packageRoot),
    index.manifest.conventions.crossCuttingTestFolder,
  );
}

function isInCrossCuttingRoot(index: RuleIndex, test: GraphFile): boolean {
  const testRoot = crossCuttingTestRoot(index);
  return test.path === testRoot || isInsideFolder(testRoot, test.path);
}

/** The unit paths that exist anywhere in the package, keyed by basename. */
function unitBaseNames(index: RuleIndex): Map<string, string> {
  return new Map(index.productionFiles.map((file) => [path.posix.basename(file.path), file.path]));
}

/**
 * T-1: a unit test is colocated with its unit. `unit.ts`, `unit.types.ts` and
 * `unit.schema.ts` all count as the unit under the same stem. A test whose unit
 * exists in another folder is a T-1 violation; a test with no unit anywhere is
 * not a unit test at all and falls to T-2.
 */
export function t1ColocatedTests(graph: ArchGraph, manifest: ArchManifest): Diagnostic[] {
  const index = buildRuleIndex(graph, manifest);
  const unitByPath = new Set(index.productionFiles.map((file) => file.path));
  const unitByBase = unitBaseNames(index);
  const diagnostics: Diagnostic[] = [];

  for (const test of index.testFiles) {
    if (isFixturePath(index, test.path) || isInCrossCuttingRoot(index, test)) {
      continue;
    }
    const unitPaths = unitPathsFor(test.path, manifest);
    if (unitPaths.some((unitPath) => unitByPath.has(unitPath))) {
      continue;
    }
    const elsewhere = unitPaths
      .map((unitPath) => unitByBase.get(path.posix.basename(unitPath)))
      .find((unitPath) => unitPath !== undefined);
    if (elsewhere !== undefined) {
      diagnostics.push(
        createDiagnostic(manifest, "T-1", {
          file: test.path,
          target: elsewhere,
          message: `test is not colocated with its unit (${elsewhere}); move it beside the unit.`,
        }),
      );
    }
  }

  return diagnostics;
}

/** The §8.1 target groups a test touches: its own group plus every import target. */
function touchedGroups(index: RuleIndex, test: GraphFile): readonly string[] {
  const targetGroupOf = new Map(index.graph.groups.map((group) => [group.name, group.targetGroup]));
  const groups = new Set<string>();
  if (test.group !== null) {
    groups.add(targetGroupOf.get(test.group) ?? test.group);
  }
  for (const edge of index.graph.edges) {
    if (edge.from !== test.path || edge.toGroup === null) {
      continue;
    }
    groups.add(targetGroupOf.get(edge.toGroup) ?? edge.toGroup);
  }
  return [...groups].sort();
}

/**
 * T-2: cross-cutting tests live in `packages/<pkg>/test/` (doc §10: "CLI
 * subprocess, MCP transport, end-to-end runs"; "There is no third location").
 *
 * Mechanical definition, scoped to that category: a test is cross-cutting when
 * it has NO unit of any kind anywhere (so it is not a T-1 unit test) AND the
 * §8.1 groups it touches span more than one group — its own group plus the
 * groups it imports. A test that stays inside one group is a folder behavior
 * test, not cross-cutting: the doc's category is about exercising a seam, not
 * about lacking a same-named unit. This is narrower than the earlier
 * "no same-basename unit anywhere" reading, which flagged colocated behavioral
 * tests.
 */
export function t2CrossCuttingTests(graph: ArchGraph, manifest: ArchManifest): Diagnostic[] {
  const index = buildRuleIndex(graph, manifest);
  const unitByPath = new Set(index.productionFiles.map((file) => file.path));
  const unitByBase = unitBaseNames(index);
  const diagnostics: Diagnostic[] = [];

  for (const test of index.testFiles) {
    if (isFixturePath(index, test.path) || isInCrossCuttingRoot(index, test)) {
      continue;
    }
    const unitPaths = unitPathsFor(test.path, manifest);
    if (unitPaths.some((unitPath) => unitByPath.has(unitPath))) {
      continue;
    }
    if (unitPaths.some((unitPath) => unitByBase.has(path.posix.basename(unitPath)))) {
      continue;
    }
    const groups = touchedGroups(index, test);
    if (groups.length <= 1) {
      continue;
    }
    diagnostics.push(
      createDiagnostic(manifest, "T-2", {
        file: test.path,
        target: crossCuttingTestRoot(index),
        message: `test has no unit and spans ${groups.join(", ")}; cross-cutting tests belong in ${crossCuttingTestRoot(index)}/.`,
      }),
    );
  }

  return diagnostics;
}
