// The Attachments section on the get_* entity reads.
//
// Each get tool lists the attachables linked to the record it shows, placed
// directly before the "View in QuickBooks" line. The lookup must never break the
// read: a failed query renders a placeholder instead of rejecting.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { setOutputMode } from "../../src/utils/output.js";
import { handleGetBill } from "../../src/tools/handlers/bill.js";
import { handleGetExpense } from "../../src/tools/handlers/expense.js";
import { handleGetInvoice } from "../../src/tools/handlers/invoice.js";
import { handleGetDeposit } from "../../src/tools/handlers/deposit.js";
import { handleGetSalesReceipt } from "../../src/tools/handlers/sales-receipt.js";
import { handleGetJournalEntry } from "../../src/tools/handlers/journal-entry.js";
import { handleGetVendorCredit } from "../../src/tools/handlers/vendor-credit.js";
import { handleGetBillPayment } from "../../src/tools/handlers/bill-payment.js";
import { handleGetCustomer } from "../../src/tools/handlers/customer.js";
import { formatAttachmentLines } from "../../src/tools/handlers/attachment.js";

type Callback<T> = (err: unknown, result: T) => void;
type ToolResult = { content: Array<{ type: string; text: string }> };

// Invented fixtures only — this repository is public (CLAUDE.md).
const ATTACHABLES = [
  { Id: "9", SyncToken: "0", FileName: "statement.pdf", ContentType: "application/pdf", Size: 2048 },
  { Id: "10", SyncToken: "0", Note: "Approved by North" },
];

const BILL = { Id: "42", SyncToken: "0", TxnDate: "2026-01-15", TotalAmt: 100, Line: [] };

type Lookup = (criteria: unknown) => unknown[] | Error;

function fakeClient(getter: string, entity: Record<string, unknown>, lookup: Lookup) {
  const queries: unknown[] = [];
  const client = {
    [getter]: (_id: string, cb: Callback<unknown>) => cb(null, entity),
    findAttachables: (criteria: unknown, cb: Callback<unknown>) => {
      queries.push(criteria);
      const found = lookup(criteria);
      if (found instanceof Error) return cb(found, undefined);
      cb(null, { QueryResponse: { Attachable: found } });
    },
  } as unknown as QuickBooks;
  return { client, queries };
}

const textOf = (result: ToolResult) => result.content[0].text;

afterEach(() => setOutputMode("stdio"));

describe("get_bill attachments section", () => {
  it("get-bill-lists-attachments", async () => {
    const { client } = fakeClient("getBill", BILL, () => ATTACHABLES);
    const text = textOf(await handleGetBill(client, { id: "42" }));

    assert.match(text, /Attachments/);
    assert.match(text, /Attachment 9: statement\.pdf \(application\/pdf, 2\.0 KB\)/);
    assert.match(text, /Attachment 10: Note — "Approved by North"/);
    assert.ok(
      text.indexOf("Attachment 10:") < text.indexOf("View in QuickBooks:"),
      "attachments are listed before the View in QuickBooks line"
    );
    assert.ok(text.indexOf("Attachments") > text.indexOf("Lines:"));
  });

  it("get-bill-no-attachments", async () => {
    const { client } = fakeClient("getBill", BILL, () => []);
    const text = textOf(await handleGetBill(client, { id: "42" }));

    assert.match(text, /Attachments: \(none\)/);
    assert.ok(text.indexOf("Attachments: (none)") < text.indexOf("View in QuickBooks:"));
  });

  it("get-bill-survives-lookup-failure", async () => {
    const { client } = fakeClient("getBill", BILL, () => new Error("query failed"));
    const text = textOf(await handleGetBill(client, { id: "42" }));

    assert.match(text, /ID: 42/);
    assert.match(text, /Total: \$100\.00/);
    assert.match(text, /Attachments: \(could not be loaded\)/);
    assert.match(text, /View in QuickBooks:/);
  });

  it("leaves the data passed to outputReport unchanged", async () => {
    setOutputMode("http");
    const { client } = fakeClient("getBill", BILL, () => ATTACHABLES);
    const result = await handleGetBill(client, { id: "42" });

    assert.deepEqual(JSON.parse(result.content[1].text), BILL);
  });
});

describe("formatAttachmentLines", () => {
  it("never rejects when the client has no findAttachables", async () => {
    const lines = await formatAttachmentLines({} as unknown as QuickBooks, "Bill", "42");
    assert.equal(lines.join("\n"), "Attachments: (could not be loaded)");
  });

  it("renders an unusable entity id as could-not-be-loaded", async () => {
    const { client } = fakeClient("getBill", BILL, () => []);
    const lines = await formatAttachmentLines(client, "Bill", "4' or '1'='1");
    assert.equal(lines.join("\n"), "Attachments: (could not be loaded)");
  });
});

const CASES: Array<{
  tool: string;
  getter: string;
  qboType: string;
  run: (c: QuickBooks, id: string) => Promise<ToolResult>;
  entity: Record<string, unknown>;
}> = [
  { tool: "get_bill", getter: "getBill", qboType: "bill", run: (c, id) => handleGetBill(c, { id }), entity: { Id: "11", SyncToken: "0", TxnDate: "2026-01-15" } },
  { tool: "get_expense", getter: "getPurchase", qboType: "purchase", run: (c, id) => handleGetExpense(c, { id }), entity: { Id: "12", SyncToken: "0", TxnDate: "2026-01-15", PaymentType: "Check" } },
  { tool: "get_invoice", getter: "getInvoice", qboType: "invoice", run: (c, id) => handleGetInvoice(c, { id }), entity: { Id: "13", SyncToken: "0", TxnDate: "2026-01-15" } },
  { tool: "get_deposit", getter: "getDeposit", qboType: "deposit", run: (c, id) => handleGetDeposit(c, { id }), entity: { Id: "14", SyncToken: "0", TxnDate: "2026-01-15" } },
  { tool: "get_sales_receipt", getter: "getSalesReceipt", qboType: "salesreceipt", run: (c, id) => handleGetSalesReceipt(c, { id }), entity: { Id: "15", SyncToken: "0", TxnDate: "2026-01-15" } },
  { tool: "get_journal_entry", getter: "getJournalEntry", qboType: "journalentry", run: (c, id) => handleGetJournalEntry(c, { id }), entity: { Id: "16", SyncToken: "0", TxnDate: "2026-01-15" } },
  { tool: "get_vendor_credit", getter: "getVendorCredit", qboType: "vendorcredit", run: (c, id) => handleGetVendorCredit(c, { id }), entity: { Id: "17", SyncToken: "0", TxnDate: "2026-01-15" } },
  { tool: "get_bill_payment", getter: "getBillPayment", qboType: "billpayment", run: (c, id) => handleGetBillPayment(c, { id }), entity: { Id: "18", SyncToken: "0", TxnDate: "2026-01-15" } },
  { tool: "get_customer", getter: "getCustomer", qboType: "customer", run: (c, id) => handleGetCustomer(c, { id }), entity: { Id: "19", SyncToken: "0", DisplayName: "Example Customer" } },
];

describe("get tools query their own entity type", () => {
  for (const c of CASES) {
    it(`get-tools-query-own-type (${c.tool})`, async () => {
      const { client, queries } = fakeClient(c.getter, c.entity, () => ATTACHABLES);
      const text = textOf(await c.run(client, String(c.entity.Id)));

      assert.equal(queries.length, 1, "exactly one attachments lookup");
      const criteria = String(queries[0]);
      assert.ok(
        criteria.includes(`AttachableRef.EntityRef.Type = '${c.qboType}'`),
        `queries type ${c.qboType}: ${criteria}`
      );
      assert.ok(
        criteria.includes(`AttachableRef.EntityRef.value = '${c.entity.Id}'`),
        `queries id ${c.entity.Id}: ${criteria}`
      );
      assert.match(text, /Attachment 9: statement\.pdf/);
      assert.ok(text.indexOf("Attachment 9:") < text.lastIndexOf("View in QuickBooks:"));
    });
  }
});
