export interface ProviderPackageRef {
  readonly sourceType: "npm" | "github";
  readonly packageName?: string;
  readonly requestedSpec: string;
}

export function parseProviderPackageRef(source: string): ProviderPackageRef | undefined {
  if (source.startsWith("github:")) {
    return { sourceType: "github", requestedSpec: source };
  }
  if (
    source.startsWith("./") ||
    source.startsWith("../") ||
    source.startsWith(".\\") ||
    source.startsWith("..\\") ||
    /^[A-Za-z]:[\\/]/u.test(source)
  ) {
    return undefined;
  }
  const scoped = /^(@[^/@\\\s]+\/[^/@\\\s]+)(?:@.+)?$/u.exec(source);
  const unscoped = /^([^@/\\\s]+)(?:@.+)?$/u.exec(source);
  const packageName = scoped?.[1] ?? unscoped?.[1];
  return packageName === undefined
    ? undefined
    : { sourceType: "npm", packageName, requestedSpec: source };
}
