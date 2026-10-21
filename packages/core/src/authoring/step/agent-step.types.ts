/**
 * Agent step request configuration.
 *
 * The declaration lives in `contracts/agents/agent-adapter.types.ts` because it
 * is mutually recursive with the adapter contract (the adapter request embeds
 * the step config, and the step config embeds the adapter selection). It is
 * re-exported here so authoring code can keep importing the step-facing name
 * from the authoring layer.
 */
export type { AgentStepRequestConfig } from "../../contracts/agents/agent-adapter.types.js";
