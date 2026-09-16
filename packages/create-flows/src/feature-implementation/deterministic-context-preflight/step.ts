import { access, readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import type { Document } from "@trailstep/authoring";
import { state, step } from "@trailstep/authoring";
import type { ContinuationResult } from "@trailstep/core";
import type { ExploreStoryOutput } from "../explore-story/prompt.js";
import {
  incrementStoryPhaseAttempt,
  loadStoryPhaseContext,
  STORY_STATE_KEYS,
} from "../shared/story-state.js";
import { writeRedTestsStep } from "../write-red-tests/step.js";

const DEFAULT_VALIDATION_COMMANDS = ["pnpm test", "pnpm typecheck", "pnpm lint"] as const;

const MAX_ITEMS = 12;

export interface DeterministicContextPreflightInput extends Record<string, unknown> {
  readonly currentStory: Document;
  readonly implementationContext?: string;
}

export interface DeterministicContextPreflightBrief extends ExploreStoryOutput {
  readonly packageHints: readonly string[];
  readonly symbols: readonly string[];
  readonly searchHints: readonly string[];
  readonly focusedValidationHints: readonly string[];
}

export const deterministicContextPreflightStep = step({ id: "deterministic-context-preflight" }).do(
  async ({
    currentStory,
    implementationContext,
  }: DeterministicContextPreflightInput): Promise<ContinuationResult> => {
    await state.set(STORY_STATE_KEYS.activePhase, "deterministic-context-preflight");
    await incrementStoryPhaseAttempt("deterministic-context-preflight");

    const brief = await buildDeterministicContextPreflightBrief({
      currentStory,
      implementationContext,
      cwd: state.cwd,
    });
    await state.set(STORY_STATE_KEYS.latestExplorationBrief, brief);

    await state.set(STORY_STATE_KEYS.activePhase, "write-red-tests");
    const attempt = await incrementStoryPhaseAttempt("write-red-tests");
    return writeRedTestsStep({
      currentStory,
      explorationBrief: brief,
      attempt,
      implementationContext: await loadStoryPhaseContext("write-red-tests"),
    });
  },
);

export async function buildDeterministicContextPreflightBrief({
  currentStory,
  implementationContext,
  cwd,
}: {
  readonly currentStory: Document;
  readonly implementationContext?: string;
  readonly cwd?: string;
}): Promise<DeterministicContextPreflightBrief> {
  const sourceText = [currentStory.path, currentStory.content, implementationContext]
    .filter(Boolean)
    .join("\n");
  const relevantFiles = uniqueBounded([
    normalizeFileHint(currentStory.path, cwd),
    ...extractPathHints(sourceText),
    ...extractPathHints(implementationContext ?? ""),
  ]);
  const packageHints = uniqueBounded(await packageHintsForFiles(relevantFiles, cwd));
  const symbols = uniqueBounded(extractSymbolHints(sourceText));
  const searchHints = uniqueBounded([
    ...symbols.slice(0, 6).map((symbol) => `rg ${shellQuote(symbol)}`),
    relevantFiles.length === 0 && symbols.length === 0
      ? "rg focused story keywords from the Goal and Acceptance Criteria"
      : undefined,
  ]);
  const explicitValidationCommands = extractValidationCommands(sourceText);
  const focusedValidationHints = uniqueBounded([
    ...explicitValidationCommands,
    ...packageHints.flatMap((filter) => [
      `pnpm --filter ${filter} test`,
      `pnpm --filter ${filter} typecheck`,
      `pnpm --filter ${filter} lint`,
    ]),
    ...(packageHints.length === 0 ? DEFAULT_VALIDATION_COMMANDS : []),
  ]);
  const graphifyHint = cwd ? await graphifyAvailable(cwd) : false;
  const relevantFileText = relevantFiles.length > 0 ? relevantFiles.join(", ") : "none detected";
  const packageText = packageHints.length > 0 ? packageHints.join(", ") : "none detected";
  const symbolText = symbols.length > 0 ? symbols.join(", ") : "none detected";
  const contextHints = uniqueBounded(extractContextHints(implementationContext ?? ""), 4);
  const contextText = contextHints.length > 0 ? ` Context hints: ${contextHints.join("; ")}.` : "";
  const graphText = graphifyHint
    ? "graphify appears available; use graphify query before broad grep for structural questions."
    : "graphify availability was not detected; use focused rg hints if more context is needed.";

  return {
    blocked: false,
    summary: `Deterministic context preflight completed without blocking. Likely files: ${relevantFileText}. Package/filter hints: ${packageText}. Symbols: ${symbolText}.${contextText} ${graphText}`,
    relevantFiles,
    testSeams: uniqueBounded([
      ...extractSectionBullets(sourceText, [
        "red phase",
        "acceptance criteria",
        "validation commands",
      ]),
      ...symbols.map((symbol) => `Behavior around ${symbol}`),
      ...searchHints,
    ]),
    recommendedValidationCommands: focusedValidationHints,
    packageHints,
    symbols,
    searchHints: uniqueBounded([
      ...(graphifyHint
        ? [
            `graphify query ${shellQuote(`Where is ${symbols[0] ?? currentStory.path} implemented or tested?`)}`,
          ]
        : []),
      ...searchHints,
    ]),
    focusedValidationHints,
  };
}

function extractPathHints(text: string): readonly string[] {
  const candidates: string[] = [];
  const pathPattern =
    /(?:^|[\s('"`])((?:\.{1,2}\/)?(?:packages|src|docs|scripts|test|tests|\.github|\.pi)\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|mjs|cjs|svelte|css|yml|yaml))/gmu;
  for (const match of text.matchAll(pathPattern)) {
    const candidate = sanitizePathCandidate(match[1]);
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function sanitizePathCandidate(candidate?: string): string | undefined {
  const cleaned = candidate
    ?.trim()
    .replace(/[),.;:]+$/u, "")
    .replace(/^`|`$/gu, "");
  if (
    !cleaned ||
    cleaned.includes("://") ||
    cleaned.includes("../") ||
    /^[A-Za-z]:/u.test(cleaned)
  ) {
    return undefined;
  }
  return cleaned.replace(/\\/gu, "/");
}

function normalizeFileHint(path: string, cwd?: string): string {
  const normalizedPath = path.replace(/\\/gu, "/");
  if (!cwd || !isAbsolute(path)) {
    return normalizedPath;
  }

  const relativePath = relative(cwd, path).replace(/\\/gu, "/");
  return relativePath.length > 0 && !relativePath.startsWith("../") ? relativePath : normalizedPath;
}

function extractSymbolHints(text: string): readonly string[] {
  const symbols: string[] = [];
  for (const match of text.matchAll(/`([^`\n]{3,80})`/gmu)) {
    const token = match[1]?.trim();
    if (token && !token.includes(" ") && !token.includes("/")) {
      symbols.push(token);
    }
  }
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/gmu)) {
    if (match[0].length <= 80) {
      symbols.push(match[0]);
    }
  }
  return symbols;
}

function extractContextHints(text: string): readonly string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*[-*]\s*/u, "").trim())
    .filter((line) => line.length > 0 && !/^[A-Za-z-]+:\s*/u.test(line));
}

function extractValidationCommands(text: string): readonly string[] {
  return uniqueBounded(
    text
      .split(/\r?\n/u)
      .map((line) => line.replace(/^\s*[-*]\s*/u, "").trim())
      .filter((line) => /\b(pnpm|npm|yarn|vitest|tsc|biome|node)\b/u.test(line))
      .map((line) => line.replace(/^`|`$/gu, "")),
  );
}

function extractSectionBullets(text: string, sectionTitles: readonly string[]): readonly string[] {
  const normalizedTitles = new Set(sectionTitles.map((title) => title.toLowerCase()));
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const bullets: string[] = [];
  let active = false;
  for (const line of lines) {
    const heading = /^#{2,6}\s+(.+?)\s*$/u.exec(line.trim());
    if (heading) {
      active = normalizedTitles.has((heading[1] ?? "").trim().toLowerCase());
      continue;
    }
    if (!active) {
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+)$/u.exec(line);
    if (bullet?.[1]) {
      bullets.push(bullet[1].trim());
    }
  }
  return bullets;
}

async function packageHintsForFiles(
  files: readonly string[],
  cwd?: string,
): Promise<readonly string[]> {
  const packageDirs = uniqueBounded(
    files.flatMap((file) => {
      const normalizedFile = file.replace(/\\/gu, "/");
      const match = /^packages\/([^/]+)/u.exec(normalizedFile);
      return match?.[1] ? [`packages/${match[1]}`] : [];
    }),
  );

  const hints: string[] = [];
  for (const packageDir of packageDirs) {
    const packageJsonPath = cwd ? join(cwd, packageDir, "package.json") : undefined;
    const packageName = packageJsonPath ? await readPackageName(packageJsonPath) : undefined;
    hints.push(packageName ?? packageDir);
  }
  return hints;
}

async function readPackageName(packageJsonPath: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      readonly name?: unknown;
    };
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

async function graphifyAvailable(cwd: string): Promise<boolean> {
  try {
    await access(join(cwd, "graphify-out", "graph.json"));
    return true;
  } catch {
    return false;
  }
}

function uniqueBounded<T>(items: readonly (T | undefined)[], max = MAX_ITEMS): readonly T[] {
  const values: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item === undefined || item === null) {
      continue;
    }
    const key = String(item);
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    values.push(item);
    if (values.length >= max) {
      break;
    }
  }
  return values;
}

function shellQuote(value: string): string {
  return JSON.stringify(value);
}
