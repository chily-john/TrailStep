#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const forwardedArgs = args[0] === "--" ? args.slice(1) : args;
const vitestCli = resolve(scriptDir, "../node_modules/vitest/vitest.mjs");

const child = spawn(process.execPath, [vitestCli, "run", ...forwardedArgs], {
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
