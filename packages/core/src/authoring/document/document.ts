import { TrailStepFailureError, validationFailure } from "../../contracts/failures/failure.js";
import type { ValidationDiagnostic } from "../../contracts/shapes/shape.types.js";
import { writeDocumentArtifact } from "../../runtime/artifacts/run-storage.js";
import { currentRunContext } from "../../runtime/run-context/run-context-storage.js";

/**
 * A captured document artifact. `Document` doubles as its own
 * `Schema<Document>`: `validate`/`diagnostics`/`assert`/`jsonSchema`/
 * `captureMode` are static members, so passing the class itself as
 * `.prompt(source, { output: Document })` gives both the TypeScript output
 * type and the runtime validator from one symbol -- no separate schema
 * constant to import or keep in sync.
 */
export class Document {
  // Index signature satisfies the `PlainObject` (`Record<string, unknown>`)
  // constraint required by `Schema<T extends PlainObject>` — a plain class
  // with only named properties does not structurally provide one otherwise.
  [key: string]: unknown;

  static readonly captureMode = "raw-text" as const;

  static readonly jsonSchema: Record<string, unknown> = {
    type: "string",
    description: "Document content, captured as raw text.",
  };

  static validate(value: unknown): value is Document {
    return isDocumentLike(value);
  }

  static diagnostics(value: unknown): readonly ValidationDiagnostic[] {
    if (isDocumentLike(value)) {
      return [];
    }

    return [
      { path: "/", message: "must be a document (an object with string content and path fields)" },
    ];
  }

  /**
   * Deliberately duck-types instead of checking `instanceof Document`: on
   * resume, a completed step's recorded output is replayed from
   * `events.jsonl` via `JSON.parse`, producing a plain deserialized object —
   * never a live `Document` instance — before `assert` is called on it. An
   * `instanceof` check would fail every such replay. `assert` reconstructs a
   * genuine `Document` from any content/path-shaped value, so every
   * consumer downstream — a live capture or a replayed value alike — always
   * receives a real `Document` instance with working prototype methods.
   */
  static assert(value: unknown, label = "value"): Document {
    const valueDiagnostics = Document.diagnostics(value);

    if (valueDiagnostics.length > 0 || !isDocumentLike(value)) {
      throw new TrailStepFailureError(
        validationFailure(
          `${label} failed schema validation: ${formatDiagnostics(valueDiagnostics)}`,
          {
            diagnostics: valueDiagnostics,
          },
        ),
      );
    }

    return new Document(value.content, value.path);
  }

  constructor(
    public readonly content: string,
    public readonly path: string,
  ) {}
}

/**
 * Captures `content` as a durable document artifact for the currently
 * executing step. Must be called from within a step's `.do()` callback —
 * it reads the step-scoped ambient context (`RunContext.currentStep`, set
 * by `withStepContext` for the duration of the step) to determine both the
 * directory to write into and this call's 1-based index within the step, so
 * that a step calling `document(...)` more than once gets
 * `document-1.md`, `document-2.md`, etc.
 */
export async function document(content: string): Promise<Document> {
  const { currentStep } = currentRunContext();

  if (!currentStep) {
    throw new Error(
      "document(...) must be called from within a step's `.do()` callback; no active step context was found.",
    );
  }

  const index = currentStep.nextDocumentIndex();
  const path = await writeDocumentArtifact(currentStep.dir, `document-${index}.md`, content);

  return new Document(content, path);
}

function isDocumentLike(value: unknown): value is { content: string; path: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).content === "string" &&
    typeof (value as Record<string, unknown>).path === "string"
  );
}

function formatDiagnostics(diagnostics: readonly ValidationDiagnostic[]): string {
  return diagnostics.map((diagnostic) => `${diagnostic.path} ${diagnostic.message}`).join("; ");
}
