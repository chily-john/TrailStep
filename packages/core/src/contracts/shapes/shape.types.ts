export type PlainObject = Record<string, unknown>;

export interface ValidationDiagnostic {
  readonly path: string;
  readonly message: string;
}

export interface Schema<T extends PlainObject = PlainObject> {
  readonly validate: (value: unknown) => value is T;
  readonly diagnostics: (value: unknown) => readonly ValidationDiagnostic[];
  readonly assert: (value: unknown, label?: string) => T;
  readonly jsonSchema: Record<string, unknown>;
  readonly captureMode?: "json" | "raw-text";
  readonly documentName?: string;
}

export type ShapePrimitive = "string" | "number" | "boolean";
export type ShapeObject = Readonly<Record<string, ShapePrimitive>>;
export type ShapeInput<T extends PlainObject = PlainObject> = Schema<T> | ShapeObject;
