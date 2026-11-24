import path from "node:path";
import type { ArchGraph } from "../engine/types.js";
import type { ArchManifest } from "../manifest.js";
import { createDiagnostic } from "./diagnostics.js";
import { buildRuleIndex, isFixturePath, type RuleIndex, typeDoorFamily } from "./graph-index.js";
import type { Diagnostic } from "./types.js";

function productionDirectFiles(index: RuleIndex, folder: string): readonly string[] {
  return (index.children.get(folder)?.files ?? []).filter(
    (file) => !file.endsWith(index.manifest.conventions.testSuffix),
  );
}

/** A crude singular/stem form: `agents` → `agent`, `policies` → `policy`. */
function singularStem(name: string): string {
  if (name.endsWith("ies")) {
    return `${name.slice(0, -3)}y`;
  }
  if (name.endsWith("ses") || name.endsWith("xes") || name.endsWith("zes")) {
    return name.slice(0, -2);
  }
  if (name.endsWith("s") && !name.endsWith("ss")) {
    return name.slice(0, -1);
  }
  return name;
}

/**
 * V-4's relation test: the containing folder already carries the repeated
 * prefix when its own name equals the prefix, starts with `<prefix>-`, or its
 * singular/stem does (`agents`/`agent-*`, `providers`/`provider-*`,
 * `sub-prompts`/`sub-*`). Creating `<prefix>/` inside such a folder would
 * create `agents/agent/`, so the missing-folder reading is wrong there. The
 * doc's literal case (`scheduler-*.ts` in `run-workflow/`) names an unrelated
 * folder and still fires.
 */
function folderCarriesPrefix(folderName: string, prefix: string): boolean {
  return [folderName, singularStem(folderName)].some(
    (candidate) => candidate === prefix || candidate.startsWith(`${prefix}-`),
  );
}

/** V-4: three same-prefix files in one folder mean the folder is missing. */
export function v4RepeatedPrefixes(graph: ArchGraph, manifest: ArchManifest): Diagnostic[] {
  const index = buildRuleIndex(graph, manifest);
  const threshold = manifest.conventions.repeatedPrefixThreshold;
  const diagnostics: Diagnostic[] = [];

  for (const folder of index.folders) {
    if (isFixturePath(index, folder)) {
      continue;
    }
    const folderName = path.posix.basename(folder);
    const counts = new Map<string, number>();
    for (const file of productionDirectFiles(index, folder)) {
      const name = path.posix.basename(file);
      const separator = name.indexOf("-");
      if (separator <= 0) {
        continue;
      }
      const prefix = name.slice(0, separator);
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    for (const prefix of [...counts.keys()].sort()) {
      const count = counts.get(prefix) ?? 0;
      if (count < threshold) {
        continue;
      }
      if (folderCarriesPrefix(folderName, prefix)) {
        continue;
      }
      diagnostics.push(
        createDiagnostic(manifest, "V-4", {
          file: folder,
          target: `${prefix}-*`,
          message: `has ${count} files sharing the "${prefix}-" prefix; create "${prefix}/" and move them.`,
        }),
      );
    }
  }

  return diagnostics;
}

/** V-6: every owner folder exposes `<owner>.ts`, or a declared `<owner>.types.ts`. */
export function v6FrontDoorPresence(graph: ArchGraph, manifest: ArchManifest): Diagnostic[] {
  const index = buildRuleIndex(graph, manifest);
  const conventions = manifest.conventions;
  const diagnostics: Diagnostic[] = [];

  for (const folder of index.folders) {
    if (folder === index.packageRoot || isFixturePath(index, folder)) {
      continue;
    }
    const ownerName = path.posix.basename(folder);
    if (ownerName === conventions.publicSurfaceFolder) {
      continue;
    }
    const files = productionDirectFiles(index, folder);
    if (files.length === 0) {
      continue;
    }
    const names = new Set(files.map((file) => path.posix.basename(file)));
    const valueFrontDoor = `${ownerName}.ts`;
    const typeFrontDoor = `${ownerName}${conventions.typeOnlySuffix}`;
    const family = typeDoorFamily(index, folder);

    // A type-door family's door is `<folder>.types.ts`, materialized or W6's
    // declared target. Naming `<folder>.ts` here would send W6 to the wrong file.
    if (family !== null) {
      if (names.has(typeFrontDoor)) {
        continue;
      }
      diagnostics.push(
        createDiagnostic(manifest, "V-6", {
          file: folder,
          target: typeFrontDoor,
          message:
            family === "pending"
              ? `has no declared front door ${typeFrontDoor} (W6 target; create it and declare the family).`
              : `has no declared front door ${typeFrontDoor}.`,
        }),
      );
      continue;
    }

    if (names.has(valueFrontDoor)) {
      continue;
    }
    diagnostics.push(
      createDiagnostic(manifest, "V-6", {
        file: folder,
        target: valueFrontDoor,
        message: `has no front door ${valueFrontDoor}.`,
      }),
    );
  }

  return diagnostics;
}

/** N-1: reserved catch-all basenames are banned below the package root. */
export function n1ReservedFilenames(graph: ArchGraph, manifest: ArchManifest): Diagnostic[] {
  const index = buildRuleIndex(graph, manifest);
  const reserved = new Set(manifest.conventions.reservedFilenames);
  const diagnostics: Diagnostic[] = [];

  for (const file of graph.files) {
    if (path.posix.dirname(file.path) === index.packageRoot) {
      continue;
    }
    if (isFixturePath(index, file.path)) {
      continue;
    }
    const name = path.posix.basename(file.path);
    if (reserved.has(name)) {
      diagnostics.push(
        createDiagnostic(manifest, "N-1", {
          file: file.path,
          target: name,
          message: `"${name}" is a catch-all name; use a kebab-case file named for its owner.`,
        }),
      );
    }
  }

  return diagnostics;
}
