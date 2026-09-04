import type { WorkflowAgentThinking } from "../../contracts/agents/agent-role.types.js";
import { TrailStepFailureError } from "../../contracts/failures/failure.js";

type PlaceholderName = "prompt" | "promptFile" | "outputFile" | "model" | "thinking";
type ConditionalName = "model" | "thinking";

type PlaceholderValues = Readonly<Partial<Record<PlaceholderName, string>>>;

const PLACEHOLDER_NAMES = new Set<PlaceholderName>([
  "prompt",
  "promptFile",
  "outputFile",
  "model",
  "thinking",
]);
const CONDITIONAL_NAMES = new Set<ConditionalName>(["model", "thinking"]);
const TEMPLATE_TOKEN_PATTERN = /^{{([#/]?)([A-Za-z][A-Za-z0-9]*)}}$/;

export function renderCustomProviderArgs(options: {
  readonly argv: readonly string[];
  readonly values: {
    readonly prompt?: string;
    readonly promptFile?: string;
    readonly outputFile?: string;
    readonly model?: string;
    readonly thinking?: WorkflowAgentThinking;
  };
  readonly errorCode: string;
  readonly commandDescription: string;
}): string[] {
  const values: PlaceholderValues = {
    ...(options.values.prompt === undefined ? {} : { prompt: options.values.prompt }),
    ...(options.values.promptFile === undefined ? {} : { promptFile: options.values.promptFile }),
    ...(options.values.outputFile === undefined ? {} : { outputFile: options.values.outputFile }),
    ...(optionalNonEmptyString(options.values.model) === undefined
      ? {}
      : { model: optionalNonEmptyString(options.values.model) }),
    ...(options.values.thinking === undefined ? {} : { thinking: options.values.thinking }),
  };

  return renderRange({
    argv: options.argv,
    values,
    errorCode: options.errorCode,
    commandDescription: options.commandDescription,
  });
}

function renderRange(options: {
  readonly argv: readonly string[];
  readonly values: PlaceholderValues;
  readonly errorCode: string;
  readonly commandDescription: string;
}): string[] {
  const rendered: string[] = [];

  for (let index = 0; index < options.argv.length; index += 1) {
    const arg = options.argv[index] ?? "";
    const token = parseTemplateToken(arg);

    if (token?.kind === "open") {
      const closeIndex = findConditionalClose({
        argv: options.argv,
        openIndex: index,
        condition: token.name,
        errorCode: options.errorCode,
        commandDescription: options.commandDescription,
      });
      if (options.values[token.name] !== undefined) {
        rendered.push(
          ...renderRange({
            ...options,
            argv: options.argv.slice(index + 1, closeIndex),
          }),
        );
      }
      index = closeIndex;
      continue;
    }

    if (token?.kind === "close") {
      throw templateError({
        code: options.errorCode,
        message: `${options.commandDescription} template has unexpected ${closingToken(token.name)} without a matching ${openingToken(token.name)}.`,
      });
    }

    if (token?.kind === "placeholder") {
      rendered.push(renderPlaceholder({ ...options, name: token.name }));
      continue;
    }

    if (TEMPLATE_TOKEN_PATTERN.test(arg)) {
      throw templateError({
        code: options.errorCode,
        message: `${options.commandDescription} template token ${arg} is not supported.`,
        details: { arg },
      });
    }

    if (arg.includes("{{") || arg.includes("}}")) {
      rendered.push(renderInterpolatedArg({ ...options, arg }));
      continue;
    }

    rendered.push(arg);
  }

  return rendered;
}

function parseTemplateToken(
  arg: string,
):
  | { readonly kind: "placeholder"; readonly name: PlaceholderName }
  | { readonly kind: "open"; readonly name: ConditionalName }
  | { readonly kind: "close"; readonly name: ConditionalName }
  | undefined {
  const match = TEMPLATE_TOKEN_PATTERN.exec(arg);
  if (!match) {
    return undefined;
  }

  const prefix = match[1] ?? "";
  const name = match[2] ?? "";

  if (prefix === "") {
    if (PLACEHOLDER_NAMES.has(name as PlaceholderName)) {
      return { kind: "placeholder", name: name as PlaceholderName };
    }
    return undefined;
  }

  if (CONDITIONAL_NAMES.has(name as ConditionalName)) {
    return {
      kind: prefix === "#" ? "open" : "close",
      name: name as ConditionalName,
    };
  }

  return undefined;
}

function renderInterpolatedArg(options: {
  readonly arg: string;
  readonly values: PlaceholderValues;
  readonly errorCode: string;
  readonly commandDescription: string;
}): string {
  let foundTemplateToken = false;
  const rendered = options.arg.replaceAll(
    /\{\{([#/]?)([A-Za-z][A-Za-z0-9]*)\}\}/gu,
    (match: string, prefix: string, name: string) => {
      foundTemplateToken = true;

      if (prefix !== "") {
        throw templateError({
          code: options.errorCode,
          message: `${options.commandDescription} conditional blocks must be whole argv values.`,
          details: { arg: options.arg, token: match },
        });
      }

      if (!PLACEHOLDER_NAMES.has(name as PlaceholderName)) {
        throw templateError({
          code: options.errorCode,
          message: `${options.commandDescription} template token ${match} is not supported.`,
          details: { arg: options.arg },
        });
      }

      return renderPlaceholder({ ...options, name: name as PlaceholderName });
    },
  );

  if (!foundTemplateToken || rendered.includes("{{") || rendered.includes("}}")) {
    throw templateError({
      code: options.errorCode,
      message: `${options.commandDescription} has malformed template syntax.`,
      details: { arg: options.arg },
    });
  }

  return rendered;
}

function findConditionalClose(options: {
  readonly argv: readonly string[];
  readonly openIndex: number;
  readonly condition: ConditionalName;
  readonly errorCode: string;
  readonly commandDescription: string;
}): number {
  let depth = 1;

  for (let index = options.openIndex + 1; index < options.argv.length; index += 1) {
    const token = parseTemplateToken(options.argv[index] ?? "");
    if (token?.name !== options.condition) {
      continue;
    }

    if (token.kind === "open") {
      depth += 1;
      continue;
    }

    if (token.kind === "close") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  throw templateError({
    code: options.errorCode,
    message: `${options.commandDescription} template is missing ${closingToken(options.condition)} for ${openingToken(options.condition)}.`,
  });
}

function renderPlaceholder(options: {
  readonly name: PlaceholderName;
  readonly values: PlaceholderValues;
  readonly errorCode: string;
  readonly commandDescription: string;
}): string {
  const value = options.values[options.name];
  if (value !== undefined) {
    return value;
  }

  if (options.name === "model" || options.name === "thinking") {
    throw templateError({
      code: options.errorCode,
      message: `${options.commandDescription} placeholder ${placeholderToken(options.name)} must be guarded with ${openingToken(options.name)} ... ${closingToken(options.name)} when no ${options.name} override is set.`,
      details: { placeholder: placeholderToken(options.name) },
    });
  }

  throw templateError({
    code: options.errorCode,
    message: `${options.commandDescription} placeholder ${placeholderToken(options.name)} is not available in this command template.`,
    details: { placeholder: placeholderToken(options.name) },
  });
}

function templateError(options: {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}): TrailStepFailureError {
  return new TrailStepFailureError({
    code: options.code,
    message: options.message,
    ...(options.details === undefined ? {} : { details: options.details }),
  });
}

function placeholderToken(name: PlaceholderName): string {
  return `{{${name}}}`;
}

function openingToken(name: ConditionalName): string {
  return `{{#${name}}}`;
}

function closingToken(name: ConditionalName): string {
  return `{{/${name}}}`;
}

function optionalNonEmptyString(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  return value;
}
