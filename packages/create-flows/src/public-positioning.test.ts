import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("public package positioning", () => {
  it("frames @stepkit/create-flows as a public reusable workflow package with docs matching exports", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      name?: string;
      description?: string;
      license?: string;
      repository?: { type?: string; url?: string };
      bugs?: { url?: string };
      homepage?: string;
      publishConfig?: { access?: string };
      files?: string[];
      keywords?: string[];
    };
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const indexSource = await readFile(new URL("./index.ts", import.meta.url), "utf8");

    expect(packageJson.name).toBe("@stepkit/create-flows");
    expect(packageJson[["pri", "vate"].join("") as keyof typeof packageJson]).not.toBe(true);
    expect(packageJson.description).toMatch(/public|reusable|general-purpose/i);
    expect(packageJson.license).toBe("Apache-2.0");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+ssh://git@github.com/chily-john/stepkit.git",
    });
    expect(packageJson.bugs?.url).toBe("https://github.com/chily-john/stepkit/issues");
    expect(packageJson.homepage).toBe("https://github.com/chily-john/stepkit#readme");
    expect(packageJson.publishConfig?.access).toBe("public");
    expect(packageJson.files).toEqual(expect.arrayContaining(["dist", "README.md", "LICENSE"]));
    expect(packageJson.keywords).toContain("stepkit-workflow");

    expect(readme).toMatch(/public/i);
    expect(readme).toMatch(/reusable/i);
    expect(readme).toMatch(/general-purpose/i);
    expect(readme).toContain("@stepkit/create-flows#takeItAway");
    expect(readme).toContain("@stepkit/create-flows#grillItAway");

    const forbiddenPublicPhraseSources = [
      ["Per", "sonal collection"],
      ["per", "sonal workflows"],
      ["pri", "vate workflows"],
      ["lo", "cal-only"],
      ["daily", "Note"],
    ];
    const publicFacingText = `${JSON.stringify(packageJson)}\n${readme}`;
    for (const forbiddenPhraseSource of forbiddenPublicPhraseSources) {
      expect(publicFacingText).not.toMatch(new RegExp(forbiddenPhraseSource.join(""), "i"));
    }

    const readmeWorkflowNames = Array.from(readme.matchAll(/^- `([^`]+)`:/gm), ([, name]) => name);
    const exportedWorkflowNames = Array.from(
      indexSource.matchAll(/export \{ ([^ }]+) \} from/g),
      ([, name]) => name,
    );
    expect(readmeWorkflowNames.toSorted()).toEqual(exportedWorkflowNames.toSorted());
  });
});
