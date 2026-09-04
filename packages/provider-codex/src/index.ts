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
        "@{{promptFile}}",
      ],
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
  },
  hooks: {
    extractOutput: { supported: false },
    repairOutput: { supported: false },
  },
} as const;
