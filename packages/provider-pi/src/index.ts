export const trailstepProvider = {
  manifest: {
    schemaVersion: 1,
    id: "pi",
    displayName: "Pi",
    working: {
      supported: true,
      command: "pi",
      args: ["-p", "{{promptFile}}", "--output-file", "{{outputFile}}"],
      prompt: { kind: "prompt-file" },
      output: { style: "provider-output-file" },
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
