/**
 * Public surface of the architecture rule layer (Story 105). Engine stays
 * rule-free; this directory owns rule semantics, diagnostics, and the
 * scorecard. The CLI (Story 106) consumes `runRules` + `buildScorecard`.
 */

export { buildRuleGraph } from "./build-rule-graph.js";
export {
  applyExemptions,
  createDiagnostic,
  createDiagnosticComparator,
  diagnosticJson,
  diagnosticSet,
  findingJson,
  isOperationalDiagnostic,
  operationalDiagnosticJson,
  renderDiagnostic,
  renderFinding,
  renderOperationalDiagnostic,
  resolutionErrorDiagnostic,
  resolutionErrorDiagnostics,
  scopeOperationalDiagnostics,
} from "./diagnostics.js";
export type { RuleIndex } from "./graph-index.js";
export { buildRuleIndex } from "./graph-index.js";
export type { ArchCheckResult, StrictRuleId } from "./run-rules.js";
export {
  BIOME_OWNED_RULE_IDS,
  diskRuleContext,
  isStrictRuleId,
  METRIC_RULE_IDS,
  REVIEW_RULE_IDS,
  runArchCheck,
  runRules,
  STRICT_RULE_IMPLEMENTATIONS,
} from "./run-rules.js";
export type { Scorecard, ScorecardMetrics } from "./scorecard.js";
export { buildScorecard, scorecardJson } from "./scorecard.js";
export type {
  CheckFinding,
  Diagnostic,
  DiagnosticInput,
  DiagnosticSet,
  DiagnosticTargetKind,
  OperationalDiagnostic,
  OperationalDiagnosticCode,
  RuleContext,
  RuleFunction,
} from "./types.js";
