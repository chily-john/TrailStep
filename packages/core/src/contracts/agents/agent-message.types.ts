import type { PlainObject, Schema } from "../shapes/shape.types.js";

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
