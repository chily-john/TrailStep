---
kind: rules
paths:
  - packages/core/src/known-cli-providers/providers/
summary: Provider-specific CLI invocations for Claude, Codex, Gemini, and Pi.
triggers:
  - claude provider
  - codex provider
  - gemini provider
  - pi provider
  - provider args
---

# packages/core/src/known-cli-providers/providers/

Enter here when changing command-line invocation details for a built-in provider.

## Rules

- `claude`, `pi`, and `gemini` working modes capture stdout and parse it through envelope extraction before writing `outputFile`.
- Pi JSON working stdout collection belongs in `createPiJsonStreamStdoutCollector`; keep extraction bounded to the latest result-candidate line with fallback diagnostics, and let a usable final envelope override non-zero exit codes.
- `codex` working mode uses `codex exec -o <outputFile>` and does not parse stdout.
- Working provider argv pass prompts as `@<promptFile>` via `promptFileReference(...)`, not inline rendered prompt text.
- Codex rejects thinking level `max`; Pi passes supported StepKit thinking levels through; Gemini intentionally does not pass thinking flags without verified CLI support.
- Provider working and interactive modes accept abort signals; interactive modes inherit stdio, accept supplied environment variables, and return an exit code. Runtime interactive calls may pass `systemPromptFile`: Claude requires it via `--append-system-prompt-file`, while Codex, Gemini, and Pi pass it as `@<systemPromptFile>`. Standalone managed sessions use provider spec prompt delivery: Claude hidden system prompt file, Codex/Gemini/Pi visible inline prompt. File-based session protocol belongs to generic interactive orchestration.
- Provider `spec` metadata must mirror the provider's tested command capabilities.
- Add or change provider argv only with provider tests that cover the exact command shape.
