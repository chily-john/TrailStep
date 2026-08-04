import type { WorkflowAgentRole } from "../../../../contracts/agents/agent-role.types.js";
import { StepKitFailureError } from "../../../../contracts/failures/failure.js";
import type {
  ProviderAdapter,
  ProviderWorkingRunner,
} from "../../../../known-cli-providers/registry/provider-registry.types.js";
import type { WorkingAgentFiles } from "../../artifacts/resolve-step-agent-files.js";

/**
 * At most one repair attempt: a repair resumes the same CLI session, so a
 * second malformed answer in a row signals something deeper than a one-off
 * formatting slip, and repeatedly resuming risks drifting the session
 * further rather than fixing it. If the repair attempt also fails, this
 * falls through to the normal target-exhaustion path unchanged.
 */
const MAX_OUTPUT_REPAIR_ATTEMPTS = 1;

/**
 * Malformed JSON from a working-agent's final answer commonly follows a real
 * multi-turn agentic turn — file edits, test runs — that already happened
 * before the model's last message failed to parse. Retrying the whole task
 * (a fresh target, or even a fresh run of the same target) would risk
 * duplicating or conflicting with that already-completed work, so instead of
 * a blind retry, providers that can resume their own CLI session (currently
 * only `claude`, via `repairOutput`) get one bounded attempt to resume that
 * exact session and re-emit just the final answer, reformatted. Providers
 * without that capability (`error.failure.details` lacking a `sessionId`, or
 * no `repairOutput` on the adapter at all) fall straight through to today's
 * immediate-failure behavior.
 */
export async function attemptProviderOutputRepair(options: {
  readonly provider: ProviderAdapter;
  readonly error: unknown;
  readonly model?: string;
  readonly thinking?: WorkflowAgentRole["thinking"];
  readonly outputSchema: Record<string, unknown>;
  readonly captureMode?: "json" | "raw-text";
  readonly files: WorkingAgentFiles;
  readonly cwd: string;
  readonly providerWorkingRunner?: ProviderWorkingRunner;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  if (!options.provider.repairOutput) {
    return false;
  }

  const repairable = extractRepairableFailure(options.error);
  if (!repairable || MAX_OUTPUT_REPAIR_ATTEMPTS < 1) {
    return false;
  }

  try {
    await options.provider.repairOutput(
      {
        sessionId: repairable.sessionId,
        rawResultText: repairable.rawResultText ?? "",
        outputFile: options.files.outputFile,
        usageFile: options.files.usageFile,
        cwd: options.cwd,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
        outputSchema: options.outputSchema,
        captureMode: options.captureMode,
        signal: options.signal,
      },
      options.providerWorkingRunner,
    );
    return true;
  } catch {
    return false;
  }
}

function extractRepairableFailure(
  error: unknown,
): { readonly sessionId: string; readonly rawResultText?: string } | undefined {
  if (!(error instanceof StepKitFailureError)) {
    return undefined;
  }

  if (error.failure.code !== "agent_provider_output_invalid") {
    return undefined;
  }

  const details = error.failure.details;
  if (typeof details !== "object" || details === null) {
    return undefined;
  }

  const sessionId = (details as Record<string, unknown>).sessionId;
  if (typeof sessionId !== "string") {
    return undefined;
  }

  const rawResultText = (details as Record<string, unknown>).rawResultText;
  return {
    sessionId,
    ...(typeof rawResultText === "string" ? { rawResultText } : {}),
  };
}
