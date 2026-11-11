import {
  parseProviderUsageEvidence,
  parseProviderUsageEvidenceRequest,
} from "../../contracts/evidence/provider-evidence-adapter.schema.js";
import type {
  ProviderEvidenceDiagnostic,
  ProviderEvidenceInvocationResult,
  ProviderEvidenceRegistry,
  ProviderEvidenceRegistryEntry,
  ProviderUsageEvidenceRequestV1,
} from "../../contracts/evidence/provider-evidence-adapter.types.js";

/**
 * Core invocation helper for the provider-neutral evidence bridge.
 *
 * It resolves only from an injected ephemeral registry, validates the
 * request/export/response, enforces the response-byte budget and the
 * cooperative deadline, and converts every failure into a typed
 * `unsupported`/`unavailable` result. It never throws adapter errors and
 * never returns raw exceptions, parser input, transcripts or private paths.
 *
 * The read-only/non-mutating rule is a documented adapter trust contract:
 * an in-process helper cannot prevent filesystem writes. Likewise a timer
 * cannot preempt synchronous code, so `timeout` stops waiting without
 * proving the adapter stopped working.
 */

export interface InvokeProviderEvidenceAdapterOptions {
  readonly registry: ProviderEvidenceRegistry;
  readonly request: ProviderUsageEvidenceRequestV1;
}

const textEncoder = new TextEncoder();

export function createProviderEvidenceRegistry(
  entries: readonly ProviderEvidenceRegistryEntry[],
): ProviderEvidenceRegistry {
  const byId = new Map<string, ProviderEvidenceRegistryEntry>();
  for (const entry of entries) {
    if (byId.has(entry.registrationId)) {
      throw new Error(`Duplicate provider evidence registration "${entry.registrationId}".`);
    }
    byId.set(entry.registrationId, entry);
  }
  return {
    get(registrationId: string): ProviderEvidenceRegistryEntry | undefined {
      return byId.get(registrationId);
    },
  };
}

export async function invokeProviderEvidenceAdapter(
  options: InvokeProviderEvidenceAdapterOptions,
): Promise<ProviderEvidenceInvocationResult> {
  const originalRequest = options.request;
  const { signal, ...serializableRequest } = originalRequest;
  const requestParse = parseProviderUsageEvidenceRequest(serializableRequest);
  if (requestParse.status === "unsupported-version") {
    return { status: "unsupported", diagnostics: requestParse.diagnostics };
  }
  if (requestParse.status === "malformed") {
    return unavailable("malformed-request", "provider evidence request failed V1 validation");
  }
  const request: ProviderUsageEvidenceRequestV1 = {
    ...requestParse.request,
    ...(signal === undefined ? {} : { signal }),
  };

  const entry = options.registry.get(request.provider.registrationId);
  if (entry === undefined) {
    return unsupported(
      "missing-capability",
      `no registered evidence adapter for "${request.provider.registrationId}"`,
    );
  }
  if (entry.manifestProviderId !== request.provider.manifestProviderId) {
    return unsupported("identity-mismatch", "registration and manifest provider identities differ");
  }
  if (
    request.providerRoots.length === 0 ||
    request.providerRoots.every((root) => root.trim().length === 0)
  ) {
    // An empty authorized-root set is missing input, never a measured zero.
    return unavailable("missing-provider-roots", "no authorized provider roots were configured");
  }
  if (request.candidates.length > request.limits.maxCandidateRuns) {
    return unavailable("budget-exceeded", "candidate-run limit exceeded");
  }

  const call = await callWithDeadline(
    (callSignal) => entry.adapter.readUsage({ ...request, signal: callSignal }),
    request.signal,
    request.limits.deadlineMs,
  ).catch(() => undefined);
  if (call === undefined) {
    return unavailable("adapter-failed", "provider evidence adapter failed");
  }
  if (call.outcome !== "settled") {
    return call.outcome === "timeout"
      ? unavailable("timeout", "provider evidence adapter did not finish before the deadline")
      : unavailable("aborted", "provider evidence adapter was aborted");
  }

  const rawResponse = call.value;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(rawResponse);
  } catch {
    return unavailable("malformed-response", "provider response could not be serialized");
  }
  if (serialized === undefined) {
    return unavailable("malformed-response", "provider response was not serializable");
  }
  if (textEncoder.encode(serialized).byteLength > request.limits.maxResponseBytes) {
    return unavailable(
      "oversized-response",
      "provider response exceeded the configured byte limit",
    );
  }

  const responseParse = parseProviderUsageEvidence(rawResponse);
  if (responseParse.status === "unsupported-version") {
    return { status: "unsupported", diagnostics: responseParse.diagnostics };
  }
  if (responseParse.status === "malformed") {
    return unavailable("malformed-response", "provider response failed V1 validation");
  }

  return { status: "evidence", evidence: responseParse.evidence };
}

class ProviderEvidenceAbort extends Error {
  constructor(readonly reason: "timeout" | "aborted") {
    super(reason);
    this.name = "ProviderEvidenceAbort";
  }
}

async function callWithDeadline(
  invoke: (signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal | undefined,
  deadlineMs: number,
): Promise<
  | { readonly outcome: "settled"; readonly value: unknown }
  | { readonly outcome: "timeout" | "aborted" }
> {
  if (signal?.aborted === true) {
    return { outcome: "aborted" };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deadlineMs);

  const onAbort = (): void => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const value = await Promise.race([
      Promise.resolve().then(() => invoke(controller.signal)),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new ProviderEvidenceAbort(timedOut ? "timeout" : "aborted")),
          { once: true },
        );
      }),
    ]);
    return { outcome: "settled", value };
  } catch (error) {
    if (error instanceof ProviderEvidenceAbort) {
      return { outcome: error.reason };
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function unsupported(
  code: ProviderEvidenceDiagnostic["code"],
  message: string,
): ProviderEvidenceInvocationResult {
  return { status: "unsupported", diagnostics: [{ code, message }] };
}

function unavailable(
  code: ProviderEvidenceDiagnostic["code"],
  message: string,
): ProviderEvidenceInvocationResult {
  return { status: "unavailable", diagnostics: [{ code, message }] };
}
