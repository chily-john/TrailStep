import type { ResolutionError } from "../engine/types.js";
import type { ArchManifest, RuleId } from "../manifest.js";
import type {
  CheckFinding,
  Diagnostic,
  DiagnosticInput,
  DiagnosticSet,
  OperationalDiagnostic,
} from "./types.js";

/** Maps the manifest severity to the rendered set label. */
export function diagnosticSet(severity: Diagnostic["severity"]): DiagnosticSet {
  if (severity === "strict") {
    return "hard";
  }
  if (severity === "report") {
    return "report";
  }
  return "review";
}

function setLabel(set: DiagnosticSet): string {
  if (set === "hard") {
    return "hard (blocking)";
  }
  if (set === "report") {
    return "report (non-blocking)";
  }
  return "review (manual)";
}

/**
 * Builds one diagnostic. The fix recipe, anchor, severity, and set are copied
 * from the manifest, never restated in rule code: `arch:explain`, the rendered
 * form, and the JSON form therefore cannot drift from the manifest.
 */
export function createDiagnostic(
  manifest: ArchManifest,
  rule: RuleId,
  input: DiagnosticInput,
): Diagnostic {
  const spec = manifest.rules[rule];
  return {
    rule,
    severity: spec.severity,
    file: input.file,
    line: input.line ?? null,
    column: input.column ?? null,
    target: input.target,
    message: input.message,
    fix: spec.fix,
    docAnchor: spec.anchor,
    docUri: manifest.docUri,
    set: diagnosticSet(spec.severity),
  };
}

/** The §9.1 rendered shape: location, message, rule, fix, set. */
export function renderDiagnostic(diagnostic: Diagnostic): string {
  const location =
    diagnostic.line === null ? diagnostic.file : `${diagnostic.file}:${diagnostic.line}`;
  return [
    `${diagnostic.rule}  ${location}`,
    `    ${diagnostic.message}`,
    `    Target: ${diagnostic.target}`,
    `    Rule: ${diagnostic.rule} (${diagnostic.docAnchor}) — ${diagnostic.docUri}`,
    `    Fix: ${diagnostic.fix}`,
    `    Set: ${setLabel(diagnostic.set)}`,
  ].join("\n");
}

/** A stable JSON object; key order is the §9.1 contract order. */
export function diagnosticJson(diagnostic: Diagnostic): Record<string, unknown> {
  return {
    rule: diagnostic.rule,
    severity: diagnostic.severity,
    file: diagnostic.file,
    line: diagnostic.line,
    column: diagnostic.column,
    target: diagnostic.target,
    message: diagnostic.message,
    fix: diagnostic.fix,
    doc: diagnostic.docUri,
    anchor: diagnostic.docAnchor,
    set: diagnostic.set,
  };
}

const RESOLUTION_FIX =
  "Correct the import path, add the missing file, or declare the missing package so TypeScript can resolve it.";

/**
 * Turns one engine resolution failure into an operational diagnostic. The
 * engine already knows the importer, specifier, edge kind, and position; the
 * CLI only supplies the actionable wording. The failure stays separate from
 * `RuleId`, so no manifest coverage/explain surface can mistake it for a rule.
 */
export function resolutionErrorDiagnostic(error: ResolutionError): OperationalDiagnostic {
  return {
    kind: "operational",
    code: "ARCH-RESOLVE",
    severity: "error",
    file: error.from,
    line: error.line,
    column: error.column,
    target: error.specifier,
    message: `${error.reason} (${error.kind} import)`,
    fix: RESOLUTION_FIX,
    set: "error",
  };
}

export function resolutionErrorDiagnostics(
  errors: readonly ResolutionError[],
): OperationalDiagnostic[] {
  return errors.map(resolutionErrorDiagnostic);
}

export function isOperationalDiagnostic(finding: CheckFinding): finding is OperationalDiagnostic {
  return "kind" in finding && finding.kind === "operational";
}

/** The §9.1 rendered shape for an operational finding (no fake rule line). */
export function renderOperationalDiagnostic(diagnostic: OperationalDiagnostic): string {
  const location =
    diagnostic.line === null ? diagnostic.file : `${diagnostic.file}:${diagnostic.line}`;
  return [
    `${diagnostic.code}  ${location}`,
    `    ${diagnostic.message}`,
    `    Target: ${diagnostic.target}`,
    `    Fix: ${diagnostic.fix}`,
    `    Set: error (blocking; operational finding, not a manifest rule)`,
  ].join("\n");
}

export function operationalDiagnosticJson(
  diagnostic: OperationalDiagnostic,
): Record<string, unknown> {
  return {
    kind: diagnostic.kind,
    code: diagnostic.code,
    severity: diagnostic.severity,
    file: diagnostic.file,
    line: diagnostic.line,
    column: diagnostic.column,
    target: diagnostic.target,
    message: diagnostic.message,
    fix: diagnostic.fix,
    set: diagnostic.set,
  };
}

/** One renderer for the mixed `--changed` finding list. */
export function renderFinding(finding: CheckFinding): string {
  return isOperationalDiagnostic(finding)
    ? renderOperationalDiagnostic(finding)
    : renderDiagnostic(finding);
}

/** One JSON contract for the mixed `--changed` finding list. */
export function findingJson(finding: CheckFinding): Record<string, unknown> {
  return isOperationalDiagnostic(finding)
    ? operationalDiagnosticJson(finding)
    : diagnosticJson(finding);
}

/** Resolution failures block only when their importer is a touched file. */
export function scopeOperationalDiagnostics(
  diagnostics: readonly OperationalDiagnostic[],
  touched: readonly string[],
): OperationalDiagnostic[] {
  if (touched.length === 0) {
    return [];
  }
  const touchedSet = new Set(touched);
  return diagnostics.filter((diagnostic) => touchedSet.has(diagnostic.file));
}

function matchesPath(value: string, exemptionPath: string): boolean {
  return value === exemptionPath || value.startsWith(`${exemptionPath}/`);
}

/**
 * Applies the manifest's documented exemptions. An exemption is a semantic
 * exception with a reason, never a baseline: it is matched by rule plus either
 * endpoint of the violation.
 */
export function applyExemptions(
  manifest: ArchManifest,
  diagnostics: readonly Diagnostic[],
): Diagnostic[] {
  if (manifest.exemptions.length === 0) {
    return [...diagnostics];
  }
  return diagnostics.filter(
    (diagnostic) =>
      !manifest.exemptions.some(
        (exemption) =>
          exemption.rule === diagnostic.rule &&
          (matchesPath(diagnostic.file, exemption.path) ||
            matchesPath(diagnostic.target, exemption.path)),
      ),
  );
}

/** Deterministic order shared by every consumer and the golden scorecard. */
export function createDiagnosticComparator(
  ruleOrder: readonly RuleId[],
): (left: Diagnostic, right: Diagnostic) => number {
  const indexByRule = new Map<RuleId, number>();
  for (const [index, rule] of ruleOrder.entries()) {
    indexByRule.set(rule, index);
  }
  return (left, right) =>
    (indexByRule.get(left.rule) ?? 0) - (indexByRule.get(right.rule) ?? 0) ||
    compare(left.file, right.file) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    (left.column ?? 0) - (right.column ?? 0) ||
    compare(left.target, right.target) ||
    compare(left.message, right.message);
}

function compare(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}
