-- The one table `SupabaseStore` (packages/core/src/store/supabase.ts) speaks
-- to over PostgREST. `collection` + `id` mirror the three-method `Store`
-- interface; everything else lives inside the jsonb `value`, so runs,
-- checkpoints, approvals and audit events all persist here without further
-- schema.
create table if not exists public.andromeda_store (
  collection text not null,
  id         text not null,
  value      jsonb not null,
  primary key (collection, id)
);

-- RLS on with no policies means deny-all for anon/authenticated keys. The
-- console runs server-side with the service-role key, which bypasses RLS —
-- so nothing is granted here until per-operator policies exist. Do not put
-- the service-role key in anything client-side.
alter table public.andromeda_store enable row level security;
