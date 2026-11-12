/**
 * Canonical run-identifier validation.
 *
 * Every TrailStep surface that turns a caller-supplied run name or run path
 * into a filesystem location must call {@link validateRunIdentifier}. Keeping
 * the checks in one place is deliberate: the previous ad-hoc guards drifted
 * (a three-dot name, a dot followed by a space, or a trailing-dot reserved
 * entry all normalised to the runs root, its parent, or `.staging`/`.archive`
 * on Windows). The validator rejects those by construction.
 *
 * The function accepts either a bare run name (resolved under the runs root)
 * or an explicit path. Read-only inspection is an explicit `access: "inspect"`
 * choice; mutating callers use `access: "mutate"` and cannot reach reserved
 * infrastructure, and a mutating bare name cannot escape the runs root.
 */
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { TrailStepFailureError } from "../contracts/failures/failure.js";
import { isNodeError } from "../json/guards.js";

/** The one runs-root child that holds run creations in flight. */
export const RUNS_ROOT_STAGING_DIR_NAME = ".staging";

/**
 * Single source of truth for "this runs-root child is not a run directory".
 *
 * Every enumerator (core run summaries, the public evidence query, CLI runs and
 * retry scans, dashboard runs, storage lifecycle) calls this predicate instead
 * of re-deriving the exclusion, so the rule cannot drift again. `.archive`
 * holds archived payloads and `.staging` holds creations in flight.
 *
 * The comparison is case-insensitive because the runs root can live on a
 * case-insensitive filesystem (the macOS default, Windows): there `.Staging`
 * and `.staging` are the same directory, so an exact-case check would let a
 * run name alias infrastructure and expose or delete it. Windows also ignores
 * trailing dots and spaces in every path component, so `.archive.` and
 * `.archive ` address the same directory as `.archive`; normalising them here
 * keeps creation, resolution and every storage operation in agreement.
 */
export function isReservedRunsRootEntry(name: string): boolean {
  const normalized = name.replace(/[. ]+$/u, "").toLowerCase();
  return normalized === ".archive" || normalized === RUNS_ROOT_STAGING_DIR_NAME;
}

/**
 * Whether a value looks like a filesystem path rather than a bare run name.
 */
export function isPathLike(value: string): boolean {
  return (
    isAbsolute(value) ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\") ||
    value.includes("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:[\\/]/u.test(value)
  );
}

/** `mutate` (default behaviour) or `inspect` (explicit read-only exception). */
export type RunIdentifierAccess = "mutate" | "inspect";

/**
 * `name` restricts the identifier to one bare path segment (creation, storage,
 * retry). `name-or-path` (the default) also accepts an explicit path, as
 * `resolveRunDirectory` does for inspection and direct-path callers.
 */
export type RunIdentifierForm = "name" | "name-or-path";

export interface ValidateRunIdentifierOptions {
  /** Directory explicit relative paths resolve against. */
  readonly cwd: string;
  /** The runs root the bare name belongs to (absolute, or relative to the process cwd). */
  readonly runsRoot: string;
  readonly access: RunIdentifierAccess;
  /** Defaults to `name-or-path`. */
  readonly form?: RunIdentifierForm;
}

export type RunIdentifierCanonicalization = "realpath" | "realpath-ancestor" | "lexical";

export interface ValidatedRunIdentifier {
  /** The caller-supplied value. */
  readonly identifier: string;
  readonly kind: "name" | "path";
  /** Absolute path used for filesystem operations (keeps the caller's spelling). */
  readonly runDir: string;
  readonly displayName: string;
  /** Canonical path used only for the guard comparisons. */
  readonly canonicalRunDir: string;
  readonly canonicalization: RunIdentifierCanonicalization;
}

interface CanonicalPath {
  readonly path: string;
  readonly kind: RunIdentifierCanonicalization;
}

/**
 * Validate one run identifier and return its resolved directory.
 *
 * Rejections throw `TrailStepFailureError`:
 * - `run_name_invalid` for an empty value or a path passed where a bare name
 *   is required;
 * - `run_name_reserved` for a dot/double-dot (or a value that normalises to
 *   one by trimming trailing dots/spaces), a reserved root entry, the runs
 *   root or any of its ancestors, a path outside the runs root when addressed
 *   as a bare name, and any mutating path inside a reserved directory.
 *
 * Existing components are resolved with `realpath`; a path that does not exist
 * yet is canonicalised through its nearest existing ancestor (or lexically when
 * no ancestor exists). The returned `runDir` keeps the lexical spelling so
 * callers still operate on the path they named.
 */
export async function validateRunIdentifier(
  identifier: string,
  options: ValidateRunIdentifierOptions,
): Promise<ValidatedRunIdentifier> {
  if (identifier.trim().length === 0) {
    throw invalidRunName(identifier, "empty", "Run name must be a non-empty single path segment.");
  }

  const kind = isPathLike(identifier) ? "path" : "name";

  // A bare dot, double dot, empty string, or any of those produced by trimming
  // trailing dots/spaces (".", "..", "...", ". ", ".. ", ". .") addresses the
  // runs root or its parent. Explicit paths are handled by the canonical
  // location checks below.
  if (kind === "name") {
    const normalized = identifier.replace(/[. ]+$/u, "");
    if (normalized.length === 0 || normalized === "." || normalized === "..") {
      throw reservedIdentifier(
        identifier,
        kind,
        "addresses the runs root or one of its parents after trimming trailing dots and spaces",
      );
    }
    if (isReservedRunsRootEntry(identifier)) {
      throw reservedIdentifier(identifier, kind, "names a reserved runs-root entry");
    }
  }

  // `runsRoot` follows the same convention as `defaultRunsRoot`: an absolute
  // path, or a path relative to the process cwd. Only explicit run paths are
  // resolved against `options.cwd`.
  const lexicalRunsRoot = resolve(options.runsRoot);
  const lexicalRunDir =
    kind === "path"
      ? resolveExplicitRunPath(identifier, options.cwd)
      : join(lexicalRunsRoot, identifier);
  const canonicalRunsRoot = await canonicalizePath(lexicalRunsRoot);
  const canonicalRunDir = await canonicalizePath(lexicalRunDir);

  // The runs root itself and every ancestor of it are infrastructure, not a
  // run. Resolving "..." or "..<space>" on Windows used to land here.
  if (
    samePath(canonicalRunDir.path, canonicalRunsRoot.path) ||
    isStrictAncestor(canonicalRunDir.path, canonicalRunsRoot.path)
  ) {
    throw reservedIdentifier(identifier, kind, "addresses the runs root or one of its parents");
  }

  // Compare dot/space aliases too: on Windows "runs/..." and "runs/. " are the
  // runs root even though the lexical path string keeps the suffix.
  const aliasRunDir = aliasPathKey(canonicalRunDir.path);
  const aliasRunsRoot = aliasPathKey(canonicalRunsRoot.path);
  if (samePath(aliasRunDir, aliasRunsRoot) || isStrictAncestor(aliasRunDir, aliasRunsRoot)) {
    throw reservedIdentifier(
      identifier,
      kind,
      "addresses the runs root or one of its parents after trimming trailing dots and spaces",
    );
  }

  const hasReservedComponent =
    hasReservedEntryRelativeTo(lexicalRunDir, lexicalRunsRoot) ||
    hasReservedEntryRelativeTo(canonicalRunDir.path, canonicalRunsRoot.path) ||
    hasReservedEntryRelativeTo(aliasRunDir, aliasRunsRoot);
  if (options.access === "mutate" && hasReservedComponent) {
    throw reservedIdentifier(
      identifier,
      kind,
      "addresses a reserved directory or a directory inside one",
    );
  }

  if (kind === "name") {
    // A bare name must stay under the runs root. This is mostly a guard against
    // a symlink under the root pointing elsewhere; normal names are joined to
    // the root and cannot escape.
    const belowRoot =
      isStrictAncestor(canonicalRunsRoot.path, canonicalRunDir.path) ||
      isStrictAncestor(aliasRunsRoot, aliasRunDir);
    if (!belowRoot) {
      throw reservedIdentifier(identifier, kind, "resolves outside the runs root");
    }
  }

  if (options.form === "name" && kind === "path") {
    throw invalidRunName(
      identifier,
      "path",
      "Run name must be a single path segment; explicit paths are not accepted here.",
    );
  }

  return {
    identifier,
    kind,
    runDir: lexicalRunDir,
    displayName: identifier,
    canonicalRunDir: canonicalRunDir.path,
    canonicalization: canonicalRunDir.kind,
  };
}

/**
 * Resolve an explicit run path against the caller's cwd.
 *
 * A relative identifier is normally cwd-relative. Tests and embedded callers
 * sometimes construct it from a cwd that is itself relative to the process
 * cwd, so the identifier already contains that prefix; treating it as
 * cwd-relative would duplicate the prefix. If the identifier already resolves
 * inside the cwd, keep it as written instead.
 */
function resolveExplicitRunPath(identifier: string, cwd: string): string {
  if (isAbsolute(identifier)) {
    return resolve(identifier);
  }
  const absoluteCwd = resolve(cwd);
  const fromProcessCwd = resolve(identifier);
  if (samePath(fromProcessCwd, absoluteCwd) || isStrictAncestor(absoluteCwd, fromProcessCwd)) {
    return fromProcessCwd;
  }
  return resolve(absoluteCwd, identifier);
}

function invalidRunName(
  identifier: string,
  reason: string,
  message: string,
): TrailStepFailureError {
  return new TrailStepFailureError({
    code: "run_name_invalid",
    message,
    details: { identifier, reason },
  });
}

function reservedIdentifier(
  identifier: string,
  kind: "name" | "path",
  reason: string,
): TrailStepFailureError {
  return new TrailStepFailureError({
    code: "run_name_reserved",
    message:
      kind === "name"
        ? `Run name "${identifier}" is reserved for TrailStep storage infrastructure.`
        : `Run directory "${identifier}" is reserved for TrailStep storage infrastructure.`,
    details: { identifier, kind, reason },
  });
}

/**
 * Resolve a path with realpath semantics. When the path does not exist yet,
 * realpath its nearest existing ancestor and keep the remaining components
 * lexically; when even the root cannot be resolved, fall back to lexical
 * normalisation.
 */
async function canonicalizePath(path: string): Promise<CanonicalPath> {
  const resolved = resolve(path);
  let current = resolved;
  const suffix: string[] = [];

  for (;;) {
    try {
      const canonical = await realpath(current);
      const joined =
        suffix.length === 0 ? canonical : resolve(canonical, ...suffix.slice().reverse());
      return {
        path: joined,
        kind: suffix.length === 0 ? "realpath" : "realpath-ancestor",
      };
    } catch (error) {
      if (!isNodeError(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        return { path: resolved, kind: "lexical" };
      }
      suffix.push(current.slice(parent.length).replace(/^[\\/]+/u, ""));
      current = parent;
    }
  }
}

/**
 * A comparison key that applies the Windows filename rules to every path
 * component: trailing dots/spaces are ignored and the result is case-folded.
 * It is only used for guard comparisons, never for filesystem access.
 */
function aliasPathKey(path: string): string {
  const resolved = resolve(path);
  const root = parse(resolved).root;
  const remainder = resolved.slice(root.length);
  const components: string[] = [];
  for (const raw of remainder.split(sep)) {
    if (raw.length === 0) {
      continue;
    }
    const component = raw.replace(/[. ]+$/u, "");
    if (component.length === 0 || component === ".") {
      continue;
    }
    if (component === "..") {
      components.pop();
      continue;
    }
    components.push(process.platform === "win32" ? component.toLowerCase() : component);
  }
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  return components.length === 0 ? normalizedRoot : normalizedRoot + components.join(sep);
}

/**
 * Whether a path is (or is inside) a reserved runs-root child, or carries a
 * reserved directory below the path prefix it shares with the runs root. The
 * shared-prefix rule keeps a project that happens to live under a directory
 * named `.archive` from invalidating every run.
 */
function hasReservedEntryRelativeTo(candidate: string, runsRoot: string): boolean {
  const relation = relative(runsRoot, candidate);
  if (isWithinRelation(relation)) {
    return relation.split(sep).filter(Boolean).some(isReservedRunsRootEntry);
  }

  const candidateParts = absolutePathComponents(candidate);
  const rootParts = absolutePathComponents(runsRoot);
  let shared = 0;
  while (
    shared < candidateParts.length &&
    shared < rootParts.length &&
    samePathComponent(candidateParts[shared] as string, rootParts[shared] as string)
  ) {
    shared += 1;
  }
  return candidateParts.slice(shared).some(isReservedRunsRootEntry);
}

function isWithinRelation(relation: string): boolean {
  return (
    relation.length === 0 ||
    (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
}

function absolutePathComponents(path: string): string[] {
  const resolved = resolve(path);
  const root = parse(resolved).root;
  return [root, ...resolved.slice(root.length).split(sep).filter(Boolean)];
}

function samePathComponent(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function samePath(left: string, right: string): boolean {
  return normalizeForComparison(left) === normalizeForComparison(right);
}

function normalizeForComparison(path: string): string {
  return process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
}

function isStrictAncestor(ancestor: string, descendant: string): boolean {
  const relation = relative(ancestor, descendant);
  return (
    relation.length > 0 &&
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}
