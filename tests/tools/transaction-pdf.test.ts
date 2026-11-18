// get_transaction_pdf: the handler calls only qboRequest (entity JSON read) and
// qboGetBinary (the /pdf read), so these tests stub globalThis.fetch and hand
// the handler a plain fake client. Invented fixtures only — this repository is
// public (CLAUDE.md). Every case id is written as a literal string in its name.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type QuickBooks from "node-quickbooks";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  HTTP_PDF_MAX_BYTES,
  handleGetTransactionPdf,
} from "../../src/tools/handlers/transaction-pdf.js";
import { formatSize } from "../../src/tools/handlers/attachment.js";
import { setOutputMode } from "../../src/utils/output.js";
import { extractHttpStatus, extractQboFault } from "../../src/utils/errors.js";

const client = {
  endpoint: "https://qbo.test/v3/company/",
  realmId: "123",
  minorversion: 75,
  token: "test-token",
} as unknown as QuickBooks;

const PDF_NAME = "20261118 Purchase Order PO1001.pdf";
const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from([0x00, 0xff, 0x10, 0x0a])]);
const OTHER_PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from([0x01, 0xfe, 0x02])]);

// Loose view of a result block: the handler's own types are not assumed here.
type Block = {
  type: string;
  text?: string;
  resource?: {
    uri: string;
    mimeType: string;
    blob: string;
    name?: unknown;
    _meta?: { fileName?: string };
  };
};
const blocksOf = (result: { content: unknown }) => result.content as Block[];
const textOf = (result: { content: unknown }) =>
  blocksOf(result)
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

interface PdfResponse {
  status: number;
  body: Uint8Array | string | null;
}

const realFetch = globalThis.fetch;

// Answers the entity JSON read with a purchase order and the /pdf read with
// `pdf`. `requested` records each URL, so a refusal can prove no QBO call.
function stubQbo(pdf: Buffer | PdfResponse, entity = { TxnDate: "2026-11-18", DocNumber: "PO1001" }) {
  const requested: string[] = [];
  const accepts: string[] = [];
  const response: PdfResponse = Buffer.isBuffer(pdf) ? { status: 200, body: pdf } : pdf;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const href = String(url);
    requested.push(href);
    accepts.push((init?.headers as Record<string, string> | undefined)?.Accept ?? "");
    const path = href.split("?")[0];
    if (path.endsWith("/pdf")) {
      const body = typeof response.body === "string" ? response.body : response.body && new Uint8Array(response.body);
      return new Response(body, { status: response.status });
    }
    const id = path.split("/").pop();
    return new Response(JSON.stringify({ PurchaseOrder: { Id: id, ...entity } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { requested, accepts };
}

// Removed after every test, whatever it did.
const scratch: string[] = [];
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "transaction-pdf-test-"));
  scratch.push(dir);
  return dir;
}

const ENV_KEYS = ["QBO_READ_ONLY", "QBO_ENABLED_TOOLS", "QBO_PDF_FILE_NAME"] as const;
let envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  envSnapshot = {};
  for (const key of ENV_KEYS) {
    envSnapshot[key] = process.env[key];
    delete process.env[key];
  }
  setOutputMode("stdio");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setOutputMode("stdio");
  for (const key of ENV_KEYS) {
    const value = envSnapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const qboPdfDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith("qbo-pdf-"));

describe("get_transaction_pdf", () => {
  it("tool-refuses-unsupported-type: bill is refused, naming the six supported types, before any QBO call", async () => {
    const { requested } = stubQbo(PDF_BYTES);

    await assert.rejects(
      handleGetTransactionPdf(client, { entity_type: "bill", id: "7" }),
      (err: Error) => {
        for (const key of ["purchase_order", "invoice", "estimate", "sales_receipt", "credit_memo", "refund_receipt"]) {
          assert.match(err.message, new RegExp(key), `names ${key}`);
        }
        return true;
      }
    );
    assert.deepEqual(requested, []);
  });

  it("tool-stdio-writes-into-created-folder: creates the folder and writes the exact bytes under the rendered name", async () => {
    const folder = join(scratchDir(), "not", "yet", "there");
    assert.equal(existsSync(folder), false);
    stubQbo(PDF_BYTES);

    const out = textOf(await handleGetTransactionPdf(client, { entity_type: "purchase_order", id: "7", folder }));

    const target = join(resolve(folder), PDF_NAME);
    assert.deepEqual(readFileSync(target), PDF_BYTES);
    assert.ok(out.includes(target), `text names the absolute path: ${out}`);
    assert.match(out, /Purchase Order/);
    assert.match(out, /PO1001/);
    assert.match(out, /\b7\b/);
    assert.match(out, /2026-?11-?18/);
    assert.ok(out.includes(formatSize(PDF_BYTES.length)), `text states the size: ${out}`);
    assert.doesNotMatch(out, /replaced/i);
  });

  it("tool-reads-entity-then-pdf-with-accept: reads the entity JSON first, then the lowercase /pdf path as application/pdf", async () => {
    const folder = scratchDir();
    const { requested, accepts } = stubQbo(PDF_BYTES);

    await handleGetTransactionPdf(client, { entity_type: "PurchaseOrder", id: "7", folder });

    assert.equal(requested.length, 2);
    assert.equal(requested[0], "https://qbo.test/v3/company/123/purchaseorder/7?minorversion=75");
    assert.equal(requested[1], "https://qbo.test/v3/company/123/purchaseorder/7/pdf?minorversion=75");
    assert.equal(accepts[1], "application/pdf");
  });

  it("tool-stdio-overwrites: a second call replaces the file with the second response's bytes and says so", async () => {
    const folder = scratchDir();
    const target = join(resolve(folder), PDF_NAME);

    stubQbo(PDF_BYTES);
    const first = textOf(await handleGetTransactionPdf(client, { entity_type: "purchase_order", id: "7", folder }));
    assert.doesNotMatch(first, /replaced/i);
    assert.deepEqual(readFileSync(target), PDF_BYTES);

    stubQbo(OTHER_PDF_BYTES);
    const second = textOf(await handleGetTransactionPdf(client, { entity_type: "purchase_order", id: "7", folder }));

    assert.deepEqual(readFileSync(target), OTHER_PDF_BYTES);
    assert.match(second, /replaced/i);
    assert.match(second, /existing file/i);
  });

  it("tool-stdio-default-temp-folder: with no folder the PDF lands in a fresh qbo-pdf- directory the text names", async () => {
    stubQbo(PDF_BYTES);

    const out = textOf(await handleGetTransactionPdf(client, { entity_type: "purchase_order", id: "7" }));

    const match = out.match(/(\/[^\s]*qbo-pdf-[A-Za-z0-9]+)/);
    assert.ok(match, `no qbo-pdf- directory in text: ${out}`);
    const dir = match[1];
    scratch.push(dir);
    assert.equal(resolve(dir, ".."), resolve(tmpdir()));
    assert.deepEqual(readFileSync(join(dir, PDF_NAME)), PDF_BYTES);
    assert.ok(out.includes(join(dir, PDF_NAME)), `text names the full path: ${out}`);
  });

  it("tool-http-resource-block: returns a text block and a PDF resource block, and writes nothing to disk", async () => {
    setOutputMode("http");
    const before = qboPdfDirs();
    stubQbo(PDF_BYTES);

    const result = await handleGetTransactionPdf(client, { entity_type: "purchase_order", id: "7" });

    const blocks = blocksOf(result);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].type, "text");
    assert.ok(blocks[0].text?.includes(PDF_NAME), `text states the file name: ${blocks[0].text}`);
    assert.equal(blocks[1].type, "resource");
    const resource = blocks[1].resource!;
    assert.equal(resource.uri, "qbo://purchase_order/7/pdf");
    assert.equal(resource.mimeType, "application/pdf");
    assert.equal(resource._meta?.fileName, PDF_NAME);
    assert.equal("name" in resource, false);
    assert.deepEqual(Buffer.from(resource.blob, "base64"), PDF_BYTES);
    assert.deepEqual(qboPdfDirs(), before);
  });

  it("tool-http-refuses-folder: a folder argument is refused over HTTP before any QBO call", async () => {
    setOutputMode("http");
    const folder = join(scratchDir(), "out");
    const { requested } = stubQbo(PDF_BYTES);

    await assert.rejects(
      handleGetTransactionPdf(client, { entity_type: "purchase_order", id: "7", folder }),
      /folder.*(unavailable|not available).*HTTP/i
    );
    assert.deepEqual(requested, []);
    assert.equal(existsSync(folder), false);
  });

  it("tool-http-size-cap: a PDF over the inline cap fails naming the size and the cap, with no blob", async () => {
    setOutputMode("http");
    const size = HTTP_PDF_MAX_BYTES + 1;
    stubQbo(Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(size - 9)]));

    await assert.rejects(
      handleGetTransactionPdf(client, { entity_type: "purchase_order", id: "7" }),
      (err: Error) => {
        assert.ok(
          err.message.includes(String(size)) || err.message.includes(formatSize(size)),
          `names the size: ${err.message}`
        );
        assert.ok(
          err.message.includes(String(HTTP_PDF_MAX_BYTES)) || err.message.includes(formatSize(HTTP_PDF_MAX_BYTES)),
          `names the cap: ${err.message}`
        );
        return true;
      }
    );
  });

  it("tool-http-size-cap-allows-exactly-cap: a PDF of exactly the cap is returned inline", async () => {
    setOutputMode("http");
    const bytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(HTTP_PDF_MAX_BYTES - 9)]);
    assert.equal(bytes.length, HTTP_PDF_MAX_BYTES);
    stubQbo(bytes);

    const result = await handleGetTransactionPdf(client, { entity_type: "purchase_order", id: "7" });

    assert.equal(blocksOf(result)[1].resource?.blob, bytes.toString("base64"));
  });

  it("tool-refuses-non-pdf-body: a 200 whose bytes do not start with %PDF fails and writes no file", async () => {
    const folder = join(scratchDir(), "out");
    stubQbo(Buffer.from("<html>sign in</html>"));

    await assert.rejects(
      handleGetTransactionPdf(client, { entity_type: "purchase_order", id: "7", folder }),
      /QuickBooks did not return a PDF for Purchase Order 7/
    );
    assert.ok(!existsSync(folder) || readdirSync(folder).length === 0, "no file written");
  });

  it("tool-empty-400-not-a-pdf: an empty 400 fails with the not-a-PDF message, keeps status 400 and writes no file", async () => {
    const folder = join(scratchDir(), "out");
    stubQbo({ status: 400, body: "" });

    await assert.rejects(
      handleGetTransactionPdf(client, { entity_type: "purchase_order", id: "7", folder }),
      (err: Error) => {
        assert.equal(err.message, "QuickBooks did not return a PDF for Purchase Order 7 (HTTP 400)");
        assert.equal(extractHttpStatus(err), 400);
        return true;
      }
    );
    assert.ok(!existsSync(folder) || readdirSync(folder).length === 0, "no file written");
  });

  it("tool-non-empty-400-quotes-body: a non-empty, Fault-free 400 body is appended after a colon", async () => {
    stubQbo({ status: 404, body: "no such document" });

    await assert.rejects(
      handleGetTransactionPdf(client, { entity_type: "purchase_order", id: "7" }),
      (err: Error) => {
        assert.equal(err.message, "QuickBooks did not return a PDF for Purchase Order 7 (HTTP 404): no such document");
        assert.equal(extractHttpStatus(err), 404);
        return true;
      }
    );
  });

  it("tool-qbo-fault-propagates-untouched: a 400 carrying a QBO Fault is not rewritten as not-a-PDF", async () => {
    const fault = `<IntuitResponse><Fault type="ValidationFault"><Error code="610"><Message>Object Not Found</Message><Detail>gone</Detail></Error></Fault></IntuitResponse>`;
    stubQbo({ status: 400, body: fault });

    await assert.rejects(handleGetTransactionPdf(client, { entity_type: "purchase_order", id: "7" }), (err: unknown) => {
      assert.ok(extractQboFault(err), "the Fault is still readable from the rejection");
      assert.ok(!(err instanceof Error) || !/did not return a PDF/.test(err.message));
      return true;
    });
  });

  it("tool-429-and-5xx-propagate-untouched: throttles and server errors keep QuickBooks' own failure", async () => {
    for (const status of [429, 503]) {
      stubQbo({ status, body: "busy" });
      await assert.rejects(
        handleGetTransactionPdf(client, { entity_type: "purchase_order", id: "7" }),
        (err: Error) => {
          assert.doesNotMatch(err.message, /did not return a PDF/, `HTTP ${status}`);
          assert.equal(extractHttpStatus(err), status);
          return true;
        }
      );
    }
  });

  it("tool-refuses-non-numeric-id: an id that is not all digits is refused before any QBO call", async () => {
    const { requested } = stubQbo(PDF_BYTES);

    await assert.rejects(
      handleGetTransactionPdf(client, { entity_type: "purchase_order", id: "1/pdf?x=" }),
      /numeric/i
    );
    assert.deepEqual(requested, []);
  });

  it("tool-http-survives-sdk-schema: the HTTP result parses through CallToolResultSchema with its resource intact", async () => {
    setOutputMode("http");
    stubQbo(PDF_BYTES);

    const result = await handleGetTransactionPdf(client, { entity_type: "purchase_order", id: "7" });
    const parsed = CallToolResultSchema.safeParse(result);

    assert.ok(parsed.success, parsed.success ? "" : parsed.error.message);
    const blocks = parsed.data.content as Block[];
    const resource = blocks.find((b) => b.type === "resource")?.resource;
    assert.ok(resource, "the resource block survived parsing");
    assert.equal(resource.uri, "qbo://purchase_order/7/pdf");
    assert.equal(resource.mimeType, "application/pdf");
    assert.equal(resource.blob, PDF_BYTES.toString("base64"));
    assert.equal(resource._meta?.fileName, PDF_NAME);
    const text = blocks.find((b) => b.type === "text");
    assert.ok(text?.text?.includes(PDF_NAME), `parsed text states the file name: ${text?.text}`);
  });

  it("tool-exposed-read-only: is listed under QBO_READ_ONLY with the read-only hints", async () => {
    process.env.QBO_READ_ONLY = "true";
    delete process.env.QBO_ENABLED_TOOLS;

    const { server } = await import("../../src/server.js");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
    try {
      const { tools } = await mcp.listTools();
      const tool = tools.find((t) => t.name === "get_transaction_pdf");
      assert.ok(tool, "get_transaction_pdf is listed under QBO_READ_ONLY");
      assert.equal(tool.annotations?.title, "Get QuickBooks transaction PDF");
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.annotations?.idempotentHint, true);
    } finally {
      await mcp.close();
      await server.close();
    }
  });
});
