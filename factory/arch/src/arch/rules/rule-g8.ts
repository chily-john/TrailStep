import path from "node:path";
import type { ArchGraph } from "../engine/types.js";
import type { ArchManifest } from "../manifest.js";
import { createDiagnostic } from "./diagnostics.js";
import { buildRuleIndex, frontDoorBasename, isInsideFolder } from "./graph-index.js";
import type { Diagnostic } from "./types.js";

/**
 * G8: an import of `<owner>/<file>.ts` from outside `<owner>/` must target the
 * owner's front door (`<owner>.ts`, or `<owner>.types.ts` for a declared
 * type-only family). A colocated `*.test.ts` file is exempt, and `api/` is the
 * package's public surface rather than an owner folder. Test importers are
 * exempt too: a test may import its unit directly.
 *
 * A pending contract family (W6 target) is declared here too, so the door name
 * the doc sanctions (`<owner>.types.ts`) is already the expected one: post-W6
 * imports of that door are not reach-ins.
 */
export function g8ReachIns(graph: ArchGraph, manifest: ArchManifest): Diagnostic[] {
  const index = buildRuleIndex(graph, manifest);
  const conventions = manifest.conventions;
  const diagnostics: Diagnostic[] = [];

  for (const edge of index.productionEdges) {
    const owner = path.posix.dirname(edge.to);
    const ownerName = path.posix.basename(owner);
    const fileName = path.posix.basename(edge.to);
    const frontDoor = frontDoorBasename(index, owner);

    if (owner === index.packageRoot || isInsideFolder(owner, edge.from)) {
      continue;
    }
    if (ownerName === conventions.publicSurfaceFolder) {
      continue;
    }
    if (edge.to.endsWith(conventions.testSuffix)) {
      continue;
    }
    if (fileName === frontDoor) {
      continue;
    }

    diagnostics.push(
      createDiagnostic(manifest, "G8", {
        file: edge.from,
        line: edge.line,
        column: edge.column,
        target: edge.to,
        message: `imports ${fileName} from outside ${ownerName}/; import the front door ${frontDoor}.`,
      }),
    );
  }

  return diagnostics;
}
