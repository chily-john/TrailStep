import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";

const BUILTIN_MODULES = new Set(builtinModules);

/**
 * Node builtins need no resolution: `ts.resolveModuleName` reports them as
 * unresolved because they are ambient, but they are never architecture edges.
 */
export function isBuiltinSpecifier(specifier: string): boolean {
  return specifier.startsWith("node:") || BUILTIN_MODULES.has(specifier);
}

/** What a specifier resolved to, or why it did not. */
export interface ResolutionOutcome {
  /** Absolute target, or `null` when nothing resolved. */
  readonly resolvedPath: string | null;
  /** True for a builtin: unresolved by design, never a diagnostic. */
  readonly external: boolean;
  /** Human-readable reason for a real resolution failure. */
  readonly reason: string | null;
}

/** One cache per graph build; resolution is the expensive half of the engine. */
export function createResolutionCache(
  projectRoot: string,
  options: ts.CompilerOptions,
): ts.ModuleResolutionCache {
  const canonicalFileName = ts.sys.useCaseSensitiveFileNames
    ? (fileName: string): string => fileName
    : (fileName: string): string => fileName.toLowerCase();

  return ts.createModuleResolutionCache(projectRoot, canonicalFileName, options);
}

/**
 * Resolves with the same `ts.resolveModuleName` + cache path the compiler uses,
 * so NodeNext `.js` specifiers, `exports` maps, and `.d.ts` targets behave
 * exactly as they do in a build. Never guesses an extension by hand.
 */
export function resolveSpecifier(
  specifier: string,
  containingFile: string,
  options: ts.CompilerOptions,
  cache: ts.ModuleResolutionCache,
): ResolutionOutcome {
  const resolution = ts.resolveModuleName(specifier, containingFile, options, ts.sys, cache);

  if (resolution.resolvedModule) {
    return {
      resolvedPath: path.resolve(resolution.resolvedModule.resolvedFileName),
      external: false,
      reason: null,
    };
  }

  if (isBuiltinSpecifier(specifier)) {
    return { resolvedPath: null, external: true, reason: null };
  }

  return {
    resolvedPath: null,
    external: false,
    reason: `module "${specifier}" did not resolve`,
  };
}
