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
      ],
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
  },
  hooks: {
    extractOutput: { supported: true, source: "package" },
    repairOutput: { supported: false },
  },
} as const;
