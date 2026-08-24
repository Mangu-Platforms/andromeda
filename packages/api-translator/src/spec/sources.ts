import type { SourceRef } from "./types.ts";

/**
 * Raw documentation the translator is willing to ingest.
 *
 * Everything here is untrusted, half-complete and mutually inconsistent by
 * assumption — that is the product's dominant blocker. Nothing in this module
 * decides anything: it flattens each format into one deterministic text digest
 * so the model sees the same prompt for the same inputs, and so the digest can
 * be diffed and checkpointed. The validator downstream is what judges.
 */
export type DocSource =
  | { kind: "openapi"; label: string; document: unknown }
  | { kind: "postman"; label: string; collection: unknown };

export interface NormalizedDocs {
  /** Model-facing rendering of every source, sorted for byte-stability. */
  digest: string;
  refs: SourceRef[];
  /** Base URLs the sources claim, deduplicated. Often zero or conflicting. */
  baseUrlHints: string[];
}

const rec = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const METHODS = ["get", "post", "put", "patch", "delete", "head"];

interface DraftOperation {
  method: string;
  path: string;
  summary: string;
  lines: string[];
}

const renderOperation = (op: DraftOperation): string =>
  [
    `${op.method} ${op.path}`,
    ...(op.summary ? [`  summary: ${op.summary}`] : []),
    ...op.lines.map((line) => `  ${line}`),
  ].join("\n");

/**
 * Flatten every source into one digest.
 *
 * Operations are sorted by `METHOD path` within each source so that reordering
 * a JSON object's keys cannot change the prompt — a prerequisite for the
 * byte-identical-codegen guarantee further down the pipeline.
 */
export function normalizeSources(sources: DocSource[]): NormalizedDocs {
  const refs: SourceRef[] = [];
  const baseUrlHints: string[] = [];
  const blocks: string[] = [];

  for (const source of sources) {
    const extracted =
      source.kind === "openapi"
        ? fromOpenApi(source.document)
        : fromPostman(source.collection);

    for (const hint of extracted.baseUrls) {
      if (hint !== "" && !baseUrlHints.includes(hint)) baseUrlHints.push(hint);
    }

    const operations = [...extracted.operations].sort((a, b) => {
      const left = `${a.method} ${a.path}`;
      const right = `${b.method} ${b.path}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });

    refs.push({
      kind: source.kind,
      label: source.label,
      operationsFound: operations.length,
    });

    blocks.push(
      [
        `## source ${source.kind}:${source.label} (${operations.length} operation(s))`,
        ...extracted.baseUrls.map((u) => `baseUrl hint: ${u}`),
        ...operations.map(renderOperation),
      ].join("\n"),
    );
  }

  return { digest: blocks.join("\n\n"), refs, baseUrlHints };
}

interface Extraction {
  operations: DraftOperation[];
  baseUrls: string[];
}

function fromOpenApi(document: unknown): Extraction {
  const root = rec(document);
  const operations: DraftOperation[] = [];
  const baseUrls: string[] = [];

  for (const server of arr(root?.servers)) {
    const url = str(rec(server)?.url);
    if (url !== "") baseUrls.push(url);
  }

  const paths = rec(root?.paths);
  if (!paths) return { operations, baseUrls };

  for (const [path, rawItem] of Object.entries(paths)) {
    const item = rec(rawItem);
    if (!item) continue;
    for (const method of METHODS) {
      const op = rec(item[method]);
      if (!op) continue;
      const lines: string[] = [];

      for (const rawParam of arr(op.parameters)) {
        const param = rec(rawParam);
        if (!param) continue;
        const type = str(rec(param.schema)?.type) || "unspecified";
        lines.push(
          `param: ${str(param.name)} in=${str(param.in)} ` +
            `required=${param.required === true} type=${type}` +
            (str(param.description) ? ` -- ${str(param.description)}` : ""),
        );
      }

      const content = rec(rec(op.requestBody)?.content);
      for (const [contentType, rawMedia] of Object.entries(content ?? {})) {
        const schema = rec(rec(rawMedia)?.schema);
        const required = arr(schema?.required).map(str);
        const properties = rec(schema?.properties) ?? {};
        lines.push(`requestContentType: ${contentType}`);
        for (const [name, rawProp] of Object.entries(properties)) {
          const prop = rec(rawProp);
          lines.push(
            `body: ${name} type=${str(prop?.type) || "unspecified"} ` +
              `required=${required.includes(name)}` +
              (str(prop?.description) ? ` -- ${str(prop?.description)}` : ""),
          );
        }
      }

      for (const [status, rawResponse] of Object.entries(rec(op.responses) ?? {})) {
        const response = rec(rawResponse);
        const responseContent = rec(response?.content);
        const contentType = Object.keys(responseContent ?? {})[0] ?? "";
        const schema = rec(responseContent?.[contentType]);
        const properties = rec(rec(schema?.schema)?.properties) ?? {};
        const fields = Object.entries(properties)
          .map(([name, prop]) => `${name}:${str(rec(prop)?.type) || "unspecified"}`)
          .join(",");
        lines.push(
          `response: ${status} ${contentType || "unspecified"}` +
            (fields ? ` fields=${fields}` : ""),
        );
      }

      operations.push({
        method: method.toUpperCase(),
        path,
        summary: str(op.summary) || str(op.description),
        lines,
      });
    }
  }

  return { operations, baseUrls };
}

/** `{{baseUrl}}/customers/:id` and `https://host/customers/:id` both reduce to `/customers/{id}`. */
function postmanPath(raw: string, segments: string[]): string {
  let path = raw;
  if (segments.length > 0) {
    path = `/${segments.join("/")}`;
  } else {
    path = path.replace(/^\{\{[^}]*\}\}/, "");
    const match = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)?$/i.exec(path);
    if (match) path = match[1] ?? "/";
    const query = path.indexOf("?");
    if (query !== -1) path = path.slice(0, query);
  }
  path = path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
  if (!path.startsWith("/")) path = `/${path}`;
  return path === "/" ? "/" : path.replace(/\/$/, "");
}

function fromPostman(collection: unknown): Extraction {
  const root = rec(collection);
  const operations: DraftOperation[] = [];
  const baseUrls: string[] = [];

  for (const rawVariable of arr(root?.variable)) {
    const variable = rec(rawVariable);
    if (str(variable?.key) === "baseUrl") baseUrls.push(str(variable?.value));
  }

  // Postman collections nest folders arbitrarily deep; walk them iteratively.
  const queue: unknown[] = [...arr(root?.item)];
  while (queue.length > 0) {
    const entry = rec(queue.shift());
    if (!entry) continue;
    if (Array.isArray(entry.item)) {
      queue.push(...entry.item);
      continue;
    }
    const request = rec(entry.request);
    if (!request) continue;

    const url = rec(request.url);
    const path = postmanPath(str(url?.raw), arr(url?.path).map(str).filter((s) => s !== ""));
    const lines: string[] = [];

    for (const rawVariable of arr(url?.variable)) {
      const variable = rec(rawVariable);
      lines.push(`param: ${str(variable?.key)} in=path required=true type=unspecified`);
    }
    for (const rawQuery of arr(url?.query)) {
      const query = rec(rawQuery);
      lines.push(
        `param: ${str(query?.key)} in=query required=${query?.disabled !== true} type=unspecified`,
      );
    }
    for (const rawHeader of arr(request.header)) {
      const header = rec(rawHeader);
      lines.push(`param: ${str(header?.key)} in=header required=true type=string`);
    }

    const body = rec(request.body);
    if (body && str(body.mode) === "raw") {
      const parsed = safeJson(str(body.raw));
      if (parsed) {
        lines.push("requestContentType: application/json");
        for (const [name, value] of Object.entries(parsed)) {
          // A Postman example body says a field exists; it never says whether
          // the field is optional. Say so rather than guessing.
          lines.push(`body: ${name} type=${jsType(value)} required=unstated (example value present)`);
        }
      }
    }

    for (const rawResponse of arr(entry.response)) {
      const response = rec(rawResponse);
      const parsed = safeJson(str(response?.body));
      const fields = parsed
        ? Object.entries(parsed)
            .map(([name, value]) => `${name}:${jsType(value)}`)
            .join(",")
        : "";
      lines.push(
        `response: ${typeof response?.code === "number" ? response.code : "unspecified"} ` +
          `application/json${fields ? ` fields=${fields}` : ""}`,
      );
    }

    operations.push({
      method: str(request.method).toUpperCase() || "GET",
      path,
      summary: str(entry.name),
      lines,
    });
  }

  return { operations, baseUrls };
}

function safeJson(raw: string): Record<string, unknown> | null {
  if (raw.trim() === "") return null;
  try {
    return rec(JSON.parse(raw));
  } catch {
    return null;
  }
}

function jsType(value: unknown): string {
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return "object";
}
