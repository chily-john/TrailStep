import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ValidateStoryInput, ValidateStoryOutput, ValidationCommandResult } from "./prompt.js";

const execFileAsync = promisify(execFile);
const MAX_COMMANDS = 5;
const COMMAND_TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT = 4_000;
const MAX_BUFFER = 256 * 1024;

const ALLOWED_COMMANDS = new Set(["pnpm", "npm", "node", "git", "./trailstep-dev.sh"]);
const BROAD_PACKAGE_MANAGER_SCRIPTS = new Set(["test", "typecheck", "lint", "build"]);
const SHELL_META_CHARS = new Set(["|", "&", ";", "<", ">", "(", ")"]);

export async function runFocusedStoryValidation(input: {
  readonly validationInput: ValidateStoryInput;
  readonly cwd?: string;
  readonly implementationContext?: string;
}): Promise<ValidateStoryOutput> {
  const commands = collectValidationCommands(input.validationInput, input.implementationContext);
  if (commands.length === 0) {
    return {
      blocked: true,
      blockedReason:
        "No focused validation commands were found in the story or exploration context.",
      summary: "Validation blocked: no focused validation commands were found.",
      commands: [],
      validationPassed: false,
    };
  }

  const results: ValidationCommandResult[] = [];
  for (const command of commands.slice(0, MAX_COMMANDS)) {
    results.push(await runValidationCommand(command, input.cwd));
  }

  const skipped = results.filter((result) => isSkippedResult(result.result));
  const failed = results.filter((result) => isFailedResult(result.result));
  const passed = results.filter((result) => isPassedResult(result.result));
  const validationPassed = failed.length === 0 && passed.length > 0;
  const blocked = passed.length === 0 && skipped.length === results.length;

  return {
    blocked,
    blockedReason: blocked
      ? "All focused validation commands were rejected or skipped."
      : undefined,
    summary: summarizeValidationResults({ passed, failed, skipped, total: results.length }),
    commands: results,
    validationPassed,
  };
}

export function collectValidationCommands(
  input: ValidateStoryInput,
  implementationContext?: string,
): readonly string[] {
  return uniqueCommands([
    ...extractValidationCommandLines(input.currentStory.content),
    ...extractValidationCommandLines(implementationContext ?? ""),
    ...(input.explorationBrief?.recommendedValidationCommands ?? []),
  ]);
}

async function runValidationCommand(
  command: string,
  cwd?: string,
): Promise<ValidationCommandResult> {
  const parsed = parseCommand(command);
  if (parsed.ok === false) {
    return { command, result: `skipped: ${parsed.reason}` };
  }

  const allowed = validateAllowedCommand(parsed.argv);
  if (allowed.ok === false) {
    return { command, result: `skipped: ${allowed.reason}` };
  }

  if (!cwd) {
    return { command, result: "skipped: workflow cwd is unavailable" };
  }

  try {
    const executable = executableForPlatform(parsed.argv[0] ?? "");
    const { stdout, stderr } = await execFileAsync(executable, parsed.argv.slice(1), {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      shell: requiresWindowsCommandShell(executable),
      windowsHide: true,
    });
    const output = formatCommandOutput(stdout, stderr);
    return { command, result: `passed${output ? `: ${output}` : ""}` };
  } catch (error) {
    return { command, result: `failed: ${formatExecutionError(error)}` };
  }
}

function executableForPlatform(executable: string): string {
  if (process.platform !== "win32") {
    return executable;
  }
  if (executable === "pnpm" || executable === "npm") {
    return `${executable}.cmd`;
  }
  return executable;
}

function requiresWindowsCommandShell(executable: string): boolean {
  return process.platform === "win32" && executable.toLowerCase().endsWith(".cmd");
}

function extractValidationCommandLines(content: string): readonly string[] {
  const normalized = content.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const commands: string[] = [];
  let inValidationSection = false;

  for (const line of lines) {
    if (/^#{2,6}\s+Validation Commands\s*$/iu.test(line.trim())) {
      inValidationSection = true;
      continue;
    }
    if (inValidationSection && /^#{2,6}\s+/u.test(line.trim())) {
      break;
    }
    if (!inValidationSection) {
      continue;
    }

    const command = normalizeCommandLine(line);
    if (command) {
      commands.push(command);
    }
  }

  return commands;
}

function normalizeCommandLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed === "Not provided.") {
    return null;
  }

  const withoutFence = trimmed.replace(/^```(?:sh|bash|shell)?\s*/iu, "").replace(/```$/u, "");
  const listMatch = /^(?:[-*+]\s+|\d+[.)]\s+)?(?:`([^`]+)`|(.+))$/u.exec(withoutFence.trim());
  const command = (listMatch?.[1] ?? listMatch?.[2] ?? withoutFence).trim();
  return command.length > 0 ? command : null;
}

function parseCommand(
  command: string,
):
  | { readonly ok: true; readonly argv: readonly string[] }
  | { readonly ok: false; readonly reason: string } {
  const argv: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (!quote && SHELL_META_CHARS.has(char)) {
      return { ok: false, reason: `shell metacharacter '${char}' is not allowlisted` };
    }
    if (!quote && char === "$" && command[index + 1] === "(") {
      return { ok: false, reason: "command substitution is not allowlisted" };
    }
    if (char === "`") {
      return { ok: false, reason: "backtick command substitution is not allowlisted" };
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current.length > 0) {
        argv.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (quote) {
    return { ok: false, reason: "unterminated quoted argument" };
  }
  if (current.length > 0) {
    argv.push(current);
  }
  if (argv.length === 0) {
    return { ok: false, reason: "empty command" };
  }
  return { ok: true, argv };
}

function validateAllowedCommand(
  argv: readonly string[],
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const executable = argv[0] ?? "";
  if (!ALLOWED_COMMANDS.has(executable)) {
    return { ok: false, reason: `command '${executable}' is not allowlisted` };
  }

  if (executable === "git") {
    return validateGitCommand(argv);
  }

  if ((executable === "pnpm" || executable === "npm") && isBroadPackageManagerCommand(argv)) {
    return {
      ok: false,
      reason:
        "broad package validation belongs to final validation; add --filter, a package path, or a specific test file for story validation",
    };
  }

  return { ok: true };
}

function validateGitCommand(
  argv: readonly string[],
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const subcommand = argv[1];
  if (subcommand === "status" || subcommand === "diff" || subcommand === "rev-parse") {
    return { ok: true };
  }
  return { ok: false, reason: `git subcommand '${subcommand ?? ""}' is not allowlisted` };
}

function isBroadPackageManagerCommand(argv: readonly string[]): boolean {
  const scriptIndex = firstPackageManagerScriptIndex(argv);
  if (scriptIndex < 0) {
    return false;
  }
  const script = argv[scriptIndex];
  if (!script || !BROAD_PACKAGE_MANAGER_SCRIPTS.has(script)) {
    return false;
  }
  const args = argv.slice(1);
  if (
    args.includes("--filter") ||
    args.includes("-F") ||
    args.some((arg) => arg.startsWith("--filter="))
  ) {
    return false;
  }
  const trailing = argv.slice(scriptIndex + 1);
  return !trailing.some(isFocusedValidationArgument);
}

function firstPackageManagerScriptIndex(argv: readonly string[]): number {
  const runIndex = argv.indexOf("run");
  if (runIndex >= 0) {
    return runIndex + 1;
  }
  return argv.findIndex((arg, index) => index > 0 && BROAD_PACKAGE_MANAGER_SCRIPTS.has(arg));
}

function isFocusedValidationArgument(arg: string): boolean {
  return (
    arg.includes("/") ||
    arg.includes("\\") ||
    /\.(?:test|spec)\.[cm]?[tj]sx?$/u.test(arg) ||
    arg.endsWith(".ts") ||
    arg.endsWith(".tsx") ||
    arg.startsWith("--testNamePattern") ||
    arg.startsWith("-t")
  );
}

function uniqueCommands(commands: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const command of commands.map((item) => normalizeCommandLine(item) ?? "")) {
    if (command && !seen.has(command)) {
      seen.add(command);
      unique.push(command);
    }
  }
  return unique;
}

function formatCommandOutput(stdout: string, stderr: string): string {
  return truncate([stdout.trim(), stderr.trim()].filter(Boolean).join("\n"));
}

function formatExecutionError(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return truncate(String(error));
  }
  const maybeError = error as {
    readonly signal?: string;
    readonly code?: number | string;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly message?: string;
    readonly killed?: boolean;
  };
  const prefix = maybeError.killed
    ? `timed out after ${COMMAND_TIMEOUT_MS}ms`
    : `exit ${maybeError.code ?? maybeError.signal ?? "unknown"}`;
  const output = formatCommandOutput(maybeError.stdout ?? "", maybeError.stderr ?? "");
  return truncate(
    output ? `${prefix}; ${output}` : `${prefix}; ${maybeError.message ?? "command failed"}`,
  );
}

function summarizeValidationResults(input: {
  readonly passed: readonly ValidationCommandResult[];
  readonly failed: readonly ValidationCommandResult[];
  readonly skipped: readonly ValidationCommandResult[];
  readonly total: number;
}): string {
  if (input.failed.length > 0) {
    return `Focused validation failed: ${input.failed.length}/${input.total} command(s) failed, ${input.passed.length} passed, ${input.skipped.length} skipped.`;
  }
  if (input.passed.length > 0) {
    return `Focused validation passed: ${input.passed.length}/${input.total} command(s) passed, ${input.skipped.length} skipped.`;
  }
  return `Focused validation skipped: ${input.skipped.length}/${input.total} command(s) were rejected or skipped.`;
}

function isPassedResult(result: string): boolean {
  return result.startsWith("passed");
}

function isFailedResult(result: string): boolean {
  return result.startsWith("failed");
}

function isSkippedResult(result: string): boolean {
  return result.startsWith("skipped");
}

function truncate(value: string): string {
  return value.length > OUTPUT_LIMIT ? `${value.slice(0, OUTPUT_LIMIT)}… [truncated]` : value;
}
