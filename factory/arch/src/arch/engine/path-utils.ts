import path from "node:path";

/**
 * Path helpers shared by the engine.
 *
 * Every comparison uses `node:path`, never a string `split("/")` on a raw
 * filesystem path: on Windows a path uses `\` and splitting on `/` would make a
 * nested folder look like a single segment. The manifest's declared roots are
 * `/`-separated by contract, and `path.resolve` normalizes them to the host
 * separator.
 */

/** Converts a native path to the `/`-separated form used in graph output. */
export function toPosixPath(value: string): string {
  return path.sep === "/" ? value : value.split(path.sep).join("/");
}

/**
 * True when `child` is strictly inside `parent`. Uses `path.relative`, so a
 * sibling whose name merely starts with the parent's name is not inside it,
 * and a different Windows drive is never inside.
 */
export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);

  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** The project-root-relative, `/`-separated path used in every graph record. */
export function relativePosixPath(parent: string, child: string): string {
  return toPosixPath(path.relative(parent, child));
}

/** Locale-independent string order, so golden JSON is byte-stable across machines. */
export function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}
