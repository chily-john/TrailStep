import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildGraph } from "./build-graph.js";
import { isInside } from "./path-utils.js";
import type { ArchGraph, EngineManifest } from "./types.js";

/** An in-memory tree: relative `/`-separated paths mapped to source text. */
export interface FixtureTree {
  readonly files: Readonly<Record<string, string>>;
  /** Overrides the default minimal NodeNext tsconfig (a JSON object). */
  readonly tsconfig?: Readonly<Record<string, unknown>>;
}

/** A materialized fixture, its graph, and the cleanup that removes the temp tree. */
export interface FixtureGraph {
  readonly projectRoot: string;
  readonly graph: ArchGraph;
  readonly cleanup: () => void;
}

/**
 * A minimal NodeNext project, because the red phase proves `.js`-specifier
 * resolution. No `node_modules`, no build output: fixtures are hermetic.
 */
export const DEFAULT_FIXTURE_TSCONFIG: Readonly<Record<string, unknown>> = {
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  },
  include: ["**/*.ts"],
};

/**
 * Materializes `paths → sources` into a temp directory and runs the real graph
 * builder over it. The temp tree is deliberate (parent §8.3): fixtures are
 * never checked-in TypeScript, and the harness returns exactly the graph shape
 * the real-tree path returns. Call `cleanup()` in a `finally`.
 */
export function buildFixtureGraph(tree: FixtureTree, manifest: EngineManifest): FixtureGraph {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "arch-engine-fixture-"));
  const cleanup = (): void => {
    rmSync(projectRoot, { recursive: true, force: true });
  };

  try {
    for (const [relativePath, sourceText] of Object.entries(tree.files)) {
      const absoluteFile = path.resolve(projectRoot, relativePath);
      if (!isInside(projectRoot, absoluteFile)) {
        throw new Error(`Fixture path escapes the temporary project root: "${relativePath}".`);
      }
      mkdirSync(path.dirname(absoluteFile), { recursive: true });
      writeFileSync(absoluteFile, sourceText, "utf8");
    }

    const tsconfigPath = path.join(projectRoot, "tsconfig.json");
    const tsconfig = tree.tsconfig ?? DEFAULT_FIXTURE_TSCONFIG;
    writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`, "utf8");

    return {
      projectRoot,
      graph: buildGraph({ projectRoot, tsconfig: tsconfigPath, manifest }),
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
