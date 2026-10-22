import type { ResolvedAgentExecutionConfig } from "../contracts/agents/agent-execution.types.js";
import type {
  ProviderHygieneArgs,
  TrailStepProviderHygieneCapability,
  TrailStepProviderHygieneManifest,
} from "./provider-manifest.types.js";

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
