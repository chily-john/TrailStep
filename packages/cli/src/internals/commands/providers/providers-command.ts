import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter, resolve } from "node:path";

import * as trailstepCore from "@trailstep/core";
import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import {
  configPathForScope,
  readRawTrailStepConfigFile,
  type WorkflowRegistryScope,
  writeRawTrailStepConfigFile,
} from "../../workflow-registry/workflow-registry.js";

interface TrailStepProviderRegistration {
  readonly source: { readonly type: "local-manifest"; readonly path: string };
  readonly manifest: TrailStepProviderManifest;
}

interface TrailStepProviderManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly displayName: string;
  readonly working: {
    readonly supported: boolean;
    readonly command?: string;
    readonly args?: readonly string[];
    readonly prompt?: { readonly kind: "prompt-file" };
    readonly output?: { readonly style: "provider-output-file" };
  };
  readonly interactive: {
    readonly supported: boolean;
    readonly reason?: string;
    readonly command?: string;
  };
  readonly model: { readonly supported: boolean };
  readonly thinking: { readonly supported: boolean; readonly levels?: readonly string[] };
  readonly environment?: {
    readonly required?: readonly string[];
    readonly optional?: readonly string[];
  };
  readonly env?: { readonly required?: readonly string[]; readonly optional?: readonly string[] };
  readonly hooks?: Record<string, unknown>;
}

type ProviderCommandArgs =
  | { readonly action: "inspect"; readonly path: string }
  | { readonly action: "add"; readonly path: string; readonly scope?: WorkflowRegistryScope }
  | { readonly action: "list"; readonly scope?: WorkflowRegistryScope }
  | { readonly action: "show"; readonly provider: string; readonly scope?: WorkflowRegistryScope }
  | { readonly action: "test"; readonly provider: string; readonly scope?: WorkflowRegistryScope }
  | {
      readonly action: "remove";
      readonly provider: string;
      readonly scope?: WorkflowRegistryScope;
    };

export const providersCommand: CliCommand<ProviderCommandArgs> = {
  name: "providers",
  parseArgs(argv: readonly string[]): ProviderCommandArgs {
    if (argv[0] !== "providers") {
      throw new CliUsageError("Expected providers command.");
    }

    const action = argv[1];
    if (action === "inspect") {
      const manifestPath = argv[2];
      assertRequiredArg(manifestPath, "trailstep providers inspect requires <path>.");
      assertNoExtraArgs(argv.slice(3), "trailstep providers inspect");
      return { action: "inspect", path: manifestPath };
    }
    if (action === "add") {
      const manifestPath = argv[2];
      assertRequiredArg(manifestPath, "trailstep providers add requires <path>.");
      const flags = parseFlags(argv.slice(3));
      return { action: "add", path: manifestPath, scope: parseOptionalScope(flags.scope) };
    }
    if (action === "list") {
      const flags = parseFlags(argv.slice(2));
      return { action: "list", scope: parseOptionalScope(flags.scope) };
    }
    if (action === "show") {
      const provider = argv[2];
      assertRequiredArg(provider, "trailstep providers show requires <provider>.");
      const flags = parseFlags(argv.slice(3));
      return { action: "show", provider, scope: parseOptionalScope(flags.scope) };
    }
    if (action === "test") {
      const provider = argv[2];
      assertRequiredArg(provider, "trailstep providers test requires <provider>.");
      const flags = parseFlags(argv.slice(3));
      return { action: "test", provider, scope: parseOptionalScope(flags.scope) };
    }
    if (action === "remove") {
      const provider = argv[2];
      assertRequiredArg(provider, "trailstep providers remove requires <provider>.");
      const flags = parseFlags(argv.slice(3));
      return { action: "remove", provider, scope: parseOptionalScope(flags.scope) };
    }

    throw new CliUsageError(
      "trailstep providers requires inspect, add, list, show, test, or remove.",
    );
  },
  async run(args: ProviderCommandArgs, context: CliCommandContext): Promise<number> {
    try {
      if (args.action === "inspect") {
        return await inspectProvider(args.path, context);
      }
      if (args.action === "add") {
        return await addProvider(args, context);
      }
      if (args.action === "list") {
        return await listProviders(args, context);
      }
      if (args.action === "show") {
        return await showProvider(args, context);
      }
      if (args.action === "test") {
        return await testProvider(args, context);
      }
      return await removeProvider(args, context);
    } catch (error) {
      if (error instanceof CliUsageError) {
        context.io.writeError(error.message);
        return 1;
      }
      throw error;
    }
  },
};

async function inspectProvider(path: string, context: CliCommandContext): Promise<number> {
  const manifest = await readLocalManifest(path, context);
  writeManifestDetails(manifest, context);
  return 0;
}

async function addProvider(
  args: Extract<ProviderCommandArgs, { readonly action: "add" }>,
  context: CliCommandContext,
): Promise<number> {
  const scope = await resolveScope(args.scope, context);
  const manifest = await readLocalManifest(args.path, context);
  const configPath = configPathForScope(scope, context);
  const config = await readRawTrailStepConfigFile(configPath);
  const providers = toMutableRecord(config.providers);
  providers[manifest.id] = {
    source: { type: "local-manifest", path: args.path },
    manifest,
  } satisfies TrailStepProviderRegistration;
  await writeRawTrailStepConfigFile(configPath, { ...config, providers });
  context.io.writeLine(`Wrote provider ${manifest.id} to ${configPath}.`);
  return 0;
}

async function listProviders(
  args: Extract<ProviderCommandArgs, { readonly action: "list" }>,
  context: CliCommandContext,
): Promise<number> {
  const scope = await resolveScope(args.scope, context);
  const config = await readRawTrailStepConfigFile(configPathForScope(scope, context));
  const providers = toMutableRecord(config.providers);
  for (const id of Object.keys(providers).sort()) {
    const rawRegistration = providers[id];
    const registration = readRegistration(rawRegistration);
    const manifest = registration?.manifest;
    const hooksPresent = providerRegistrationHasHooks(rawRegistration);
    context.io.writeLine(
      `${id}\t${manifest?.displayName ?? "(unknown)"}\t${registration?.source.type ?? "unknown"}\thooks: ${hooksPresent ? "yes" : "no"}`,
    );
  }
  return 0;
}

async function showProvider(
  args: Extract<ProviderCommandArgs, { readonly action: "show" }>,
  context: CliCommandContext,
): Promise<number> {
  const scope = await resolveScope(args.scope, context);
  const config = await readRawTrailStepConfigFile(configPathForScope(scope, context));
  const registration = readRegistration(toMutableRecord(config.providers)[args.provider]);
  if (registration === undefined) {
    throw new CliUsageError(`Provider ${args.provider} does not exist in ${scope} config.`);
  }
  writeManifestDetails(registration.manifest, context);
  context.io.writeLine(`Source: ${registration.source.type} ${registration.source.path}`);
  return 0;
}

async function testProvider(
  args: Extract<ProviderCommandArgs, { readonly action: "test" }>,
  context: CliCommandContext,
): Promise<number> {
  const scope = await resolveScope(args.scope, context);
  const config = await readRawTrailStepConfigFile(configPathForScope(scope, context));
  const rawRegistration = toMutableRecord(config.providers)[args.provider];
  const diagnostics: string[] = [];
  const registration = readRegistration(rawRegistration, diagnostics);
  let failed = false;

  if (registration === undefined) {
    context.io.writeError(
      diagnostics.length > 0
        ? `Invalid stored provider metadata for ${args.provider}:\n${diagnostics.join("\n")}`
        : `Provider ${args.provider} does not exist in ${scope} config.`,
    );
    return 1;
  }

  context.io.writeLine(`Provider: ${registration.manifest.id}`);
  context.io.writeLine("Registration: valid");

  if (registration.manifest.working.supported) {
    const command = registration.manifest.working.command;
    if (command === undefined || !(await resolveProviderBinary(command, context))) {
      context.io.writeError(`Missing binary for working.command: ${command ?? "(missing)"}`);
      failed = true;
    } else {
      context.io.writeLine(`Working binary: ${command}`);
    }
  }

  if (registration.manifest.interactive.command !== undefined) {
    const command = registration.manifest.interactive.command;
    if (!(await resolveProviderBinary(command, context))) {
      context.io.writeError(`Missing binary for interactive.command: ${command}`);
      failed = true;
    } else {
      context.io.writeLine(`Interactive binary: ${command}`);
    }
  }

  for (const variable of requiredEnvironmentVariables(registration.manifest)) {
    const value = context.env?.[variable];
    if (value === undefined || value === "") {
      context.io.writeError(`Missing required environment variable: ${variable}`);
      failed = true;
    } else {
      context.io.writeLine(`Required environment variable present: ${variable}`);
    }
  }

  context.io.writeLine(
    `Hooks: ${providerRegistrationHasHooks(rawRegistration) ? "present" : "absent"}`,
  );
  context.io.writeLine("Prompt execution skipped.");
  return failed ? 1 : 0;
}

async function removeProvider(
  args: Extract<ProviderCommandArgs, { readonly action: "remove" }>,
  context: CliCommandContext,
): Promise<number> {
  const referrers = await findProviderReferrers(args.provider, context);
  if (referrers.length > 0) {
    throw new CliUsageError(
      `Cannot remove provider ${args.provider} because it is referenced by ${referrers
        .map((referrer) => `${referrer.scope}: ${referrer.path}`)
        .join(", ")}.`,
    );
  }

  const scope = await resolveScope(args.scope, context);
  const configPath = configPathForScope(scope, context);
  const config = await readRawTrailStepConfigFile(configPath);
  const providers = toMutableRecord(config.providers);
  if (!(args.provider in providers)) {
    throw new CliUsageError(`Provider ${args.provider} does not exist in ${scope} config.`);
  }
  delete providers[args.provider];
  await writeRawTrailStepConfigFile(configPath, { ...config, providers });
  context.io.writeLine(`Removed provider ${args.provider} from ${configPath}.`);
  return 0;
}

async function readLocalManifest(
  manifestPath: string,
  context: CliCommandContext,
): Promise<TrailStepProviderManifest> {
  const fullPath = resolve(context.cwd, manifestPath);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(fullPath, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CliUsageError(
        `Invalid provider manifest JSON at ${manifestPath}: ${error.message}`,
      );
    }
    throw error;
  }

  const diagnostics: string[] = [];
  const manifest = parseProviderManifest("manifest", value, diagnostics);
  if (manifest === undefined || diagnostics.length > 0) {
    throw new CliUsageError(
      `Invalid provider manifest at ${manifestPath}:\n${diagnostics.join("\n")}`,
    );
  }
  return isRecord(value) && isRecord(value.hooks) ? { ...manifest, hooks: value.hooks } : manifest;
}

function writeManifestDetails(
  manifest: TrailStepProviderManifest,
  context: CliCommandContext,
): void {
  context.io.writeLine(`Id: ${manifest.id}`);
  context.io.writeLine(`Display name: ${manifest.displayName}`);
  context.io.writeLine(`Working: ${manifest.working.supported ? "supported" : "unsupported"}`);
  context.io.writeLine(
    `Interactive: ${manifest.interactive.supported ? "supported" : "unsupported"}`,
  );
  context.io.writeLine(`Model override: ${manifest.model.supported ? "supported" : "unsupported"}`);
  context.io.writeLine(`Thinking: ${manifest.thinking.supported ? "supported" : "unsupported"}`);
}

async function resolveScope(
  scope: WorkflowRegistryScope | undefined,
  context: CliCommandContext,
): Promise<WorkflowRegistryScope> {
  if (scope !== undefined) {
    return scope;
  }
  if (context.prompts === undefined) {
    throw new CliUsageError("trailstep providers requires --scope <local|project|global>.");
  }
  const selection = await context.prompts.select("Scope", ["local", "project", "global"]);
  return parseScope(selection);
}

function parseFlags(argv: readonly string[]): Record<string, string | undefined> {
  const flags: Record<string, string | undefined> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== "--scope") {
      throw new CliUsageError(`Unknown option for trailstep providers: ${option ?? ""}`);
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new CliUsageError("Missing value for --scope.");
    }
    flags.scope = value;
    index += 1;
  }
  return flags;
}

function parseOptionalScope(value: string | undefined): WorkflowRegistryScope | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parseScope(value);
}

function parseScope(value: string): WorkflowRegistryScope {
  if (value === "local" || value === "project" || value === "global") {
    return value;
  }
  throw new CliUsageError(
    "trailstep providers requires --scope local, --scope project, or --scope global.",
  );
}

function assertRequiredArg(value: string | undefined, message: string): asserts value is string {
  if (value === undefined || value.trim().length === 0 || value.startsWith("--")) {
    throw new CliUsageError(message);
  }
}

function assertNoExtraArgs(argv: readonly string[], command: string): void {
  if (argv.length > 0) {
    throw new CliUsageError(`Unknown option for ${command}: ${argv[0] ?? ""}`);
  }
}

interface ProviderReferrer {
  readonly scope: WorkflowRegistryScope;
  readonly path: string;
}

async function findProviderReferrers(
  provider: string,
  context: CliCommandContext,
): Promise<readonly ProviderReferrer[]> {
  const referrers: ProviderReferrer[] = [];
  for (const scope of ["local", "project", "global"] as const) {
    const config = await readRawTrailStepConfigFile(configPathForScope(scope, context));
    collectProviderReferrers(config.agents, "agents", provider, scope, referrers);
    collectProviderReferrers(config.workflows, "workflows", provider, scope, referrers);
  }
  return referrers;
}

function collectProviderReferrers(
  value: unknown,
  path: string,
  provider: string,
  scope: WorkflowRegistryScope,
  referrers: ProviderReferrer[],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (isRecord(item) && item.provider === provider) {
        referrers.push({ scope, path: `${path}[${index}]` });
      }
      collectProviderReferrers(item, `${path}[${index}]`, provider, scope, referrers);
    });
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    collectProviderReferrers(child, `${path}.${key}`, provider, scope, referrers);
  }
}

function parseProviderManifest(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest | undefined {
  const parser = (
    trailstepCore as unknown as {
      readonly parseTrailStepProviderManifest?: (
        path: string,
        value: unknown,
        diagnostics: string[],
      ) => TrailStepProviderManifest | undefined;
    }
  ).parseTrailStepProviderManifest;
  if (parser !== undefined) {
    return parser(path, value, diagnostics);
  }
  return parseManifestSnapshot(path, value, diagnostics);
}

function parseManifestSnapshot(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest | undefined {
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object.`);
    return undefined;
  }
  if (value.schemaVersion !== 1) diagnostics.push(`${path}.schemaVersion must be 1.`);
  const id = parseRequiredString(`${path}.id`, value.id, diagnostics);
  const displayName = parseRequiredString(`${path}.displayName`, value.displayName, diagnostics);
  const working = parseWorking(`${path}.working`, value.working, diagnostics);
  const interactive = parseInteractive(`${path}.interactive`, value.interactive, diagnostics);
  const model = parseSupported(`${path}.model`, value.model, diagnostics);
  const thinking = parseThinking(`${path}.thinking`, value.thinking, diagnostics);
  const env = parseManifestEnvironment(`${path}.env`, value.env, diagnostics);
  if (
    value.schemaVersion !== 1 ||
    id === undefined ||
    displayName === undefined ||
    working === undefined ||
    interactive === undefined ||
    model === undefined ||
    thinking === undefined ||
    env === null
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    id,
    displayName,
    working,
    interactive,
    model,
    thinking,
    ...(env === undefined ? {} : { env }),
  };
}

function parseWorking(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest["working"] | undefined {
  if (!isRecord(value) || typeof value.supported !== "boolean") {
    diagnostics.push(`${path} must be an object with a boolean supported field.`);
    return undefined;
  }
  if (!value.supported) return { supported: false };
  const command = parseRequiredString(`${path}.command`, value.command, diagnostics);
  const args = parseOptionalStringArray(`${path}.args`, value.args, diagnostics);
  const prompt =
    isRecord(value.prompt) && value.prompt.kind === "prompt-file"
      ? { kind: "prompt-file" as const }
      : undefined;
  if (prompt === undefined) diagnostics.push(`${path}.prompt.kind must be prompt-file.`);
  const output =
    isRecord(value.output) && value.output.style === "provider-output-file"
      ? { style: "provider-output-file" as const }
      : undefined;
  if (output === undefined) diagnostics.push(`${path}.output.style must be provider-output-file.`);
  if (command === undefined || args === null || prompt === undefined || output === undefined)
    return undefined;
  return { supported: true, command, ...(args === undefined ? {} : { args }), prompt, output };
}

function parseInteractive(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest["interactive"] | undefined {
  const parsed = parseSupported(path, value, diagnostics);
  if (parsed === undefined || !isRecord(value)) return undefined;
  const command = parseOptionalNonEmptyString(`${path}.command`, value.command, diagnostics);
  if (command === null) return undefined;
  return { ...parsed, ...(command === undefined ? {} : { command }) };
}

function parseSupported(
  path: string,
  value: unknown,
  diagnostics: string[],
): { readonly supported: boolean; readonly reason?: string } | undefined {
  if (!isRecord(value) || typeof value.supported !== "boolean") {
    diagnostics.push(`${path} must be an object with a boolean supported field.`);
    return undefined;
  }
  return {
    supported: value.supported,
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  };
}

function parseManifestEnvironment(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest["env"] | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    return null;
  }
  const required = parseOptionalStringArray(`${path}.required`, value.required, diagnostics);
  const optional = parseOptionalStringArray(`${path}.optional`, value.optional, diagnostics);
  if (required === null || optional === null) return null;
  return {
    ...(required === undefined ? {} : { required }),
    ...(optional === undefined ? {} : { optional }),
  };
}

function parseThinking(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest["thinking"] | undefined {
  const parsed = parseSupported(path, value, diagnostics);
  if (parsed === undefined) return undefined;
  if (isRecord(value) && value.levels !== undefined) {
    if (
      !Array.isArray(value.levels) ||
      value.levels.some(
        (level) =>
          typeof level !== "string" || !["low", "medium", "high", "xhigh", "max"].includes(level),
      )
    ) {
      diagnostics.push(
        `${path}.levels must be an array of supported thinking levels when present.`,
      );
      return undefined;
    }
    return { supported: parsed.supported, levels: value.levels };
  }
  return parsed;
}

function parseRequiredString(
  path: string,
  value: unknown,
  diagnostics: string[],
): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    diagnostics.push(`${path} must be a non-empty string.`);
    return undefined;
  }
  return value;
}

function parseOptionalStringArray(
  path: string,
  value: unknown,
  diagnostics: string[],
): readonly string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    diagnostics.push(`${path} must be an array of strings when present.`);
    return null;
  }
  return value;
}

function readRegistration(
  value: unknown,
  diagnostics: string[] = [],
): TrailStepProviderRegistration | undefined {
  if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.manifest)) {
    diagnostics.push("registration must include source and manifest objects.");
    return undefined;
  }
  if (value.source.type !== "local-manifest" || typeof value.source.path !== "string") {
    diagnostics.push("registration.source must be a local-manifest source with a path.");
    return undefined;
  }
  const manifest = parseProviderManifest("manifest", value.manifest, diagnostics);
  if (manifest === undefined || diagnostics.length > 0) {
    return undefined;
  }
  return {
    source: { type: "local-manifest", path: value.source.path },
    manifest: withStoredManifestMetadata(manifest, value.manifest),
  };
}

function withStoredManifestMetadata(
  manifest: TrailStepProviderManifest,
  storedManifest: Record<string, unknown>,
): TrailStepProviderManifest {
  const environment = parseEnvironmentDeclarations(storedManifest.environment);
  const env = parseEnvironmentDeclarations(storedManifest.env);
  const interactiveCommand = isRecord(storedManifest.interactive)
    ? parseOptionalString(storedManifest.interactive.command)
    : undefined;
  return {
    ...manifest,
    interactive: {
      ...manifest.interactive,
      ...(interactiveCommand === undefined ? {} : { command: interactiveCommand }),
    },
    ...(environment === undefined ? {} : { environment }),
    ...(env === undefined ? {} : { env }),
  };
}

function requiredEnvironmentVariables(manifest: TrailStepProviderManifest): readonly string[] {
  return [...(manifest.environment?.required ?? []), ...(manifest.env?.required ?? [])];
}

function parseEnvironmentDeclarations(
  value: unknown,
): { readonly required?: readonly string[]; readonly optional?: readonly string[] } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const required = parseStoredStringArray(value.required);
  const optional = parseStoredStringArray(value.optional);
  if (required === undefined && optional === undefined) {
    return undefined;
  }
  return {
    ...(required === undefined ? {} : { required }),
    ...(optional === undefined ? {} : { optional }),
  };
}

function parseStoredStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return undefined;
  }
  return value;
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseOptionalNonEmptyString(
  path: string,
  value: unknown,
  diagnostics: string[],
): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    diagnostics.push(`${path} must be a non-empty string when present.`);
    return null;
  }
  return value;
}

async function resolveProviderBinary(binary: string, context: CliCommandContext): Promise<boolean> {
  if (context.providerBinaryResolver !== undefined) {
    return context.providerBinaryResolver(binary, context);
  }
  return defaultProviderBinaryResolver(binary, context);
}

async function defaultProviderBinaryResolver(
  binary: string,
  context: CliCommandContext,
): Promise<boolean> {
  const candidates =
    binary.includes("/") || binary.includes("\\")
      ? [resolve(context.cwd, binary)]
      : pathBinaryCandidates(binary, context.env?.PATH ?? process.env.PATH ?? "");
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Try the next candidate.
    }
  }
  return false;
}

function pathBinaryCandidates(binary: string, pathValue: string): readonly string[] {
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  const names =
    process.platform === "win32" && /\.[^\\/]+$/.test(binary)
      ? [binary]
      : extensions.map((extension) => `${binary}${extension.toLowerCase()}`);
  return pathValue
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .flatMap((entry) => names.map((name) => resolve(entry, name)));
}

function toMutableRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  return { ...value };
}

function providerRegistrationHasHooks(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.manifest) || !isRecord(value.manifest.hooks)) {
    return false;
  }
  return Object.keys(value.manifest.hooks).length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
