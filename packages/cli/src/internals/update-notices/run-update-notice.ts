import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { gt, valid } from "semver";

import type { CliCommandContext } from "../command.types.js";
import { resolveGlobalCliUpdateTarget } from "../commands/update/global-cli-update-target.js";
import { findStaleTrackedPackagedTrailStepSkillInstallations } from "../trailstep-skill/trailstep-skill.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_PATH = join(".trailstep", "update-check.json");

interface UpdateNoticeCache {
  readonly checkedAt: string;
  readonly currentVersion: string;
  readonly targetVersion: string;
}

export async function maybeWriteRunUpdateNotice(context: CliCommandContext): Promise<void> {
  if (isUpdateNoticeSuppressed(context)) {
    return;
  }

  await maybeWriteStaleSkillNotice(context);
  await maybeWriteCliUpdateNotice(context);
}

async function maybeWriteStaleSkillNotice(context: CliCommandContext): Promise<void> {
  try {
    const staleSkills = await findStaleTrackedPackagedTrailStepSkillInstallations(context);
    if (staleSkills.length > 0) {
      context.io.writeLine(
        "TrailStep skills are out of date. Run `trailstep update` to refresh tracked skills.",
      );
    }
  } catch {
    // Update notices should never block a workflow run.
  }
}

async function maybeWriteCliUpdateNotice(context: CliCommandContext): Promise<void> {
  const now = context.runNameClock?.() ?? new Date();
  const cachePath = updateNoticeCachePath(context);

  try {
    const cached = await readUpdateNoticeCache(cachePath);
    const installedVersion = await readInstalledCliVersion();
    if (
      cached !== undefined &&
      cached.currentVersion === installedVersion &&
      isFresh(cached, now)
    ) {
      writeCachedUpdateNotice(cached, context);
      return;
    }

    const plan = await resolveGlobalCliUpdateTarget({
      cwd: context.cwd,
      packageCommandRunner: context.packageCommandRunner,
    });
    const cache = {
      checkedAt: now.toISOString(),
      currentVersion: plan.currentVersion,
      targetVersion: plan.targetVersion,
    };
    await writeUpdateNoticeCache(cachePath, cache);
    writeCachedUpdateNotice(cache, context);
  } catch {
    // Network/cache/update-check errors are intentionally non-blocking and quiet.
  }
}

function writeCachedUpdateNotice(cache: UpdateNoticeCache, context: CliCommandContext): void {
  if (!isNewerVersion(cache.targetVersion, cache.currentVersion)) {
    return;
  }

  context.io.writeLine(
    `TrailStep update available: ${cache.currentVersion} -> ${cache.targetVersion}. Run \`trailstep update\` to update the CLI and refresh tracked skills.`,
  );
}

function updateNoticeCachePath(context: Pick<CliCommandContext, "homeDir">): string {
  return join(context.homeDir ?? homedir(), CACHE_PATH);
}

async function readUpdateNoticeCache(path: string): Promise<UpdateNoticeCache | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    return typeof parsed.checkedAt === "string" &&
      typeof parsed.currentVersion === "string" &&
      typeof parsed.targetVersion === "string"
      ? {
          checkedAt: parsed.checkedAt,
          currentVersion: parsed.currentVersion,
          targetVersion: parsed.targetVersion,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

async function writeUpdateNoticeCache(path: string, cache: UpdateNoticeCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

async function readInstalledCliVersion(): Promise<string> {
  const packageRoot = await findCliPackageRoot(dirname(fileURLToPath(import.meta.url)));
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    readonly version?: unknown;
  };
  return typeof packageJson.version === "string" ? packageJson.version : "unknown";
}

async function findCliPackageRoot(startDirectory: string): Promise<string> {
  let current = startDirectory;

  while (true) {
    if (await isTrailStepCliPackageRoot(current)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Could not resolve @trailstep/cli package root for update notice.");
    }
    current = parent;
  }
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

function isFresh(cache: UpdateNoticeCache, now: Date): boolean {
  const checkedAt = Date.parse(cache.checkedAt);
  return Number.isFinite(checkedAt) && now.getTime() - checkedAt < CACHE_TTL_MS;
}

function isNewerVersion(targetVersion: string, currentVersion: string): boolean {
  if (valid(targetVersion) !== null && valid(currentVersion) !== null) {
    return gt(targetVersion, currentVersion);
  }
  return targetVersion !== currentVersion;
}

function isUpdateNoticeSuppressed(context: Pick<CliCommandContext, "env">): boolean {
  const env = context.env ?? {};
  const setting = env.TRAILSTEP_UPDATE_NOTICE?.toLowerCase();
  return (
    setting === "0" ||
    setting === "false" ||
    setting === "off" ||
    env.TRAILSTEP_NO_UPDATE_NOTICE === "1" ||
    (env.CI !== undefined && env.CI !== "false") ||
    env.NODE_ENV === "test"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
