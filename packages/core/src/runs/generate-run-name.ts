/**
 * Canonical run-name generation.
 *
 * A run name is `<readable-name>-<timestamp>-<random-suffix>`, e.g.
 * `review-20260102-030405-aabbccdd`. The CLI derives the readable name from the
 * parsed workflow export name; the MCP used to re-derive it from the raw
 * workflow ref string, so the same workflow could get different run names
 * depending on who started it. Both surfaces now use this generator: the CLI
 * passes the parsed `exportName`, the MCP passes the export name derived from
 * the raw ref by `deriveWorkflowExportName`.
 */
import { randomBytes } from "node:crypto";
import { basename } from "node:path";

export interface GenerateRunNameOptions {
  /** Readable name source (the workflow export name). */
  readonly exportName: string;
  /** Test seam: clock used for the timestamp. */
  readonly now?: () => Date;
  /** Test seam: random suffix source. */
  readonly randomSuffix?: () => string;
}

/** Generate a run name from a workflow export name. */
export function generateRunName(options: GenerateRunNameOptions): string {
  const date = options.now?.() ?? new Date();
  const timestamp = date
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "")
    .replace("T", "-");
  const readableName = slugifyRunNamePart(options.exportName);
  const suffix = slugifyRunNamePart(options.randomSuffix?.() ?? randomBytes(4).toString("hex"));
  return `${readableName}-${timestamp}-${suffix}`;
}

/**
 * Derive the workflow export name from a raw workflow reference, mirroring the
 * CLI's static workflow-ref parsing:
 *
 * - `package#workflowName` (bundle refs) -> `workflowName`
 * - `package:exportName` (legacy package exports) -> `exportName`
 * - direct workflow file paths -> the file name without its extension
 *   (the CLI resolves the file and uses the workflow's declared id; the file
 *   name is the closest static approximation)
 * - anything else -> the reference itself
 */
export function deriveWorkflowExportName(rawRef: string): string {
  const ref = rawRef.trim();
  if (ref === "") {
    return ref;
  }

  const hashIndex = ref.lastIndexOf("#");
  if (hashIndex > 0 && hashIndex < ref.length - 1) {
    return ref.slice(hashIndex + 1);
  }

  if (isDirectFilePath(ref)) {
    const base = basename(ref);
    return base.replace(/\.[^.]+$/u, "") || ref;
  }

  const colonIndex = ref.lastIndexOf(":");
  if (colonIndex > 0 && colonIndex < ref.length - 1 && !/^[A-Za-z]:[\\/]/u.test(ref)) {
    return ref.slice(colonIndex + 1);
  }

  return ref;
}

function isDirectFilePath(ref: string): boolean {
  return (
    ref.startsWith("./") ||
    ref.startsWith("../") ||
    ref.startsWith(".\\") ||
    ref.startsWith("..\\") ||
    ref.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/u.test(ref)
  );
}

/** Slugify a run-name part (lowercase, dash separated). */
export function slugifyRunNamePart(value: string): string {
  const slug = value
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return slug === "" ? "workflow" : slug;
}
