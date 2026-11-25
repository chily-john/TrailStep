import type { ArchGraph } from "../engine/types.js";
import type { ArchManifest, RuleId, RuleSeverity } from "../manifest.js";

/**
 * The agent-facing set a rule belongs to. Severity lives in the manifest; this
 * is only the rendered label (`hard` is blocking, `report` never blocks, and
 * `review` has no implementation yet).
 */
export type DiagnosticSet = "hard" | "report" | "review";

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
  readonly message: string;
  readonly fix: string;
  readonly docAnchor: string;
  readonly docUri: string;
  readonly set: DiagnosticSet;
}

/**
 * A stable machine code for a finding that is not a manifest rule. Resolution
 * failures are operational errors: they must block a touched file, but they do
 * not belong to the architecture rule vocabulary (no severity, anchor, fix
 * recipe, or exemption lives in the manifest for them).
 */
export type OperationalDiagnosticCode = "ARCH-RESOLVE";

/**
 * A non-rule finding. It deliberately has no `rule`, `docAnchor`, or `docUri`:
 * pretending it were a manifest rule would make `arch:explain` and the
 * manifest coverage tests lie.
 */
export interface OperationalDiagnostic {
  readonly kind: "operational";
  readonly code: OperationalDiagnosticCode;
  readonly severity: "error";
  readonly file: string;
  readonly line: number | null;
  readonly column: number | null;
  readonly target: string;
  readonly message: string;
  readonly fix: string;
  readonly set: "error";
}

/** Everything `--changed` can report: manifest diagnostics plus operational errors. */
export type CheckFinding = Diagnostic | OperationalDiagnostic;

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
  readonly message: string;
  readonly line?: number | null;
  readonly column?: number | null;
}
