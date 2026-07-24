import { StepKitFailureError, validationFailure } from "../../contracts/failures/failure.js";
import type { Schema, ValidationDiagnostic } from "../../contracts/shapes/shape.types.js";
import { writeDocumentArtifact } from "../../runtime/artifacts/run-storage.js";
import { state } from "../state/state.js";

export class Document<Name extends string = string> {
  // Index signature satisfies the `PlainObject` (`Record<string, unknown>`)
  // constraint required by `Schema<T extends PlainObject>` — a plain class
  // with only named properties does not structurally provide one otherwise.
  [key: string]: unknown;

  constructor(
    public readonly name: Name,
    public readonly content: string,
    public readonly path: string,
  ) {}
}

async function createDocument<Name extends string>(
  name: Name,
  content: string,
): Promise<Document<Name>> {
  const runDir = state.path;
  const path = await writeDocumentArtifact(runDir, name, content);

  return new Document(name, content, path);
}

export function document<Name extends string>(name: Name): Schema<Document<Name>>;
export function document<Name extends string>(name: Name, content: string): Promise<Document<Name>>;
export function document<Name extends string>(
  name: Name,
  content?: string,
): Schema<Document<Name>> | Promise<Document<Name>> {
  if (content !== undefined) {
    return createDocument(name, content);
  }

  const diagnostics = (value: unknown): readonly ValidationDiagnostic[] => {
    if (value instanceof Document) {
      return [];
    }

    return [{ path: "/", message: "must be a Document" }];
  };

  const schema: Schema<Document<Name>> = {
    validate(value: unknown): value is Document<Name> {
      return value instanceof Document;
    },
    diagnostics,
    assert(value: unknown, label = "value"): Document<Name> {
      const valueDiagnostics = diagnostics(value);

      if (valueDiagnostics.length > 0) {
        throw new StepKitFailureError(
          validationFailure(
            `${label} failed schema validation: ${formatDiagnostics(valueDiagnostics)}`,
            { diagnostics: valueDiagnostics },
          ),
        );
      }

      return value as Document<Name>;
    },
    jsonSchema: { type: "string", description: "Document content, captured as raw text." },
    captureMode: "raw-text",
    documentName: name,
  };

  return schema;
}

function formatDiagnostics(diagnostics: readonly ValidationDiagnostic[]): string {
  return diagnostics.map((diagnostic) => `${diagnostic.path} ${diagnostic.message}`).join("; ");
}
