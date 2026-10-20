import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { PlainObject, WorkingAgentProcessRunner } from "@trailstep/core";

/** A canned response for one matched `outputFile` substring. */
export interface FakeOutputRoute {
  /** Written to `outputFile`: strings verbatim, objects as JSON. Omit to write nothing (e.g. failing exit codes). */
  readonly output?: string | PlainObject;
  /** Returned to the runtime; defaults to `0`. */
  readonly exitCode?: number;
}

/** Route shorthand: a plain string is a raw `outputFile` body with exit code 0. */
export type FakeOutputRouteInput = string | FakeOutputRoute;

/**
 * Build a `workingAgentProcessRunner` that answers agent requests from canned
 * routes keyed by case-insensitive `outputFile` substrings (step artifact paths
 * contain the sanitized step id, e.g. `steps/0001-review/output.json`).
 * Longer substrings win over shorter ones, so specific routes beat broad ones.
 * Requests matching no route throw instead of spawning a subprocess.
 */
export function fakeOutputFileHandler(
  routes: Readonly<Record<string, FakeOutputRouteInput>>,
): WorkingAgentProcessRunner {
  const ordered = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  const lowercaseOutputFile = (path: string): string => path.toLowerCase();

  return async (request) => {
    const outputFile = lowercaseOutputFile(request.outputFile);
    const match = ordered.find(([substring]) =>
      outputFile.includes(lowercaseOutputFile(substring)),
    );
    if (match === undefined) {
      throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
    }

    const [, routeInput] = match;
    const route: FakeOutputRoute =
      typeof routeInput === "string" ? { output: routeInput } : routeInput;
    if (route.output !== undefined) {
      await mkdir(dirname(request.outputFile), { recursive: true });
      const content =
        typeof route.output === "string" ? route.output : JSON.stringify(route.output);
      await writeFile(request.outputFile, content, "utf8");
    }
    return { exitCode: route.exitCode ?? 0 };
  };
}
