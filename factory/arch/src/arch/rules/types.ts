import type { ArchGraph } from "../engine/types.js";
import type { ArchManifest, RuleId, RuleSeverity } from "../manifest.js";

/**
 * The agent-facing set a rule belongs to. Severity lives in the manifest; this
 * is only the rendered label (`hard` is blocking, `report` never blocks, and
 * `review` has no implementation yet).
 */
export type DiagnosticSet = "hard" | "report" | "review";

/**
 * The kind of cycle a G1 diagnostic names. `--changed` consumes this instead
 * of inferring the kind from the target text.
 */
export type DiagnosticTargetKind = "group" | "owner";

/**
 * One violation, in the §9.1 contract shape. Folder-level rules use the folder
 * as `file` and `null` for `line`/`column`; every rule carries the manifest's
 * fix recipe and doc anchor verbatim.
 */
export interface Diagnostic {
  readonly rule: RuleId;
  readonly severity: RuleSeverity;
  readonly file: string;
  readonly line: number | null;
  readonly column: number | null;
  readonly target: string;
  /** Set only by rules whose target has more than one namespace (G1). */
  readonly targetKind?: DiagnosticTargetKind;
  readonly message: string;
  readonly fix: string;
  readonly docAnchor: string;
  readonly docUri: string;
  readonly set: DiagnosticSet;
}

/**
 * The only I/O a rule may request. `runRules` supplies a disk-backed reader for
 * a real run (`diskRuleContext`); the fixture harness supplies an in-memory map
 * of the fixture sources. A rule therefore stays a function of its inputs: the
 * graph, the manifest, and this context — never the filesystem directly.
 */
export interface RuleContext {
  readonly readSource: (filePath: string) => string | undefined;
}

/** A rule is a pure function over the graph, the manifest, and the read context. */
export type RuleFunction = (
  graph: ArchGraph,
  manifest: ArchManifest,
  context: RuleContext,
) => Diagnostic[];

/** Fields a rule supplies; severity/fix/anchor/set come from the manifest. */
export interface DiagnosticInput {
  readonly file: string;
  readonly target: string;
  readonly targetKind?: DiagnosticTargetKind;
  readonly message: string;
  readonly line?: number | null;
  readonly column?: number | null;
}
