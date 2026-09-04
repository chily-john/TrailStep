export const trailstepProvider = {
  manifest: {
    schemaVersion: 1,
    id: "claude",
    displayName: "Claude",
    working: {
      supported: true,
      command: "claude",
      args: [
        "-p",
        "--output-format",
        "json",
        "{{#model}}",
        "--model",
        "{{model}}",
        "{{/model}}",
        "{{#thinking}}",
        "--effort",
        "{{thinking}}",
        "{{/thinking}}",
        "@{{promptFile}}",
      ],
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
    },
    model: { supported: true, flag: "--model" },
    thinking: {
      supported: true,
      flag: "--effort",
      levels: ["low", "medium", "high", "xhigh", "max"],
    },
  },
  hooks: {
    extractOutput: { supported: true, source: "package" },
    repairOutput: { supported: true, source: "package" },
  },
} as const;
