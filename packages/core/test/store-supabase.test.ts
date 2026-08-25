import { test } from "node:test";
import assert from "node:assert/strict";

import { SupabaseStore, supabaseStoreFromEnv } from "../src/store/supabase.ts";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(calls: Call[], respond: (call: Call) => Response) {
  return (async (url: string | URL, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
}

test("get sends a filtered select and unwraps the row", async () => {
  const calls: Call[] = [];
  const store = new SupabaseStore({
    url: "https://proj.supabase.co",
    apiKey: "svc-key",
    fetchImpl: fakeFetch(calls, () =>
      new Response(JSON.stringify([{ value: { hello: "world" } }]), { status: 200 }),
    ),
  });

  const result = await store.get<{ hello: string }>("runs", "run_1");

  assert.deepEqual(result, { hello: "world" });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.url,
    "https://proj.supabase.co/rest/v1/andromeda_store?collection=eq.runs&id=eq.run_1&select=value&limit=1",
  );
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.apikey, "svc-key");
  assert.equal(headers.authorization, "Bearer svc-key");
});

test("get returns null when no row matches", async () => {
  const store = new SupabaseStore({
    url: "https://proj.supabase.co",
    apiKey: "svc-key",
    fetchImpl: fakeFetch([], () => new Response(JSON.stringify([]), { status: 200 })),
  });

  assert.equal(await store.get("runs", "missing"), null);
});

test("put upserts on the composite key with merge-duplicates", async () => {
  const calls: Call[] = [];
  const store = new SupabaseStore({
    url: "https://proj.supabase.co",
    apiKey: "svc-key",
    fetchImpl: fakeFetch(calls, () => new Response(null, { status: 201 })),
  });

  await store.put("runs", "run_1", { status: "suspended" });

  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(calls[0]?.url, "https://proj.supabase.co/rest/v1/andromeda_store?on_conflict=collection,id");
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.prefer, "resolution=merge-duplicates,return=minimal");
  assert.deepEqual(JSON.parse(calls[0]?.init.body as string), [
    { collection: "runs", id: "run_1", value: { status: "suspended" } },
  ]);
});

test("list orders by id and maps rows", async () => {
  const store = new SupabaseStore({
    url: "https://proj.supabase.co",
    apiKey: "svc-key",
    fetchImpl: fakeFetch([], () =>
      new Response(
        JSON.stringify([
          { id: "a", value: 1 },
          { id: "b", value: 2 },
        ]),
        { status: 200 },
      ),
    ),
  });

  assert.deepEqual(await store.list("runs"), [
    { id: "a", value: 1 },
    { id: "b", value: 2 },
  ]);
});

test("delete issues a DELETE scoped to collection and id", async () => {
  const calls: Call[] = [];
  const store = new SupabaseStore({
    url: "https://proj.supabase.co",
    apiKey: "svc-key",
    fetchImpl: fakeFetch(calls, () => new Response(null, { status: 204 })),
  });

  await store.delete("runs", "run_1");

  assert.equal(calls[0]?.init.method, "DELETE");
  assert.equal(calls[0]?.url, "https://proj.supabase.co/rest/v1/andromeda_store?collection=eq.runs&id=eq.run_1");
});

test("a non-2xx response throws with the status and body, not a silent no-op", async () => {
  const store = new SupabaseStore({
    url: "https://proj.supabase.co",
    apiKey: "bad-key",
    fetchImpl: fakeFetch([], () => new Response("permission denied for table andromeda_store", { status: 401 })),
  });

  await assert.rejects(() => store.get("runs", "run_1"), /401/);
});

test("collection and id are percent-encoded rather than spliced into the query", async () => {
  const calls: Call[] = [];
  const store = new SupabaseStore({
    url: "https://proj.supabase.co",
    apiKey: "svc-key",
    fetchImpl: fakeFetch(calls, () => new Response(JSON.stringify([]), { status: 200 })),
  });

  await store.get("run events", "id&evil=1");

  assert.match(calls[0]?.url ?? "", /collection=eq\.run%20events/);
  assert.match(calls[0]?.url ?? "", /id=eq\.id%26evil%3D1/);
});

test("supabaseStoreFromEnv stays local without SUPABASE_URL", () => {
  assert.equal(supabaseStoreFromEnv({}), null);
  assert.equal(supabaseStoreFromEnv({ SUPABASE_URL: "https://proj.supabase.co" }), null);
});

test("supabaseStoreFromEnv prefers the service role key over the anon key", async () => {
  const calls: Call[] = [];
  const store = supabaseStoreFromEnv(
    {
      SUPABASE_URL: "https://proj.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "svc-key",
      SUPABASE_ANON_KEY: "anon-key",
    },
    fakeFetch(calls, () => new Response(JSON.stringify([]), { status: 200 })),
  );
  assert.ok(store);

  await store.list("runs");

  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.apikey, "svc-key");
});
