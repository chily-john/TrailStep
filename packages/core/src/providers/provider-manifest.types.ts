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
