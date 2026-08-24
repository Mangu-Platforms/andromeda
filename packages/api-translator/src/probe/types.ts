import type { HttpMethod } from "../spec/types.ts";

/**
 * One live request the translator is prepared to make against the real API.
 *
 * The probe deliberately carries the `operationId` alongside the wire details:
 * everything the probe learns has to be attributable to a specific operation in
 * the canonical spec, or it cannot be turned into provenance.
 */
export interface ProbeRequest {
  operationId: string;
  method: HttpMethod;
  /** Templated path, e.g. `/customers/{customerId}/invoices`. */
  path: string;
  pathParams: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  /**
   * False when credentials are deliberately withheld. An API that answers 200
   * to an unauthenticated request has an auth scheme the docs got wrong.
   */
  authenticated: boolean;
}

export interface ProbeResponse {
  status: number;
  contentType: string;
  body: Record<string, unknown> | null;
  /** Whatever the API said about the failure, verbatim. Becomes evidence. */
  message: string;
}

/**
 * The seam between the translator and a real network.
 *
 * Nothing in this package implements this against `fetch`; the only
 * implementation shipped here is the offline `ScriptedProbe`, so the test suite
 * and every example run stay hermetic.
 */
export interface ApiProbe {
  readonly name: string;
  send(request: ProbeRequest): Promise<ProbeResponse>;
}

/** Concrete URL a probe request would hit, for evidence strings. */
export function renderProbePath(request: ProbeRequest): string {
  let path = request.path;
  for (const [name, value] of Object.entries(request.pathParams)) {
    path = path.split(`{${name}}`).join(value);
  }
  const query = Object.entries(request.query)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return query === "" ? path : `${path}?${query}`;
}
