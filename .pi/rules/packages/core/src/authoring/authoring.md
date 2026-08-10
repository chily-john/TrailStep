# TrailStep authoring package rule

Built workflow packages must preserve the caller directory structure so prompt templates and other local assets resolve from the package layout the author tested.

Use the continuation model (`defineWorkflow({ ... start })`, `step(...)`, and `done(...)`) for new workflow examples and tests.
