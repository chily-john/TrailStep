import type { CliCommand, CliCommandContext } from "../../command-framework/command.types.js";
import { CliUsageError } from "../../command-framework/command.types.js";

import { parseProvidersCommandArgs } from "./providers-args.js";
import type { ProviderCommandArgs } from "./providers-command.types.js";
import { addProvider, migrateProviders, removeProvider } from "./providers-config.js";
import { inspectProvider, listProviders, showProvider } from "./providers-listing.js";
import { testProvider } from "./providers-test.js";

export const providersCommand: CliCommand<ProviderCommandArgs> = {
  name: "providers",
  parseArgs(argv: readonly string[]): ProviderCommandArgs {
    return parseProvidersCommandArgs(argv);
  },
  async run(args: ProviderCommandArgs, context: CliCommandContext): Promise<number> {
    try {
      if (args.action === "inspect") {
        return await inspectProvider(args.path, context);
      }
      if (args.action === "add") {
        return await addProvider(args, context);
      }
      if (args.action === "list") {
        return await listProviders(args, context);
      }
      if (args.action === "show") {
        return await showProvider(args, context);
      }
      if (args.action === "test") {
        return await testProvider(args, context);
      }
      if (args.action === "migrate") {
        return await migrateProviders(args, context);
      }
      return await removeProvider(args, context);
    } catch (error) {
      if (error instanceof CliUsageError) {
        context.io.writeError(error.message);
        return 1;
      }
      throw error;
    }
  },
};
