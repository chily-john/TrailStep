import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { CliCommandContext } from "../command.types.js";
import {
  configPathForScope,
  readRawTrailStepConfigFile,
  type WorkflowRegistryScope,
  writeRawTrailStepConfigFile,
} from "../workflow-registry/workflow-registry.js";
import { distributeWorkflowSkill } from "../workflow-skills/skills-cli.js";

export const PACKAGED_TRAILSTEP_SKILLS = [
  {
    name: "trailstep",
    directoryName: "trailstep-skill",
    source: "@trailstep/cli/trailstep-skill",
  },
  {
    name: "trailstep-authoring",
    directoryName: "trailstep-authoring-skill",
    source: "@trailstep/cli/trailstep-authoring-skill",
  },
] as const;

export type PackagedTrailStepSkillName = (typeof PACKAGED_TRAILSTEP_SKILLS)[number]["name"];
export type PackagedTrailStepSkillSource = (typeof PACKAGED_TRAILSTEP_SKILLS)[number]["source"];
export type TrailStepSkillInstallTarget = "project" | "user";

export interface TrailStepSkillInstallationMarker {
  readonly source: PackagedTrailStepSkillSource;
  readonly target: TrailStepSkillInstallTarget;
  readonly contentHash: string;
}

export interface TrailStepSkillRefreshResult {
  readonly configPath: string;
  readonly target: TrailStepSkillInstallTarget;
}

export interface StaleTrailStepSkillInstallation {
  readonly configPath: string;
  readonly target: TrailStepSkillInstallTarget;
}

export async function installPackagedTrailStepSkill(
  scope: "local" | "project" | "global",
  context: CliCommandContext,
): Promise<void> {
  await installPackagedTrailStepSkills(scope, context);
}

export async function installPackagedTrailStepSkills(
  scope: "local" | "project" | "global",
  context: CliCommandContext,
): Promise<void> {
  for (const skill of PACKAGED_TRAILSTEP_SKILLS) {
    await distributeWorkflowSkill({
      skillDirectory: await resolvePackagedTrailStepSkillDirectory(skill.name),
      target: trailStepSkillInstallTargetForScope(scope),
      resolver: context.skillsCliResolver,
      runner: context.skillsCliProcessRunner,
    });
  }
}

export function trailStepSkillInstallTargetForScope(
  scope: "local" | "project" | "global",
): TrailStepSkillInstallTarget {
  return scope === "global" ? "user" : "project";
}

export async function refreshTrackedPackagedTrailStepSkills(
  context: CliCommandContext,
): Promise<readonly TrailStepSkillRefreshResult[]> {
  const refreshed: TrailStepSkillRefreshResult[] = [];
  const refreshedTargets = new Set<TrailStepSkillInstallTarget>();

  for (const scope of [
    "local",
    "project",
    "global",
  ] as const satisfies readonly WorkflowRegistryScope[]) {
    const configPath = configPathForScope(scope, context);
    const config = await readRawTrailStepConfigFile(configPath);
    const markerTarget = readPackagedTrailStepSkillInstallationTarget(config);
    if (markerTarget === undefined) {
      continue;
    }

    if (!refreshedTargets.has(markerTarget)) {
      await installPackagedTrailStepSkills(scopeForSkillInstallTarget(markerTarget), context);
      refreshedTargets.add(markerTarget);
    }

    const nextMarkers = await createPackagedTrailStepSkillInstallationMarkers(markerTarget);
    await writeRawTrailStepConfigFile(
      configPath,
      setTrailStepSkillInstallationMarkers(config, nextMarkers),
    );
    refreshed.push({ configPath, target: markerTarget });
  }

  return refreshed;
}

export async function findStaleTrackedPackagedTrailStepSkillInstallations(
  context: Pick<CliCommandContext, "cwd" | "homeDir">,
): Promise<readonly StaleTrailStepSkillInstallation[]> {
  const stale: StaleTrailStepSkillInstallation[] = [];

  for (const scope of [
    "local",
    "project",
    "global",
  ] as const satisfies readonly WorkflowRegistryScope[]) {
    const configPath = configPathForScope(scope, context);
    const config = await readRawTrailStepConfigFile(configPath);
    const markerTarget = readPackagedTrailStepSkillInstallationTarget(config);
    if (markerTarget === undefined) {
      continue;
    }

    const expectedMarkers = await createPackagedTrailStepSkillInstallationMarkers(markerTarget);
    if (!hasCurrentTrailStepSkillInstallationMarkers(config, expectedMarkers)) {
      stale.push({ configPath, target: markerTarget });
    }
  }

  return stale;
}

export async function createPackagedTrailStepSkillInstallationMarker(
  target: TrailStepSkillInstallTarget,
): Promise<TrailStepSkillInstallationMarker> {
  const markers = await createPackagedTrailStepSkillInstallationMarkers(target);
  return markers.trailstep;
}

export async function createPackagedTrailStepSkillInstallationMarkers(
  target: TrailStepSkillInstallTarget,
): Promise<Record<PackagedTrailStepSkillName, TrailStepSkillInstallationMarker>> {
  const entries = await Promise.all(
    PACKAGED_TRAILSTEP_SKILLS.map(
      async (skill) =>
        [
          skill.name,
          {
            source: skill.source,
            target,
            contentHash: await hashDirectory(
              await resolvePackagedTrailStepSkillDirectory(skill.name),
            ),
          },
        ] as const,
    ),
  );

  return Object.fromEntries(entries) as Record<
    PackagedTrailStepSkillName,
    TrailStepSkillInstallationMarker
  >;
}

export function hasCurrentTrailStepSkillInstallationMarker(
  config: Record<string, unknown>,
  expectedMarker: TrailStepSkillInstallationMarker,
): boolean {
  const marker = readTrailStepSkillInstallationMarker(config, "trailstep");
  return markerMatches(marker, expectedMarker);
}

export function hasCurrentTrailStepSkillInstallationMarkers(
  config: Record<string, unknown>,
  expectedMarkers: Record<PackagedTrailStepSkillName, TrailStepSkillInstallationMarker>,
): boolean {
  return PACKAGED_TRAILSTEP_SKILLS.every((skill) =>
    markerMatches(
      readTrailStepSkillInstallationMarker(config, skill.name),
      expectedMarkers[skill.name],
    ),
  );
}

export function setTrailStepSkillInstallationMarker(
  config: Record<string, unknown>,
  marker: TrailStepSkillInstallationMarker,
): Record<string, unknown> {
  return setTrailStepSkillInstallationMarkers(config, { trailstep: marker });
}

export function setTrailStepSkillInstallationMarkers(
  config: Record<string, unknown>,
  markers: Partial<Record<PackagedTrailStepSkillName, TrailStepSkillInstallationMarker>>,
): Record<string, unknown> {
  return {
    ...config,
    skillInstallations: {
      ...(isRecord(config.skillInstallations) ? config.skillInstallations : {}),
      ...markers,
    },
  };
}

function scopeForSkillInstallTarget(target: TrailStepSkillInstallTarget): WorkflowRegistryScope {
  return target === "user" ? "global" : "project";
}

export async function resolvePackagedTrailStepSkillDirectory(
  name: PackagedTrailStepSkillName = "trailstep",
): Promise<string> {
  const skill = PACKAGED_TRAILSTEP_SKILLS.find((candidate) => candidate.name === name);
  if (skill === undefined) {
    throw new Error(`Unknown packaged TrailStep skill: ${name}`);
  }

  const packageRoot = await findCliPackageRoot(dirname(fileURLToPath(import.meta.url)));
  const skillDirectory = join(packageRoot, skill.directoryName);
  await access(join(skillDirectory, "SKILL.md"));
  return skillDirectory;
}

function readPackagedTrailStepSkillInstallationTarget(
  config: Record<string, unknown>,
): TrailStepSkillInstallTarget | undefined {
  for (const skill of PACKAGED_TRAILSTEP_SKILLS) {
    const marker = readTrailStepSkillInstallationMarker(config, skill.name);
    if (marker !== undefined) {
      return marker.target;
    }
  }

  return undefined;
}

function readTrailStepSkillInstallationMarker(
  config: Record<string, unknown>,
  name: PackagedTrailStepSkillName,
): TrailStepSkillInstallationMarker | undefined {
  if (!isRecord(config.skillInstallations)) {
    return undefined;
  }

  const skill = PACKAGED_TRAILSTEP_SKILLS.find((candidate) => candidate.name === name);
  if (skill === undefined) {
    return undefined;
  }

  const marker = config.skillInstallations[name];
  if (!isRecord(marker)) {
    return undefined;
  }

  return marker.source === skill.source &&
    (marker.target === "project" || marker.target === "user") &&
    typeof marker.contentHash === "string"
    ? {
        source: skill.source,
        target: marker.target,
        contentHash: marker.contentHash,
      }
    : undefined;
}

function markerMatches(
  marker: TrailStepSkillInstallationMarker | undefined,
  expectedMarker: TrailStepSkillInstallationMarker,
): boolean {
  return (
    marker !== undefined &&
    marker.source === expectedMarker.source &&
    marker.target === expectedMarker.target &&
    marker.contentHash === expectedMarker.contentHash
  );
}

async function hashDirectory(directory: string): Promise<string> {
  const files = await listFiles(directory);
  const hash = createHash("sha256");
  for (const file of files) {
    const relativePath = relative(directory, file).replaceAll("\\", "/");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        return listFiles(entryPath);
      }
      return entry.isFile() ? [entryPath] : [];
    }),
  );
  return files.flat().sort();
}

async function findCliPackageRoot(startDirectory: string): Promise<string> {
  let current = startDirectory;

  while (true) {
    if (await isTrailStepCliPackageRoot(current)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Could not resolve @trailstep/cli package root for TrailStep skill.");
    }
    current = parent;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function isTrailStepCliPackageRoot(directory: string): Promise<boolean> {
  try {
    const packageJson = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
      readonly name?: string;
    };
    return packageJson.name === "@trailstep/cli";
  } catch {
    return false;
  }
}
