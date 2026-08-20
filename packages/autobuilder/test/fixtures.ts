import type { ProjectSpec } from "../src/spec/types.ts";

/** A small but realistic spec: two related tables, RLS, one generated feature. */
export function sampleSpec(overrides: Partial<ProjectSpec> = {}): ProjectSpec {
  return {
    specVersion: "1",
    name: "invoice-tracker",
    summary: "Track invoices and their line items for a single freelancer.",
    template: "next-supabase-app",
    auth: { enabled: true, providers: ["email"] },
    entities: [
      {
        name: "line_items",
        summary: "Individual billable lines on an invoice.",
        ownerField: "owner_id",
        fields: [
          { name: "owner_id", type: "uuid", required: true, unique: false, references: "" },
          { name: "invoice_id", type: "uuid", required: true, unique: false, references: "invoices" },
          { name: "description", type: "text", required: true, unique: false, references: "" },
          { name: "amount_cents", type: "integer", required: true, unique: false, references: "" },
        ],
      },
      {
        name: "invoices",
        summary: "Invoices issued to clients.",
        ownerField: "owner_id",
        fields: [
          { name: "owner_id", type: "uuid", required: true, unique: false, references: "" },
          { name: "number", type: "text", required: true, unique: true, references: "" },
          { name: "issued_at", type: "timestamptz", required: true, unique: false, references: "" },
          { name: "paid", type: "boolean", required: true, unique: false, references: "" },
        ],
      },
    ],
    routes: [
      { path: "/api/invoices/total", method: "POST", summary: "Total an invoice.", feature: "invoice-total" },
      { path: "/api/invoices", method: "GET", summary: "List invoices.", feature: "" },
    ],
    features: [
      {
        id: "invoice-total",
        summary: "Sum line items into a total with tax.",
        acceptance: [
          "returns 400 when body.lineItems is missing",
          "sums amount_cents across all line items",
          "applies the tax rate and rounds to the nearest cent",
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
        name: "SUPABASE_SERVICE_ROLE_KEY",
        description: "Server-side key for migrations.",
        required: false,
        secret: true,
      },
    ],
    deploy: { target: "vercel" },
    ...overrides,
  };
}
