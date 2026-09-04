import { OFFICIAL_PROVIDER_IDS, type OfficialProviderId } from "../official-provider-specs.js";

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
