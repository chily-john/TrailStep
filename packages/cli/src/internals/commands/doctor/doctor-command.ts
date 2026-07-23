import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { minVersion } from "semver";

import { type CliCommand, CliUsageError } from "../../command.types.js";
import { formatDeprecationFinding } from "../../deprecation-scan/deprecation-formatter.js";
import {
  type DeprecationFinding,
  scanWorkflowSourceForDeprecations,
} from "../../deprecation-scan/deprecation-scanner.js";
import { resolveDeprecationScanTargets } from "../../deprecation-scan/scan-targets.js";

interface DoctorCommandArgs {
  readonly includeDiscovered: boolean;
}

export const doctorCommand: CliCommand<DoctorCommandArgs> = {
  name: "doctor",
  parseArgs(argv) {
    if (argv[0] !== "doctor") {
      throw new CliUsageError("Expected doctor command.");
    }
    if (argv.length > 1) {
      throw new CliUsageError(`Unknown option: ${argv[1] ?? ""}`);
    }
    return { includeDiscovered: true };
  },
  async run(args, context) {
    const versionsByPackageName = await readInstalledStepKitVersions(context.cwd);
    const targets = await resolveDeprecationScanTargets({
      cwd: context.cwd,
      homeDir: context.homeDir,
      includeDiscovered: args.includeDiscovered,
    });
    const findings: DeprecationFinding[] = [];

    for (const target of targets) {
      try {
        findings.push(
          ...(await scanWorkflowSourceForDeprecations({
            sourceFile: target.sourceFile,
            versionsByPackageName,
            manifest: context.deprecationManifest,
          })),
        );
      } catch {
        // Doctor is advisory: unreadable scan targets are skipped until scanner coverage expands.
      }
    }

    for (const finding of findings) {
      context.io.writeLine(formatDeprecationFinding(finding));
    }

    if (findings.length === 0) {
      context.io.writeLine("No StepKit deprecation findings.");
      return 0;
    }

    if (findings.some((finding) => finding.severity === "blocking")) {
      context.io.writeError("Doctor found blocking deprecation findings.");
      return 2;
    }

    context.io.writeError("Doctor found deprecation warnings.");
    return 1;
  },
};

async function readInstalledStepKitVersions(
  cwd: string,
): Promise<Map<string, { readonly installedVersion?: string; readonly targetVersion: string }>> {
  let packageJson: Record<string, unknown>;
  try {
    packageJson = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return new Map();
  }

  const versions = new Map<
    string,
    { readonly installedVersion?: string; readonly targetVersion: string }
  >();
  for (const sectionName of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const section = packageJson[sectionName];
    if (!isRecord(section)) {
      continue;
    }
    for (const packageName of ["@stepkit/core", "@stepkit/sdk", "@stepkit/cli"] as const) {
      const range = section[packageName];
      if (typeof range !== "string") {
        continue;
      }
      const installedVersion = minVersion(range)?.version ?? range.match(/^\d+\.\d+\.\d+/u)?.[0];
      versions.set(packageName, {
        ...(installedVersion === undefined ? {} : { installedVersion }),
        targetVersion: installedVersion ?? range,
      });
    }
  }
  return versions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
