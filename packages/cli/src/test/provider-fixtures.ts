export const TEST_CUSTOM_PROVIDERS = {
  claude: {
    binary: "claude",
    args: ["--prompt-file", "{{promptFile}}", "--output-file", "{{outputFile}}"],
    interactiveArgs: [
      "{{#model}}",
      "--model",
      "{{model}}",
      "{{/model}}",
      "--append-system-prompt-file",
      "{{promptFile}}",
    ],
  },
  codex: {
    binary: "codex",
    args: ["--prompt-file", "{{promptFile}}", "--output-file", "{{outputFile}}"],
    interactiveArgs: ["{{promptFile}}"],
  },
  gemini: {
    binary: "gemini",
    args: ["--prompt-file", "{{promptFile}}", "--output-file", "{{outputFile}}"],
    interactiveArgs: ["{{promptFile}}"],
  },
  pi: {
    binary: "pi",
    args: ["--prompt-file", "{{promptFile}}", "--output-file", "{{outputFile}}"],
    interactiveArgs: ["--append-system-prompt", "{{promptFile}}"],
  },
} as const;

export function withTestCustomProviders<T extends Record<string, unknown>>(config: T): T {
  return {
    ...config,
    customProviders: {
      ...TEST_CUSTOM_PROVIDERS,
      ...(isRecord(config.customProviders) ? config.customProviders : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
