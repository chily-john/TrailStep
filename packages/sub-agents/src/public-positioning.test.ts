import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("public package positioning", () => {
  it("frames @trailstep/sub-agents as a public reusable sub-agent workflow package with docs matching exports", async () => {
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
      trailstep?: { workflows?: Record<string, string> };
    };
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const indexSource = await readFile(new URL("./index.ts", import.meta.url), "utf8");

    expect(packageJson.name).toBe("@trailstep/sub-agents");
    expect(packageJson[["pri", "vate"].join("") as keyof typeof packageJson]).not.toBe(true);
    expect(packageJson.description).toMatch(/public|reusable|sub-agent/i);
    expect(packageJson.license).toBe("Apache-2.0");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+ssh://git@github.com/chily-john/trailstep.git",
    });
    expect(packageJson.bugs?.url).toBe("https://github.com/chily-john/trailstep/issues");
    expect(packageJson.homepage).toBe("https://github.com/chily-john/trailstep#readme");
    expect(packageJson.publishConfig?.access).toBe("public");
    expect(packageJson.files).toEqual(expect.arrayContaining(["dist", "README.md", "LICENSE"]));
    expect(packageJson.keywords).toContain("trailstep-workflow");
    expect(packageJson.trailstep?.workflows).toEqual({
      delegate: "./dist/index.js#delegate",
      delegateExplore: "./dist/index.js#delegateExplore",
      delegateReview: "./dist/index.js#delegateReview",
      delegateImplement: "./dist/index.js#delegateImplement",
    });

    expect(readme).toMatch(/public/i);
    expect(readme).toMatch(/reusable/i);
    expect(readme).toMatch(/sub-agent/i);
    expect(readme).toContain("@trailstep/sub-agents#delegate");
    expect(readme).toContain("@trailstep/sub-agents#delegateExplore");
    expect(readme).toContain("@trailstep/sub-agents#delegateReview");
    expect(readme).toContain("@trailstep/sub-agents#delegateImplement");

    const workflowSection = readme.slice(
      readme.indexOf("## Workflows"),
      readme.indexOf("The delegate workflows"),
    );
    const readmeWorkflowNames = Array.from(
      workflowSection.matchAll(/^- `([^`]+)`:/gm),
      ([, name]) => String(name),
    );
    const exportedWorkflowNames = Array.from(
      indexSource.matchAll(/export \{([\s\S]*?)\} from/g),
      ([, names]) => String(names),
    )
      .flatMap((names) => names.split(","))
      .map((name) => name.trim())
      .filter(Boolean);
    expect([...readmeWorkflowNames].sort()).toEqual([...exportedWorkflowNames].sort());
  });
});
