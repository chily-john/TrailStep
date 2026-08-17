import { describe, expect, it } from "vitest";
import type { PackageCommandRequest } from "../command.types.js";
import { fetchNpmPackageMetadata, NpmRegistryError } from "./npm-registry.js";

describe("fetchNpmPackageMetadata", () => {
  it("uses npm view through the injected package command runner", async () => {
    const requests: PackageCommandRequest[] = [];

    const metadata = await fetchNpmPackageMetadata({
      cwd: "/repo",
      packageName: "@trailstep/core",
      packageCommandRunner: async (request) => {
        requests.push(request);
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            { version: "0.0.1", peerDependencies: { "@trailstep/core": "^0.0.1" } },
            { version: "0.0.2" },
          ]),
        };
      },
    });

    expect(requests).toEqual([
      {
        command: "npm",
        args: ["view", "@trailstep/core@*", "version", "peerDependencies", "--json"],
        cwd: "/repo",
      },
    ]);
    expect(metadata).toEqual({
      packageName: "@trailstep/core",
      versions: ["0.0.1", "0.0.2"],
      peerDependenciesByVersion: {
        "0.0.1": { "@trailstep/core": "^0.0.1" },
        "0.0.2": {},
      },
    });
  });

  it("accepts npm view's string shorthand when only the version field is returned", async () => {
    const metadata = await fetchNpmPackageMetadata({
      cwd: "/repo",
      packageName: "@trailstep/core",
      packageCommandRunner: async () => ({ exitCode: 0, stdout: JSON.stringify("0.1.0") }),
    });

    expect(metadata).toEqual({
      packageName: "@trailstep/core",
      versions: ["0.1.0"],
      peerDependenciesByVersion: { "0.1.0": {} },
    });
  });

  it("includes the package name when npm view fails", async () => {
    await expect(
      fetchNpmPackageMetadata({
        cwd: "/repo",
        packageName: "@trailstep/authoring",
        packageCommandRunner: async () => ({ exitCode: 1, stderr: "registry unavailable" }),
      }),
    ).rejects.toThrow(NpmRegistryError);
    await expect(
      fetchNpmPackageMetadata({
        cwd: "/repo",
        packageName: "@trailstep/authoring",
        packageCommandRunner: async () => ({ exitCode: 1, stderr: "registry unavailable" }),
      }),
    ).rejects.toThrow(/@trailstep\/authoring.*registry unavailable/s);
  });

  it("reports malformed npm view JSON clearly", async () => {
    await expect(
      fetchNpmPackageMetadata({
        cwd: "/repo",
        packageName: "@trailstep/cli",
        packageCommandRunner: async () => ({ exitCode: 0, stdout: "not json" }),
      }),
    ).rejects.toThrow(/Malformed npm view JSON for @trailstep\/cli/);
  });
});
