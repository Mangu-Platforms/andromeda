import type { Store } from "../store.ts";

/**
 * `Store` backed by a single Supabase/Postgres table, spoken to directly over
 * PostgREST rather than through `@supabase/supabase-js` — this project's only
 * dependency exception is the Anthropic SDK, and a four-method REST client
 * does not earn a second one.
 *
 * `collection` and `id` map onto the table's composite primary key, and
 * `value` is stored as `jsonb`. See `supabase/migrations/` for the schema
 * this expects and its Row Level Security policy.
 */
export interface SupabaseStoreOptions {
  /** Project URL, e.g. `https://xyzcompany.supabase.co`. */
  url: string;
  /** Service role key (bypasses RLS) or anon/publishable key (subject to it). */
  apiKey: string;
  /** Defaults to `andromeda_store`. */
  table?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class SupabaseStore implements Store {
  readonly #restUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: SupabaseStoreOptions) {
    this.#restUrl = `${options.url.replace(/\/+$/, "")}/rest/v1/${options.table ?? "andromeda_store"}`;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.#apiKey,
      authorization: `Bearer ${this.#apiKey}`,
      "content-type": "application/json",
      ...extra,
    };
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    const res = await this.#fetch(`${this.#restUrl}${path}`, init);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`SupabaseStore: ${init.method ?? "GET"} ${path} failed (${res.status}): ${body}`);
    }
    return res;
  }

  async get<T>(collection: string, id: string): Promise<T | null> {
    const query = `collection=eq.${encodeURIComponent(collection)}&id=eq.${encodeURIComponent(id)}&select=value&limit=1`;
    const res = await this.#request(`?${query}`, { headers: this.#headers() });
    const rows = (await res.json()) as Array<{ value: T }>;
    return rows[0]?.value ?? null;
  }

  async put<T>(collection: string, id: string, value: T): Promise<void> {
    const query = "on_conflict=collection,id";
    await this.#request(`?${query}`, {
      method: "POST",
      headers: this.#headers({ prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify([{ collection, id, value }]),
    });
  }

  async list<T>(collection: string): Promise<Array<{ id: string; value: T }>> {
    const query = `collection=eq.${encodeURIComponent(collection)}&select=id,value&order=id.asc`;
    const res = await this.#request(`?${query}`, { headers: this.#headers() });
    return (await res.json()) as Array<{ id: string; value: T }>;
  }

  async delete(collection: string, id: string): Promise<void> {
    const query = `collection=eq.${encodeURIComponent(collection)}&id=eq.${encodeURIComponent(id)}`;
    await this.#request(`?${query}`, {
      method: "DELETE",
      headers: this.#headers({ prefer: "return=minimal" }),
    });
  }
}

/**
 * Build a `SupabaseStore` from the environment, or `null` to stay local.
 *
 * Prefers `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS; use server-side only)
 * and falls back to `SUPABASE_ANON_KEY` / `SUPABASE_PUBLISHABLE_KEY` (subject
 * to whatever policy the table carries). Takes the environment as a plain
 * object rather than reading `process.env` itself, so it stays as testable
 * as everything else in this package.
 */
export function supabaseStoreFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): SupabaseStore | null {
  const url = env.SUPABASE_URL;
  const apiKey = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_ANON_KEY ?? env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !apiKey) return null;
  return new SupabaseStore({ url, apiKey, ...(fetchImpl ? { fetchImpl } : {}) });
}
