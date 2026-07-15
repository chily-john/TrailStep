// NOTE: `AgentAdapterRequest` is defined in `../engine/agent-invocation.types.ts` (it needs
// `AgentStepRequestConfig`, an authoring-layer type), but `AgentAdapter`/`AgentAdapterObject`
// below reference it in a value (function parameter) position. This type-only import is a
// deliberate, narrow exception to "shared never imports engine": it mirrors a genuine mutual
// dependency that already existed in the original flat `types.ts`, is fully erased at compile
// time (no runtime module reference), and preserving the exact public signatures of
// `AgentAdapter`/`AgentAdapterRequest` was required over strict layering purity. See the
// package's restructuring notes for more detail.
import type { AgentAdapterRequest } from "../engine/agent-invocation.types.js";
import type { PlainObject, Schema } from "./shape.types.js";

export interface AgentMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
}

export type AgentPromptRenderer<TInput extends PlainObject = PlainObject> = {
  bivarianceHack(context: { readonly input: TInput }): string;
}["bivarianceHack"];

export type AgentPrompt<TInput extends PlainObject = PlainObject> =
  | string
  | AgentPromptRenderer<TInput>;

export interface AgentTool<TInput extends PlainObject = PlainObject> {
  readonly name: string;
  readonly description?: string;
  readonly schema: Schema<TInput>;
  call(input: TInput): void | Promise<void>;
}

export type AgentAdapter<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> = {
  bivarianceHack(request: AgentAdapterRequest<TInput, TOutput>): void | Promise<void>;
}["bivarianceHack"];

export interface AgentAdapterObject<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  runAgentStep(request: AgentAdapterRequest<TInput, TOutput>): void | Promise<void>;
}

export type AgentAdapterSelection<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> = AgentAdapter<TInput, TOutput> | AgentAdapterObject<TInput, TOutput>;
