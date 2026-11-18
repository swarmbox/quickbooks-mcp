// qboGetBinary: a GET whose success body is bytes (a PDF) rather than JSON, and
// whose failures arrive as an XML Fault. Its rejections must match qboRequest's
// contract — a parsed Fault, a synthesized 401, or a status-carrying Error — and
// must never carry the request headers or the bearer token (CLAUDE.md § QBO
// Error Handling).

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";
import { qboGetBinary } from "../../src/client/rest.js";
import { extractHttpStatus, extractQboFault, formatQboError, isAuthFault } from "../../src/utils/errors.js";

// Invented fixtures only — this repository is public (CLAUDE.md).
const TOKEN = "SECRET-TOKEN-VALUE";
const client = {
  endpoint: "https://qbo.test/v3/company/",
  realmId: "123",
  minorversion: 75,
  token: TOKEN,
} as unknown as QuickBooks;

const PDF_BYTES = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x00, 0xff, 0x0a]); // "%PDF-1.4", NUL, 0xFF, LF

const XML_FAULT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<IntuitResponse xmlns="http://schema.intuit.com/finance/v3" time="2026-01-01T00:00:00.000Z">
  <Fault type="ValidationFault">
    <Error code="610">
      <Message>Object Not Found &amp; gone</Message>
      <Detail>Something &lt;Id&gt; is missing</Detail>
    </Error>
  </Fault>
</IntuitResponse>`;

const realFetch = globalThis.fetch;

interface Seen {
  url: string;
  init: RequestInit;
}

function stubFetch(status: number, body: BodyInit | null, contentType?: string): { seen: Seen[] } {
  const seen: Seen[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(body, { status, headers: contentType ? { "Content-Type": contentType } : undefined });
  }) as unknown as typeof fetch;
  return { seen };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the request to reject");
}

describe("qboGetBinary", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("binary-returns-bytes: resolves to a Buffer of the response bytes with Accept, bearer and minorversion", async () => {
    const { seen } = stubFetch(200, PDF_BYTES, "application/pdf");

    const result = await qboGetBinary(client, "/purchaseorder/1/pdf", "application/pdf");

    assert.ok(Buffer.isBuffer(result));
    assert.deepEqual([...result], [...PDF_BYTES]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://qbo.test/v3/company/123/purchaseorder/1/pdf?minorversion=75");
    const headers = seen[0].init.headers as Record<string, string>;
    assert.equal(headers.Accept, "application/pdf");
    assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(seen[0].init.method, "GET");
  });

  it("binary-xml-fault-parsed: rejects with a Fault whose code, decoded message and detail are readable", async () => {
    stubFetch(400, XML_FAULT, "text/xml");

    const error = await rejection(qboGetBinary(client, "/purchaseorder/9/pdf", "application/pdf"));

    const fault = extractQboFault(error);
    assert.ok(fault, "a Fault is readable from the rejection");
    assert.equal(fault.type, "ValidationFault");
    assert.equal(fault.errors.length, 1);
    assert.equal(fault.errors[0].code, "610");
    assert.equal(fault.errors[0].message, "Object Not Found & gone");
    assert.ok(fault.errors[0].detail?.includes("<Id>"), `detail was ${fault.errors[0].detail}`);

    const formatted = formatQboError(error);
    assert.ok(formatted.includes("[610]"), formatted);
    assert.ok(formatted.includes("Object Not Found & gone"), formatted);
    assert.ok(formatted.includes("<Id>"), formatted);
  });

  it("binary-401-auth-fault: a bodiless 401 rejects with a value isAuthFault accepts", async () => {
    stubFetch(401, null);

    const error = await rejection(qboGetBinary(client, "/purchaseorder/1/pdf", "application/pdf"));

    assert.equal(isAuthFault(error), true);
  });

  it("binary-empty-400-status: an empty text/xml 400 rejects with an Error carrying status 400", async () => {
    stubFetch(400, "", "text/xml");

    const error = await rejection(qboGetBinary(client, "/purchaseorder/1/pdf", "application/pdf"));

    assert.ok(error instanceof Error);
    assert.equal(extractHttpStatus(error), 400);
    assert.equal(isAuthFault(error), false);
  });

  it("binary-error-no-token: no failing rejection leaks the token or an Authorization header", async () => {
    const failures: Array<[number, string | null]> = [
      [400, XML_FAULT],
      [401, null],
      [400, ""],
    ];

    for (const [status, body] of failures) {
      stubFetch(status, body, "text/xml");
      const error = await rejection(qboGetBinary(client, "/purchaseorder/1/pdf", "application/pdf"));

      for (const output of [formatQboError(error), JSON.stringify(error)]) {
        assert.ok(!output.includes(TOKEN), `HTTP ${status}: output contains the token`);
        assert.ok(!output.includes("Authorization"), `HTTP ${status}: output contains Authorization`);
      }
    }
  });
});
