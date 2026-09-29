import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("public package positioning", () => {
  it("frames @trailstep/create-flows as a public reusable workflow package with docs matching exports", async () => {
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
      trailstep?: {
        workflows?: Record<string, string>;
        recommendedConfig?: Record<string, unknown>;
      };
    };
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const indexSource = await readFile(new URL("./index.ts", import.meta.url), "utf8");

    expect(packageJson.name).toBe("@trailstep/create-flows");
    expect(packageJson[["pri", "vate"].join("") as keyof typeof packageJson]).not.toBe(true);
    expect(packageJson.description).toMatch(/public|reusable|general-purpose/i);
    expect(packageJson.license).toBe("Apache-2.0");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+ssh://git@github.com/chily-john/trailstep.git",
    });
    expect(packageJson.bugs?.url).toBe("https://github.com/chily-john/trailstep/issues");
    expect(packageJson.homepage).toBe("https://github.com/chily-john/trailstep#readme");
    expect(packageJson.publishConfig?.access).toBe("public");
    expect(packageJson.files).toEqual(expect.arrayContaining(["dist", "README.md", "LICENSE"]));
    expect(packageJson.files).not.toContain("shared");
    expect(packageJson.keywords).toContain("trailstep-workflow");
    expect(packageJson.trailstep?.workflows).toEqual({
      takeItAway: "./dist/index.js#takeItAway",
      grillItAway: "./dist/index.js#grillItAway",
    });
    expect(packageJson.trailstep?.recommendedConfig).toMatchObject({
      agents: {
        generalist: [
          { provider: "pi", model: "openrouter/meta/muse-spark-1.3" },
          { provider: "pi", model: "openrouter/xiaomi/mimo-v2.6-pro" },
        ],
        planner: [{ provider: "pi", model: "openrouter/xiaomi/mimo-v2.6-pro" }],
        explorer: [{ provider: "pi", model: "openrouter/deepseek/deepseek-v4-flash-0731", thinking: "low" }],
        "smart-implementor": [{ provider: "pi", model: "openrouter/xiaomi/mimo-v2.6-pro" }],
        fixer: [{ ref: "debugger" }],
      },
      workflows: {
        "take-it-away": { agents: { storyImplementer: [{ ref: "smart-implementor" }] } },
        "grill-it-away": { agents: { grillingAgent: [{ ref: "planner" }] } },
      },
    });

    expect(readme).toMatch(/public/i);
    expect(readme).toMatch(/reusable/i);
    expect(readme).toMatch(/general-purpose/i);
    expect(readme).toContain("@trailstep/create-flows#takeItAway");
    expect(readme).toContain("@trailstep/create-flows#grillItAway");
    expect(readme).not.toContain("@trailstep/create-flows#delegate");

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

    const readmeWorkflowNames = Array.from(readme.matchAll(/^- `([^`]+)`:/gm), ([, name]) =>
      String(name),
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
