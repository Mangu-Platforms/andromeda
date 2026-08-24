import type { ApiProbe, ProbeRequest, ProbeResponse } from "./types.ts";

/**
 * What the *real* API does, expressed as data — independent of what its
 * documentation claims. Tests write the truth here and then assert that the
 * translator discovers it.
 */
export interface ScriptedRoute {
  operationId: string;
  /** Body fields the live API actually rejects requests without. */
  requiredBody?: string[];
  /** Query parameters the live API actually rejects requests without. */
  requiredQuery?: string[];
  /** Default true: the live API answers 401 without credentials. */
  requiresAuth?: boolean;
  successStatus?: number;
  /** Exactly what a successful call returns, undocumented fields included. */
  responseBody?: Record<string, unknown>;
  /** Set when the documented operation does not exist on the live API at all. */
  notFound?: boolean;
}

/**
 * Offline stand-in for a live API.
 *
 * Deterministic and hermetic: no timers, no network, no randomness, so a probe
 * transcript is reproducible and can be asserted byte-for-byte.
 */
export class ScriptedProbe implements ApiProbe {
  readonly name = "scripted";
  /** Every request made, in order. Assert against this to pin probe volume. */
  readonly calls: ProbeRequest[] = [];
  readonly #routes = new Map<string, ScriptedRoute>();

  constructor(routes: ScriptedRoute[]) {
    for (const route of routes) this.#routes.set(route.operationId, route);
  }

  async send(request: ProbeRequest): Promise<ProbeResponse> {
    this.calls.push(JSON.parse(JSON.stringify(request)) as ProbeRequest);
    const route = this.#routes.get(request.operationId);

    if (!route || route.notFound === true) {
      return json(404, { error: "not_found" }, "no such endpoint");
    }
    if (route.requiresAuth !== false && !request.authenticated) {
      return json(401, { error: "unauthorized" }, "credentials required");
    }

    const body = request.body ?? {};
    for (const field of route.requiredBody ?? []) {
      if (!Object.hasOwn(body, field)) {
        return json(
          400,
          { error: "invalid_request", param: field },
          `missing required field "${field}"`,
        );
      }
    }
    for (const param of route.requiredQuery ?? []) {
      if (!Object.hasOwn(request.query, param)) {
        return json(
          400,
          { error: "invalid_request", param },
          `missing required query parameter "${param}"`,
        );
      }
    }

    return json(route.successStatus ?? 200, route.responseBody ?? {}, "ok");
  }
}

const json = (
  status: number,
  body: Record<string, unknown>,
  message: string,
): ProbeResponse => ({ status, contentType: "application/json", body, message });
