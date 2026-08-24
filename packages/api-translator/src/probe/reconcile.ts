import type {
  ApiSpec,
  AuthScheme,
  Field,
  Operation,
  ProvenanceRecord,
} from "../spec/types.ts";
import type { ApiProbe, ProbeRequest, ProbeResponse } from "./types.ts";
import { renderProbePath } from "./types.ts";

/**
 * Reconcile documentation against the live API. The probe wins.
 *
 * This is the product's central claim, and the reason it can be sold to API
 * *consumers* rather than producers: the docs for somebody else's API are
 * frequently wrong, and the difference between "optional per the docs" and
 * "400 without it" is an SDK that compiles and then fails in production.
 *
 * So documentation is treated as a hypothesis and the probe as the observation.
 * Every disagreement is resolved in the probe's favour and recorded as a
 * `ProvenanceRecord` carrying the concrete request that settles it — the
 * canonical spec must never say something surprising without a receipt.
 *
 * What this deliberately does not do is infer. A probe that fails to
 * demonstrate an auth scheme leaves it `unconfirmed`; it does not guess.
 */

export interface ReconcileOptions {
  spec: ApiSpec;
  probe: ApiProbe;
  /**
   * Sample values for path parameters, per operation. Reconciliation skips an
   * operation it cannot address rather than inventing an id and reporting the
   * resulting 404 as evidence about a field.
   */
  samples?: Record<string, Record<string, string>>;
  /** Credentials for the authenticated probes. */
  credentials?: Record<string, string>;
}

export interface ReconcileResult {
  spec: ApiSpec;
  provenance: ProvenanceRecord[];
  /** Operations skipped for want of a usable sample, with the reason. */
  skipped: Array<{ operationId: string; reason: string }>;
}

const CLIENT_ERROR = 400;
const SERVER_ERROR = 500;

/** A required field is one the API refuses to work without. */
function omitting(field: string, base: ProbeRequest): ProbeRequest {
  const body = { ...(base.body ?? {}) };
  delete body[field];
  const query = { ...base.query };
  delete query[field];
  return { ...base, body: base.body === null ? null : body, query };
}

export async function reconcileWithProbe(
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const provenance: ProvenanceRecord[] = [];
  const skipped: Array<{ operationId: string; reason: string }> = [];
  const operations: Operation[] = [];

  for (const operation of options.spec.operations) {
    const samples = options.samples?.[operation.operationId] ?? {};
    const missing = pathParamsOf(operation).filter((name) => samples[name] === undefined);
    if (missing.length > 0) {
      // Inventing an id would produce a 404 and we would then "learn" that
      // every field is required. Silence is more honest than bad evidence.
      skipped.push({
        operationId: operation.operationId,
        reason: `no sample value for path parameter(s): ${missing.join(", ")}`,
      });
      operations.push(operation);
      continue;
    }

    const base = baseRequest(operation, samples, options.credentials ?? {});
    const reconciled = await reconcileOperation(operation, base, options.probe, provenance);
    operations.push(reconciled);
  }

  const auth = await confirmAuth(options.spec, operations, options.samples ?? {}, options, provenance);

  return { spec: { ...options.spec, auth, operations }, provenance, skipped };
}

const pathParamsOf = (operation: Operation): string[] =>
  [...operation.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string);

function baseRequest(
  operation: Operation,
  samples: Record<string, string>,
  credentials: Record<string, string>,
): ProbeRequest {
  const query: Record<string, string> = {};
  for (const parameter of operation.parameters) {
    if (parameter.in !== "query") continue;
    query[parameter.name] = samples[parameter.name] ?? "probe";
  }

  const body: Record<string, unknown> | null =
    operation.requestBody.length === 0 ? null : {};
  if (body) {
    for (const field of operation.requestBody) {
      body[field.name] = samples[field.name] ?? sampleFor(field);
    }
  }

  return {
    operationId: operation.operationId,
    method: operation.method,
    path: operation.path,
    pathParams: Object.fromEntries(pathParamsOf(operation).map((n) => [n, samples[n] as string])),
    query,
    headers: { ...credentials },
    body,
    authenticated: true,
  };
}

const sampleFor = (field: Field): unknown => {
  switch (field.type) {
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return true;
    case "string[]":
      return ["probe"];
    case "integer[]":
      return [1];
    case "object":
      return {};
    default:
      return "probe";
  }
};

async function reconcileOperation(
  operation: Operation,
  base: ProbeRequest,
  probe: ApiProbe,
  provenance: ProvenanceRecord[],
): Promise<Operation> {
  const baseline = await probe.send(base);

  // A baseline that already fails tells us nothing about individual fields:
  // every omission would fail too, and we would mark the whole body required.
  if (baseline.status >= CLIENT_ERROR) {
    provenance.push({
      target: `${operation.operationId}`,
      claimedByDocs: "the documented request should succeed",
      observedByProbe: `${baseline.status} ${baseline.message}`.trim(),
      resolution: "probe-wins",
      evidence: `${base.method} ${renderProbePath(base)} -> ${baseline.status}`,
    });
    return operation;
  }

  const requestBody = await reconcileFields(
    operation,
    operation.requestBody,
    "body",
    base,
    probe,
    provenance,
  );
  const parameters = await reconcileFields(
    operation,
    operation.parameters.filter((p) => p.in === "query"),
    "query",
    base,
    probe,
    provenance,
  );

  const untouched = operation.parameters.filter((p) => p.in !== "query");
  const merged = [...untouched, ...(parameters as Operation["parameters"])];

  // The observed status belongs in the spec even when the docs never mentioned it.
  const responses = mergeObservedStatus(operation, baseline, provenance, base);

  return { ...operation, requestBody, parameters: merged, responses };
}

/**
 * Omit each documented field in turn and see whether the API objects.
 *
 * The probe decides required-ness in both directions: a field the docs called
 * optional that draws a 400 becomes required, and one called required that the
 * API happily accepts without becomes optional. A 5xx is not evidence — the
 * server broke, which says nothing about the contract.
 */
async function reconcileFields<T extends Field>(
  operation: Operation,
  fields: T[],
  where: "body" | "query",
  base: ProbeRequest,
  probe: ApiProbe,
  provenance: ProvenanceRecord[],
): Promise<T[]> {
  const out: T[] = [];

  for (const field of fields) {
    const response = await probe.send(omitting(field.name, base));
    const target = `${operation.operationId}.${where}.${field.name}.required`;
    const evidence = `${base.method} ${renderProbePath(base)} without "${field.name}" -> ${response.status}`;

    if (response.status >= SERVER_ERROR) {
      // The server fell over. Keep the documented claim and say why.
      provenance.push({
        target,
        claimedByDocs: String(field.required),
        observedByProbe: `${response.status} (server error, not evidence)`,
        resolution: "human-decision",
        evidence,
      });
      out.push(field);
      continue;
    }

    const observedRequired = response.status >= CLIENT_ERROR;
    if (observedRequired === field.required) {
      provenance.push({
        target,
        claimedByDocs: String(field.required),
        observedByProbe: String(observedRequired),
        resolution: "docs-confirmed",
        evidence,
      });
      out.push(field);
      continue;
    }

    provenance.push({
      target,
      claimedByDocs: String(field.required),
      observedByProbe: String(observedRequired),
      resolution: "probe-wins",
      evidence: `${evidence}: ${response.message}`.trim(),
    });
    out.push({ ...field, required: observedRequired });
  }

  return out;
}

function mergeObservedStatus(
  operation: Operation,
  baseline: ProbeResponse,
  provenance: ProvenanceRecord[],
  base: ProbeRequest,
): Operation["responses"] {
  if (operation.responses.some((r) => r.status === baseline.status)) return operation.responses;

  provenance.push({
    target: `${operation.operationId}.responses.${baseline.status}`,
    claimedByDocs: `statuses ${operation.responses.map((r) => r.status).join(", ") || "(none)"}`,
    observedByProbe: String(baseline.status),
    resolution: "probe-wins",
    evidence: `${base.method} ${renderProbePath(base)} -> ${baseline.status}`,
  });

  return [
    ...operation.responses,
    { status: baseline.status, contentType: baseline.contentType, fields: [] },
  ];
}

/**
 * Confirm the auth scheme by withholding credentials.
 *
 * An API that answers 2xx to an unauthenticated request does not have the auth
 * scheme the docs claim, and that is worth knowing before an SDK ships assuming
 * it does. Confirmation is only ever raised to `"probe"` on positive evidence:
 * anything ambiguous stays `unconfirmed`, which is what codegen refuses to emit.
 */
async function confirmAuth(
  spec: ApiSpec,
  operations: Operation[],
  samples: Record<string, Record<string, string>>,
  options: ReconcileOptions,
  provenance: ProvenanceRecord[],
): Promise<AuthScheme> {
  if (spec.auth.kind === "none") return spec.auth;

  const candidate = operations.find(
    (operation) => pathParamsOf(operation).every((n) => samples[operation.operationId]?.[n] !== undefined),
  );
  if (!candidate) return spec.auth;

  const sample = samples[candidate.operationId] ?? {};
  const unauthenticated: ProbeRequest = {
    ...baseRequest(candidate, sample, {}),
    headers: {},
    authenticated: false,
  };
  const response = await options.probe.send(unauthenticated);
  const evidence = `${unauthenticated.method} ${renderProbePath(unauthenticated)} without credentials -> ${response.status}`;

  if (response.status === 401 || response.status === 403) {
    provenance.push({
      target: "auth.confirmation",
      claimedByDocs: spec.auth.kind,
      observedByProbe: `${response.status}: credentials are enforced`,
      resolution: "probe-wins",
      evidence,
    });
    return { ...spec.auth, confirmation: "probe" };
  }

  if (response.status < CLIENT_ERROR) {
    // Worth flagging loudly: the documented scheme is not actually enforced.
    provenance.push({
      target: "auth.confirmation",
      claimedByDocs: `${spec.auth.kind} is required`,
      observedByProbe: `${response.status}: the API answered without credentials`,
      resolution: "probe-wins",
      evidence,
    });
  }

  // Anything else is ambiguous, and ambiguity does not raise confirmation.
  return { ...spec.auth, confirmation: "unconfirmed" };
}
