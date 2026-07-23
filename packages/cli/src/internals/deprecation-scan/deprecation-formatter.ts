import type { DeprecationFinding } from "./deprecation-scanner.js";

export function formatDeprecationFinding(finding: DeprecationFinding): string {
  const replacement = finding.replacement ? ` Replacement: ${finding.replacement}.` : "";
  const sourceFile = finding.sourceFile.replaceAll("\\", "/");
  return `${finding.severity} ${finding.packageName}/${finding.symbol} ${sourceFile}:${finding.line}:${finding.column} ${finding.message}${replacement}`;
}
