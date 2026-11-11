import { isRecord } from "../../json/guards.js";
import type { RetryPolicyInput } from "../../runtime/retry/retry-policy.js";
import type { TrailStepEvidenceSettings, TrailStepSettings } from "../targeting.types.js";

export function parseSettings(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepSettings | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    return undefined;
  }

  const settings: Record<string, unknown> = { ...value };

  if (value.retry !== undefined) {
    if (!isRecord(value.retry)) {
      diagnostics.push(`${path}.retry must be an object when present.`);
      delete settings.retry;
    } else if (value.retry.maxAttempts === undefined && value.retry.retryOn === undefined) {
      delete settings.retry;
    } else {
      const retry: RetryPolicyInput = {
        ...(value.retry.maxAttempts === undefined ? {} : { maxAttempts: value.retry.maxAttempts }),
        ...(value.retry.retryOn === undefined ? {} : { retryOn: value.retry.retryOn }),
      };
      settings.retry = retry;
    }
  }

  if (value.timeout !== undefined && typeof value.timeout !== "number") {
    diagnostics.push(`${path}.timeout must be a number when present.`);
    delete settings.timeout;
  }

  if (value.stallTimeout !== undefined && typeof value.stallTimeout !== "number") {
    diagnostics.push(`${path}.stallTimeout must be a number when present.`);
    delete settings.stallTimeout;
  }

  if (value.evidence !== undefined) {
    const evidence = parseEvidenceSettings(`${path}.evidence`, value.evidence, diagnostics);
    if (evidence === undefined) {
      delete settings.evidence;
    } else {
      settings.evidence = evidence;
    }
  }

  return settings;
}

const EVIDENCE_PROVIDER_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
const MAX_EVIDENCE_PROVIDER_ROOTS = 64;
const MAX_ROOTS_PER_PROVIDER = 32;
const MAX_ROOT_LENGTH = 1024;

function parseEvidenceSettings(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepEvidenceSettings | undefined {
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    return undefined;
  }

  if (value.schemaVersion !== 1) {
    diagnostics.push(`${path}.schemaVersion must be 1.`);
    return undefined;
  }

  const usage = value.usage === undefined ? false : value.usage;
  if (typeof usage !== "boolean") {
    diagnostics.push(`${path}.usage must be a boolean when present.`);
    return undefined;
  }

  const providerRoots = parseEvidenceProviderRoots(
    `${path}.providerRoots`,
    value.providerRoots,
    diagnostics,
  );
  if (providerRoots === undefined && value.providerRoots !== undefined) {
    return undefined;
  }

  return {
    schemaVersion: 1,
    usage,
    ...(providerRoots === undefined ? {} : { providerRoots }),
  };
}

function parseEvidenceProviderRoots(
  path: string,
  value: unknown,
  diagnostics: string[],
): Readonly<Record<string, readonly string[]>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    return undefined;
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_EVIDENCE_PROVIDER_ROOTS) {
    diagnostics.push(`${path} must declare at most ${MAX_EVIDENCE_PROVIDER_ROOTS} providers.`);
    return undefined;
  }

  const providerRoots: Record<string, readonly string[]> = {};
  for (const [providerId, rawRoots] of entries) {
    if (
      providerId.length === 0 ||
      providerId.length > 256 ||
      new RegExp(EVIDENCE_PROVIDER_ID_PATTERN).test(providerId) === false
    ) {
      diagnostics.push(`${path}.${providerId} must be a registered provider id.`);
      return undefined;
    }
    if (!Array.isArray(rawRoots)) {
      diagnostics.push(`${path}.${providerId} must be an array of authorized root paths.`);
      return undefined;
    }
    if (rawRoots.length > MAX_ROOTS_PER_PROVIDER) {
      diagnostics.push(
        `${path}.${providerId} must declare at most ${MAX_ROOTS_PER_PROVIDER} roots.`,
      );
      return undefined;
    }
    const roots: string[] = [];
    for (const root of rawRoots) {
      if (
        typeof root !== "string" ||
        root.length === 0 ||
        root.length > MAX_ROOT_LENGTH ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: explicit NUL/control rejection
        /[\u0000-\u001F\u007F]/.test(root)
      ) {
        diagnostics.push(
          `${path}.${providerId} roots must be non-empty bounded strings without control characters.`,
        );
        return undefined;
      }
      roots.push(root);
    }
    providerRoots[providerId] = roots;
  }

  return providerRoots;
}
