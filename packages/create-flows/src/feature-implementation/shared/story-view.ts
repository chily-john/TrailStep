const STORY_SECTION_TITLES = [
  "Dependencies",
  "Goal",
  "User-Visible / Integration-Visible Slice",
  "Acceptance Criteria",
  "Red Phase",
  "Green Phase",
  "Refactor Phase",
  "Validation Commands",
  "Notes for Implementer",
] as const;

type StorySectionTitle = (typeof STORY_SECTION_TITLES)[number];

const KNOWN_SECTION_TITLES = new Set<string>(STORY_SECTION_TITLES.map(normalizeHeading));

export function storyViewForExplorer(storyContent: string): string {
  return storyView(storyContent, [
    "Dependencies",
    "Goal",
    "User-Visible / Integration-Visible Slice",
    "Acceptance Criteria",
  ]);
}

export function storyViewForTestWriter(storyContent: string): string {
  return storyView(storyContent, [
    "Dependencies",
    "Goal",
    "User-Visible / Integration-Visible Slice",
    "Acceptance Criteria",
    "Red Phase",
    "Validation Commands",
  ]);
}

export function storyViewForImplementer(storyContent: string): string {
  return storyView(storyContent, [
    "Dependencies",
    "Goal",
    "User-Visible / Integration-Visible Slice",
    "Acceptance Criteria",
    "Green Phase",
    "Refactor Phase",
    "Notes for Implementer",
  ]);
}

export function storyViewForValidator(storyContent: string): string {
  return storyView(storyContent, [
    "Goal",
    "User-Visible / Integration-Visible Slice",
    "Acceptance Criteria",
    "Validation Commands",
  ]);
}

export function storyViewForReviewer(storyContent: string): string {
  return storyView(storyContent, [
    "Dependencies",
    "Goal",
    "User-Visible / Integration-Visible Slice",
    "Acceptance Criteria",
    "Red Phase",
    "Green Phase",
    "Refactor Phase",
    "Validation Commands",
    "Notes for Implementer",
  ]);
}

function storyView(storyContent: string, visibleSections: readonly StorySectionTitle[]): string {
  const parsed = parseStorySections(storyContent);
  const selected = visibleSections.flatMap((title) => {
    const section = parsed.sections.get(normalizeHeading(title));
    return section ? [section] : [];
  });

  return [parsed.preamble, ...selected]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function parseStorySections(storyContent: string): {
  readonly preamble: string;
  readonly sections: ReadonlyMap<string, string>;
} {
  const normalized = storyContent.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const sections = new Map<string, string>();
  const preambleLines: string[] = [];
  let activeSectionTitle: string | undefined;
  let activeSectionLines: string[] = [];

  for (const line of lines) {
    const heading = parseKnownSectionHeading(line);
    if (heading) {
      flushActiveSection();
      activeSectionTitle = heading.normalizedTitle;
      activeSectionLines = [line];
      continue;
    }

    if (activeSectionTitle) {
      activeSectionLines.push(line);
    } else {
      preambleLines.push(line);
    }
  }

  flushActiveSection();

  return {
    preamble: preambleLines.join("\n"),
    sections,
  };

  function flushActiveSection(): void {
    if (!activeSectionTitle) {
      return;
    }
    sections.set(activeSectionTitle, activeSectionLines.join("\n"));
    activeSectionTitle = undefined;
    activeSectionLines = [];
  }
}

function parseKnownSectionHeading(line: string): { readonly normalizedTitle: string } | undefined {
  const match = /^(#{2,6})\s+(.+?)\s*$/u.exec(line.trim());
  if (!match) {
    return undefined;
  }

  const normalizedTitle = normalizeHeading(match[2] ?? "");
  return KNOWN_SECTION_TITLES.has(normalizedTitle) ? { normalizedTitle } : undefined;
}

function normalizeHeading(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
