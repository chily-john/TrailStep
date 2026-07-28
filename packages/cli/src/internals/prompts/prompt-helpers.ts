import { type CliCommandContext, CliUsageError } from "../command.types.js";

export async function promptText(
  label: string,
  value: string | undefined,
  prompts: CliCommandContext["prompts"],
  usageHint: string,
): Promise<string> {
  if (value !== undefined) {
    return value;
  }
  if (prompts === undefined) {
    throw new CliUsageError(usageHint);
  }
  const answer = (await prompts.text(label)).trim();
  if (!answer) {
    throw new CliUsageError(`${label} is required.`);
  }
  return answer;
}

export async function promptSelect<T extends string>(
  label: string,
  choices: readonly T[],
  prompts: CliCommandContext["prompts"],
  usageHint: string,
): Promise<T> {
  if (prompts === undefined) {
    throw new CliUsageError(usageHint);
  }
  const selected = await prompts.select(label, choices);
  if (!choices.includes(selected as T)) {
    throw new CliUsageError(`Invalid selection for ${label}: ${selected}`);
  }
  return selected as T;
}

export async function promptMultiSelect<T extends string>(
  label: string,
  choices: readonly T[],
  prompts: CliCommandContext["prompts"],
  usageHint: string,
): Promise<readonly T[]> {
  if (prompts?.multiSelect === undefined) {
    throw new CliUsageError(usageHint);
  }
  const selected = await prompts.multiSelect(label, choices);
  for (const selection of selected) {
    if (!choices.includes(selection as T)) {
      throw new CliUsageError(`Invalid selection for ${label}: ${selection}`);
    }
  }
  return selected as readonly T[];
}

export async function promptYesNo(
  label: string,
  prompts: CliCommandContext["prompts"],
  usageHint: string,
): Promise<boolean> {
  return (await promptSelect(label, ["yes", "no"], prompts, usageHint)) === "yes";
}
