import { join } from "node:path";
import { buildGraph } from "../engine/build-graph.js";
import { buildFixtureGraph } from "../engine/fixture-harness.js";
import { type ArchManifest, manifest } from "../manifest.js";
import { STRICT_RULE_IMPLEMENTATIONS, type StrictRuleId } from "./run-rules.js";
import type { Diagnostic, RuleContext } from "./types.js";

/**
 * A fixture-only manifest. The group names stay the real ones (so the typed
 * manifest stays honest); the roots are fixture paths, and the conventions are
 * inherited from the production manifest. Tests are exempt from the portability
 * scan, so naming real groups here is deliberate.
 */
export const FIXTURE_MANIFEST: ArchManifest = {
  ...manifest,
  ranks: [
    {
      rank: 0,
      docGroups: ["json", "contracts"],
      forbiddenPeers: [],
      groups: [
        { name: "json", root: "src/json", targetGroup: "json" },
        { name: "contracts", root: "src/contracts", targetGroup: "contracts" },
      ],
    },
    {
      rank: 1,
      docGroups: ["authoring"],
      forbiddenPeers: [],
      groups: [{ name: "authoring", root: "src/authoring", targetGroup: "authoring" }],
    },
    {
      rank: 2,
      docGroups: ["providers", "run-store"],
      forbiddenPeers: [{ from: "providers", to: "run-store" }],
      groups: [
        { name: "providers", root: "src/providers", targetGroup: "providers" },
        { name: "runs", root: "src/runs", targetGroup: "run-store" },
      ],
    },
    {
      rank: 3,
      docGroups: ["execution", "evidence"],
      forbiddenPeers: [{ from: "execution", to: "evidence" }],
      groups: [
        { name: "runtime", root: "src/runtime", targetGroup: "execution" },
        { name: "agent-execution", root: "src/agent-execution", targetGroup: "execution" },
        // A fixture-only folder for the execution ↔ evidence exclusion; no
        // production group is declared here.
        { name: "evidence", root: "src/evidence", targetGroup: "evidence" },
      ],
    },
  ],
  unrankedGroups: [],
  typeOnlyFamilies: ["src/contracts/typed-family"],
  contractFamilyRoots: ["src/contracts/pending-family"],
  exemptions: [],
  demotions: [],
};

export interface FixtureCase {
  readonly files: Readonly<Record<string, string>>;
  readonly includeTests?: boolean;
}

export interface RuleFixture {
  readonly pass: FixtureCase;
  readonly fail: FixtureCase;
}

function numberedFiles(folder: string, count: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let index = 1; index <= count; index += 1) {
    const name = `part-${String(index).padStart(2, "0")}`;
    files[`${folder}/${name}.ts`] = `export const ${name.replace("-", "_")} = ${index};\n`;
  }
  return files;
}

const OWNER_FRONT_DOOR = "src/contracts/owner/owner.ts";
const OWNER_PRIVATE = "src/contracts/owner/private.ts";
const TYPED_FRONT_DOOR = "src/contracts/typed-family/typed-family.types.ts";
const PENDING_FRONT_DOOR = "src/contracts/pending-family/pending-family.types.ts";

export const RULE_FIXTURES: Readonly<Record<StrictRuleId, RuleFixture>> = {
  G1: {
    pass: {
      files: {
        "src/json/json.ts": "export const json = 1;\n",
        "src/contracts/contracts.ts":
          'import { json } from "../json/json.js";\nexport const contracts = json;\n',
      },
    },
    fail: {
      files: {
        "src/json/json.ts":
          'import { contracts } from "../contracts/contracts.js";\nexport const json = contracts;\n',
        "src/contracts/contracts.ts":
          'import { json } from "../json/json.js";\nexport const contracts = json;\n',
      },
    },
  },
  G2: {
    pass: {
      files: {
        "src/json/json.ts": "export const json = 1;\n",
        "src/contracts/contracts.ts":
          'import { json } from "../json/json.js";\nexport const contracts = json;\n',
      },
    },
    fail: {
      files: {
        "src/json/json.ts":
          'import { contracts } from "../contracts/contracts.js";\nexport const json = contracts;\n',
        "src/contracts/contracts.ts": "export const contracts = 1;\n",
      },
    },
  },
  G4: {
    // Regression fixture: the owner imports its own private sibling and exactly
    // one sibling area reaches in. The intra-owner edge must not count toward
    // the NCA span, so this is a pass (a single reach-in is a G8 case).
    pass: {
      files: {
        "src/runtime/scope/helper/helper.ts":
          'import { helperValue } from "./private.js";\nexport const helper = helperValue;\n',
        "src/runtime/scope/helper/private.ts": "export const helperValue = 1;\n",
        "src/runtime/scope/alpha/a.ts":
          'import { helperValue } from "../helper/private.js";\nexport const a = helperValue;\n',
      },
    },
    fail: {
      files: {
        "src/runtime/scope/helper/private.ts": "export const helper = 1;\n",
        "src/runtime/scope/alpha/a.ts":
          'import { helper } from "../helper/private.js";\nexport const a = helper;\n',
        "src/runtime/scope/beta/b.ts":
          'import { helper } from "../helper/private.js";\nexport const b = helper;\n',
      },
    },
  },
  G5: {
    pass: { files: numberedFiles("src/runtime/wide", 12) },
    fail: { files: numberedFiles("src/runtime/wide", 13) },
  },
  G8: {
    pass: {
      files: {
        [OWNER_FRONT_DOOR]: "export const owner = 1;\n",
        [OWNER_PRIVATE]: "export const privateValue = 1;\n",
        [TYPED_FRONT_DOOR]: "export type Typed = { value: number };\n",
        [PENDING_FRONT_DOOR]: "export type Pending = { value: number };\n",
        "src/authoring/consumer.ts":
          'import { owner } from "../contracts/owner/owner.js";\n' +
          'import type { Typed } from "../contracts/typed-family/typed-family.types.js";\n' +
          'import type { Pending } from "../contracts/pending-family/pending-family.types.js";\n' +
          "export const consumer: Typed & Pending = { value: owner };\n",
        "src/authoring/consumer.test.ts":
          'import { privateValue } from "../contracts/owner/private.js";\nexport const seen = privateValue;\n',
      },
    },
    fail: {
      files: {
        [OWNER_FRONT_DOOR]: "export const owner = 1;\n",
        [OWNER_PRIVATE]: "export const privateValue = 1;\n",
        "src/authoring/consumer.ts":
          'import { privateValue } from "../contracts/owner/private.js";\nexport const consumer = privateValue;\n',
      },
    },
  },
  "S-5": {
    pass: {
      files: {
        "src/runtime/capability/capability.ts": "export const capability = 1;\n",
      },
    },
    fail: {
      files: {
        "src/runtime/utils/utils.ts": "export const helper = 1;\n",
      },
    },
  },
  "S-6": {
    pass: {
      files: {
        "src/runtime/internal/capability/capability.ts":
          'import { policy } from "../policy/policy.js";\nexport const capability = policy;\n',
        "src/runtime/internal/policy/policy.ts": "export const policy = 1;\n",
      },
    },
    fail: {
      files: {
        "src/runtime/api/public.ts": "export const publicValue = 1;\n",
        "src/runtime/internal/capability/capability.ts":
          'import { publicValue } from "../../api/public.js";\nexport const capability = publicValue;\n',
      },
    },
  },
  "S-9": {
    pass: {
      files: {
        "src/runtime/runtime.ts": "export const runtime = 1;\n",
        "src/runtime/level/level.ts": "export const level = 1;\n",
        "src/runtime/level/only-child/only-child.ts": "export const child = 1;\n",
      },
    },
    fail: {
      files: {
        "src/runtime/runtime.ts": "export const runtime = 1;\n",
        "src/runtime/level/only-child/only-child.ts": "export const child = 1;\n",
      },
    },
  },
  "V-4": {
    pass: {
      // The folder already carries the prefix: three `scheduler-*.ts` files in
      // `scheduler/` mean the folder exists, so `scheduler/scheduler-a.ts` is
      // not a missing level (P2-2's false-positive class).
      files: {
        "src/runtime/scheduler/scheduler.ts": "export const scheduler = 1;\n",
        "src/runtime/scheduler/scheduler-a.ts": "export const a = 1;\n",
        "src/runtime/scheduler/scheduler-b.ts": "export const b = 1;\n",
        "src/runtime/scheduler/scheduler-c.ts": "export const c = 1;\n",
      },
    },
    fail: {
      // The doc's literal case: scheduler-*.ts in a folder that does not carry
      // the prefix (`runtime/run-workflow`), so `scheduler/` is missing.
      files: {
        "src/runtime/run-workflow/run-workflow.ts": "export const workflow = 1;\n",
        "src/runtime/run-workflow/scheduler-a.ts": "export const a = 1;\n",
        "src/runtime/run-workflow/scheduler-b.ts": "export const b = 1;\n",
        "src/runtime/run-workflow/scheduler-c.ts": "export const c = 1;\n",
      },
    },
  },
  "V-6": {
    pass: {
      files: {
        "src/runtime/owner/owner.ts": "export const owner = 1;\n",
      },
    },
    fail: {
      files: {
        "src/runtime/owner/private.ts": "export const privateValue = 1;\n",
      },
    },
  },
  "N-1": {
    pass: {
      files: {
        "src/index.ts": "export const root = 1;\n",
        "src/runtime/owner/owner.ts": "export const owner = 1;\n",
      },
    },
    fail: {
      files: {
        "src/runtime/helpers.ts": "export const helpers = 1;\n",
      },
    },
  },
  "M-6": {
    pass: {
      files: {
        "src/runtime/internal/capability/capability.ts":
          "export const readHome = (env: { HOME?: string }): string | undefined => env.HOME;\n",
      },
    },
    fail: {
      files: {
        "src/runtime/internal/capability/capability.ts": "export const home = process.env.HOME;\n",
      },
    },
  },
  "T-1": {
    pass: {
      includeTests: true,
      files: {
        "src/runtime/owner/owner.ts": "export const owner = 1;\n",
        "src/runtime/owner/owner.test.ts":
          'import { owner } from "./owner.js";\nexport const t = owner;\n',
      },
    },
    fail: {
      includeTests: true,
      files: {
        "src/runtime/owner/owner.ts": "export const owner = 1;\n",
        "src/authoring/owner.test.ts":
          'import { owner } from "../runtime/owner/owner.js";\nexport const t = owner;\n',
      },
    },
  },
  "T-2": {
    pass: {
      includeTests: true,
      files: {
        "src/runtime/owner/owner.ts": "export const owner = 1;\n",
        "src/runtime/owner/owner.test.ts":
          'import { owner } from "./owner.js";\nexport const t = owner;\n',
      },
    },
    fail: {
      includeTests: true,
      files: {
        "src/contracts/contracts.ts": "export const contracts = 1;\n",
        "src/providers/providers.ts": "export const providers = 1;\n",
        // No unit anywhere and two foreign §8.1 groups touched: cross-cutting.
        "src/runtime/integration.test.ts":
          'import { contracts } from "../contracts/contracts.js";\n' +
          'import { providers } from "../providers/providers.js";\n' +
          "export const t = contracts + providers;\n",
      },
    },
  },
};

/** The in-memory read seam: fixture rules never read the real filesystem. */
export function fixtureRuleContext(fixture: FixtureCase): RuleContext {
  return { readSource: (filePath: string) => fixture.files[filePath] };
}

/** Runs one rule against one fixture and returns only that rule's diagnostics. */
export function runRuleOnFixture(
  rule: StrictRuleId,
  fixture: FixtureCase,
  context: RuleContext = fixtureRuleContext(fixture),
): Diagnostic[] {
  const materialized = buildFixtureGraph({ files: fixture.files }, FIXTURE_MANIFEST);
  try {
    const graph =
      fixture.includeTests === true
        ? buildGraph({
            projectRoot: materialized.projectRoot,
            tsconfig: join(materialized.projectRoot, "tsconfig.json"),
            manifest: FIXTURE_MANIFEST,
            includeTests: true,
          })
        : materialized.graph;
    return STRICT_RULE_IMPLEMENTATIONS[rule](graph, FIXTURE_MANIFEST, context);
  } finally {
    materialized.cleanup();
  }
}
