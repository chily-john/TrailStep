import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CliCommandContext } from "../command.types.js";
import { distributeWorkflowSkill } from "../workflow-skills/skills-cli.js";

const TRAILSTEP_SKILL_DIRECTORY_NAME = "trailstep-skill";
const TRAILSTEP_SKILL_NAME = "trailstep";
const TRAILSTEP_SKILL_SOURCE = "@trailstep/cli/trailstep-skill";

export type TrailStepSkillInstallTarget = "project" | "user";

export interface TrailStepSkillInstallationMarker {
  readonly source: typeof TRAILSTEP_SKILL_SOURCE;
  readonly target: TrailStepSkillInstallTarget;
  readonly contentHash: string;
}

export async function installPackagedTrailStepSkill(
  scope: "local" | "project" | "global",
  context: CliCommandContext,
): Promise<void> {
  await distributeWorkflowSkill({
    skillDirectory: await resolvePackagedTrailStepSkillDirectory(),
    target: trailStepSkillInstallTargetForScope(scope),
    resolver: context.skillsCliResolver,
    runner: context.skillsCliProcessRunner,
  });
}

export function trailStepSkillInstallTargetForScope(
  scope: "local" | "project" | "global",
): TrailStepSkillInstallTarget {
  return scope === "global" ? "user" : "project";
}

export async function createPackagedTrailStepSkillInstallationMarker(
  target: TrailStepSkillInstallTarget,
): Promise<TrailStepSkillInstallationMarker> {
  const skillDirectory = await resolvePackagedTrailStepSkillDirectory();
  const skillMarkdown = await readFile(join(skillDirectory, "SKILL.md"));

  return {
    source: TRAILSTEP_SKILL_SOURCE,
    target,
    contentHash: `sha256:${createHash("sha256").update(skillMarkdown).digest("hex")}`,
  };
}

export function hasCurrentTrailStepSkillInstallationMarker(
  config: Record<string, unknown>,
  expectedMarker: TrailStepSkillInstallationMarker,
): boolean {
  const marker = readTrailStepSkillInstallationMarker(config);
  return (
    marker !== undefined &&
    marker.source === expectedMarker.source &&
    marker.target === expectedMarker.target &&
    marker.contentHash === expectedMarker.contentHash
  );
}

export function setTrailStepSkillInstallationMarker(
  config: Record<string, unknown>,
  marker: TrailStepSkillInstallationMarker,
): Record<string, unknown> {
  return {
    ...config,
    skillInstallations: {
      ...(isRecord(config.skillInstallations) ? config.skillInstallations : {}),
      [TRAILSTEP_SKILL_NAME]: marker,
    },
  };
}

export async function resolvePackagedTrailStepSkillDirectory(): Promise<string> {
  const packageRoot = await findCliPackageRoot(dirname(fileURLToPath(import.meta.url)));
  const skillDirectory = join(packageRoot, TRAILSTEP_SKILL_DIRECTORY_NAME);
  await access(join(skillDirectory, "SKILL.md"));
  return skillDirectory;
}

function readTrailStepSkillInstallationMarker(
  config: Record<string, unknown>,
): TrailStepSkillInstallationMarker | undefined {
  if (!isRecord(config.skillInstallations)) {
    return undefined;
  }

  const marker = config.skillInstallations[TRAILSTEP_SKILL_NAME];
  if (!isRecord(marker)) {
    return undefined;
  }

  return marker.source === TRAILSTEP_SKILL_SOURCE &&
    (marker.target === "project" || marker.target === "user") &&
    typeof marker.contentHash === "string"
    ? {
        source: marker.source,
        target: marker.target,
        contentHash: marker.contentHash,
      }
    : undefined;
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
