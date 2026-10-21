import type { ProviderModelDiscoverySpec, WorkflowAgentThinking } from "@trailstep/core";

export const OFFICIAL_PROVIDER_IDS = ["claude", "codex", "gemini", "pi"] as const;

export type OfficialProviderId = (typeof OFFICIAL_PROVIDER_IDS)[number];

interface OfficialProviderSpec {
  readonly model?:
    | { readonly supported: false }
    | { readonly supported: true; readonly discovery: ProviderModelDiscoverySpec };
  readonly thinking?:
    | { readonly supported: false }
    | { readonly supported: true; readonly levels: readonly WorkflowAgentThinking[] };
}

const GENERIC_THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

const OFFICIAL_PROVIDER_SPECS: Record<OfficialProviderId, OfficialProviderSpec> = {
  claude: {
    model: { supported: false },
    thinking: { supported: true, levels: GENERIC_THINKING_LEVELS },
  },
  codex: {
    model: { supported: false },
    thinking: { supported: true, levels: ["low", "medium", "high", "xhigh"] },
  },
  gemini: {
    model: { supported: false },
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
