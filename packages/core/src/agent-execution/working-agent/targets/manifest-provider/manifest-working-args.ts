import type { WorkflowAgentThinking } from "../../../../contracts/agents/agent-role.types.js";
import type { TrailStepProviderManifest } from "../../../../providers/provider-manifest.js";

export function defaultManifestWorkingArgs(options: {
  readonly manifest: TrailStepProviderManifest;
  readonly promptFile: string;
  readonly outputFile: string;
  readonly model?: string;
  readonly thinking?: WorkflowAgentThinking;
}): readonly string[] {
  const args: string[] = [];

  if (options.model !== undefined && options.manifest.model.supported) {
    args.push(...renderFlaggedValue(options.manifest.model.flag, options.model));
  }

  if (options.thinking !== undefined && options.manifest.thinking.supported) {
    args.push(...renderFlaggedValue(options.manifest.thinking.flag, options.thinking));
  }

  if (options.manifest.working.prompt?.reference === "at-prefixed-argument") {
    args.push(`@${options.promptFile}`);
  } else {
    args.push("--prompt-file", options.promptFile);
  }

  if (options.manifest.working.output?.style === "provider-output-file") {
    args.push("--output-file", options.outputFile);
  }

  return args;
}

function renderFlaggedValue(flag: string | undefined, value: string): readonly string[] {
  if (flag === undefined) {
    return [];
  }

  const parts = flag.split(/\s+/u).filter(Boolean);
  if (parts.length === 0) {
    return [];
  }

  if (parts.length === 2) {
    return [parts[0] as string, `${parts[1] as string}=${value}`];
  }

  return [...parts, value];
}

export function optionalNonEmptyString(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}
