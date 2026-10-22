import type {
  CliCommandContext,
  PackageCommandRunner,
} from "../../command-framework/command.types.js";
import { rewritePackageJsonDependencies } from "../../package-manager/package-json-rewrite.js";
import { detectPackageManager } from "../../package-manager/package-manager.js";
import type { DependencyUpdateGroup } from "./update-dependency-groups.js";

export interface DependencyInstallFailure {
  readonly installRoot: string;
  readonly exitCode: number;
  readonly stderr?: string;
}

/**
 * Rewrites the dependency ranges of every group and runs the detected package
 * manager install in that group. Returns the first failure; the caller turns
 * it into the command's error output.
 */
export async function installDependencyUpdateGroups(
  groups: readonly DependencyUpdateGroup[],
  context: CliCommandContext,
  runPackageCommand: PackageCommandRunner,
): Promise<DependencyInstallFailure | undefined> {
  for (const group of groups) {
    await rewritePackageJsonDependencies({ cwd: group.installRoot, updates: group.updates });
    const packageManager = await detectPackageManager({ cwd: group.installRoot });
    for (const warning of packageManager.warnings) {
      context.io.writeLine(warning);
    }
    const installResult = await runPackageCommand({
      command: packageManager.installCommand.command,
      args: packageManager.installCommand.args,
      cwd: group.installRoot,
    });
    if (installResult.exitCode !== 0) {
      // package.json may already contain the rewritten dependency ranges; users can recover
      // by fixing the install issue and re-running their package manager install command.
      return {
        installRoot: group.installRoot,
        exitCode: installResult.exitCode,
        ...(installResult.stderr === undefined ? {} : { stderr: installResult.stderr }),
      };
    }
  }
  return undefined;
}
