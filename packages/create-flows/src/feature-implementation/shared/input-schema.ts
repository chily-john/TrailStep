import { jsonSchema } from "@trailstep/authoring";

export interface TakeItAwayPullRequestInput extends Record<string, unknown> {
  readonly enabled?: boolean;
  readonly base?: string;
  readonly remote?: string;
  readonly draft?: boolean;
  readonly title?: string;
  readonly body?: string;
}

export interface TakeItAwayInput extends Record<string, unknown> {
  readonly conversation: string;
  readonly autoCommit?: boolean;
  readonly pullRequest?: TakeItAwayPullRequestInput;
}

export interface TakeItAwayPullRequestOptions extends Record<string, unknown> {
  readonly enabled: boolean;
  readonly base: string;
  readonly remote: string;
  readonly draft: boolean;
  readonly title?: string;
  readonly body?: string;
}

export interface TakeItAwayWorkflowOptions extends Record<string, unknown> {
  readonly autoCommit: boolean;
  readonly pullRequest: TakeItAwayPullRequestOptions;
}

export const takeItAwayInput = jsonSchema<TakeItAwayInput>({
  type: "object",
  properties: {
    conversation: { type: "string" },
    autoCommit: { type: "boolean" },
    pullRequest: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        base: { type: "string" },
        remote: { type: "string" },
        draft: { type: "boolean" },
        title: { type: "string" },
        body: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  required: ["conversation"],
  additionalProperties: false,
});

export function defaultTakeItAwayWorkflowOptions(): TakeItAwayWorkflowOptions {
  return {
    autoCommit: true,
    pullRequest: {
      enabled: true,
      base: "main",
      remote: "origin",
      draft: false,
    },
  };
}

export function normalizeTakeItAwayWorkflowOptions(
  input: TakeItAwayInput,
): TakeItAwayWorkflowOptions {
  const defaults = defaultTakeItAwayWorkflowOptions();
  const title = nonEmptyOptional(input.pullRequest?.title);
  const body = nonEmptyOptional(input.pullRequest?.body);
  return {
    autoCommit: input.autoCommit ?? defaults.autoCommit,
    pullRequest: {
      enabled: input.pullRequest?.enabled ?? defaults.pullRequest.enabled,
      base: nonEmptyOrDefault(input.pullRequest?.base, defaults.pullRequest.base),
      remote: nonEmptyOrDefault(input.pullRequest?.remote, defaults.pullRequest.remote),
      draft: input.pullRequest?.draft ?? defaults.pullRequest.draft,
      ...(title === undefined ? {} : { title }),
      ...(body === undefined ? {} : { body }),
    },
  };
}

function nonEmptyOrDefault(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function nonEmptyOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
