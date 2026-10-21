import { isAbsolute } from "node:path";

/**
 * Path-shaped workflow reference detection.
 *
 * This module is a leaf: it depends on `node:path` only. Both the registry
 * implementation and the workflow resolution implementation need it, so it
 * lives outside both of them to keep the CLI import graph acyclic.
 */

export function isDirectWorkflowFileReference(rawRef: string): boolean {
  return isDirectWorkflowFileReferencePrefix(stripExportName(rawRef));
}

function isDirectWorkflowFileReferencePrefix(pathRef: string): boolean {
  return (
    pathRef.startsWith("./") ||
    pathRef.startsWith("../") ||
    pathRef.startsWith(".\\") ||
    pathRef.startsWith("..\\") ||
    isAbsolute(pathRef) ||
    /^[A-Za-z]:[\\/]/u.test(pathRef) ||
    pathRef.startsWith("\\\\")
  );
}

export function stripExportName(rawRef: string): string {
  const hashIndex = rawRef.lastIndexOf("#");
  return hashIndex === -1 ? rawRef : rawRef.slice(0, hashIndex);
}
