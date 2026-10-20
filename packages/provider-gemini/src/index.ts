export const trailstepProvider = {
  manifest: {
    schemaVersion: 1,
    id: "gemini",
    displayName: "Gemini",
    working: {
      supported: true,
      command: "gemini",
      args: [
        "-p",
        "@{{promptFile}}",
        "--output-format",
        "json",
        "{{#model}}",
        "-m",
        "{{model}}",
        "{{/model}}",
        "{{tools}}",
        "{{skills}}",
        "{{mcpArgs}}",
        "{{extensionsArgs}}",
        "{{contextFilesArgs}}",
      ],
      followUp: {
        supported: true,
        resumeArgs: [
          "-p",
          "@{{promptFile}}",
          "--output-format",
          "json",
          "{{#model}}",
          "-m",
          "{{model}}",
          "{{/model}}",
          "{{tools}}",
          "{{skills}}",
          "{{mcpArgs}}",
          "{{extensionsArgs}}",
          "{{contextFilesArgs}}",
          "--resume",
          "{{sessionId}}",
        ],
      },
      prompt: { kind: "prompt-file", reference: "at-prefixed-argument" },
      output: {
        style: "stdout-json-envelope",
        parsing: { resultField: "response" },
      },
    },
    interactive: {
      supported: true,
      command: "gemini",
      modelFlag: "-m",
    },
    model: { supported: true, flag: "-m" },
    thinking: { supported: false },
    // Skills, mcp, extensions, and contextFiles are intentionally omitted:
    // gemini has no per-run skills flag (use `gemini skills disable --all`
    // beforehand), MCP control is allowlist-only (`--allowed-mcp-server-names`
    // has no disable form), `--extensions` selects extensions rather than
    // disabling them, and GEMINI.md discovery cannot be skipped per run.
    // `--allowed-tools` is deprecated upstream in favor of the Policy Engine.
    hygiene: {
      tools: { flag: "--allowed-tools" },
    },
  },
  hooks: {
    extractOutput: { supported: true, source: "package" },
    repairOutput: { supported: false },
  },
} as const;
