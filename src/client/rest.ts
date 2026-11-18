// Raw QuickBooks REST access for entities node-quickbooks does not wrap.
//
// node-quickbooks declares one prototype method per entity and keeps its generic
// CRUD/query helpers on the CommonJS `module` object rather than `module.exports`,
// so any entity it omits is unreachable through the client. Six queryable
// entities fall in that gap: CreditCardPayment, InventoryAdjustment,
// RecurringTransaction, ReimburseCharge, TaxClassification, TaxPayment.
//
// Errors reject with the parsed QBO `Fault` body rather than a generic Error, so
// isQBError/isAuthError still recognize them and the auth-retry dispatcher in
// tools/index.ts keeps working for these calls too. A rejection never carries the
// request headers, URL or fetch init — only the status and Fault fields — so the
// bearer token cannot leak through it (CLAUDE.md § QBO Error Handling).

import QuickBooks from "node-quickbooks";

// Truncation cap for error text we surface from a non-JSON or unfaulted failure.
const ERROR_BODY_CHARS = 500;

function buildUrl(client: QuickBooks, path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  // client.endpoint already ends in ".../v3/company/"
  return `${client.endpoint}${client.realmId}${path}${sep}minorversion=${client.minorversion}`;
}

/** The one place a QBO request is built and sent: URL, bearer token, Accept. */
function sendQbo(
  client: QuickBooks,
  method: "GET" | "POST",
  path: string,
  accept: string,
  body?: unknown
): Promise<Response> {
  const hasBody = body !== undefined;
  return fetch(buildUrl(client, path), {
    method,
    headers: {
      Authorization: `Bearer ${client.token}`,
      Accept: accept,
      ...(hasBody && { "Content-Type": "application/json" }),
    },
    ...(hasBody && { body: JSON.stringify(body) }),
  });
}

/**
 * What to reject with for a non-OK response that carried no parseable Fault.
 * Only the status and the truncated body text are kept, never request data.
 */
function unfaultedFailure(status: number, text: string): unknown {
  // A 401 can come back without a Fault body. Synthesize one so isAuthError
  // sees it and executeTool retries with refreshed credentials.
  if (status === 401) {
    return { Fault: { Error: [{ Message: "Unauthorized", code: "401" }], type: "AUTHENTICATION" } };
  }
  const body = text.slice(0, ERROR_BODY_CHARS);
  // Carry the status so isRetryableError can tell a throttle (429) from a
  // permanent failure without parsing the message. `body` lets a caller quote a
  // non-empty 4xx body without parsing the message.
  return Object.assign(new Error(`QuickBooks request failed (HTTP ${status}): ${body}`), { status, body });
}

/**
 * Issue a request against the QuickBooks v3 REST API using the client's own
 * token, realm, and minor version.
 */
export async function qboRequest<T>(
  client: QuickBooks,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<T> {
  const response = await sendQbo(client, method, path, "application/json", body);

  const text = await response.text();

  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `QuickBooks returned non-JSON (HTTP ${response.status}): ${text.slice(0, ERROR_BODY_CHARS)}`
    );
  }

  const fault = (parsed as { Fault?: unknown }).Fault;
  if (fault) throw parsed;

  if (!response.ok) throw unfaultedFailure(response.status, text);

  return parsed as T;
}

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

// One pass, so "&amp;lt;" decodes to "&lt;" and not on to "<".
function decodeXmlEntities(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos);/g, (_, name: string) => XML_ENTITIES[name]);
}

function xmlAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attributes);
  const value = match?.[1] ?? match?.[2];
  return value === undefined ? undefined : decodeXmlEntities(value);
}

function xmlElementText(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? decodeXmlEntities(match[1].trim()) : undefined;
}

/**
 * Read the `<Fault>` of an `IntuitResponse` XML body into the same
 * `{ Fault: { Error: [{ code, Message, Detail }], type } }` shape the JSON API
 * returns, so extractQboFault and isAuthFault read it unchanged. Returns
 * undefined when the text holds no Fault. A small targeted reader rather than a
 * general XML parser: the Fault envelope is flat and fixed, and this adds no
 * dependency.
 */
function parseXmlFault(xml: string): { Fault: { Error: Record<string, string>[]; type?: string } } | undefined {
  const fault = /<Fault\b([^>]*)>([\s\S]*?)<\/Fault>/.exec(xml);
  if (!fault) return undefined;

  const errors: Record<string, string>[] = [];
  for (const match of fault[2].matchAll(/<Error\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Error>)/g)) {
    const inner = match[2] ?? "";
    const entry: Record<string, string> = {};
    const code = xmlAttribute(match[1], "code");
    const message = xmlElementText(inner, "Message");
    const detail = xmlElementText(inner, "Detail");
    if (code !== undefined) entry.code = code;
    if (message !== undefined) entry.Message = message;
    if (detail !== undefined) entry.Detail = detail;
    errors.push(entry);
  }

  const type = xmlAttribute(fault[1], "type");
  if (errors.length === 0 && type === undefined) return undefined;
  return { Fault: { Error: errors, ...(type !== undefined && { type }) } };
}

/**
 * GET a binary resource (a PDF) from the QuickBooks v3 REST API and return its
 * bytes. `accept` is the media type to request, e.g. "application/pdf".
 *
 * Unlike qboRequest the success body is not JSON, and QBO answers a failed
 * binary route in XML (an `IntuitResponse` carrying a `Fault`) whatever Accept
 * asked for — so the Fault is parsed from XML here. Errors still mirror
 * qboRequest's contract: a parsed Fault, a synthesized auth Fault for a bodiless
 * 401, or an Error carrying `status` and the truncated body text (an unsupported
 * entity returns an empty 400, which has no Fault to parse). No retry or
 * throttle wrapping — callers use withRetry where they need it.
 */
export async function qboGetBinary(client: QuickBooks, path: string, accept: string): Promise<Buffer> {
  const response = await sendQbo(client, "GET", path, accept);

  if (response.ok) return Buffer.from(await response.arrayBuffer());

  const text = await response.text();
  const fault = parseXmlFault(text);
  if (fault) throw fault;
  throw unfaultedFailure(response.status, text);
}

/**
 * Run a query statement through the REST query endpoint. Mirrors what
 * node-quickbooks' find* methods do internally (`select * from <entity> <criteria>`),
 * for entities that have no find* method.
 */
export async function qboQuery<T>(client: QuickBooks, selectStatement: string): Promise<T> {
  return qboRequest<T>(client, "GET", `/query?query=${encodeURIComponent(selectStatement)}`);
}
