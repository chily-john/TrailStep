import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Ephemeral full-project repro: builds a fresh sandbox project under the OS
// tmpdir, drives the local CLI build (never a global `trailstep`) through
// init -> fixture workflow -> workflows list -> run -> output -> doctor -> MCP
// listTools, verifying artifacts at every stage. The sandbox is deleted on
// success unless --keep is passed, and always kept (with its path printed) on
// failure.
//
// Isolation mirrors packages/cli/src/test/setup-clean-env.ts: HOME/USERPROFILE
// point into the sandbox and TRAILSTEP_* variables are stripped. The CLI has no
// global `--project` flag (only `trailstep mcp` does), so every CLI command
// runs with the sandbox as its cwd, which scopes `.trailstep/config.json`,
// discovery, and `.trailstep/runs` to the sandbox and prevents the repo root's
// own .trailstep/config.json from resolving.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = join(root, "packages", "cli", "dist", "index.js");
const coreDist = join(root, "packages", "core", "dist", "index.js");
const mcpServerDist = join(root, "packages", "mcp", "dist", "server.js");

const FIXTURE_PACKAGE = "@sandbox/trailstep-review-fixture";
const FIXTURE_REF = `${FIXTURE_PACKAGE}:review`;
const RUN_NAME = "sandbox-run";
const RUN_INPUT = '{"ok":true}';
const PROVIDER_PACKAGE_DIR = ["node_modules", "@trailstep", "provider-claude"];
const EXPECTED_MCP_TOOLS = ["trst_answer", "trst_resume", "trst_run_workflow", "trst_watch"];

const INIT_TIMEOUT_MS = 7 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 3 * 60 * 1000;
const POLL_INTERVAL_MS = 25;
const OUTPUT_TAIL_CHARS = 3000;

// Scripted answers for the interactive `trailstep init` flow (init has no
// --yes flag). Each response is written only after its prompt is observed on
// stdout, because @clack/prompts drops keypresses that arrive while no prompt
// is listening. Select prompts submit the highlighted first option on Enter
// ("\r"); confirm prompts submit immediately on the "n" keypress.
const INIT_PROMPTS = [
  { pattern: "Provider", response: "\r" },
  { pattern: "Model override", response: "\r" },
  { pattern: "Reasoning/thinking override", response: "\r" },
  { pattern: "Configure another agent?", response: "n" },
  { pattern: "Configure recommended run artifact lifecycle storage?", response: "n" },
  { pattern: "Register the TrailStep MCP server", response: "n" },
];

const keepSandbox = process.argv.includes("--keep");

class StageError extends Error {
  constructor(stage, message) {
    super(`stage "${stage}" failed: ${message}`);
    this.name = "StageError";
    this.stage = stage;
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function tail(text) {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_TAIL_CHARS ? trimmed.slice(-OUTPUT_TAIL_CHARS) : trimmed;
}

function sandboxEnv(home) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("TRAILSTEP_")) {
      env[key] = value;
    }
  }
  env.HOME = home;
  env.USERPROFILE = home;
  return env;
}

async function runCli(stage, args, options) {
  const { cwd, env, expectations = [], timeoutMs = COMMAND_TIMEOUT_MS } = options;
  const child = spawn(process.execPath, [cliEntry, ...args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let exit;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.on("error", () => {
    // The child may exit before consuming every scripted answer.
  });
  const exited = new Promise((resolveExit) => {
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      resolveExit(exit);
    });
    child.on("error", (error) => {
      exit = { code: null, error };
      resolveExit(exit);
    });
  });

  const deadline = Date.now() + timeoutMs;
  const combined = () => `${stdout}\n${stderr}`;
  const abort = (message) => {
    child.kill();
    throw new StageError(stage, `${message}\n--- output tail ---\n${tail(combined())}`);
  };

  try {
    if (expectations.length === 0) {
      child.stdin.end();
    }
    for (const { pattern, response } of expectations) {
      while (!stdout.includes(pattern)) {
        if (exit !== undefined) {
          abort(`CLI exited with code ${exit.code} before expected prompt "${pattern}"`);
        }
        if (Date.now() >= deadline) {
          abort(`timed out after ${timeoutMs}ms waiting for prompt "${pattern}"`);
        }
        await delay(POLL_INTERVAL_MS);
      }
      child.stdin.write(response);
    }
    if (expectations.length > 0) {
      // Every scripted answer has been written; closing stdin delivers EOF so
      // @clack/prompts' stdin keypress listener cannot keep the CLI process
      // alive after the final prompt resolves.
      child.stdin.end();
    }

    const remainingMs = Math.max(deadline - Date.now(), 1);
    const result = await Promise.race([exited, delay(remainingMs).then(() => undefined)]);
    if (result === undefined) {
      abort(`timed out after ${timeoutMs}ms waiting for the CLI to exit`);
    }
    if (result.error) {
      abort(`could not spawn the CLI: ${result.error.message}`);
    }
    if (result.code !== 0) {
      abort(`CLI exited with code ${result.code}`);
    }
    return { stdout, stderr };
  } catch (error) {
    child.kill();
    if (error instanceof StageError) {
      throw error;
    }
    throw new StageError(stage, error instanceof Error ? error.message : String(error));
  }
}

async function expectPath(stage, path, label) {
  try {
    await access(path);
  } catch {
    throw new StageError(stage, `expected ${label} to exist at ${path}`);
  }
}

async function stage(name, run) {
  console.log(`[sandbox] stage ${name}: running`);
  try {
    await run();
  } catch (error) {
    if (error instanceof StageError) {
      throw error;
    }
    throw new StageError(
      name,
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  }
  console.log(`[sandbox] stage ${name}: ok`);
}

function preflight() {
  const missing = [cliEntry, coreDist, mcpServerDist].filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new StageError(
      "preflight",
      `local build artifacts missing:\n${missing.join("\n")}\nRun \`pnpm build\` first.`,
    );
  }
}

async function initStage(sandbox, home, env) {
  await mkdir(home, { recursive: true });
  const consumerPackage = {
    name: "trailstep-sandbox",
    version: "0.0.0",
    private: true,
    type: "module",
  };
  await writeFile(join(sandbox, "package.json"), `${JSON.stringify(consumerPackage, null, 2)}\n`);

  await runCli("init", ["init", "--scope", "project", "--no-install-skill"], {
    cwd: sandbox,
    env,
    expectations: INIT_PROMPTS,
    timeoutMs: INIT_TIMEOUT_MS,
  });

  const configPath = join(sandbox, ".trailstep", "config.json");
  await expectPath("init", configPath, ".trailstep/config.json in the sandbox");
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new StageError("init", `.trailstep/config.json is not valid JSON: ${error.message}`);
  }
  if (
    config === null ||
    typeof config !== "object" ||
    Object.keys(config.agents ?? {}).length === 0
  ) {
    throw new StageError("init", ".trailstep/config.json has no configured agents");
  }
  await expectPath(
    "init",
    join(sandbox, ...PROVIDER_PACKAGE_DIR, "package.json"),
    "the selected official provider package install",
  );
}

async function fixtureStage(sandbox) {
  const consumerPath = join(sandbox, "package.json");
  const consumer = JSON.parse(await readFile(consumerPath, "utf8"));
  consumer.dependencies = { ...consumer.dependencies, [FIXTURE_PACKAGE]: "1.0.0" };
  await writeFile(consumerPath, `${JSON.stringify(consumer, null, 2)}\n`);

  const packageDir = join(sandbox, "node_modules", ...FIXTURE_PACKAGE.split("/"));
  await mkdir(packageDir, { recursive: true });
  const fixturePackage = {
    name: FIXTURE_PACKAGE,
    version: "1.0.0",
    type: "module",
    main: "./review.mjs",
    keywords: ["trailstep-workflow"],
  };
  await writeFile(join(packageDir, "package.json"), `${JSON.stringify(fixturePackage, null, 2)}\n`);

  const coreUrl = pathToFileURL(coreDist).href;
  const reviewSource = `import { done, step } from "${coreUrl}";

const schema = {
  validate: (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  diagnostics: () => [],
  assert: (value, label) => {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value;
    }
    throw new Error(label + " must be an object");
  },
};

const workflow = {
  id: "review",
  input: schema,
  output: schema,
  start: (input) =>
    step({ id: "prepare" })
      .do((stepInput) => done({ ...stepInput, prepared: true }))(input),
};

export const review = workflow;
export default workflow;
`;
  await writeFile(join(packageDir, "review.mjs"), reviewSource);

  await expectPath("fixture", join(packageDir, "review.mjs"), "the fixture workflow file");
}

async function workflowsStage(sandbox, home, env) {
  const { stdout } = await runCli("workflows", ["workflows"], { cwd: sandbox, env });
  if (!stdout.includes(FIXTURE_REF)) {
    throw new StageError(
      "workflows",
      `expected \`trailstep workflows\` to list ${FIXTURE_REF}\n--- output tail ---\n${tail(stdout)}`,
    );
  }
  void home;
}

async function runStage(sandbox, env) {
  const { stdout } = await runCli("run", [FIXTURE_REF, RUN_NAME, "--input", RUN_INPUT], {
    cwd: sandbox,
    env,
  });
  if (!stdout.includes("Workflow completed")) {
    throw new StageError(
      "run",
      `expected the run to report "Workflow completed"\n--- output tail ---\n${tail(stdout)}`,
    );
  }

  const eventsPath = join(sandbox, ".trailstep", "runs", RUN_NAME, "events.jsonl");
  await expectPath("run", eventsPath, "the run's events.jsonl");
  const events = await readFile(eventsPath, "utf8");
  for (const expected of ["step.started", "step.completed", "workflow.completed"]) {
    if (!events.includes(expected)) {
      throw new StageError("run", `events.jsonl is missing the ${expected} event`);
    }
  }
}

async function outputStage(sandbox, env) {
  const { stdout } = await runCli("output", ["output", RUN_NAME, "--json"], { cwd: sandbox, env });
  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new StageError(
      "output",
      `expected parseable JSON output\n--- output tail ---\n${tail(stdout)}`,
    );
  }
  if (parsed?.ok !== true || parsed?.prepared !== true) {
    throw new StageError(
      "output",
      `expected the typed result {ok: true, prepared: true}, got ${JSON.stringify(parsed)}`,
    );
  }
}

async function doctorStage(sandbox, env) {
  // runCli fails the stage when doctor exits non-zero.
  await runCli("doctor", ["doctor"], { cwd: sandbox, env });
}

async function mcpStage(sandbox, home) {
  const mcpRequire = createRequire(join(root, "packages", "mcp", "package.json"));
  let sdkPackage;
  let sdkRoot;
  try {
    const cjsClientPath = mcpRequire.resolve("@modelcontextprotocol/sdk/client/index.js");
    sdkRoot = resolve(dirname(cjsClientPath), "..", "..", "..");
    sdkPackage = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"));
  } catch (error) {
    throw new StageError("mcp", `could not resolve @modelcontextprotocol/sdk: ${error.message}`);
  }

  const clientImport = sdkPackage.exports?.["./client"]?.import;
  const starImport = sdkPackage.exports?.["./*"]?.import;
  if (typeof clientImport !== "string" || typeof starImport !== "string") {
    throw new StageError("mcp", "unexpected @modelcontextprotocol/sdk exports map");
  }

  const { Client } = await import(pathToFileURL(join(sdkRoot, clientImport)).href);
  const { InMemoryTransport } = await import(
    pathToFileURL(join(sdkRoot, starImport.replace("*", "inMemory.js"))).href
  );
  const { createServer } = await import(pathToFileURL(mcpServerDist).href);

  const server = createServer({ projectDir: sandbox, homeDir: home });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "trailstep-sandbox", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  await client.close().catch(() => undefined);

  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_MCP_TOOLS)) {
    throw new StageError(
      "mcp",
      `expected MCP tools ${EXPECTED_MCP_TOOLS.join(", ")}; got ${names.join(", ")}`,
    );
  }
  console.log(`[sandbox] MCP listTools: ${names.join(", ")}`);
}

async function main() {
  preflight();
  const sandbox = await mkdtemp(join(tmpdir(), "trailstep-sandbox-"));
  const home = join(sandbox, "home");
  const env = sandboxEnv(home);
  console.log(`[sandbox] sandbox project: ${sandbox}`);

  try {
    await stage("init", () => initStage(sandbox, home, env));
    await stage("fixture", () => fixtureStage(sandbox));
    await stage("workflows", () => workflowsStage(sandbox, home, env));
    await stage("run", () => runStage(sandbox, env));
    await stage("output", () => outputStage(sandbox, env));
    await stage("doctor", () => doctorStage(sandbox, env));
    await stage("mcp", () => mcpStage(sandbox, home));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[sandbox] ${message}`);
    console.error(`[sandbox] sandbox kept at ${sandbox}`);
    process.exitCode = 1;
    return;
  }

  if (keepSandbox) {
    console.log(`[sandbox] all stages passed; sandbox kept at ${sandbox}`);
  } else {
    await rm(sandbox, { recursive: true, force: true });
    console.log("[sandbox] all stages passed; sandbox removed");
  }
}

await main();
