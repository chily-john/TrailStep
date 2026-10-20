import { describe, expect, it } from "vitest";
import { resolveAgentExecutionConfig } from "../contracts/agents/agent-execution.types.js";
import { TrailStepFailureError } from "../contracts/failures/failure.js";
import {
  buildProviderHygieneArgs,
  parseTrailStepProviderManifest,
  parseTrailStepProviderRegistrations,
} from "./provider-manifest.js";

describe("provider manifest validation", () => {
  it("preserves provider-specific package manifest invocation fields", () => {
    const diagnostics: string[] = [];

    const manifest = parseTrailStepProviderManifest(
      "trailstepProvider.manifest",
      {
        schemaVersion: 1,
        id: "claude",
        displayName: "Claude",
        working: {
          supported: true,
          command: "claude",
          prompt: { kind: "prompt-file", reference: "at-prefixed-argument" },
          output: {
            style: "stdout-json-envelope",
            parsing: { resultField: "result" },
          },
        },
        interactive: {
          supported: true,
          command: "claude",
          requiresSystemPromptFile: true,
          systemPromptFileFlag: "--append-system-prompt-file",
          modelFlag: "--model",
          permissionBypassFlag: "--dangerously-skip-permissions",
        },
        model: { supported: true, flag: "--model" },
        thinking: {
          supported: true,
          flag: "--effort",
          levels: ["low", "medium", "high", "xhigh", "max"],
        },
      },
      diagnostics,
    );

    expect(diagnostics).toEqual([]);
    expect(manifest).toMatchObject({
      working: {
        prompt: { reference: "at-prefixed-argument" },
        output: { style: "stdout-json-envelope", parsing: { resultField: "result" } },
      },
      interactive: {
        requiresSystemPromptFile: true,
        systemPromptFileFlag: "--append-system-prompt-file",
        modelFlag: "--model",
        permissionBypassFlag: "--dangerously-skip-permissions",
      },
      model: { flag: "--model" },
      thinking: { flag: "--effort", levels: ["low", "medium", "high", "xhigh", "max"] },
    });
  });

  it("reports actionable diagnostics for malformed provider manifests", () => {
    try {
      parseTrailStepProviderRegistrations(
        "providers",
        {
          "echo-agent": {
            source: { type: "local-manifest", path: "./echo-provider.json" },
            manifest: {
              schemaVersion: 1,
              displayName: "Echo Agent",
              working: {
                supported: true,
                args: ["--prompt-file", "{{promptFile}}"],
                prompt: { kind: "prompt-file" },
                output: { style: "provider-output-file" },
              },
              interactive: { supported: false, reason: "No interactive mode" },
              model: { supported: false },
              thinking: { supported: false },
            },
          },
        },
        [],
      );
      throw new Error("Expected provider manifest parsing to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(TrailStepFailureError);
      expect((error as TrailStepFailureError).failure.details).toEqual({
        diagnostics: expect.arrayContaining([
          "providers.echo-agent.manifest.id must be a non-empty string.",
          "providers.echo-agent.manifest.working.command must be a non-empty string.",
        ]),
      });
    }
  });

  describe("working followUp", () => {
    const baseManifest = (working: Record<string, unknown>): Record<string, unknown> => ({
      schemaVersion: 1,
      id: "claude",
      displayName: "Claude",
      working,
      interactive: { supported: false },
      model: { supported: false },
      thinking: { supported: false },
    });

    const workingWith = (followUp: unknown): Record<string, unknown> => ({
      supported: true,
      command: "claude",
      args: ["--prompt-file", "{{promptFile}}"],
      prompt: { kind: "prompt-file", reference: "at-prefixed-argument" },
      output: { style: "stdout-json-envelope", parsing: { resultField: "result" } },
      ...(followUp === undefined ? {} : { followUp }),
    });

    const parseWithFollowUp = (
      followUp: unknown,
      diagnostics: string[],
    ): ReturnType<typeof parseTrailStepProviderManifest> =>
      parseTrailStepProviderManifest(
        "trailstepProvider.manifest",
        baseManifest(workingWith(followUp)),
        diagnostics,
      );

    it("keeps working manifests without followUp backward compatible", () => {
      const diagnostics: string[] = [];

      const manifest = parseWithFollowUp(undefined, diagnostics);

      expect(diagnostics).toEqual([]);
      expect(manifest?.working).not.toHaveProperty("followUp");
    });

    it("parses followUp supported false with reason", () => {
      const diagnostics: string[] = [];

      const manifest = parseWithFollowUp(
        { supported: false, reason: "Provider has no resume flag." },
        diagnostics,
      );

      expect(diagnostics).toEqual([]);
      expect(manifest?.working.followUp).toEqual({
        supported: false,
        reason: "Provider has no resume flag.",
      });
    });

    it("parses followUp supported true with sessionIdFlag and resumeArgs", () => {
      const diagnostics: string[] = [];

      const manifest = parseWithFollowUp(
        {
          supported: true,
          sessionIdFlag: "--resume",
          resumeArgs: ["{{sessionId}}", "@{{promptFile}}"],
        },
        diagnostics,
      );

      expect(diagnostics).toEqual([]);
      expect(manifest?.working.followUp).toEqual({
        supported: true,
        sessionIdFlag: "--resume",
        resumeArgs: ["{{sessionId}}", "@{{promptFile}}"],
      });
    });

    it("reports diagnostics for malformed followUp shapes", () => {
      const nonArrayResumeArgsDiagnostics: string[] = [];
      expect(
        parseWithFollowUp(
          { supported: true, resumeArgs: "--resume" },
          nonArrayResumeArgsDiagnostics,
        ),
      ).toBeUndefined();
      expect(nonArrayResumeArgsDiagnostics).toEqual([
        "trailstepProvider.manifest.working.followUp.resumeArgs must be an array of strings when present.",
      ]);

      const emptySessionIdFlagDiagnostics: string[] = [];
      expect(
        parseWithFollowUp({ supported: true, sessionIdFlag: "" }, emptySessionIdFlagDiagnostics),
      ).toBeUndefined();
      expect(emptySessionIdFlagDiagnostics).toEqual([
        "trailstepProvider.manifest.working.followUp.sessionIdFlag must be a non-empty string when present.",
      ]);

      const missingSupportedDiagnostics: string[] = [];
      expect(
        parseWithFollowUp({ sessionIdFlag: "--resume" }, missingSupportedDiagnostics),
      ).toBeUndefined();
      expect(missingSupportedDiagnostics).toEqual([
        "trailstepProvider.manifest.working.followUp must be an object with a boolean supported field.",
      ]);
    });
  });

  describe("hygiene capability mapping", () => {
    const baseManifest = (
      hygiene: unknown,
      extra: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      schemaVersion: 1,
      id: "pi",
      displayName: "Pi",
      working: {
        supported: true,
        command: "pi",
        args: ["--prompt-file", "{{promptFile}}"],
        prompt: { kind: "prompt-file" },
        output: { style: "provider-output-file" },
      },
      interactive: { supported: false },
      model: { supported: false },
      thinking: { supported: false },
      ...(hygiene === undefined ? {} : { hygiene }),
      ...extra,
    });

    it("parses provider-package style entries and ignores unknown keys", () => {
      const diagnostics: string[] = [];

      const manifest = parseTrailStepProviderManifest(
        "trailstepProvider.manifest",
        baseManifest(
          {
            tools: { supported: true, flag: "--tools", futureKey: "ignored" },
            skills: { supported: false, reason: "no runtime skills flag" },
            mcp: { supported: true, flag: "--no-mcp" },
            contextSuppression: { supported: true, flag: "--no-context-files" },
            futureCapability: { supported: true, flag: "--future" },
          },
          { futureTopLevel: true },
        ),
        diagnostics,
      );

      expect(diagnostics).toEqual([]);
      expect(manifest?.hygiene).toEqual({
        tools: { flag: "--tools" },
        skills: { supported: false, reason: "no runtime skills flag" },
        mcp: { flag: "--no-mcp" },
        contextFiles: { flag: "--no-context-files" },
      });
      expect(manifest).not.toHaveProperty("futureTopLevel");
    });

    it("parses disableFlag-style entries and the contextFiles spelling", () => {
      const diagnostics: string[] = [];

      const manifest = parseTrailStepProviderManifest(
        "trailstepProvider.manifest",
        baseManifest({
          tools: { flag: "--tools" },
          skills: { flag: "--skill", disableFlag: "--no-skills" },
          mcp: { disableFlag: "--no-mcp" },
          extensions: { disableFlag: "--no-extensions" },
          contextFiles: { disableFlag: "--no-context-files" },
        }),
        diagnostics,
      );

      expect(diagnostics).toEqual([]);
      expect(manifest?.hygiene).toEqual({
        tools: { flag: "--tools" },
        skills: { flag: "--skill", disableFlag: "--no-skills" },
        mcp: { disableFlag: "--no-mcp" },
        extensions: { disableFlag: "--no-extensions" },
        contextFiles: { disableFlag: "--no-context-files" },
      });
    });

    it("keeps manifests without hygiene backward compatible", () => {
      const diagnostics: string[] = [];

      const manifest = parseTrailStepProviderManifest(
        "trailstepProvider.manifest",
        baseManifest(undefined),
        diagnostics,
      );

      expect(diagnostics).toEqual([]);
      expect(manifest?.hygiene).toBeUndefined();
    });

    it("reports actionable diagnostics for malformed hygiene entries", () => {
      const unsupportedWithoutReason: string[] = [];
      expect(
        parseTrailStepProviderManifest(
          "trailstepProvider.manifest",
          baseManifest({ tools: { supported: true, flag: "--tools", bad: 1 }, mcp: {} }),
          unsupportedWithoutReason,
        ),
      ).toBeUndefined();
      expect(unsupportedWithoutReason).toEqual([
        "trailstepProvider.manifest.hygiene.mcp must declare flag or disableFlag when present.",
      ]);

      const supportedFalseWithoutReason: string[] = [];
      expect(
        parseTrailStepProviderManifest(
          "trailstepProvider.manifest",
          baseManifest({ extensions: { supported: false } }),
          supportedFalseWithoutReason,
        ),
      ).toBeUndefined();
      expect(supportedFalseWithoutReason).toEqual([
        "trailstepProvider.manifest.hygiene.extensions must declare reason when supported is false.",
      ]);

      const nonObjectCapability: string[] = [];
      expect(
        parseTrailStepProviderManifest(
          "trailstepProvider.manifest",
          baseManifest({ mcp: "--no-mcp" }),
          nonObjectCapability,
        ),
      ).toBeUndefined();
      expect(nonObjectCapability).toEqual([
        "trailstepProvider.manifest.hygiene.mcp must be an object when present.",
      ]);

      const nonObjectHygiene: string[] = [];
      expect(
        parseTrailStepProviderManifest(
          "trailstepProvider.manifest",
          baseManifest("hygiene"),
          nonObjectHygiene,
        ),
      ).toBeUndefined();
      expect(nonObjectHygiene).toEqual([
        "trailstepProvider.manifest.hygiene must be an object when present.",
      ]);
    });
  });
});

describe("buildProviderHygieneArgs", () => {
  const piHygiene = {
    tools: { flag: "--tools" },
    skills: { flag: "--skill", disableFlag: "--no-skills" },
    mcp: { disableFlag: "--no-mcp" },
    extensions: { disableFlag: "--no-extensions" },
    contextFiles: { disableFlag: "--no-context-files" },
  };

  it("renders nothing when execution or hygiene is absent", () => {
    expect(buildProviderHygieneArgs({})).toEqual({});
    expect(buildProviderHygieneArgs({ execution: resolveAgentExecutionConfig({}) })).toEqual({});
    expect(buildProviderHygieneArgs({ hygiene: piHygiene })).toEqual({});
  });

  it("renders lean pi defaults to suppression flags only", () => {
    const args = buildProviderHygieneArgs({
      execution: resolveAgentExecutionConfig({}),
      hygiene: piHygiene,
    });

    expect(args).toEqual({
      skills: ["--no-skills"],
      mcpArgs: ["--no-mcp"],
      extensionsArgs: ["--no-extensions"],
      contextFilesArgs: ["--no-context-files"],
    });
    expect(args.tools).toBeUndefined();
  });

  it("renders an explicit tools allowlist as flag plus comma-joined value", () => {
    const args = buildProviderHygieneArgs({
      execution: resolveAgentExecutionConfig({ tools: ["Read", "Grep"] }),
      hygiene: piHygiene,
    });

    expect(args.tools).toEqual(["--tools", "Read,Grep"]);
  });

  it("renders per-item enable flags for a non-empty skills list", () => {
    const args = buildProviderHygieneArgs({
      execution: resolveAgentExecutionConfig({ skills: ["alpha", "beta"] }),
      hygiene: piHygiene,
    });

    expect(args.skills).toEqual(["--skill", "alpha", "--skill", "beta"]);
  });

  it("treats a lone flag as the suppression flag for skills", () => {
    const args = buildProviderHygieneArgs({
      execution: resolveAgentExecutionConfig({ skills: ["alpha"] }),
      hygiene: { skills: { flag: "--no-skills" } },
    });

    expect(args.skills).toBeUndefined();
    expect(
      buildProviderHygieneArgs({
        execution: resolveAgentExecutionConfig({ skills: [] }),
        hygiene: { skills: { flag: "--no-skills" } },
      }).skills,
    ).toEqual(["--no-skills"]);
  });

  it("honors supported false by rendering nothing", () => {
    const args = buildProviderHygieneArgs({
      execution: resolveAgentExecutionConfig({ mcp: false, contextFiles: false }),
      hygiene: {
        mcp: { supported: false, reason: "no flag" },
        contextSuppression: { supported: false, reason: "no flag" },
      },
    });

    expect(args).toEqual({});
  });

  it("renders nothing for unrestricted context files and mcp enabled", () => {
    const args = buildProviderHygieneArgs({
      execution: resolveAgentExecutionConfig({
        mcp: true,
        contextFiles: true,
        skills: ["alpha"],
        extensions: ["./ext.js"],
      }),
      hygiene: piHygiene,
    });

    expect(args).toEqual({ skills: ["--skill", "alpha"] });
  });

  it("splits multi-word flags into separate argv entries", () => {
    const args = buildProviderHygieneArgs({
      execution: resolveAgentExecutionConfig({ mcp: false }),
      hygiene: { mcp: { flag: "-c mcp_servers={}" } },
    });

    expect(args.mcpArgs).toEqual(["-c", "mcp_servers={}"]);
  });
});
