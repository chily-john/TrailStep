import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ProviderUsageEvidenceV1,
  parseTrailStepConfig,
  type TrailStepConfig,
  type TrailStepProviderManifest,
  type TrailStepProviderRegistration,
} from "@trailstep/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CliCommandContext } from "../command-framework/command.types.js";
import {
  loadConfiguredProviderEvidence,
  loadProviderEvidencePackage,
} from "./provider-evidence-loader.js";
import { resolveRegisteredProviderPackageRoot } from "./provider-package-root.js";

const validManifest: TrailStepProviderManifest = {
  schemaVersion: 1,
  id: "pi",
  displayName: "Pi Provider",
  working: {
    supported: true,
    command: "pi",
    args: ["--prompt", "{{promptFile}}", "--output", "{{outputFile}}"],
    prompt: { kind: "prompt-file", reference: "at-prefixed-argument" },
    output: { style: "stdout-json-envelope", parsing: { resultField: "result" } },
  },
  interactive: {
    supported: false,
    reason: "Working-agent only.",
    modelFlag: "--model",
  },
  model: { supported: true, flag: "--model" },
  thinking: { supported: true, flag: "--thinking", levels: ["low", "medium"] },
};

const completeResponse: ProviderUsageEvidenceV1 = {
  kind: "trailstep.provider-usage-evidence",
  schemaVersion: 1,
  observedAt: "2026-11-11T14:00:00.000Z",
  status: "complete",
  coverage: "complete",
  activities: [],
  subtotals: [],
  diagnostics: [],
};

const createdRoots: string[] = [];

afterEach(async () => {
  for (const root of createdRoots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

async function packageDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "trailstep-provider-evidence-"));
  createdRoots.push(root);
  const packageRoot = join(root, "pi-package");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify(
      {
        name: "@example/trailstep-provider-pi",
        version: "1.2.3",
        type: "module",
        exports: "./index.mjs",
      },
      null,
      2,
    ),
    "utf8",
  );
  return packageRoot;
}

function context(cwd: string, homeDir?: string): CliCommandContext {
  return {
    cwd,
    ...(homeDir === undefined ? {} : { homeDir }),
    io: { writeLine: () => undefined, writeError: () => undefined },
  };
}

function registration(
  overrides: Partial<TrailStepProviderRegistration> = {},
): TrailStepProviderRegistration {
  return {
    source: {
      type: "local-package",
      packageName: "@example/trailstep-provider-pi",
      spec: "/tmp/pi-package",
    },
    manifest: validManifest,
    ...overrides,
  };
}

function importerFor(provider: Record<string, unknown>) {
  return vi.fn(async () => ({ trailstepProvider: provider }));
}

function configWithEvidence(
  providerRoots: Record<string, readonly string[]>,
  registrationOverride: TrailStepProviderRegistration = registration(),
): TrailStepConfig {
  return parseTrailStepConfig({
    version: 1,
    customProviders: {},
    agents: {},
    providers: { pi: registrationOverride },
    settings: {
      evidence: { schemaVersion: 1, usage: true, providerRoots },
    },
  });
}

describe("loadProviderEvidencePackage", () => {
  it("loads only the callable evidence export from a registered package", async () => {
    const packageRoot = await packageDir();
    const importer = importerFor({
      manifest: validManifest,
      evidence: {
        schemaVersion: 1,
        adapterRevision: "pi-1",
        readUsage: async () => completeResponse,
      },
    });
    const loaded = await loadProviderEvidencePackage({
      registrationId: "pi",
      registration: registration(),
      scope: "project",
      context: context(packageRoot),
      packageRoot,
      importer,
    });

    expect(loaded.status).toBe("loaded");
    if (loaded.status === "loaded") {
      expect(loaded.registrationId).toBe("pi");
      expect(loaded.manifestProviderId).toBe("pi");
      expect(loaded.adapter.adapterRevision).toBe("pi-1");
      expect(loaded.packageRoot).toBe(packageRoot);
    }
    expect(importer).toHaveBeenCalledWith(pathToFileURL(resolve(packageRoot, "index.mjs")).href);
  });

  it("returns unsupported for local manifests, legacy custom providers and missing exports", async () => {
    for (const source of [
      { type: "local-manifest", path: "/tmp/manifest.json" },
      { type: "legacy-custom-provider" },
    ] as const) {
      const importer = vi.fn(async () => ({}));
      const loaded = await loadProviderEvidencePackage({
        registrationId: "pi",
        registration: registration({ source }),
        scope: "project",
        context: context("/tmp"),
        importer,
      });
      expect(loaded.status).toBe("unsupported");
      if (loaded.status === "unsupported") {
        expect(loaded.diagnostics[0]?.code).toBe("missing-capability");
      }
      expect(importer).not.toHaveBeenCalled();
    }

    const packageRoot = await packageDir();
    const missingExport = await loadProviderEvidencePackage({
      registrationId: "pi",
      registration: registration(),
      scope: "project",
      context: context(packageRoot),
      packageRoot,
      importer: importerFor({ manifest: validManifest }),
    });
    expect(missingExport.status).toBe("unsupported");
    if (missingExport.status === "unsupported") {
      expect(missingExport.diagnostics[0]?.code).toBe("missing-capability");
    }
  });

  it("rejects registration/manifest identity mismatches and unsupported adapter versions", async () => {
    const packageRoot = await packageDir();
    const mismatch = await loadProviderEvidencePackage({
      registrationId: "other",
      registration: registration(),
      scope: "project",
      context: context(packageRoot),
      packageRoot,
      importer: importerFor({
        manifest: validManifest,
        evidence: { schemaVersion: 1, readUsage: async () => completeResponse },
      }),
    });
    expect(mismatch.status).toBe("unavailable");
    if (mismatch.status === "unavailable") {
      expect(mismatch.diagnostics[0]?.code).toBe("identity-mismatch");
    }

    const loadedManifestMismatch = await loadProviderEvidencePackage({
      registrationId: "pi",
      registration: registration(),
      scope: "project",
      context: context(packageRoot),
      packageRoot,
      importer: importerFor({
        manifest: { ...validManifest, id: "not-pi" },
        evidence: { schemaVersion: 1, readUsage: async () => completeResponse },
      }),
    });
    expect(loadedManifestMismatch.status).toBe("unavailable");
    if (loadedManifestMismatch.status === "unavailable") {
      expect(loadedManifestMismatch.diagnostics[0]?.code).toBe("identity-mismatch");
    }

    const future = await loadProviderEvidencePackage({
      registrationId: "pi",
      registration: registration(),
      scope: "project",
      context: context(packageRoot),
      packageRoot,
      importer: importerFor({
        manifest: validManifest,
        evidence: { schemaVersion: 2, readUsage: async () => completeResponse },
      }),
    });
    expect(future.status).toBe("unsupported");
    if (future.status === "unsupported") {
      expect(future.diagnostics[0]?.code).toBe("unsupported-version");
    }
  });
});

describe("loadConfiguredProviderEvidence", () => {
  it("performs zero imports and invocations while evidence usage is off or omitted", async () => {
    const packageRoot = await packageDir();
    const importer = vi.fn(async () => ({}));
    const off = parseTrailStepConfig({
      version: 1,
      customProviders: {},
      agents: {},
      providers: { pi: registration() },
      settings: {
        evidence: { schemaVersion: 1, usage: false, providerRoots: { pi: ["/roots"] } },
      },
    });

    for (const config of [undefined, off]) {
      const result = await loadConfiguredProviderEvidence({
        config,
        scope: "project",
        context: context(packageRoot),
        importer,
      });
      expect(result.status).toBe("disabled");
    }
    expect(importer).not.toHaveBeenCalled();
  });

  it("treats missing/empty roots as unavailable instead of zero and never imports", async () => {
    const packageRoot = await packageDir();
    const importer = vi.fn(async () => ({}));
    const config = parseTrailStepConfig({
      version: 1,
      customProviders: {},
      agents: {},
      providers: { pi: registration() },
      settings: { evidence: { schemaVersion: 1, usage: true } },
    });

    const result = await loadConfiguredProviderEvidence({
      config,
      scope: "project",
      context: context(packageRoot),
      importer,
    });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.diagnostics[0]?.code).toBe("missing-provider-roots");
    }
    expect(importer).not.toHaveBeenCalled();
  });

  it("requires each root key to name a registered package provider", async () => {
    const packageRoot = await packageDir();
    const importer = vi.fn(async () => ({}));
    const config = configWithEvidence({ "unknown-provider": ["/roots"] });

    const result = await loadConfiguredProviderEvidence({
      config,
      scope: "project",
      context: context(packageRoot),
      importer,
    });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.diagnostics[0]?.code).toBe("missing-capability");
      expect(result.diagnostics[0]?.message).toContain("unregistered provider");
    }
    expect(importer).not.toHaveBeenCalled();
  });

  it("builds an ephemeral registry for enabled configured roots", async () => {
    const packageRoot = await packageDir();
    const importer = importerFor({
      manifest: validManifest,
      evidence: { schemaVersion: 1, readUsage: async () => completeResponse },
    });
    const config = configWithEvidence(
      { pi: ["/authorized/pi"] },
      registration({
        source: {
          type: "local-package",
          packageName: "@example/trailstep-provider-pi",
          spec: packageRoot,
        },
      }),
    );

    const result = await loadConfiguredProviderEvidence({
      config,
      scope: "project",
      context: context(packageRoot),
      importer,
    });
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.entries).toHaveLength(1);
      expect(result.registry.get("pi")?.manifestProviderId).toBe("pi");
      expect(result.diagnostics).toEqual([]);
    }
  });
});

describe("resolveRegisteredProviderPackageRoot", () => {
  it("keeps scope-sensitive package resolution unchanged", () => {
    const cliContext = context("/project", "/home/user");
    expect(
      resolveRegisteredProviderPackageRoot(
        { type: "local-package", packageName: "pkg", spec: "./local-pkg" },
        "project",
        cliContext,
      ),
    ).toBe(resolve("/project", "./local-pkg"));
    expect(
      resolveRegisteredProviderPackageRoot(
        { type: "npm", packageName: "@scope/pkg", spec: "@scope/pkg" },
        "project",
        cliContext,
      ),
    ).toBe(resolve("/project", "node_modules", "@scope", "pkg"));
    expect(
      resolveRegisteredProviderPackageRoot(
        { type: "github", packageName: "pkg", spec: "owner/repo" },
        "global",
        cliContext,
      ),
    ).toBe(resolve("/home/user", ".trailstep", "packages", "node_modules", "pkg"));
  });
});
