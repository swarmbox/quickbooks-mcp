// edit_vendor: a draft-first sparse update. Only the fields passed are sent, on
// a freshly fetched SyncToken, and a partial bill_address is merged over the
// stored address. Adapted from upstream's vendor tests (laf-rge/quickbooks-mcp
// #76) to the fork's parameter names, which match create_vendor's.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { clearLookupCache } from "../../src/client/index.js";
import { handleEditVendor } from "../../src/tools/handlers/vendor.js";
import { executeTool } from "../../src/tools/index.js";

type Callback<T> = (err: unknown, result: T) => void;

// Invented fixtures only — this repository is public (CLAUDE.md).
const TERMS = [
  { Id: "1", Name: "Due on receipt", Type: "STANDARD", DueDays: 0 },
  { Id: "3", Name: "Net 30", Type: "STANDARD", DueDays: 30 },
];

const STORED = {
  Id: "42",
  SyncToken: "7",
  DisplayName: "Acme Supply Co",
  CompanyName: "Acme Supply Company",
  PrimaryEmailAddr: { Address: "ap@example.com" },
  BillAddr: { Id: "90", Line1: "1 Example Way", City: "Springfield", CountrySubDivisionCode: "ST", PostalCode: "00000" },
  AcctNum: "A-100",
  Vendor1099: false,
  Active: true,
};

function fakeClient() {
  const updated: Record<string, unknown>[] = [];
  const list = (key: string, rows: unknown[]) => ({ QueryResponse: rows.length ? { [key]: rows } : {} });
  const client = {
    findTerms: (...args: unknown[]) => (args[args.length - 1] as Callback<unknown>)(null, list("Term", TERMS)),
    getVendor: (_id: string, cb: Callback<unknown>) => cb(null, structuredClone(STORED)),
    updateVendor: (v: Record<string, unknown>, cb: Callback<unknown>) => {
      updated.push(v);
      cb(null, { ...STORED, ...v, SyncToken: "8" });
    },
  } as unknown as QuickBooks;
  return { client, updated };
}

beforeEach(() => {
  // The term cache is module-level and TTL'd.
  clearLookupCache();
});

describe("edit_vendor", () => {
  it("sends a sparse update carrying only the changed fields", async () => {
    const { client, updated } = fakeClient();
    await handleEditVendor(client, { id: "42", acct_num: "A-200", vendor_1099: true, draft: false });

    assert.deepEqual(updated[0], {
      Id: "42",
      SyncToken: "7",
      sparse: true,
      AcctNum: "A-200",
      Vendor1099: true,
    });
  });

  it("merges a partial address over the stored one", async () => {
    const { client, updated } = fakeClient();
    await handleEditVendor(client, { id: "42", bill_address: { postal_code: "11111" }, draft: false });

    assert.deepEqual(updated[0].BillAddr, {
      Id: "90", Line1: "1 Example Way", City: "Springfield", CountrySubDivisionCode: "ST", PostalCode: "11111",
    });
  });

  it("resolves payment terms by name", async () => {
    const { client, updated } = fakeClient();
    await handleEditVendor(client, { id: "42", sales_term_ref: "net 30", draft: false });

    assert.deepEqual(updated[0].TermRef, { value: "3", name: "Net 30" });
  });

  it("deactivates with active=false", async () => {
    const { client, updated } = fakeClient();
    const text = (await handleEditVendor(client, { id: "42", active: false, draft: false })).content[0].text;

    assert.equal(updated[0].Active, false);
    assert.match(text, /Vendor 42 updated successfully/);
    assert.match(text, /New SyncToken: 8/);
  });

  it("previews before and after without writing", async () => {
    const { client, updated } = fakeClient();
    const text = (await handleEditVendor(client, { id: "42", phone: "555-0199", sales_term_ref: "Net 30" })).content[0].text;

    assert.equal(updated.length, 0);
    assert.match(text, /DRAFT - Vendor Edit Preview/);
    assert.match(text, /ID: 42 \(Acme Supply Co\)/);
    assert.match(text, /^ {2}Phone: \(none\) → 555-0199$/m);
    assert.match(text, /^ {2}Terms: \(none\) → Net 30$/m);
    assert.doesNotMatch(text, /Account Number/);
  });

  it("previews a partial address as the merged result", async () => {
    const { client } = fakeClient();
    const text = (await handleEditVendor(client, { id: "42", bill_address: { postal_code: "11111" } })).content[0].text;

    assert.match(text, /Billing Address \(before\):\n {4}1 Example Way\n {4}Springfield, ST 00000/);
    assert.match(text, /Billing Address \(after\):\n {4}1 Example Way\n {4}Springfield, ST 11111/);
  });
});

// Validation runs before a client is requested, so these need no credentials.
describe("edit_vendor — argument validation", () => {
  it("refuses a misspelled parameter", async () => {
    const result = await executeTool("edit_vendor", { id: "42", account_number: "A-100" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown parameter "account_number"/);
  });

  it("refuses an unknown address key", async () => {
    const result = await executeTool("edit_vendor", { id: "42", bill_address: { zip: "00000" } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown parameter "zip" at "bill_address"/);
  });

  it("refuses notes, which the Vendor API does not accept", async () => {
    const result = await executeTool("edit_vendor", { id: "42", notes: "call first" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown parameter "notes"/);
  });

  it("refuses an edit with nothing to change", async () => {
    const result = await executeTool("edit_vendor", { id: "42", draft: false });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no fields to change/);
  });
});
