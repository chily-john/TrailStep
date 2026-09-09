import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import { runContextStorage } from "../../runtime/run-context/run-context-storage.js";

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export interface WorkflowInputApi<TInput extends PlainObject = PlainObject> {
  input(): Promise<DeepReadonly<TInput>>;
  input<TOverrideInput extends PlainObject>(): Promise<DeepReadonly<TOverrideInput>>;
  inputValue<TKey extends keyof TInput & string>(key: TKey): Promise<DeepReadonly<TInput[TKey]>>;
  inputValue<TOverrideInput extends PlainObject, TKey extends keyof TOverrideInput & string>(
    key: TKey,
  ): Promise<DeepReadonly<TOverrideInput[TKey]>>;
  withInput<TTypedInput extends PlainObject>(): WorkflowInputApi<TTypedInput>;
}

export const workflow: WorkflowInputApi = createWorkflowInputApi<PlainObject>();

function createWorkflowInputApi<TInput extends PlainObject>(): WorkflowInputApi<TInput> {
  return {
    async input() {
      return cloneAndFreeze(readWorkflowInput());
    },
    async inputValue(key: string) {
      const input = readWorkflowInput();
      return cloneAndFreeze(input[key]);
    },
    withInput<TTypedInput extends PlainObject>(): WorkflowInputApi<TTypedInput> {
      return createWorkflowInputApi<TTypedInput>();
    },
  } as WorkflowInputApi<TInput>;
}

function readWorkflowInput(): PlainObject {
  const runContext = runContextStorage.getStore();
  if (!runContext) {
    throw new Error("workflow.input() called outside an active TrailStep run.");
  }

  const input = runContext.events?.().find((event) => event.type === "workflow.started")
    ?.payload.input;
  if (!isPlainObject(input)) {
    throw new Error("workflow input is not available in the active TrailStep run.");
  }

  return input;
}

function cloneAndFreeze<T>(value: T): DeepReadonly<T> {
  return deepFreeze(structuredClone(value)) as DeepReadonly<T>;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  Object.freeze(value);
  for (const property of Object.values(value)) {
    deepFreeze(property);
  }

  return value;
}

function isPlainObject(value: unknown): value is PlainObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
