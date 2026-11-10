import { stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, expect } from "vitest";

import { it } from "./test-fixtures";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) {
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

for (const attempt of [1, 2]) {
  it(`creates an isolated OS temporary directory (attempt ${attempt})`, async ({ cwd }) => {
    expect(dirname(cwd)).toBe(tmpdir());
    expect(roots).not.toContain(cwd);
    roots.push(cwd);
    await expect(stat(join(cwd, "marker"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(cwd, "marker"), "temporary fixture");
  });
}
