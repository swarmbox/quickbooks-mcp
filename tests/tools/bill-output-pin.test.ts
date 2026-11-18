// Byte-for-byte pins on create_bill, get_bill and edit_bill output.
//
// The bill line code is being lifted into a shared expense-lines module so the
// purchase-order tools can reuse it. These pins were captured from the bill
// handler before that lift and must never be edited to match a later change:
// bill posts to a live ledger, so its previews and payloads are a contract.
//
// Each scenario runs in HTTP output mode and compares only the summary block
// (content[0]), so no temp-file path or timestamp enters a literal, and with
// QBO_SANDBOX unset, so the View in QuickBooks host is fixed.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { clearLookupCache } from "../../src/client/index.js";
import { handleCreateBill, handleEditBill, handleGetBill } from "../../src/tools/handlers/bill.js";
import { setOutputMode } from "../../src/utils/output.js";

type Callback<T> = (err: unknown, result: T) => void;
type Result = { content: Array<{ type: string; text: string }> };
interface Criterion {
  field: string;
  value: string | boolean;
  operator: string;
}

// Invented fixtures only — this repository is public (CLAUDE.md).
const ACCOUNTS = [{ Id: "12", Name: "Supplies", FullyQualifiedName: "Supplies", AcctNum: "6000" }];
const CLASSES = [{ Id: "50", Name: "North", FullyQualifiedName: "North" }];
const VENDORS = [{ Id: "20", DisplayName: "North Freight" }];
const CUSTOMERS = [{ Id: "70", DisplayName: "Harbor Diner" }];
const ITEMS = [
  { Id: "30", Name: "Shipping", FullyQualifiedName: "Freight:Shipping", Active: true },
  { Id: "31", Name: "Shipping", FullyQualifiedName: "Supplies:Shipping", Active: true },
  { Id: "32", Name: "Fuel Surcharge", FullyQualifiedName: "Freight:Fuel Surcharge", Active: true },
  { Id: "33", Name: "Pallets (deleted)", FullyQualifiedName: "Pallets (deleted)", Active: false },
];

interface Sent {
  created: unknown[];
  updated: unknown[];
}

function fakeClient(entity?: Record<string, unknown>) {
  const sent: Sent = { created: [], updated: [] };
  const list = <T>(key: string, rows: T[]) => ({ QueryResponse: { [key]: rows } });

  const client = {
    findAccounts: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Account", ACCOUNTS)),
    findDepartments: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Department", [])),
    findClasses: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Class", CLASSES)),
    findVendors: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Vendor", VENDORS)),
    findEmployees: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Employee", [])),
    findCustomers: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Customer", CUSTOMERS)),
    findAttachables: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Attachable", [])),
    // Name "=" is case-insensitive equality, Name LIKE a substring match, and
    // with no Active criterion only active rows answer, as QBO does.
    findItems: (criteria: Criterion[], cb: Callback<unknown>) => {
      const active = criteria.find((c) => c.field === "Active");
      let rows = ITEMS.filter((i) => i.Active === (active ? active.value : true));
      for (const c of criteria) {
        const v = String(c.value).toLowerCase();
        if (c.field === "Name" && c.operator === "=") rows = rows.filter((i) => i.Name.toLowerCase() === v);
        if (c.field === "Name" && c.operator === "LIKE") {
          rows = rows.filter((i) => i.Name.toLowerCase().includes(v.replace(/%/g, "")));
        }
        if (c.field === "Id" && c.operator === "=") rows = rows.filter((i) => i.Id === c.value);
      }
      cb(null, list("Item", rows.map((i) => ({ ...i }))));
    },
    createBill: (body: unknown, cb: Callback<unknown>) => {
      sent.created.push(body);
      cb(null, { Id: "802", DocNumber: "1001" });
    },
    getBill: (_id: string, cb: Callback<unknown>) => cb(null, structuredClone(entity)),
    updateBill: (body: unknown, cb: Callback<unknown>) => {
      sent.updated.push(body);
      cb(null, { Id: "800", SyncToken: "4" });
    },
  } as unknown as QuickBooks;

  return { client, sent };
}

const summaryOf = (result: Result): string => result.content[0].text;

// An item line (qty 2, class, customer) and an account line (description, class).
const CREATE_ARGS = {
  vendor_name: "North Freight",
  txn_date: "2026-01-15",
  due_date: "2026-02-14",
  memo: "Monthly freight",
  doc_number: "1001",
  lines: [
    { item_name: "Fuel Surcharge", qty: 2, unit_price: 25, class_name: "North", customer_name: "Harbor Diner" },
    { account_name: "Supplies", amount: 100, description: "Pickup: Dock 4", class_name: "North" },
  ],
};

// A stored bill: an item line, an account line carrying class, customer and a
// description, and a third line the edit scenario deletes.
const STORED_BILL = {
  Id: "800",
  SyncToken: "3",
  TxnDate: "2026-01-15",
  DueDate: "2026-02-14",
  DocNumber: "1001",
  PrivateNote: "Monthly freight",
  TotalAmt: 190,
  VendorRef: { value: "20", name: "North Freight" },
  Line: [
    {
      Id: "1",
      LineNum: 1,
      Amount: 50,
      DetailType: "ItemBasedExpenseLineDetail",
      ItemBasedExpenseLineDetail: {
        ItemRef: { value: "32", name: "Fuel Surcharge" },
        ClassRef: { value: "50", name: "North" },
        Qty: 2,
        UnitPrice: 25,
        BillableStatus: "NotBillable",
      },
    },
    {
      Id: "2",
      LineNum: 2,
      Amount: 100,
      Description: "Pickup: Dock 4",
      DetailType: "AccountBasedExpenseLineDetail",
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: "12", name: "Supplies" },
        ClassRef: { value: "50", name: "North" },
        CustomerRef: { value: "70", name: "Harbor Diner" },
        BillableStatus: "NotBillable",
      },
    },
    {
      Id: "3",
      LineNum: 3,
      Amount: 40,
      DetailType: "AccountBasedExpenseLineDetail",
      AccountBasedExpenseLineDetail: { AccountRef: { value: "12", name: "Supplies" } },
    },
  ],
};

// Reprice the item line, convert the account line to an item line, append an
// account line and delete the third line.
const EDIT_ARGS = {
  id: "800",
  lines: [
    { line_id: "1", amount: 60 },
    { line_id: "2", item_name: "Fuel Surcharge", qty: 4 },
    { account_name: "Supplies", amount: 20, description: "Deliver: Stop A", class_name: "North" },
    { line_id: "3", delete: true },
  ],
};

let savedSandbox: string | undefined;
before(() => {
  savedSandbox = process.env.QBO_SANDBOX;
  delete process.env.QBO_SANDBOX;
  setOutputMode("http");
});
after(() => {
  setOutputMode("stdio");
  if (savedSandbox === undefined) delete process.env.QBO_SANDBOX;
  else process.env.QBO_SANDBOX = savedSandbox;
});
beforeEach(() => clearLookupCache());

const fuel = { value: "32", name: "Fuel Surcharge" };
const north = { value: "50", name: "North" };
const harbor = { value: "70", name: "Harbor Diner" };
const supplies = { value: "12", name: "Supplies" };

describe("bill output pins", () => {
  it("bill-create-draft-pinned — the create preview is byte-identical", async () => {
    const { client, sent } = fakeClient();
    const text = summaryOf(await handleCreateBill(client, CREATE_ARGS));

    assert.equal(
      text,
      [
        "DRAFT - Bill Preview",
        "",
        "Vendor: North Freight",
        "Date: 2026-01-15",
        "Due Date: 2026-02-14",
        "Terms: (none)",
        "Ref no.: 1001",
        "Department: (none)",
        "AP Account: (default)",
        "Memo: Monthly freight",
        "Total: $150.00",
        "",
        "Lines:",
        "  Item: Fuel Surcharge (Qty: 2 x $25.00) [Class: North] [Customer: Harbor Diner]: $50.00",
        '  6000 Supplies [Class: North]: $100.00 "Pickup: Dock 4"',
        "",
        "Set draft=false to create this bill.",
      ].join("\n")
    );
    assert.equal(sent.created.length, 0);
  });

  it("bill-create-commit-pinned — the create payload and result are identical", async () => {
    const { client, sent } = fakeClient();
    const text = summaryOf(await handleCreateBill(client, { ...CREATE_ARGS, draft: false }));

    assert.deepEqual(sent.created, [{
      VendorRef: { value: "20", name: "North Freight" },
      TxnDate: "2026-01-15",
      DueDate: "2026-02-14",
      PrivateNote: "Monthly freight",
      DocNumber: "1001",
      Line: [
        {
          Amount: 50,
          DetailType: "ItemBasedExpenseLineDetail",
          ItemBasedExpenseLineDetail: {
            ItemRef: fuel,
            Qty: 2,
            UnitPrice: 25,
            BillableStatus: "NotBillable",
            ClassRef: north,
            CustomerRef: harbor,
          },
        },
        {
          Amount: 100,
          Description: "Pickup: Dock 4",
          DetailType: "AccountBasedExpenseLineDetail",
          AccountBasedExpenseLineDetail: {
            AccountRef: supplies,
            BillableStatus: "NotBillable",
            ClassRef: north,
          },
        },
      ],
    }]);
    assert.equal(
      text,
      [
        "Bill Created!",
        "",
        "Vendor: North Freight",
        "Ref no.: 1001",
        "Date: 2026-01-15",
        "Due Date: 2026-02-14",
        "Terms: (none)",
        "Total: $150.00",
        "",
        "View in QuickBooks: https://app.qbo.intuit.com/app/bill?txnId=802",
      ].join("\n")
    );
  });

  it("bill-get-pinned — the get summary is byte-identical", async () => {
    const { client } = fakeClient(STORED_BILL);
    const text = summaryOf(await handleGetBill(client, { id: "800" }));

    assert.equal(
      text,
      [
        "Bill",
        "====",
        "ID: 800",
        "SyncToken: 3",
        "Vendor: North Freight",
        "Date: 2026-01-15",
        "Due Date: 2026-02-14",
        "Terms: (none)",
        "Ref no.: 1001",
        "Memo: Monthly freight",
        "AP Account: Accounts Payable",
        "Total: $190.00",
        "",
        "Lines:",
        "  Line 1: Item: Fuel Surcharge (Qty: 2 x $25.00) [Class: North] $50.00",
        '  Line 2: Supplies [Class: North] [Customer: Harbor Diner] $100.00 "Pickup: Dock 4"',
        "  Line 3: Supplies $40.00",
        "",
        "Attachments: (none)",
        "",
        "View in QuickBooks: https://app.qbo.intuit.com/app/bill?txnId=800",
      ].join("\n")
    );
  });

  it("bill-edit-pinned — the edit preview and update payload are identical", async () => {
    const draft = fakeClient(STORED_BILL);
    const text = summaryOf(await handleEditBill(draft.client, EDIT_ARGS));

    assert.equal(
      text,
      [
        "DRAFT - Bill Edit Preview",
        "",
        "ID: 800",
        "SyncToken: 3",
        "",
        "Changes:",
        "",
        "Updated Lines:",
        "  Item: Fuel Surcharge (Qty: 2 x $30.00) [Class: North]: $60.00",
        "  Item: Fuel Surcharge (Qty: 4 x $25.00) [Class: North] [Customer: Harbor Diner]: $100.00",
        "  Supplies [Class: North]: $20.00",
        "",
        "Set draft=false to apply these changes.",
      ].join("\n")
    );
    assert.equal(draft.sent.updated.length, 0);

    clearLookupCache();
    const commit = fakeClient(STORED_BILL);
    const committed = summaryOf(await handleEditBill(commit.client, { ...EDIT_ARGS, draft: false }));

    assert.deepEqual(commit.sent.updated, [{
      Id: "800",
      SyncToken: "3",
      VendorRef: { value: "20", name: "North Freight" },
      sparse: true,
      Line: [
        {
          Id: "1",
          Amount: 60,
          DetailType: "ItemBasedExpenseLineDetail",
          ItemBasedExpenseLineDetail: {
            ClassRef: north,
            BillableStatus: "NotBillable",
            ItemRef: fuel,
            Qty: 2,
            UnitPrice: 30,
          },
        },
        {
          Id: "2",
          Amount: 100,
          Description: "Pickup: Dock 4",
          DetailType: "ItemBasedExpenseLineDetail",
          ItemBasedExpenseLineDetail: {
            ClassRef: north,
            CustomerRef: harbor,
            BillableStatus: "NotBillable",
            ItemRef: fuel,
            Qty: 4,
            UnitPrice: 25,
          },
        },
        {
          Amount: 20,
          Description: "Deliver: Stop A",
          DetailType: "AccountBasedExpenseLineDetail",
          AccountBasedExpenseLineDetail: { AccountRef: supplies, ClassRef: north },
        },
      ],
    }]);
    assert.equal(
      committed,
      "Bill 800 updated successfully.\nNew SyncToken: 4\nView in QuickBooks: https://app.qbo.intuit.com/app/bill?txnId=800"
    );
  });
});
