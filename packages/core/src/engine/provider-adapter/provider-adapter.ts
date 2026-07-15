import { claudeProvider } from "./claude-provider.js";
import { codexProvider } from "./codex-provider.js";
import { geminiProvider } from "./gemini-provider.js";
import { piProvider } from "./pi-provider.js";
import type { ProviderAdapter } from "./provider-adapter.types.js";

/**
 * Core's built-in known-CLI provider registry. Each entry maps a provider id
 * (matched against a `.stepkit/config.json` target's `provider` field) to a
 * core-owned CLI print-mode invocation for a single named vendor.
 *
 * This is the full four-provider set. Unlike Claude/Codex/Pi, `gemini`'s
 * adapter is structurally verified only (an injected fake stdout-capturing
 * runner in `agent.test.ts`/`gemini.test.ts`) — the real `gemini` CLI is not
 * installed in this environment, so its argv/envelope shape has not been
 * confirmed against a live process. See `mock-local-test/README.md` and
 * `docs/architecture.md` for the explicit follow-up.
 */
export const providerRegistry: Record<"claude" | "codex" | "pi" | "gemini", ProviderAdapter> = {
  claude: claudeProvider,
  codex: codexProvider,
  pi: piProvider,
  gemini: geminiProvider,
};

export type ProviderRegistryKey = keyof typeof providerRegistry;

export function isProviderRegistryKey(provider: string): provider is ProviderRegistryKey {
  return Object.hasOwn(providerRegistry, provider);
}
