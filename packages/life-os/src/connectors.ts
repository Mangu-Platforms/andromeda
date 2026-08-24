import type { DomainId } from "./types.ts";
import { scanForInjection } from "./untrusted.ts";

/**
 * How much the system trusts an item's free text.
 *
 * `trusted`   — the user's own devices and accounts speaking in numbers.
 * `untrusted` — written by a third party. Displayed, never obeyed.
 * `quarantined` — untrusted *and* it tried to give the agent instructions.
 */
export type Trust = "trusted" | "untrusted" | "quarantined";

/**
 * Structured, connector-authored facts (times, amounts, flags) plus the free
 * text. Branching logic reads `fields`; `text` only ever reaches a summary
 * string or the brief.
 */
export interface ConnectorItem {
  id: string;
  fields: Record<string, string | number | boolean>;
  text: string;
  trust: Trust;
  /** Injection pattern ids matched in `text`. Non-empty implies quarantined. */
  flags: string[];
}

/** What a connector returns before the registry stamps trust on it. */
export interface RawItem {
  id: string;
  fields: Record<string, string | number | boolean>;
  text: string;
}

/**
 * MCP-shaped read-only source. One connector belongs to exactly one domain;
 * that binding is what connector isolation is enforced against.
 *
 * `authorship` is declared by the connector, not by its content: a mailbox is
 * third-party even when a particular message came from the user.
 */
export interface Connector {
  readonly id: string;
  readonly domain: DomainId;
  readonly authorship: "self" | "third_party";
  readonly resources: readonly string[];
  read(resource: string): Promise<RawItem[]>;
}

export class ConnectorAccessError extends Error {
  readonly connectorId: string;
  readonly domain: DomainId;

  constructor(domain: DomainId, connectorId: string, detail: string) {
    super(`domain "${domain}" may not read connector "${connectorId}": ${detail}`);
    this.name = "ConnectorAccessError";
    this.connectorId = connectorId;
    this.domain = domain;
  }
}

/**
 * The view of the world a domain agent gets. It holds only that domain's
 * connectors and has no reference to the registry, so there is no path from a
 * domain agent to another domain's data — asking for one by id is an error
 * rather than a silent empty result, because a silent empty result reads as
 * "no mail today" instead of "you are not allowed to look".
 */
export class ScopedConnectors {
  readonly domain: DomainId;
  readonly #allowed: Map<string, Connector>;

  constructor(domain: DomainId, allowed: readonly Connector[]) {
    this.domain = domain;
    this.#allowed = new Map(allowed.map((c) => [c.id, c]));
  }

  ids(): string[] {
    return [...this.#allowed.keys()].sort();
  }

  has(connectorId: string): boolean {
    return this.#allowed.has(connectorId);
  }

  /**
   * Read one resource. Trust is stamped here rather than by the connector, so a
   * connector cannot declare its own content trusted, and injection scanning
   * cannot be skipped by a source that forgets to call it.
   */
  async read(connectorId: string, resource: string): Promise<ConnectorItem[]> {
    const connector = this.#allowed.get(connectorId);
    if (!connector) {
      throw new ConnectorAccessError(
        this.domain,
        connectorId,
        `it is out of scope (in scope: ${this.ids().join(", ") || "none"})`,
      );
    }
    if (!connector.resources.includes(resource)) {
      throw new ConnectorAccessError(
        this.domain,
        connectorId,
        `unknown resource "${resource}"`,
      );
    }
    const raw = await connector.read(resource);
    return raw.map((item) => stamp(item, connector.authorship));
  }
}

function stamp(item: RawItem, authorship: "self" | "third_party"): ConnectorItem {
  if (authorship === "self") {
    return { ...item, trust: "trusted", flags: [] };
  }
  const flags = scanForInjection(item.text);
  return {
    ...item,
    trust: flags.length > 0 ? "quarantined" : "untrusted",
    flags,
  };
}

/**
 * Holds every connector and hands out per-domain views. Nothing else in the
 * package accepts a registry, so the only way to read connector data is through
 * a scope.
 */
export class ConnectorRegistry {
  readonly #byId = new Map<string, Connector>();

  register(connector: Connector): this {
    if (this.#byId.has(connector.id)) {
      throw new Error(`connector "${connector.id}" is already registered`);
    }
    const prefix = connector.id.split(".")[0];
    if (prefix !== connector.domain) {
      // Ids are read by humans in audit logs; a mail connector called
      // "finance.inbox" would make an isolation breach look routine.
      throw new Error(
        `connector "${connector.id}" belongs to domain "${connector.domain}" ` +
          `and must be named "${connector.domain}.*"`,
      );
    }
    if (connector.resources.length === 0) {
      throw new Error(`connector "${connector.id}" exposes no resources`);
    }
    this.#byId.set(connector.id, connector);
    return this;
  }

  ids(): string[] {
    return [...this.#byId.keys()].sort();
  }

  scopeTo(domain: DomainId): ScopedConnectors {
    const mine = [...this.#byId.values()].filter((c) => c.domain === domain);
    return new ScopedConnectors(domain, mine);
  }
}

/** Field readers. Connector data is `unknown`-ish by construction; coerce explicitly. */
export const numField = (item: ConnectorItem, key: string, fallback = 0): number => {
  const value = item.fields[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

export const strField = (item: ConnectorItem, key: string, fallback = ""): string => {
  const value = item.fields[key];
  return typeof value === "string" ? value : fallback;
};

export const boolField = (item: ConnectorItem, key: string, fallback = false): boolean => {
  const value = item.fields[key];
  return typeof value === "boolean" ? value : fallback;
};
