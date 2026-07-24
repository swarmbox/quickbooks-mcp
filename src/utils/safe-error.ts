// Safe error stringification for QuickBooks-touching paths.
//
// Raw node-quickbooks / axios error objects can carry the request `config` —
// including the `Authorization: Bearer <access-token>` header. Serializing one
// (JSON.stringify / util.inspect / console.error / raw re-throw into a print or
// log sink) leaks a live QBO access token into the tool result, transcript, or
// server stderr. NEVER serialize a raw QBO error: extract only the HTTP status
// and the QBO Fault code/message/detail. See CLAUDE.md
// "QBO Error Handling (Never Leak Tokens)" (CWE-532).

import { isQBError, extractQBErrorInfo } from "../types/quickbooks.js";

/**
 * Convert an arbitrary thrown value into a safe, human-readable string that
 * never includes the raw error object, its `config`, `headers`, or `request`.
 *
 * Ordering:
 *  - QB Fault error  → `code` / `message` / `detail` (+ `HTTP <status>` if present)
 *  - axios-shaped    → `HTTP <status>` (+ safe `.message`)
 *  - Error           → `.message`
 *  - string          → itself
 *  - anything else   → a generic string
 */
export function toSafeErrorText(error: unknown): string {
  const status = axiosStatus(error);

  if (isQBError(error)) {
    const { code, message, detail } = extractQBErrorInfo(error);
    const segments = [
      status !== undefined ? `HTTP ${status}` : undefined,
      code ? `code ${code}` : undefined,
      message,
      detail,
    ].filter((s): s is string => Boolean(s));
    return segments.length > 0 ? segments.join(" — ") : "QuickBooks API error";
  }

  if (status !== undefined) {
    // axios' own `.message` is "Request failed with status code N" — safe.
    return error instanceof Error && error.message
      ? `HTTP ${status} — ${error.message}`
      : `HTTP ${status}`;
  }

  if (error instanceof Error) {
    return error.message || error.name || "Error";
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unknown error";
}

/** Read a numeric `error.response.status` (axios shape) without touching config. */
function axiosStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const response = (error as Record<string, unknown>).response;
  if (typeof response !== "object" || response === null) return undefined;
  const status = (response as Record<string, unknown>).status;
  return typeof status === "number" ? status : undefined;
}
