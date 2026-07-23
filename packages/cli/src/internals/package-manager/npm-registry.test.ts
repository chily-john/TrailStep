import { describe, expect, it } from "vitest";
import type { PackageCommandRequest } from "../command.types.js";
import { fetchNpmPackageMetadata, NpmRegistryError } from "./npm-registry.js";

describe("fetchNpmPackageMetadata", () => {
  it("uses npm view through the injected package command runner", async () => {
    const requests: PackageCommandRequest[] = [];

    const metadata = await fetchNpmPackageMetadata({
      cwd: "/repo",
      packageName: "@stepkit/core",
      packageCommandRunner: async (request) => {
        requests.push(request);
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            { version: "0.0.1", peerDependencies: { "@stepkit/core": "^0.0.1" } },
            { version: "0.0.2" },
          ]),
        };
      },
    });

    expect(requests).toEqual([
      {
        command: "npm",
        args: ["view", "@stepkit/core@*", "version", "peerDependencies", "--json"],
        cwd: "/repo",
      },
    ]);
    expect(metadata).toEqual({
      packageName: "@stepkit/core",
      versions: ["0.0.1", "0.0.2"],
      peerDependenciesByVersion: {
        "0.0.1": { "@stepkit/core": "^0.0.1" },
        "0.0.2": {},
      },
    });
  });

  it("includes the package name when npm view fails", async () => {
    await expect(
      fetchNpmPackageMetadata({
        cwd: "/repo",
        packageName: "@stepkit/sdk",
        packageCommandRunner: async () => ({ exitCode: 1, stderr: "registry unavailable" }),
      }),
    ).rejects.toThrow(NpmRegistryError);
    await expect(
      fetchNpmPackageMetadata({
        cwd: "/repo",
        packageName: "@stepkit/sdk",
        packageCommandRunner: async () => ({ exitCode: 1, stderr: "registry unavailable" }),
      }),
    ).rejects.toThrow(/@stepkit\/sdk.*registry unavailable/s);
  });

  it("reports malformed npm view JSON clearly", async () => {
    await expect(
      fetchNpmPackageMetadata({
        cwd: "/repo",
        packageName: "@stepkit/cli",
        packageCommandRunner: async () => ({ exitCode: 0, stdout: "not json" }),
      }),
    ).rejects.toThrow(/Malformed npm view JSON for @stepkit\/cli/);
  });
});
