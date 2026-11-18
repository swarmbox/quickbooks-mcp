// Pins qboRequest's observable behavior before its URL/header/error plumbing is
// shared with the binary request path. Imports qboRequest only, so it runs
// unchanged against the code before and after that refactor.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";
import { qboRequest } from "../../src/client/rest.js";

// Invented fixtures only — this repository is public (CLAUDE.md).
const client = {
  endpoint: "https://qbo.test/v3/company/",
  realmId: "123",
  minorversion: 75,
  token: "SECRET-TOKEN-VALUE",
} as unknown as QuickBooks;

const realFetch = globalThis.fetch;

function stubFetch(status: number, body: string): void {
  globalThis.fetch = (async () => new Response(body || null, { status })) as typeof fetch;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the request to reject");
}

describe("qboRequest", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("json-request-unchanged: returns the parsed body on a 200", async () => {
    stubFetch(200, JSON.stringify({ Vendor: { Id: "1" } }));
    const result = await qboRequest(client, "GET", "/vendor/1");
    assert.deepEqual(result, { Vendor: { Id: "1" } });
  });

  it("json-request-unchanged: rejects with the parsed Fault body", async () => {
    const fault = {
      Fault: { Error: [{ Message: "Object Not Found", Detail: "Id 9", code: "610" }], type: "ValidationFault" },
    };
    stubFetch(400, JSON.stringify(fault));
    assert.deepEqual(await rejection(qboRequest(client, "GET", "/vendor/9")), fault);
  });

  it("json-request-unchanged: rejects with the synthesized auth Fault on a bodiless 401", async () => {
    stubFetch(401, "");
    assert.deepEqual(await rejection(qboRequest(client, "GET", "/vendor/1")), {
      Fault: { Error: [{ Message: "Unauthorized", code: "401" }], type: "AUTHENTICATION" },
    });
  });

  it("json-request-unchanged: sends the bearer token, JSON accept and the minorversion", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await qboRequest(client, "GET", "/vendor/1?foo=bar");
    assert.equal(seen?.url, "https://qbo.test/v3/company/123/vendor/1?foo=bar&minorversion=75");
    assert.equal(seen?.headers.Authorization, "Bearer SECRET-TOKEN-VALUE");
    assert.equal(seen?.headers.Accept, "application/json");
  });
});
