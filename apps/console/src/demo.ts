import { MockLLMProvider } from "@andromeda/core";
import type { ProjectSpec } from "@andromeda/autobuilder";

/**
 * Offline demo fixtures.
 *
 * Lets the console be run and reviewed end to end with no API key and no cloud
 * account. The first implementation attempt is wrong on purpose: the repair
 * loop and the test-gate are the parts worth seeing, and a fixture that passes
 * immediately would show neither.
 */
export const DEMO_SPEC: ProjectSpec = {
  specVersion: "1",
  name: "link-shortener",
  summary: "Shorten URLs and count how often each short link is followed.",
  template: "next-supabase-app",
  auth: { enabled: true, providers: ["email"] },
  entities: [
    {
      name: "links",
      summary: "A short code pointing at a destination URL.",
      ownerField: "owner_id",
      fields: [
        { name: "owner_id", type: "uuid", required: true, unique: false, references: "" },
        { name: "code", type: "text", required: true, unique: true, references: "" },
        { name: "destination", type: "text", required: true, unique: false, references: "" },
        { name: "hits", type: "integer", required: true, unique: false, references: "" },
      ],
    },
  ],
  routes: [
    {
      path: "/api/links",
      method: "POST",
      summary: "Create a short link from a destination URL.",
      feature: "create-link",
    },
    { path: "/api/links", method: "GET", summary: "List the caller's links.", feature: "" },
  ],
  features: [
    {
      id: "create-link",
      summary: "Validate a destination URL and allocate a short code for it.",
      acceptance: [
        "returns 401 when the request has no authenticated user",
        "returns 400 when destination is missing or is not an http(s) URL",
        "returns 201 with a six-character lowercase alphanumeric code derived from the destination",
      ],
    },
  ],
  env: [
    {
      name: "NEXT_PUBLIC_SUPABASE_URL",
      description: "Supabase project URL.",
      required: true,
      secret: false,
    },
    {
      name: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      description: "Supabase anon key, safe to expose to the browser.",
      required: true,
      secret: false,
    },
    {
      name: "SUPABASE_SERVICE_ROLE_KEY",
      description: "Service-role key used only to apply migrations from CI.",
      required: false,
      secret: true,
    },
  ],
  deploy: { target: "vercel" },
};

const DEMO_TESTS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "#features/create-link.ts";

const call = (body: unknown, userId: string | null = "user-1") =>
  handle({ method: "POST", path: "/api/links", query: {}, body, userId });

test("returns 401 when the request has no authenticated user", async () => {
  const result = await call({ destination: "https://example.com" }, null);
  assert.equal(result.status, 401);
});

test("returns 400 when destination is missing or is not an http(s) URL", async () => {
  assert.equal((await call({})).status, 400);
  assert.equal((await call({ destination: "javascript:alert(1)" })).status, 400);
  assert.equal((await call({ destination: "not a url" })).status, 400);
});

test("returns 201 with a six-character lowercase alphanumeric code", async () => {
  const result = await call({ destination: "https://example.com/a/very/long/path" });
  assert.equal(result.status, 201);
  const body = result.body as { code: string; destination: string };
  assert.match(body.code, /^[a-z0-9]{6}$/);
  assert.equal(body.destination, "https://example.com/a/very/long/path");

  // The same destination must produce the same code.
  const again = await call({ destination: "https://example.com/a/very/long/path" });
  assert.equal((again.body as { code: string }).code, body.code);
});
`;

/** Accepts any non-empty string and never checks the caller. */
const DEMO_IMPL_BROKEN = `import type { FeatureInput, FeatureResult } from "#features/contract.ts";

export async function handle(input: FeatureInput): Promise<FeatureResult> {
  const body = input.body as { destination?: string };
  if (!body?.destination) {
    return { status: 400, body: { error: "destination is required" } };
  }

  let hash = 0;
  for (const char of body.destination) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  const code = hash.toString(36).slice(0, 6);

  return { status: 201, body: { code, destination: body.destination } };
}
`;

const DEMO_IMPL_FIXED = `import type { FeatureInput, FeatureResult } from "#features/contract.ts";

const CODE_LENGTH = 6;

function shortCode(destination: string): string {
  // FNV-1a, so the same destination always maps to the same code.
  let hash = 2166136261;
  for (const char of destination) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36).padStart(CODE_LENGTH, "0").slice(0, CODE_LENGTH);
}

export async function handle(input: FeatureInput): Promise<FeatureResult> {
  if (!input.userId) {
    return { status: 401, body: { error: "authentication required" } };
  }

  const body = input.body as { destination?: unknown };
  const destination = typeof body?.destination === "string" ? body.destination : "";
  if (!destination) {
    return { status: 400, body: { error: "destination is required" } };
  }

  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return { status: 400, body: { error: "destination must be a valid URL" } };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { status: 400, body: { error: "destination must be an http(s) URL" } };
  }

  return { status: 201, body: { code: shortCode(destination), destination } };
}
`;

export function demoProvider(): MockLLMProvider {
  return new MockLLMProvider({
    handlers: {
      "spec.compile": [DEMO_SPEC],
      "spec.repair": [DEMO_SPEC],
      "feature.tests": [DEMO_TESTS],
      "feature.implement": [DEMO_IMPL_BROKEN],
      "feature.repair": [DEMO_IMPL_FIXED],
    },
  });
}
