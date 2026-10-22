import type { ProviderModelDiscoverySpec, WorkflowAgentThinking } from "@trailstep/core";

export const OFFICIAL_PROVIDER_IDS = ["claude", "codex", "gemini", "pi"] as const;

export type OfficialProviderId = (typeof OFFICIAL_PROVIDER_IDS)[number];

/**
 * CLI-side mirror of the capability metadata declared by the official
 * provider packages (`@trailstep/provider-*`).
 *
 * The provider package manifest is the source of truth: the package knows
 * which flags its own CLI supports. This table only carries the two pieces
 * the CLI needs before a provider package is installed (model discovery and
 * the thinking levels offered in the agent setup wizard), so it must agree
 * with the manifest. `official-providers.test.ts` pins that agreement.
 */
export interface OfficialProviderSpec {
  readonly model?:
    | { readonly supported: false }
    | {
        readonly supported: true;
        /** Present only when the provider CLI can list its models. */
        readonly discovery?: ProviderModelDiscoverySpec;
      };
  readonly thinking?:
    | { readonly supported: false }
    | { readonly supported: true; readonly levels: readonly WorkflowAgentThinking[] };
}

const GENERIC_THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

const OFFICIAL_PROVIDER_SPECS: Record<OfficialProviderId, OfficialProviderSpec> = {
  claude: {
    // `claude --model <name>` is supported, but the CLI has no model-listing
    // command, so no discovery spec exists.
    model: { supported: true },
    thinking: { supported: true, levels: GENERIC_THINKING_LEVELS },
  },
  codex: {
    // `codex -m <name>` is supported, but the CLI has no model-listing
    // command, so no discovery spec exists.
    model: { supported: true },
    thinking: { supported: true, levels: ["low", "medium", "high", "xhigh"] },
  },
  gemini: {
    // `gemini -m <name>` is supported, but the CLI has no model-listing
    // command, so no discovery spec exists.
    model: { supported: true },
    thinking: { supported: false },
  },
  pi: {
    model: {
      supported: true,
      discovery: {
        command: "pi",
        args: ["--list-models"],
        outputParser: "pi-list-models-table",
      },
    },
    thinking: { supported: true, levels: GENERIC_THINKING_LEVELS },
  },
};

export function isOfficialProviderId(value: string): value is OfficialProviderId {
  return OFFICIAL_PROVIDER_IDS.includes(value as OfficialProviderId);
}

export function officialProviderSpecFor(value: string): OfficialProviderSpec | undefined {
  return isOfficialProviderId(value) ? OFFICIAL_PROVIDER_SPECS[value] : undefined;
}

export interface OfficialProviderPackage {
  readonly id: OfficialProviderId;
  readonly packageName: `@trailstep/provider-${string}`;
}

export const OFFICIAL_PROVIDER_PACKAGES: readonly OfficialProviderPackage[] =
  OFFICIAL_PROVIDER_IDS.map((id) => ({
    id,
    packageName: `@trailstep/provider-${id}`,
  }));

export function isOfficialProviderPackageName(value: string): boolean {
  return OFFICIAL_PROVIDER_PACKAGES.some((provider) => provider.packageName === value);
}

export function officialProviderIdForSelection(value: string): string {
  return OFFICIAL_PROVIDER_PACKAGES.find((provider) => provider.packageName === value)?.id ?? value;
}
