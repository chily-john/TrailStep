export type StoryContextAudience = "implementer" | "reviewer" | "all";

export type StoryContextPhase =
  | "explore-story"
  | "write-red-tests"
  | "implement-green"
  | "validate-story"
  | "review-story-implementation";

export interface ParsedStoryContextBlock {
  readonly audience?: StoryContextAudience;
  readonly stories?: readonly string[] | "all";
  readonly phases?: readonly StoryContextPhase[] | "all";
  readonly body: string;
}

export function parseStoryContextBlocks(
  rawBlocks: readonly string[],
): readonly ParsedStoryContextBlock[] {
  return rawBlocks.flatMap((rawBlock) => {
    const parsed = parseStoryContextBlock(rawBlock);
    return parsed ? [parsed] : [];
  });
}

export function selectStoryContext({
  blocks,
  storyContent,
  audience,
  phase,
}: {
  readonly blocks: readonly ParsedStoryContextBlock[];
  readonly storyContent: string;
  readonly audience: Exclude<StoryContextAudience, "all">;
  readonly phase: StoryContextPhase;
}): string {
  return blocks
    .filter(
      (block) =>
        blockMatchesAudience(block, audience) &&
        blockMatchesStory(block, storyContent) &&
        blockMatchesPhase(block, phase),
    )
    .map((block) => block.body)
    .join("\n\n---\n\n");
}

function parseStoryContextBlock(rawBlock: string): ParsedStoryContextBlock | undefined {
  const lines = rawBlock.replace(/\r\n?/g, "\n").split("\n");
  const firstBlankLine = lines.findIndex((line) => line.trim().length === 0);
  const metadataLines = firstBlankLine === -1 ? lines : lines.slice(0, firstBlankLine);
  const bodyLines = firstBlankLine === -1 ? [] : lines.slice(firstBlankLine + 1);
  const metadata = parseMetadataLines(metadataLines);
  const body = bodyLines.join("\n").trim();

  if (body.length === 0 || !hasRecognizedScopeMetadata(metadata)) {
    return undefined;
  }

  return { ...metadata, body };
}

interface ParsedStoryContextMetadata {
  audience?: StoryContextAudience;
  stories?: readonly string[] | "all";
  phases?: readonly StoryContextPhase[] | "all";
}

function parseMetadataLines(lines: readonly string[]): ParsedStoryContextMetadata {
  const metadata: ParsedStoryContextMetadata = {};

  for (const line of lines) {
    const match = /^([A-Za-z-]+):\s*(.*?)\s*$/.exec(line.trim());
    if (!match) {
      continue;
    }

    const key = match[1]?.toLowerCase();
    const value = match[2] ?? "";
    if (key === "audience") {
      const audience = parseAudience(value);
      if (audience) {
        metadata.audience = audience;
      }
      continue;
    }

    if (key === "stories") {
      const stories = parseStoryList(value);
      if (stories) {
        metadata.stories = stories;
      }
      continue;
    }

    if (key === "phases") {
      const phases = parsePhaseList(value);
      if (phases) {
        metadata.phases = phases;
      }
    }
  }

  return metadata;
}

function parseAudience(value: string): StoryContextAudience | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "implementer" || normalized === "reviewer" || normalized === "all") {
    return normalized;
  }
  return undefined;
}

function parseStoryList(value: string): readonly string[] | "all" | undefined {
  const items = splitMetadataList(value);
  if (items.length === 0) {
    return undefined;
  }

  if (items.length === 1 && items[0]?.toLowerCase() === "all") {
    return "all";
  }

  return items.filter((item) => item.toLowerCase() !== "all");
}

function parsePhaseList(value: string): readonly StoryContextPhase[] | "all" | undefined {
  const items = splitMetadataList(value);
  if (items.length === 0) {
    return undefined;
  }

  if (items.length === 1 && items[0]?.toLowerCase() === "all") {
    return "all";
  }

  const phases = items.filter(isStoryContextPhase);
  return phases.length > 0 ? phases : undefined;
}

function splitMetadataList(value: string): readonly string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function isStoryContextPhase(value: string): value is StoryContextPhase {
  return [
    "explore-story",
    "write-red-tests",
    "implement-green",
    "validate-story",
    "review-story-implementation",
  ].includes(value);
}

function hasRecognizedScopeMetadata(metadata: ParsedStoryContextMetadata): boolean {
  return Boolean(metadata.audience || metadata.stories || metadata.phases);
}

function blockMatchesAudience(
  block: ParsedStoryContextBlock,
  audience: Exclude<StoryContextAudience, "all">,
): boolean {
  return block.audience === audience || block.audience === "all";
}

function blockMatchesStory(block: ParsedStoryContextBlock, storyContent: string): boolean {
  if (block.stories === "all") {
    return true;
  }

  if (!block.stories) {
    return false;
  }

  const storyLabels = extractStoryLabels(storyContent).map(normalizeStoryLabel);
  return block.stories.some((story) => storyLabels.includes(normalizeStoryLabel(story)));
}

function blockMatchesPhase(block: ParsedStoryContextBlock, phase: StoryContextPhase): boolean {
  return !block.phases || block.phases === "all" || block.phases.includes(phase);
}

function extractStoryLabels(storyContent: string): readonly string[] {
  const match = /^#{1,6}\s+(Story\s+\d+)(?::\s*(.+))?\s*$/im.exec(storyContent);
  const ordinal = match?.[1]?.trim();
  if (!ordinal) {
    return [];
  }

  const title = match?.[2]?.trim();
  return title ? [ordinal, `${ordinal}: ${title}`] : [ordinal];
}

function normalizeStoryLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
