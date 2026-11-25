/**
 * Portable entry point for the architecture CLI.
 *
 * Root scripts run this file instead of `dist/cli.js`, so a clean checkout works
 * after `pnpm install` with no separate build. The source entry is resolved
 * relative to this file, never the caller's working directory, and `argv[1]` is
 * set to the canonical source path so `cli.ts` still sees itself as the
 * entrypoint when this launcher is reached through a symlink.
 */

import "./typescript-loader.mjs";

import { fileURLToPath } from "node:url";

const entryUrl = new URL("./src/cli.ts", import.meta.url);

process.argv[1] = fileURLToPath(entryUrl);
await import(entryUrl.href);
