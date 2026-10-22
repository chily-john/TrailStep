import {
  hasConfiguredAgentEntries,
  runAgentSetupWizard,
} from "../../agent-config/agent-setup-wizard.js";
import type { CliCommandContext } from "../../command-framework/command.types.js";
import { CliUsageError } from "../../command-framework/command.types.js";
import {
  configPathForScope,
  readRawTrailStepConfigFile,
  writeRawTrailStepConfigFile,
} from "../../workflow-registry/workflow-registry.js";

import { buildInteractiveRows, scopeForInteractiveLabel } from "./agents-listing.js";
import { createNamedAgent, editNamedAgent } from "./agents-named-agent-flow.js";
import { PROVIDER_CHOICES } from "./agents-provider-choices.js";
import { editWorkflowRole } from "./agents-workflow-role-flow.js";

const INTERACTIVE_SCOPES = ["local", "project", "global"] as const;

export async function runInteractiveAgents(context: CliCommandContext): Promise<number> {
  if (context.prompts === undefined) {
    throw new CliUsageError("trailstep agents requires prompts for interactive mode.");
  }

  const scopeLabel = await context.prompts.select("Scope", INTERACTIVE_SCOPES);
  const scope = scopeForInteractiveLabel(scopeLabel);
  const configPath = configPathForScope(scope, context);
  const config = await readRawTrailStepConfigFile(configPath);
  if (!hasConfiguredAgentEntries(config)) {
    const nextConfig = await runAgentSetupWizard({
      config,
      agentName: "default",
      prompts: context.prompts,
      providerChoices: PROVIDER_CHOICES,
      cwd: context.cwd,
      io: context.io,
      packageCommandRunner: context.packageCommandRunner,
    });
    await writeRawTrailStepConfigFile(configPath, nextConfig);
    context.io.writeLine(`Wrote agent default to ${configPath}.`);
    return 0;
  }

  const rows = await buildInteractiveRows(scope, context);
  const selected = await context.prompts.select(`${scopeLabel} agents`, [
    ...rows.map((row) => row.label),
    "+ Create new agent",
    "Done",
  ]);
  if (selected === "Done") {
    return 0;
  }

  if (selected === "+ Create new agent") {
    await createNamedAgent(scope, context);
    return 0;
  }

  const row = rows.find((candidate) => candidate.label === selected);
  if (row?.kind === "named-agent") {
    await editNamedAgent(row, scope, context);
  } else if (row?.kind === "workflow-role") {
    await editWorkflowRole(row, scope, context);
  }
  return 0;
}
