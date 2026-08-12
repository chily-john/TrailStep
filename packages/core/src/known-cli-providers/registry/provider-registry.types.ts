import type { WorkflowAgentThinking } from "../../contracts/agents/agent-role.types.js";
import type {
  InteractiveProcessResult,
  InteractiveProcessRunner,
} from "../../runtime/run-workflow/run-workflow.types.js";

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
  readonly captureMode?: "json" | "raw-text";
  readonly signal?: AbortSignal;
}

/** Low-level process request for a provider's stdout-capturing runner. */
export interface ProviderWorkingProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /**
   * Prompt text to write to the child's stdin and close, rather than appending
   * it to `args`. Windows' `CreateProcess` concatenates argv into a single
   * command-line string capped around 32,767 characters, so large rendered
   * prompts must use either a tiny @prompt-file argv reference or stdin.
   * Providers only set this for CLI flows that cannot use an existing prompt
   * file artifact (for example, Claude's output-repair prompt).
   */
  readonly stdin?: string;
  readonly signal?: AbortSignal;
}

export interface ProviderWorkingProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/**
 * Spawns a provider's CLI, collecting stdout for envelope parsing instead of
 * inheriting it. Runners may ignore stdin or pipe it depending on whether
 * `stdin` is set. Injectable for tests.
 */
export type ProviderWorkingRunner = (
  request: ProviderWorkingProcessRequest,
) => ProviderWorkingProcessResult | Promise<ProviderWorkingProcessResult>;

export type ProviderPromptFileReferenceStyle = "at-prefixed-argument";

export type ProviderPromptInputSpec =
  | {
      readonly kind: "prompt-file";
      readonly reference: ProviderPromptFileReferenceStyle;
    }
  | {
      readonly kind: "inline-prompt";
    };

export type ProviderOutputStyle =
  | "stdout-json-envelope"
  | "stdout-jsonl-transcript"
  | "provider-output-file";

export interface ProviderOutputParsingMetadata {
  readonly resultField?: string;
}

export interface ProviderOutputSpec {
  readonly style: ProviderOutputStyle;
  readonly parsing?: ProviderOutputParsingMetadata;
}

export type ProviderModelDiscoveryOutputParser = "pi-list-models-table";

export interface ProviderModelDiscoverySpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly outputParser: ProviderModelDiscoveryOutputParser;
}

export type ProviderModelOverrideSupport =
  | {
      readonly supported: true;
      readonly flag: string;
      readonly discovery?: ProviderModelDiscoverySpec;
    }
  | {
      readonly supported: false;
    };

export type ProviderThinkingOverrideSupport =
  | {
      readonly supported: true;
      readonly flag: string;
      readonly levels: readonly WorkflowAgentThinking[];
    }
  | {
      readonly supported: false;
      readonly levels?: readonly [];
    };

export interface ProviderWorkingRepairInvocationSpec {
  readonly supported: boolean;
  readonly resumeFlag?: string;
  readonly promptDelivery?: "stdin" | "prompt-file";
}

export interface ProviderWorkingInvocationSpec {
  readonly command: string;
  readonly prompt: ProviderPromptInputSpec;
  readonly baseArgs: readonly string[];
  readonly output: ProviderOutputSpec;
  readonly repair?: ProviderWorkingRepairInvocationSpec;
}

export type ProviderInteractiveInvocationSpec =
  | {
      readonly supported: true;
      readonly command: string;
      readonly requiresSystemPromptFile?: boolean;
      readonly systemPromptFileFlag?: string;
      readonly modelFlag?: string;
      readonly permissionBypassFlag?: string;
    }
  | {
      readonly supported: false;
      readonly reason?: string;
    };

export interface ProviderSpec {
  readonly id: string;
  readonly displayName: string;
  readonly model: ProviderModelOverrideSupport;
  readonly thinking: ProviderThinkingOverrideSupport;
  readonly working: ProviderWorkingInvocationSpec;
  readonly interactive: ProviderInteractiveInvocationSpec;
}

/** Request shape for a built-in provider's interactive (human-in-the-loop) invocation. */
export interface ProviderInteractiveRequest {
  readonly prompt: string;
  /**
   * Path to a file containing the full interactive prompt, for adapters that
   * support a system-prompt-file flag instead of a positional prompt argument.
   */
  readonly systemPromptFile?: string;
  readonly cwd: string;
  readonly model?: string;
  /** Undefined means bypass (per-tool confirmation is skipped by default). */
  readonly permissionMode?: "bypass" | "prompt";
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/**
 * Request shape for a one-shot repair of a working-agent turn whose final
 * answer failed JSON extraction. `sessionId` and `rawResultText` are the
 * malformed turn's own session id and (best-effort) raw final-answer text, as
 * surfaced by the failed `runWorking` call.
 */
export interface ProviderWorkingRepairRequest {
  readonly sessionId: string;
  readonly rawResultText: string;
  readonly outputFile: string;
  readonly usageFile?: string;
  readonly cwd: string;
  readonly model?: string;
  readonly thinking?: WorkflowAgentThinking;
  readonly outputSchema: Record<string, unknown>;
  readonly captureMode?: "json" | "raw-text";
  readonly signal?: AbortSignal;
}

/**
 * A built-in, core-owned known-CLI adapter for a single named vendor.
 * This is CLI print-mode invocation knowledge, not an in-process vendor SDK
 * adapter: adapters spawn a real CLI process and never import a vendor SDK
 * library.
 */
export interface ProviderAdapter {
  readonly id: string;
  readonly spec: ProviderSpec;
  /** Non-interactive invocation: writes `request.outputFile` itself before resolving. */
  runWorking(request: ProviderWorkingRequest, runner?: ProviderWorkingRunner): Promise<void>;
  /**
   * Optional one-shot repair of a malformed final answer, for providers whose
   * CLI can resume a prior session (currently only `claude`). Malformed JSON
   * after a real agentic turn should not trigger a full re-run of the task —
   * the agent may have already made real file edits, and redoing the task
   * from scratch risks duplicating or conflicting with them — so this asks
   * the *same* session to reformat its last answer only. Providers without a
   * resumable session omit this entirely and keep today's immediate-failure
   * behavior.
   */
  repairOutput?(
    request: ProviderWorkingRepairRequest,
    runner?: ProviderWorkingRunner,
  ): Promise<void>;
  /** Interactive invocation: inherited stdio, a human is present. */
  runInteractive(
    request: ProviderInteractiveRequest,
    runner?: InteractiveProcessRunner,
  ): Promise<InteractiveProcessResult>;
}
