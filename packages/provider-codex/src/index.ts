export const trailstepProvider = {
  manifest: {
    schemaVersion: 1,
    id: "codex",
    displayName: "Codex",
    working: {
      supported: true,
      command: "codex",
      args: [
        "exec",
        "-o",
        "{{outputFile}}",
        "{{#model}}",
        "-m",
        "{{model}}",
        "{{/model}}",
        "{{#thinking}}",
        "-c",
        "model_reasoning_effort={{thinking}}",
        "{{/thinking}}",
        "{{tools}}",
        "{{skills}}",
        "{{mcpArgs}}",
        "{{extensionsArgs}}",
        "{{contextFilesArgs}}",
        "@{{promptFile}}",
      ],
      followUp: {
        supported: true,
        resumeArgs: [
          "exec",
          "resume",
          "{{sessionId}}",
          "-o",
          "{{outputFile}}",
          "{{#model}}",
          "-m",
          "{{model}}",
          "{{/model}}",
          "{{#thinking}}",
          "-c",
          "model_reasoning_effort={{thinking}}",
          "{{/thinking}}",
          "{{tools}}",
          "{{skills}}",
          "{{mcpArgs}}",
          "{{extensionsArgs}}",
          "{{contextFilesArgs}}",
          "@{{promptFile}}",
        ],
      },
      prompt: { kind: "prompt-file", reference: "at-prefixed-argument" },
      output: { style: "provider-output-file" },
    },
    interactive: {
      supported: true,
      command: "codex",
      modelFlag: "--model",
    },
    model: { supported: true, flag: "-m" },
    thinking: {
      supported: true,
      flag: "-c model_reasoning_effort",
      levels: ["low", "medium", "high", "xhigh"],
    },
    // Tools, skills, and contextFiles are intentionally omitted: codex exec
    // has no per-tool allow/deny flag, no runtime skills flag, and no flag to
    // skip the AGENTS.md project doc. Flags split on whitespace into argv entries (`-c key=value` renders as two
    // entries); prefer the single-token `--flag=value` form for values.
    hygiene: {
      mcp: { disableFlag: "--config=mcp_servers={}" },
      extensions: { disableFlag: "--disable=plugins" },
    },
  },
  hooks: {
    extractOutput: { supported: false },
    repairOutput: { supported: false },
  },
} as const;
