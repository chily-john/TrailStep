import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveProjectRoot, TRAILSTEP_PROJECT_ROOT_ENV } from "./project-root.js";

const createdRoots: string[] = [];

async function makeTree(paths: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "trailstep-project-root-"));
  createdRoots.push(root);
  for (const path of paths) {
    await mkdir(join(root, path), { recursive: true });
  }
  return root;
}

async function writeMarker(root: string, relativePath: string): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  if (relativePath.endsWith("package.json")) {
    await writeFile(target, "{}\n", "utf8");
    return;
  }
  await mkdir(target, { recursive: true });
}

afterEach(async () => {
  for (const root of createdRoots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

describe("resolveProjectRoot", () => {
  it("returns an absolute TRAILSTEP_PROJECT_ROOT override as-is", async () => {
    const cwd = await makeTree(["a/b"]);
    const override = await makeTree(["override"]);

    await expect(
      resolveProjectRoot({
        cwd: join(cwd, "a", "b"),
        env: { [TRAILSTEP_PROJECT_ROOT_ENV]: override },
      }),
    ).resolves.toBe(resolve(override));
  });

  it("resolves a relative TRAILSTEP_PROJECT_ROOT override against the cwd", async () => {
    const cwd = await makeTree(["a/b"]);

    await expect(
      resolveProjectRoot({
        cwd: join(cwd, "a", "b"),
        env: { [TRAILSTEP_PROJECT_ROOT_ENV]: "../.." },
      }),
    ).resolves.toBe(resolve(cwd));
  });

  it("keeps the cwd when it already holds a .trailstep directory", async () => {
    const root = await makeTree(["nested/.trailstep"]);
    await writeMarker(root, ".git");

    await expect(resolveProjectRoot({ cwd: join(root, "nested") })).resolves.toBe(
      resolve(root, "nested"),
    );
  });

  it("finds a .git directory three levels up", async () => {
    const root = await makeTree(["a/b/c"]);
    await writeMarker(root, ".git");

    await expect(resolveProjectRoot({ cwd: join(root, "a", "b", "c") })).resolves.toBe(
      resolve(root),
    );
  });

  it("falls back to the nearest package.json ancestor when there is no .git", async () => {
    const root = await makeTree(["pkg/a/b"]);
    await writeMarker(root, "package.json");

    await expect(resolveProjectRoot({ cwd: join(root, "pkg", "a", "b") })).resolves.toBe(
      resolve(root),
    );
  });

  it("ignores a package.json under a node_modules segment and keeps walking up", async () => {
    const root = await makeTree(["node_modules/@acme/pkg/src"]);
    await writeMarker(root, "package.json");
    await writeMarker(root, "node_modules/@acme/pkg/package.json");

    await expect(
      resolveProjectRoot({ cwd: join(root, "node_modules", "@acme", "pkg", "src") }),
    ).resolves.toBe(resolve(root));
  });

  it("returns the cwd when no marker is found", async () => {
    const root = await makeTree(["lonely/nested"]);

    await expect(resolveProjectRoot({ cwd: join(root, "lonely", "nested") })).resolves.toBe(
      resolve(root, "lonely", "nested"),
    );
  });

  it("honours the exists seam instead of touching the filesystem", async () => {
    const cwd = resolve("/fake/project/packages/sub");
    const markerDir = resolve("/fake/project");
    const probed: string[] = [];

    await expect(
      resolveProjectRoot({
        cwd,
        exists: async (path) => {
          probed.push(path);
          return path === join(markerDir, "package.json");
        },
      }),
    ).resolves.toBe(markerDir);

    expect(probed).toContain(join(markerDir, "package.json"));
    expect(probed).toContain(join(cwd, ".git"));
  });
});
