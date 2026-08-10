import { type CliCommand, CliUsageError } from "../../command.types.js";
import { formatDeprecationFinding } from "../../deprecation-scan/deprecation-formatter.js";
import {
  type DeprecationFinding,
  scanWorkflowSourceForDeprecations,
} from "../../deprecation-scan/deprecation-scanner.js";
import { resolveInstalledTrailStepVersions } from "../../deprecation-scan/resolve-installed-trailstep-versions.js";
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
    const versionsByPackageName = await resolveInstalledTrailStepVersions({ cwd: context.cwd });
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
      context.io.writeLine("No TrailStep deprecation findings.");
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
