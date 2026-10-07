// The get_company_info tool: a short identity-card summary, with the full
// CompanyInfo object handed to outputReport as-is (temp file in stdio, inline in HTTP).

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type QuickBooks from "node-quickbooks";

import { setOutputMode } from "../../src/utils/output.js";
import { handleGetCompanyInfo } from "../../src/tools/handlers/company.js";

type Callback<T> = (err: unknown, result: T) => void;
type ToolResult = { content: Array<{ type: string; text: string }> };

// Invented fixtures only — this repository is public (CLAUDE.md).
const FULL_INFO = {
  Id: "1",
  SyncToken: "0",
  CompanyName: "North Co",
  LegalName: "North Co LLC",
  Country: "US",
  FiscalYearStartMonth: "January",
  CompanyStartDate: "2020-01-01",
  Email: { Address: "books@example.com" },
  PrimaryPhone: { FreeFormNumber: "555-0100" },
  WebAddr: { URI: "https://example.com" },
  CompanyAddr: { Line1: "100 Main St", City: "Springfield", CountrySubDivisionCode: "IL", PostalCode: "62701" },
};

function fakeClient(info: unknown) {
  let calls = 0;
  const client = {
    getCompanyInfo: (_realmId: string, cb: Callback<unknown>) => {
      calls++;
      cb(null, info);
    },
  } as unknown as QuickBooks;
  return { client, calls: () => calls };
}

const textOf = (result: ToolResult) => result.content[0].text;
const lines = (text: string) => text.split("\n");

afterEach(() => setOutputMode("stdio"));

describe("get_company_info summary", () => {
  it("company-info-summary-fields", async () => {
    const { client } = fakeClient(FULL_INFO);
    const summary = lines(textOf(await handleGetCompanyInfo(client)));

    assert.equal(summary[0], "Company Info");
    assert.match(summary[1], /^=+$/);
    for (const line of [
      "Name: North Co",
      "Legal name: North Co LLC",
      "Country: US",
      "Fiscal year starts: January",
      "Company start date: 2020-01-01",
      "Email: books@example.com",
      "Phone: 555-0100",
      "Web: https://example.com",
      "Address:",
      "  100 Main St",
      "  Springfield, IL 62701",
    ]) {
      assert.ok(summary.includes(line), `summary has line '${line}'`);
    }
  });

  it("company-info-legal-name-same-omitted", async () => {
    const { client } = fakeClient({ CompanyName: "North Co", LegalName: "North Co" });
    const text = textOf(await handleGetCompanyInfo(client));

    assert.ok(lines(text).includes("Name: North Co"));
    assert.ok(!text.includes("Legal name:"));
  });

  it("company-info-empty-object-is-safe", async () => {
    const { client } = fakeClient({});
    const text = textOf(await handleGetCompanyInfo(client));

    assert.ok(text.includes("Company Info"));
    assert.ok(!text.includes("Address:"));
    assert.ok(!text.includes("undefined"));
    assert.ok(!text.includes("null"));
  });
});

describe("get_company_info output", () => {
  it("company-info-http-inline-json", async () => {
    setOutputMode("http");
    const { client } = fakeClient(FULL_INFO);
    const result = (await handleGetCompanyInfo(client)) as ToolResult;

    assert.equal(result.content.length, 2);
    assert.deepEqual(JSON.parse(result.content[1].text), FULL_INFO);
  });

  it("company-info-stdio-full-data-file", async () => {
    setOutputMode("stdio");
    const { client, calls } = fakeClient(FULL_INFO);
    const result = (await handleGetCompanyInfo(client)) as ToolResult;

    assert.equal(calls(), 1);
    assert.equal(result.content.length, 1);
    assert.ok(!result.content[0].text.includes('"CompanyName"'), "raw JSON stays out of the text");
    const match = /Full data: (.+)$/.exec(result.content[0].text);
    assert.ok(match, "text ends with 'Full data: <path>'");
    assert.deepEqual(JSON.parse(readFileSync(match[1], "utf8")), FULL_INFO);
  });

  it("company-info-fault-propagates", async () => {
    const fault = Object.assign(new Error("Request failed with status code 400"), {
      response: { status: 400, data: { Fault: { Error: [{ Message: "Bad", code: "2500" }] } } },
    });
    const client = {
      getCompanyInfo: (_realmId: string, cb: Callback<unknown>) => cb(fault, undefined),
    } as unknown as QuickBooks;

    await assert.rejects(
      () => handleGetCompanyInfo(client),
      (err) => err === fault
    );
  });
});
