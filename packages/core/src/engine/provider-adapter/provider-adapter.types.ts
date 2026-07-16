import type { WorkflowAgentThinking } from "../../shared/agent-role.types.js";
import type { InteractiveProcessResult, InteractiveProcessRunner } from "../engine.types.js";

/**
 * Request shape for a built-in provider's non-interactive ("working") invocation.
 * The runtime has already written `promptFile`; the adapter is responsible for
 * invoking its vendor CLI and writing a single JSON object to `outputFile`.
 */
export interface ProviderWorkingRequest {
  readonly promptFile: string;
  readonly outputFile: string;
  readonly usageFile?: string;
  readonly cwd: string;
  readonly model?: string;
  readonly thinking?: WorkflowAgentThinking;
}

/** Low-level process request for a provider's stdout-capturing runner. */
export interface ProviderWorkingProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface ProviderWorkingProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/**
 * Spawns a provider's CLI with stdio `["ignore", "pipe", "inherit"]`, collecting
 * stdout for envelope parsing instead of inheriting it. Injectable for tests.
 */
export type ProviderWorkingRunner = (
  request: ProviderWorkingProcessRequest,
) => ProviderWorkingProcessResult | Promise<ProviderWorkingProcessResult>;

/** Request shape for a built-in provider's interactive (human-in-the-loop) invocation. */
export interface ProviderInteractiveRequest {
  readonly prompt: string;
  readonly cwd: string;
  readonly model?: string;
}

/**
 * A built-in, core-owned known-CLI adapter for a single named vendor.
 * This is CLI print-mode invocation knowledge, not an in-process vendor SDK
 * adapter: adapters spawn a real CLI process and never import a vendor SDK
 * library.
 */
export interface ProviderAdapter {
  readonly id: string;
  /** Non-interactive invocation: writes `request.outputFile` itself before resolving. */
  runWorking(request: ProviderWorkingRequest, runner?: ProviderWorkingRunner): Promise<void>;
  /** Interactive invocation: inherited stdio, a human is present. */
  runInteractive(
    request: ProviderInteractiveRequest,
    runner?: InteractiveProcessRunner,
  ): Promise<InteractiveProcessResult>;
}
