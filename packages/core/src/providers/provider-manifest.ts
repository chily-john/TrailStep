import {
  isRecord,
  parseOptionalStringArray,
  parseOptionalStringRecord,
  throwValidationFailure,
} from "../agent-targeting/parse-trailstep-config/parse-utils.js";
import type { ResolvedAgentExecutionConfig } from "../contracts/agents/agent-execution.types.js";
import type { WorkflowAgentThinking } from "../contracts/agents/agent-role.types.js";

export interface TrailStepProviderRegistration {
  readonly source: TrailStepProviderSource;
  readonly manifest: TrailStepProviderManifest;
}

export type TrailStepProviderSource =
  | { readonly type: "local-manifest"; readonly path: string }
  | { readonly type: "legacy-custom-provider" }
  | {
      readonly type: "npm" | "github" | "local-package";
      readonly packageName: string;
      readonly spec: string;
      readonly resolvedVersion?: string;
    };

/**
 * ESM package contract for provider packages: export `trailstepProvider` from
 * the package root. Keep hook functions outside `manifest` so the manifest is
 * serializable and safe to persist.
 */
export interface TrailStepProviderPackageDefinition {
  readonly manifest: TrailStepProviderManifest;
  readonly hooks?: Record<string, unknown>;
}

export interface TrailStepProviderManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly displayName: string;
  readonly working: TrailStepProviderWorkingManifest;
  readonly interactive: TrailStepProviderInteractiveManifest;
  readonly model: TrailStepProviderModelManifest;
  readonly thinking: TrailStepProviderThinkingManifest;
  readonly env?: TrailStepProviderEnvironmentManifest;
  /**
   * Optional capability mapping describing which CLI flags this provider
   * uses to render a step's lean execution context ({{tools}}, {{skills}},
   * {{mcpArgs}}, {{extensionsArgs}}, {{contextFilesArgs}} argv templates).
   * Unknown keys are ignored for forward/back-compat.
   */
  readonly hygiene?: TrailStepProviderHygieneManifest;
  readonly hooks?: Record<string, unknown>;
}

export type TrailStepProviderPromptFileReferenceStyle = "at-prefixed-argument";

export interface TrailStepProviderPromptManifest {
  readonly kind: "prompt-file";
  readonly reference?: TrailStepProviderPromptFileReferenceStyle;
}

export type TrailStepProviderOutputStyle =
  | "provider-output-file"
  | "stdout-json-envelope"
  | "stdout-jsonl-transcript";

export interface TrailStepProviderOutputParsingManifest {
  readonly resultField?: string;
}

export interface TrailStepProviderOutputManifest {
  readonly style: TrailStepProviderOutputStyle;
  readonly parsing?: TrailStepProviderOutputParsingManifest;
}

export interface TrailStepProviderWorkingManifest {
  readonly supported: boolean;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly prompt?: TrailStepProviderPromptManifest;
  readonly output?: TrailStepProviderOutputManifest;
  readonly followUp?: TrailStepProviderFollowUpManifest;
}

export interface TrailStepProviderFollowUpManifest {
  readonly supported: boolean;
  readonly reason?: string;
  readonly sessionIdFlag?: string;
  readonly resumeArgs?: readonly string[];
}

export interface TrailStepProviderInteractiveManifest {
  readonly supported: boolean;
  readonly reason?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly requiresSystemPromptFile?: boolean;
  readonly systemPromptFileFlag?: string;
  readonly modelFlag?: string;
  readonly permissionBypassFlag?: string;
}

export interface TrailStepProviderEnvironmentManifest {
  readonly required?: readonly string[];
  readonly optional?: readonly string[];
}

export interface TrailStepProviderModelDiscoveryManifest {
  readonly command: string;
  readonly args: readonly string[];
  readonly outputParser: string;
}

export interface TrailStepProviderModelManifest {
  readonly supported: boolean;
  readonly reason?: string;
  readonly flag?: string;
  readonly discovery?: TrailStepProviderModelDiscoveryManifest;
}

export interface TrailStepProviderThinkingManifest {
  readonly supported: boolean;
  readonly reason?: string;
  readonly flag?: string;
  readonly levels?: readonly WorkflowAgentThinking[];
}

/**
 * One hygiene capability entry: how a provider CLI expresses the restriction
 * for one execution dimension.
 *
 * Two spellings are accepted so manifests written from either card stay
 * valid — unknown keys are ignored for back-compat:
 * - Provider-package style: `{ supported, flag, reason }` (`supported: false`
 *   requires `reason` and renders nothing).
 * - Disable-flag style: `{ disableFlag }` (equivalent to `{ flag }`).
 *
 * `flag`/`disableFlag` is the restriction flag: for `tools` it is a value
 * flag (`--tools <list>`), for every other dimension it is a suppression
 * flag (`--no-skills`). Multi-word flags split into multiple argv entries
 * (`-c mcp_servers={}` -> `-c`, `mcp_servers={}`). `enableFlag` is an
 * optional per-item flag (e.g. pi `--skill <path>`) used when execution
 * requests specific values instead of the restriction.
 */
export interface TrailStepProviderHygieneCapability {
  /** `false` means the CLI cannot express this restriction; `reason` required. */
  readonly supported?: boolean;
  /** Restriction flag (see interface docs). */
  readonly flag?: string;
  /** Disable-flag spelling of {@link flag}. */
  readonly disableFlag?: string;
  /** Optional per-item enable flag for non-restricted requests. */
  readonly enableFlag?: string;
  /** Why no flag exists; required when `supported` is false. Never rendered. */
  readonly reason?: string;
}

/**
 * Optional capability mapping describing which CLI flags this provider
 * uses to render a step's lean execution context ({{tools}}, {{skills}},
 * {{mcpArgs}}, {{extensionsArgs}}, {{contextFilesArgs}} argv templates).
 * Unknown keys are ignored for forward/back-compat; `contextSuppression`
 * is an accepted alias of `contextFiles`.
 */
export interface TrailStepProviderHygieneManifest {
  readonly tools?: TrailStepProviderHygieneCapability;
  readonly skills?: TrailStepProviderHygieneCapability;
  readonly mcp?: TrailStepProviderHygieneCapability;
  readonly extensions?: TrailStepProviderHygieneCapability;
  readonly contextFiles?: TrailStepProviderHygieneCapability;
  /** Provider-package spelling of `contextFiles`; accepted as an alias. */
  readonly contextSuppression?: TrailStepProviderHygieneCapability;
}

export interface ProviderHygieneArgs {
  readonly tools?: readonly string[];
  readonly skills?: readonly string[];
  readonly mcpArgs?: readonly string[];
  readonly extensionsArgs?: readonly string[];
  readonly contextFilesArgs?: readonly string[];
}

/**
 * Maps a resolved execution block through a provider's hygiene capability
 * mapping into argv fragments for the `{{tools}}`, `{{skills}}`,
 * `{{mcpArgs}}`, `{{extensionsArgs}}`, and `{{contextFilesArgs}}` template
 * variables. Returns no args when either side is absent, which keeps
 * omitted `execution` (or a hygiene-less manifest) byte-for-byte identical
 * to previous provider invocations.
 *
 * Rules: an explicit tools allowlist renders `flag value`; `'*'` renders
 * nothing (already the provider default). Skills and extensions render
 * their suppression flag (`disableFlag ?? flag`) when the list is empty
 * and per-item `enableFlag`/`flag` entries when non-empty — the enable
 * spelling is only trusted when the capability also declares a distinct
 * `disableFlag` (otherwise a lone `flag` is the suppression flag); nothing
 * is rendered when the capability cannot express the request. `mcp: false`
 * and any non-`true` contextFiles value render their restriction flag.
 * Capabilities with `supported: false` render nothing; their `reason`
 * documents the gap.
 */
export function buildProviderHygieneArgs(options: {
  readonly execution?: ResolvedAgentExecutionConfig;
  readonly hygiene?: TrailStepProviderHygieneManifest;
}): ProviderHygieneArgs {
  const { execution, hygiene } = options;
  if (execution === undefined || hygiene === undefined) {
    return {};
  }

  const args: {
    tools?: readonly string[];
    skills?: readonly string[];
    mcpArgs?: readonly string[];
    extensionsArgs?: readonly string[];
    contextFilesArgs?: readonly string[];
  } = {};

  const toolsFlag = restrictionFlag(hygiene.tools);
  if (Array.isArray(execution.tools) && toolsFlag !== undefined) {
    args.tools = [...splitFlag(toolsFlag), execution.tools.join(",")];
  }

  const skillsArgs = listCapabilityArgs(hygiene.skills, execution.skills);
  if (skillsArgs !== undefined) {
    args.skills = skillsArgs;
  }

  const mcpFlag = restrictionFlag(hygiene.mcp);
  if (!execution.mcp && mcpFlag !== undefined) {
    args.mcpArgs = splitFlag(mcpFlag);
  }

  const extensionsArgs = listCapabilityArgs(hygiene.extensions, execution.extensions);
  if (extensionsArgs !== undefined) {
    args.extensionsArgs = extensionsArgs;
  }

  const contextFilesCapability = hygiene.contextFiles ?? hygiene.contextSuppression;
  const contextFilesFlag = restrictionFlag(contextFilesCapability);
  // No provider CLI exposes a project-only flag (pi --no-context-files
  // disables all discovery), so both 'project-only' and false render the
  // suppression flag. Conservative: lean delegates stay minimal.
  if (execution.contextFiles !== true && contextFilesFlag !== undefined) {
    args.contextFilesArgs = splitFlag(contextFilesFlag);
  }

  return args;
}

function restrictionFlag(
  capability: TrailStepProviderHygieneCapability | undefined,
): string | undefined {
  if (capability === undefined || capability.supported === false) {
    return undefined;
  }
  return capability.disableFlag ?? capability.flag;
}

function listCapabilityArgs(
  capability: TrailStepProviderHygieneCapability | undefined,
  items: readonly string[],
): string[] | undefined {
  if (capability === undefined || capability.supported === false) {
    return undefined;
  }

  if (items.length === 0) {
    const flag = restrictionFlag(capability);
    return flag === undefined ? undefined : splitFlag(flag);
  }

  // A distinct `disableFlag` disambiguates `flag` as the per-item enable
  // flag (card convention: `{ flag: "--skill", disableFlag: "--no-skills" }`).
  // A lone `flag` is the suppression flag (provider-package convention) and
  // cannot express specific items — render nothing rather than suppress them.
  const enableFlag =
    capability.enableFlag ?? (capability.disableFlag === undefined ? undefined : capability.flag);
  if (enableFlag === undefined) {
    return undefined;
  }
  return items.flatMap((item) => [...splitFlag(enableFlag), item]);
}

function splitFlag(flag: string): string[] {
  return flag.split(/\s+/u).filter(Boolean);
}

const THINKING_LEVELS = new Set<WorkflowAgentThinking>(["low", "medium", "high", "xhigh", "max"]);

export function parseTrailStepProviderManifest(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest | undefined {
  return parseManifest(path, value, diagnostics);
}

export function parseTrailStepProviderRegistrations(
  path: string,
  value: unknown,
  diagnostics: string[],
): Record<string, TrailStepProviderRegistration> {
  const start = diagnostics.length;
  const providers: Record<string, TrailStepProviderRegistration> = {};

  if (value === undefined) {
    return providers;
  }

  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    throwIfNewDiagnostics(diagnostics, start);
    return providers;
  }

  for (const [name, registration] of Object.entries(value)) {
    const parsed = parseProviderRegistration(`${path}.${name}`, registration, diagnostics);
    if (parsed !== undefined) {
      providers[name] = parsed;
    }
  }

  throwIfNewDiagnostics(diagnostics, start);
  return providers;
}

function parseProviderRegistration(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderRegistration | undefined {
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object.`);
    return undefined;
  }

  const source = parseSource(`${path}.source`, value.source, diagnostics);
  const manifest =
    source?.type === "legacy-custom-provider"
      ? parseLegacyCustomProviderManifest(`${path}.manifest`, value.manifest, diagnostics)
      : parseManifest(`${path}.manifest`, value.manifest, diagnostics);

  if (source === undefined || manifest === undefined) {
    return undefined;
  }

  return { source, manifest };
}

function parseSource(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderRegistration["source"] | undefined {
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object.`);
    return undefined;
  }

  if (value.type === "local-manifest") {
    if (typeof value.path !== "string" || value.path.length === 0) {
      diagnostics.push(`${path}.path must be a non-empty string.`);
      return undefined;
    }
    return { type: "local-manifest", path: value.path };
  }

  if (value.type === "legacy-custom-provider") {
    return { type: "legacy-custom-provider" };
  }

  if (value.type === "npm" || value.type === "github" || value.type === "local-package") {
    if (typeof value.packageName !== "string" || value.packageName.length === 0) {
      diagnostics.push(`${path}.packageName must be a non-empty string.`);
    }
    if (typeof value.spec !== "string" || value.spec.length === 0) {
      diagnostics.push(`${path}.spec must be a non-empty string.`);
    }
    if (
      typeof value.packageName !== "string" ||
      value.packageName.length === 0 ||
      typeof value.spec !== "string" ||
      value.spec.length === 0
    ) {
      return undefined;
    }
    return {
      type: value.type,
      packageName: value.packageName,
      spec: value.spec,
      ...(typeof value.resolvedVersion === "string" && value.resolvedVersion.length > 0
        ? { resolvedVersion: value.resolvedVersion }
        : {}),
    };
  }

  diagnostics.push(
    `${path}.type must be local-manifest, legacy-custom-provider, npm, github, or local-package.`,
  );
  return undefined;
}

function parseLegacyCustomProviderManifest(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest | undefined {
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object.`);
    return undefined;
  }

  if (value.schemaVersion !== 1) {
    diagnostics.push(`${path}.schemaVersion must be 1.`);
  }
  const id = parseRequiredString(`${path}.id`, value.id, diagnostics);
  const displayName = parseRequiredString(`${path}.displayName`, value.displayName, diagnostics);
  const working = parseWorking(`${path}.working`, value.working, diagnostics);
  const interactive = parseLegacyInteractive(`${path}.interactive`, value.interactive, diagnostics);
  const model = parseLegacyModel(`${path}.model`, value.model, diagnostics);
  const thinking = parseLegacyThinking(`${path}.thinking`, value.thinking, diagnostics);
  const env = parseOptionalStringRecord(`${path}.env`, value.env, diagnostics);

  if (
    value.schemaVersion !== 1 ||
    id === undefined ||
    displayName === undefined ||
    working === undefined ||
    interactive === undefined ||
    model === undefined ||
    thinking === undefined
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
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    ...(env === undefined ? {} : { env }),
  } as TrailStepProviderManifest;
}

function parseManifest(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest | undefined {
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object.`);
    return undefined;
  }

  if (value.schemaVersion !== 1) {
    diagnostics.push(`${path}.schemaVersion must be 1.`);
  }
  const id = parseRequiredString(`${path}.id`, value.id, diagnostics);
  const displayName = parseRequiredString(`${path}.displayName`, value.displayName, diagnostics);
  const working = parseWorking(`${path}.working`, value.working, diagnostics);
  const interactive = parseInteractive(`${path}.interactive`, value.interactive, diagnostics);
  const model = parseModel(`${path}.model`, value.model, diagnostics);
  const thinking = parseThinking(`${path}.thinking`, value.thinking, diagnostics);
  const env = parseEnvironment(`${path}.env`, value.env, diagnostics);
  const hygiene = parseHygiene(`${path}.hygiene`, value.hygiene, diagnostics);

  if (
    value.schemaVersion !== 1 ||
    id === undefined ||
    displayName === undefined ||
    working === undefined ||
    interactive === undefined ||
    model === undefined ||
    thinking === undefined ||
    env === null ||
    hygiene === null
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
    ...(hygiene === undefined ? {} : { hygiene }),
    ...(isRecord(value.hooks) ? { hooks: value.hooks } : {}),
  };
}

function parseWorking(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderWorkingManifest | undefined {
  if (!isRecord(value) || typeof value.supported !== "boolean") {
    diagnostics.push(`${path} must be an object with a boolean supported field.`);
    return undefined;
  }

  if (!value.supported) {
    return { supported: false };
  }

  const command = parseRequiredString(`${path}.command`, value.command, diagnostics);
  const args = parseOptionalStringArray(`${path}.args`, value.args, diagnostics);
  const prompt = parsePrompt(`${path}.prompt`, value.prompt, diagnostics);
  const output = parseOutput(`${path}.output`, value.output, diagnostics);
  const followUp = parseFollowUp(`${path}.followUp`, value.followUp, diagnostics);

  if (command === undefined || prompt === undefined || output === undefined || followUp === null) {
    return undefined;
  }

  return {
    supported: true,
    command,
    ...(args === undefined ? {} : { args }),
    prompt,
    output,
    ...(followUp === undefined ? {} : { followUp }),
  };
}

function parseFollowUp(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderFollowUpManifest | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || typeof value.supported !== "boolean") {
    diagnostics.push(`${path} must be an object with a boolean supported field.`);
    return null;
  }
  if (!value.supported) {
    return {
      supported: false,
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    };
  }
  const sessionIdFlag = parseOptionalNonEmptyString(
    `${path}.sessionIdFlag`,
    value.sessionIdFlag,
    diagnostics,
  );
  if (sessionIdFlag === null) {
    return null;
  }
  let resumeArgs: readonly string[] | undefined;
  if (value.resumeArgs !== undefined) {
    if (
      !Array.isArray(value.resumeArgs) ||
      value.resumeArgs.some((item) => typeof item !== "string")
    ) {
      diagnostics.push(`${path}.resumeArgs must be an array of strings when present.`);
      return null;
    }
    resumeArgs = value.resumeArgs;
  }
  return {
    supported: true,
    ...(sessionIdFlag === undefined ? {} : { sessionIdFlag }),
    ...(resumeArgs === undefined ? {} : { resumeArgs }),
  };
}

function parseLegacyInteractive(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest["interactive"] | undefined {
  const parsed = parseSupportedObject(path, value, diagnostics);
  if (parsed === undefined || !isRecord(value)) {
    return undefined;
  }
  const command = parseOptionalNonEmptyString(`${path}.command`, value.command, diagnostics);
  const args = parseOptionalStringArray(`${path}.args`, value.args, diagnostics);
  if (command === null) {
    return undefined;
  }
  return {
    ...parsed,
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args }),
  } as TrailStepProviderManifest["interactive"];
}

function parseInteractive(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderInteractiveManifest | undefined {
  const parsed = parseSupportedObject(path, value, diagnostics);
  if (parsed === undefined || !isRecord(value)) {
    return undefined;
  }
  const command = parseOptionalNonEmptyString(`${path}.command`, value.command, diagnostics);
  const args = parseOptionalStringArray(`${path}.args`, value.args, diagnostics);
  const systemPromptFileFlag = parseOptionalNonEmptyString(
    `${path}.systemPromptFileFlag`,
    value.systemPromptFileFlag,
    diagnostics,
  );
  const modelFlag = parseOptionalNonEmptyString(`${path}.modelFlag`, value.modelFlag, diagnostics);
  const permissionBypassFlag = parseOptionalNonEmptyString(
    `${path}.permissionBypassFlag`,
    value.permissionBypassFlag,
    diagnostics,
  );
  if (
    command === null ||
    systemPromptFileFlag === null ||
    modelFlag === null ||
    permissionBypassFlag === null
  ) {
    return undefined;
  }
  return {
    ...parsed,
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args }),
    ...(typeof value.requiresSystemPromptFile === "boolean"
      ? { requiresSystemPromptFile: value.requiresSystemPromptFile }
      : {}),
    ...(systemPromptFileFlag === undefined ? {} : { systemPromptFileFlag }),
    ...(modelFlag === undefined ? {} : { modelFlag }),
    ...(permissionBypassFlag === undefined ? {} : { permissionBypassFlag }),
  };
}

function parseSupportedObject(
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

function parseEnvironment(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderEnvironmentManifest | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    return null;
  }
  const start = diagnostics.length;
  const required = parseOptionalStringArray(`${path}.required`, value.required, diagnostics);
  const optional = parseOptionalStringArray(`${path}.optional`, value.optional, diagnostics);
  if (diagnostics.length > start) {
    return null;
  }
  return {
    ...(required === undefined ? {} : { required }),
    ...(optional === undefined ? {} : { optional }),
  };
}

function parseHygiene(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderHygieneManifest | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    return null;
  }

  // Unknown hygiene keys are intentionally ignored so newer provider
  // packages stay loadable by older TrailStep versions (back-compat).
  const tools = parseHygieneCapability(`${path}.tools`, value.tools, diagnostics);
  const skills = parseHygieneCapability(`${path}.skills`, value.skills, diagnostics);
  const mcp = parseHygieneCapability(`${path}.mcp`, value.mcp, diagnostics);
  const extensions = parseHygieneCapability(`${path}.extensions`, value.extensions, diagnostics);
  // `contextSuppression` is the provider-package spelling of `contextFiles`.
  const contextFiles =
    value.contextFiles === undefined
      ? parseHygieneCapability(`${path}.contextSuppression`, value.contextSuppression, diagnostics)
      : parseHygieneCapability(`${path}.contextFiles`, value.contextFiles, diagnostics);

  if (
    tools === null ||
    skills === null ||
    mcp === null ||
    extensions === null ||
    contextFiles === null
  ) {
    return null;
  }

  return {
    ...(tools === undefined ? {} : { tools }),
    ...(skills === undefined ? {} : { skills }),
    ...(mcp === undefined ? {} : { mcp }),
    ...(extensions === undefined ? {} : { extensions }),
    ...(contextFiles === undefined ? {} : { contextFiles }),
  };
}

function parseHygieneCapability(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderHygieneCapability | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    return null;
  }

  const start = diagnostics.length;
  let supported = true;
  if (value.supported !== undefined) {
    if (typeof value.supported !== "boolean") {
      diagnostics.push(`${path}.supported must be a boolean when present.`);
    } else {
      supported = value.supported;
    }
  }

  const flag = parseOptionalNonEmptyString(`${path}.flag`, value.flag, diagnostics);
  const disableFlag = parseOptionalNonEmptyString(
    `${path}.disableFlag`,
    value.disableFlag,
    diagnostics,
  );
  const enableFlag = parseOptionalNonEmptyString(
    `${path}.enableFlag`,
    value.enableFlag,
    diagnostics,
  );
  const reason = parseOptionalNonEmptyString(`${path}.reason`, value.reason, diagnostics);

  if (
    diagnostics.length > start ||
    flag === null ||
    disableFlag === null ||
    enableFlag === null ||
    reason === null
  ) {
    return null;
  }

  let invalid = false;
  if (!supported) {
    if (reason === undefined) {
      diagnostics.push(`${path} must declare reason when supported is false.`);
      invalid = true;
    }
  } else if (flag === undefined && disableFlag === undefined) {
    diagnostics.push(`${path} must declare flag or disableFlag when present.`);
    invalid = true;
  }

  if (invalid) {
    return null;
  }

  return {
    ...(supported ? {} : { supported }),
    ...(flag === undefined ? {} : { flag }),
    ...(disableFlag === undefined ? {} : { disableFlag }),
    ...(enableFlag === undefined ? {} : { enableFlag }),
    ...(reason === undefined ? {} : { reason }),
  };
}

function parseLegacyModel(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest["model"] | undefined {
  const parsed = parseSupportedObject(path, value, diagnostics);
  if (parsed === undefined || !isRecord(value)) {
    return undefined;
  }
  const flag = parseOptionalNonEmptyString(`${path}.flag`, value.flag, diagnostics);
  if (flag === null) {
    return undefined;
  }
  return {
    ...parsed,
    ...(flag === undefined ? {} : { flag }),
  } as TrailStepProviderManifest["model"];
}

function parseLegacyThinking(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest["thinking"] | undefined {
  if (!isRecord(value) || typeof value.supported !== "boolean") {
    diagnostics.push(`${path} must be an object with a boolean supported field.`);
    return undefined;
  }

  const flag = parseOptionalNonEmptyString(`${path}.flag`, value.flag, diagnostics);
  if (flag === null) {
    return undefined;
  }

  if (value.levels !== undefined) {
    if (
      !Array.isArray(value.levels) ||
      value.levels.some(
        (level) =>
          typeof level !== "string" || !THINKING_LEVELS.has(level as WorkflowAgentThinking),
      )
    ) {
      diagnostics.push(
        `${path}.levels must be an array of supported thinking levels when present.`,
      );
      return undefined;
    }
    return {
      supported: value.supported,
      ...(flag === undefined ? {} : { flag }),
      levels: value.levels as WorkflowAgentThinking[],
    } as TrailStepProviderManifest["thinking"];
  }

  return {
    supported: value.supported,
    ...(flag === undefined ? {} : { flag }),
  } as TrailStepProviderManifest["thinking"];
}

function parseModel(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderModelManifest | undefined {
  const parsed = parseSupportedObject(path, value, diagnostics);
  if (parsed === undefined || !isRecord(value)) {
    return undefined;
  }
  const flag = parseOptionalNonEmptyString(`${path}.flag`, value.flag, diagnostics);
  const discovery = parseModelDiscovery(`${path}.discovery`, value.discovery, diagnostics);
  if (flag === null || discovery === null) {
    return undefined;
  }
  return {
    ...parsed,
    ...(flag === undefined ? {} : { flag }),
    ...(discovery === undefined ? {} : { discovery }),
  };
}

function parseModelDiscovery(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderModelDiscoveryManifest | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    return null;
  }
  const command = parseRequiredString(`${path}.command`, value.command, diagnostics);
  const args = parseRequiredStringArray(`${path}.args`, value.args, diagnostics);
  const outputParser = parseRequiredString(`${path}.outputParser`, value.outputParser, diagnostics);
  if (command === undefined || args === undefined || outputParser === undefined) {
    return null;
  }
  return { command, args, outputParser };
}

function parseThinking(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderThinkingManifest | undefined {
  const parsed = parseSupportedObject(path, value, diagnostics);
  if (parsed === undefined || !isRecord(value)) {
    return undefined;
  }

  const flag = parseOptionalNonEmptyString(`${path}.flag`, value.flag, diagnostics);
  if (flag === null) {
    return undefined;
  }

  if (value.levels !== undefined) {
    if (
      !Array.isArray(value.levels) ||
      value.levels.some(
        (level) =>
          typeof level !== "string" || !THINKING_LEVELS.has(level as WorkflowAgentThinking),
      )
    ) {
      diagnostics.push(
        `${path}.levels must be an array of supported thinking levels when present.`,
      );
      return undefined;
    }
    return {
      ...parsed,
      ...(flag === undefined ? {} : { flag }),
      levels: value.levels as WorkflowAgentThinking[],
    };
  }

  return { ...parsed, ...(flag === undefined ? {} : { flag }) };
}

function parsePrompt(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderPromptManifest | undefined {
  if (!isRecord(value) || value.kind !== "prompt-file") {
    diagnostics.push(`${path}.kind must be prompt-file.`);
    return undefined;
  }
  if (value.reference !== undefined && value.reference !== "at-prefixed-argument") {
    diagnostics.push(`${path}.reference must be at-prefixed-argument when present.`);
    return undefined;
  }
  return {
    kind: "prompt-file",
    ...(value.reference === undefined ? {} : { reference: value.reference }),
  };
}

function parseOutput(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderOutputManifest | undefined {
  if (!isRecord(value) || !isProviderOutputStyle(value.style)) {
    diagnostics.push(
      `${path}.style must be provider-output-file, stdout-json-envelope, or stdout-jsonl-transcript.`,
    );
    return undefined;
  }
  const parsing = parseOutputParsing(`${path}.parsing`, value.parsing, diagnostics);
  if (parsing === null) {
    return undefined;
  }
  return {
    style: value.style,
    ...(parsing === undefined ? {} : { parsing }),
  };
}

function parseOutputParsing(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderOutputParsingManifest | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    return null;
  }
  const resultField = parseOptionalNonEmptyString(
    `${path}.resultField`,
    value.resultField,
    diagnostics,
  );
  if (resultField === null) {
    return null;
  }
  return {
    ...(resultField === undefined ? {} : { resultField }),
  };
}

function isProviderOutputStyle(value: unknown): value is TrailStepProviderOutputStyle {
  return (
    value === "provider-output-file" ||
    value === "stdout-json-envelope" ||
    value === "stdout-jsonl-transcript"
  );
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

function parseRequiredStringArray(
  path: string,
  value: unknown,
  diagnostics: string[],
): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    diagnostics.push(`${path} must be an array of strings.`);
    return undefined;
  }
  return value;
}

function parseOptionalNonEmptyString(
  path: string,
  value: unknown,
  diagnostics: string[],
): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    diagnostics.push(`${path} must be a non-empty string when present.`);
    return null;
  }
  return value;
}

function throwIfNewDiagnostics(diagnostics: string[], start: number): void {
  if (diagnostics.length > start) {
    throwValidationFailure(diagnostics);
  }
}
