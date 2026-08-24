import type { ApiSpec } from "../src/spec/types.ts";

/**
 * A canonical spec that passes `validateApiSpec` unmodified. Tests mutate a
 * fresh copy to prove one rule at a time, so this must stay valid.
 */
export function sampleSpec(): ApiSpec {
  return {
    specVersion: "1",
    name: "billing-api",
    baseUrl: "https://api.example.com/v1",
    auth: { kind: "bearer", headerName: "", confirmation: "probe" },
    operations: [
      {
        operationId: "getInvoice",
        method: "GET",
        path: "/customers/{customerId}/invoices/{invoiceId}",
        summary: "Fetch a single invoice.",
        parameters: [
          {
            name: "customerId",
            in: "path",
            type: "string",
            required: true,
            description: "Customer identifier.",
          },
          {
            name: "invoiceId",
            in: "path",
            type: "string",
            required: true,
            description: "Invoice identifier.",
          },
          {
            name: "expand",
            in: "query",
            type: "boolean",
            required: false,
            description: "Include line items.",
          },
        ],
        requestBody: [],
        requestContentType: "",
        responses: [
          {
            status: 200,
            contentType: "application/json",
            fields: [
              { name: "id", type: "string", required: true, description: "Invoice id." },
              { name: "total", type: "integer", required: true, description: "Minor units." },
            ],
          },
          { status: 404, contentType: "application/json", fields: [] },
        ],
      },
      {
        operationId: "createInvoice",
        method: "POST",
        path: "/customers/{customerId}/invoices",
        summary: "Create an invoice for a customer.",
        parameters: [
          {
            name: "customerId",
            in: "path",
            type: "string",
            required: true,
            description: "Customer identifier.",
          },
        ],
        requestBody: [
          { name: "amount", type: "integer", required: true, description: "Minor units." },
          { name: "currency", type: "string", required: true, description: "ISO 4217." },
          { name: "memo", type: "string", required: false, description: "Free text." },
        ],
        requestContentType: "application/json",
        responses: [
          {
            status: 201,
            contentType: "application/json",
            fields: [
              { name: "id", type: "string", required: true, description: "Invoice id." },
            ],
          },
          { status: 400, contentType: "application/json", fields: [] },
        ],
      },
    ],
  };
}

/** Deep copy helper so a mutation in one test cannot leak into another. */
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
