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
      trailstep?: {
        workflows?: Record<string, string>;
        recommendedConfig?: Record<string, unknown>;
      };
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
      delegateSimpleExplore: "./dist/index.js#delegateSimpleExplore",
      delegateArchitectPlanner: "./dist/index.js#delegateArchitectPlanner",
      delegateReview: "./dist/index.js#delegateReview",
      delegateImplement: "./dist/index.js#delegateImplement",
      delegateQuickImplementor: "./dist/index.js#delegateQuickImplementor",
      delegateSmartImplementor: "./dist/index.js#delegateSmartImplementor",
      delegateRelentlessDebugger: "./dist/index.js#delegateRelentlessDebugger",
      delegateSchemaFormatter: "./dist/index.js#delegateSchemaFormatter",
      delegateParallel: "./dist/index.js#delegateParallel",
    });
    expect(packageJson.trailstep?.recommendedConfig).toMatchObject({
      agents: {
        generalist: [
          { provider: "pi", model: "openrouter/meta/muse-spark-1.3" },
          { provider: "pi", model: "openrouter/xiaomi/mimo-v2.6-pro" },
        ],
        explorer: [
          { provider: "pi", model: "openrouter/deepseek/deepseek-v4-flash-0731", thinking: "low" },
        ],
        "quick-implementor": [{ provider: "pi", model: "openrouter/z-ai/glm-5.3-flash" }],
        "smart-implementor": [{ provider: "pi", model: "openrouter/xiaomi/mimo-v2.6-pro" }],
        fixer: [{ ref: "debugger" }],
      },
      workflows: {
        delegate: { agents: { delegateAgent: [{ ref: "smart-implementor" }] } },
        delegateExplore: { agents: { delegateAgent: [{ ref: "explorer" }] } },
        delegateSmartImplementor: { agents: { delegateAgent: [{ ref: "smart-implementor" }] } },
      },
    });

    expect(readme).toMatch(/public/i);
    expect(readme).toMatch(/reusable/i);
    expect(readme).toMatch(/sub-agent/i);
    expect(readme).toContain("@trailstep/sub-agents#delegate");
    expect(readme).toContain("@trailstep/sub-agents#delegateExplore");
    expect(readme).toContain("@trailstep/sub-agents#delegateReview");
    expect(readme).toContain("@trailstep/sub-agents#delegateImplement");
    expect(readme).toContain("@trailstep/sub-agents#delegateParallel");

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
