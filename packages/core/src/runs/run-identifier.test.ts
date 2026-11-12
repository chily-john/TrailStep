import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { validateRunIdentifier } from "./run-identifier.js";

async function makeFixture(): Promise<{
  readonly root: string;
  readonly runsRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "trailstep-core-run-identifier-"));
  const runsRoot = join(root, ".trailstep", "runs");
  await mkdir(runsRoot, { recursive: true });
  return { root, runsRoot };
}

describe("canonical run identifier validation", () => {
  it.each(["", "   "])("rejects the empty identifier %j as invalid", async (identifier) => {
    const { runsRoot } = await makeFixture();

    await expect(
      validateRunIdentifier(identifier, {
        cwd: dirname(runsRoot),
        runsRoot,
        access: "mutate",
      }),
    ).rejects.toMatchObject({ failure: { code: "run_name_invalid" } });
  });

  it.each([".", "..", "...", ". ", ".. ", ". .", " ...", ".  "])(
    "rejects the runs-root alias %j as reserved",
    async (identifier) => {
      const { runsRoot } = await makeFixture();

      await expect(
        validateRunIdentifier(identifier, {
          cwd: dirname(runsRoot),
          runsRoot,
          access: "mutate",
        }),
      ).rejects.toMatchObject({ failure: { code: "run_name_reserved" } });
    },
  );

  it.each([".staging", ".archive", ".STAGING", ".Archive", ".staging.", ".archive "])(
    "rejects the reserved name %j as reserved",
    async (identifier) => {
      const { runsRoot } = await makeFixture();

      await expect(
        validateRunIdentifier(identifier, {
          cwd: dirname(runsRoot),
          runsRoot,
          access: "mutate",
        }),
      ).rejects.toMatchObject({ failure: { code: "run_name_reserved" } });
    },
  );

  it.each(["run", "run.", "run ", ".near-miss", ".staging-run", ".archivex"])(
    "accepts the non-reserved bare name %j",
    async (identifier) => {
      const { runsRoot } = await makeFixture();

      const validated = await validateRunIdentifier(identifier, {
        cwd: dirname(runsRoot),
        runsRoot,
        access: "mutate",
      });

      expect(validated.kind).toBe("name");
      expect(validated.runDir).toBe(join(runsRoot, identifier));
      expect(validated.canonicalization).toMatch(/realpath/u);
    },
  );

  it.each(["", ".archive", ".archive/run", ".archive/run/steps", ".staging/tmp/run"])(
    "rejects the reserved or root path %j for mutation",
    async (suffix) => {
      const { root, runsRoot } = await makeFixture();
      const path = suffix.length === 0 ? runsRoot : join(runsRoot, suffix);

      await expect(
        validateRunIdentifier(path, {
          cwd: root,
          runsRoot,
          access: "mutate",
        }),
      ).rejects.toMatchObject({ failure: { code: "run_name_reserved" } });
    },
  );

  it("rejects a reserved directory outside the runs root for mutation", async () => {
    const { root, runsRoot } = await makeFixture();

    await expect(
      validateRunIdentifier(join(root, ".archive", "run"), {
        cwd: root,
        runsRoot,
        access: "mutate",
      }),
    ).rejects.toMatchObject({ failure: { code: "run_name_reserved" } });
  });

  it("does not reject a runs root that merely lives below a directory named .archive", async () => {
    const outer = await mkdtemp(join(tmpdir(), "trailstep-core-run-identifier-archive-"));
    const root = join(outer, ".archive", "project");
    const runsRoot = join(root, ".trailstep", "runs");
    await mkdir(runsRoot, { recursive: true });

    const validated = await validateRunIdentifier(join(runsRoot, "normal-run"), {
      cwd: root,
      runsRoot,
      access: "mutate",
    });
    expect(validated.runDir).toBe(join(runsRoot, "normal-run"));
  });

  it("rejects the runs root parent and any ancestor", async () => {
    const { root, runsRoot } = await makeFixture();

    for (const path of [dirname(runsRoot), root, dirname(root)]) {
      await expect(
        validateRunIdentifier(path, {
          cwd: root,
          runsRoot,
          access: "mutate",
        }),
      ).rejects.toMatchObject({ failure: { code: "run_name_reserved" } });
    }
  });

  it.each(["...", ". ", ".. ", ".. ."])(
    "rejects the dot/space alias %j of the runs root through the explicit path form",
    async (alias) => {
      const { root, runsRoot } = await makeFixture();

      await expect(
        validateRunIdentifier(join(runsRoot, alias), {
          cwd: root,
          runsRoot,
          access: "mutate",
        }),
      ).rejects.toMatchObject({ failure: { code: "run_name_reserved" } });
    },
  );

  it("accepts a normal explicit run path and a path outside the runs root", async () => {
    const { root, runsRoot } = await makeFixture();
    const outside = join(root, "elsewhere", "run");

    const inside = await validateRunIdentifier(join(runsRoot, "normal-run"), {
      cwd: root,
      runsRoot,
      access: "mutate",
    });
    expect(inside.kind).toBe("path");
    expect(inside.runDir).toBe(join(runsRoot, "normal-run"));

    const external = await validateRunIdentifier(outside, {
      cwd: root,
      runsRoot,
      access: "mutate",
    });
    expect(external.runDir).toBe(outside);
  });

  it("allows reserved paths only through the explicit inspect access", async () => {
    const { root, runsRoot } = await makeFixture();
    const archivedRun = join(runsRoot, ".archive", "run", "steps");

    await expect(
      validateRunIdentifier(archivedRun, {
        cwd: root,
        runsRoot,
        access: "mutate",
      }),
    ).rejects.toMatchObject({ failure: { code: "run_name_reserved" } });

    const inspected = await validateRunIdentifier(archivedRun, {
      cwd: root,
      runsRoot,
      access: "inspect",
    });
    expect(inspected.runDir).toBe(archivedRun);

    // Inspection still never resolves the runs root or its parents as a run.
    for (const path of [runsRoot, dirname(runsRoot)]) {
      await expect(
        validateRunIdentifier(path, {
          cwd: root,
          runsRoot,
          access: "inspect",
        }),
      ).rejects.toMatchObject({ failure: { code: "run_name_reserved" } });
    }
  });

  it("rejects a path passed where the caller requires a bare name", async () => {
    const { root, runsRoot } = await makeFixture();

    await expect(
      validateRunIdentifier(join(runsRoot, "run"), {
        cwd: root,
        runsRoot,
        access: "mutate",
        form: "name",
      }),
    ).rejects.toMatchObject({ failure: { code: "run_name_invalid" } });
  });

  it.skipIf(process.platform === "win32")(
    "uses realpath so a symlink under the runs root cannot escape it",
    async () => {
      const { root, runsRoot } = await makeFixture();
      const outside = join(root, "outside");
      await mkdir(outside, { recursive: true });
      await symlink(outside, join(runsRoot, "escaped"), "dir");

      await expect(
        validateRunIdentifier("escaped", {
          cwd: root,
          runsRoot,
          access: "mutate",
        }),
      ).rejects.toMatchObject({ failure: { code: "run_name_reserved" } });
    },
  );

  it("canonicalises an existing path with realpath and a missing path through its ancestor", async () => {
    const { root, runsRoot } = await makeFixture();
    await mkdir(join(runsRoot, "existing"));

    const existing = await validateRunIdentifier(join(runsRoot, "existing"), {
      cwd: root,
      runsRoot,
      access: "mutate",
    });
    expect(existing.canonicalization).toBe("realpath");

    const missing = await validateRunIdentifier(join(runsRoot, "missing", "nested"), {
      cwd: root,
      runsRoot,
      access: "mutate",
    });
    expect(missing.canonicalization).toBe("realpath-ancestor");
  });
});
