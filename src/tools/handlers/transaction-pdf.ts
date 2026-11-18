// Handler for get_transaction_pdf: QuickBooks' own rendered PDF of one
// transaction (purchase order, invoice, estimate, sales receipt, credit memo,
// refund receipt). Read-only: nothing in QuickBooks changes.
//
// stdio saves the file locally (a path in the text; the bytes never enter the
// model's context). HTTP has no filesystem the caller can reach, so the PDF
// comes back inline as an embedded resource block, under a size cap.

import type QuickBooks from "node-quickbooks";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { qboGetBinary, qboRequest } from "../../client/rest.js";
import { extractHttpStatus, extractQboFault } from "../../utils/errors.js";
import { resolvePdfType } from "../../utils/entity-types.js";
import { renderFileName } from "../../utils/file-name.js";
import { isHttpMode } from "../../utils/output.js";
import { formatSize } from "./attachment.js";
// Type-only, so there is no runtime cycle with the dispatcher that imports this file.
import type { ToolHandlerResult } from "../index.js";

/**
 * Largest PDF (decimal bytes, checked before base64-encoding) returned inline
 * over HTTP. Lambda's response limit is 6 MB; base64 inflates by 4/3, so
 * 4,400,000 bytes becomes about 5.87 MB, which leaves room for the JSON
 * envelope and the text block.
 */
export const HTTP_PDF_MAX_BYTES = 4_400_000;

// Longest slice of a QuickBooks error body quoted back to the caller.
const QUOTED_BODY_CHARS = 200;

// Every PDF starts with this marker; an HTML sign-in page or error page does not.
const PDF_MAGIC = "%PDF";

/**
 * QuickBooks answers a type or document it cannot render with a bodiless 4xx
 * (an empty 400, never a Fault), which on its own reads as a generic request
 * failure. Anything else — a Fault, 401 (auth retry), 429 or 5xx (retry
 * classification) — is returned untouched so the dispatcher's handling applies.
 */
function explainNotAPdf(error: unknown, what: string): unknown {
  const status = extractHttpStatus(error);
  const isPlain4xx =
    status !== undefined && status >= 400 && status < 500 && status !== 401 && status !== 429;
  if (!isPlain4xx || extractQboFault(error) !== undefined) return error;

  const body = (error as { body?: unknown }).body;
  const quoted = typeof body === "string" && body.trim() ? `: ${body.trim().slice(0, QUOTED_BODY_CHARS)}` : "";
  return Object.assign(new Error(`QuickBooks did not return a PDF for ${what} (HTTP ${status})${quoted}`), { status });
}

export async function handleGetTransactionPdf(
  client: QuickBooks,
  args: { entity_type: string; id: string; folder?: string }
): Promise<ToolHandlerResult> {
  // Refusals first: nothing below this block runs for a bad request.
  const type = resolvePdfType(args.entity_type);
  const id = String(args.id).trim();
  if (!/^\d+$/.test(id)) {
    throw new Error(`Invalid id "${id}": the id must be numeric (digits only).`);
  }
  if (args.folder !== undefined && isHttpMode()) {
    throw new Error(
      "folder is unavailable over HTTP: there is no local filesystem to save to. Omit it and the PDF is returned inline."
    );
  }

  const what = `${type.label} ${id}`;
  const path = `/${type.pathSegment}/${id}`;

  // The entity's own fields name the file; the PDF body carries none of them.
  const read = await qboRequest<Record<string, { TxnDate?: string; DocNumber?: string } | undefined>>(
    client,
    "GET",
    path
  );
  const entity = read[type.qboType] ?? {};

  let pdf: Buffer;
  try {
    pdf = await qboGetBinary(client, `${path}/pdf`, "application/pdf");
  } catch (error) {
    throw explainNotAPdf(error, what);
  }
  if (pdf.subarray(0, PDF_MAGIC.length).toString("latin1") !== PDF_MAGIC) {
    throw new Error(`QuickBooks did not return a PDF for ${what}: the response was not a PDF document.`);
  }

  const fileName = renderFileName({ date: entity.TxnDate, type: type.label, ref: entity.DocNumber, id });
  const subject = `${type.label} ${entity.DocNumber?.trim() || id} (Id ${id}${entity.TxnDate ? `, ${entity.TxnDate}` : ""})`;
  const size = formatSize(pdf.length);

  if (isHttpMode()) {
    if (pdf.length > HTTP_PDF_MAX_BYTES) {
      throw new Error(
        `The PDF for ${what} is ${pdf.length} bytes (${size}), over the ${HTTP_PDF_MAX_BYTES}-byte ` +
          `(${formatSize(HTTP_PDF_MAX_BYTES)}) limit for inline PDFs over HTTP.`
      );
    }
    return {
      content: [
        { type: "text", text: `${subject}: PDF attached as ${fileName} (${size}).` },
        {
          type: "resource",
          // No `name`: the MCP SDK strips unknown keys other than _meta.
          resource: {
            uri: `qbo://${type.key}/${id}/pdf`,
            mimeType: "application/pdf",
            blob: pdf.toString("base64"),
            _meta: { fileName },
          },
        },
      ],
    };
  }

  let directory: string;
  if (args.folder !== undefined) {
    directory = resolve(args.folder);
    mkdirSync(directory, { recursive: true });
  } else {
    directory = mkdtempSync(join(tmpdir(), "qbo-pdf-"));
  }
  const target = join(directory, fileName);
  const replaced = existsSync(target);
  writeFileSync(target, pdf);

  const lines = [`${subject}: PDF saved (${size}).`, `Saved to: ${target}`];
  if (replaced) lines.push("An existing file at that path was replaced.");
  return { content: [{ type: "text", text: lines.join("\n") }] };
}
