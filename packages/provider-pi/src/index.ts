export const trailstepProvider = {
  manifest: {
    schemaVersion: 1,
    id: "pi",
    displayName: "Pi",
    working: {
      supported: true,
      command: "pi",
      args: [
        "-p",
        "--mode",
        "json",
        "{{#model}}",
        "--model",
        "{{model}}",
        "{{/model}}",
        "{{#thinking}}",
        "--thinking",
        "{{thinking}}",
        "{{/thinking}}",
        "@{{promptFile}}",
      ],
      prompt: { kind: "prompt-file", reference: "at-prefixed-argument" },
      output: {
        style: "stdout-jsonl-transcript",
        parsing: { resultField: "message" },
      },
    },
    interactive: {
      supported: true,
      command: "pi",
    },
    model: { supported: true },
    thinking: { supported: true, levels: ["low", "medium", "high", "xhigh", "max"] },
  },
  hooks: {
    extractOutput: { supported: true, source: "package" },
  },
} as const;
