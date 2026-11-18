// get_purchase_order: the summary a reader sees and the entity an editor needs.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { clearLookupCache } from "../../src/client/index.js";
import { setOutputMode } from "../../src/utils/output.js";
import { handleGetPurchaseOrder } from "../../src/tools/handlers/purchase-order.js";

type Callback<T> = (err: unknown, result: T) => void;

// Invented fixtures only — this repository is public (CLAUDE.md).
const PO_600 = {
  Id: "600",
  SyncToken: "2",
  TxnDate: "2026-11-02",
  DocNumber: "PO1001",
  POStatus: "Open",
  VendorRef: { value: "20", name: "North Freight" },
  ShipMethodRef: { value: "Truck", name: "Truck" },
  ShipAddr: { Id: "90", Line1: "Stop A", Line2: "100 Main St", City: "Northtown", CountrySubDivisionCode: "CA", PostalCode: "11111" },
  PrivateNote: "Load 1",
  Memo: "Call before delivery",
  TotalAmt: 150,
  APAccountRef: { value: "80", name: "Accounts Payable" },
  LinkedTxn: [{ TxnId: "700", TxnType: "Bill" }],
  Line: [
    {
      Id: "1",
      LineNum: 1,
      Amount: 100,
      Description: "Pickup: Dock 4\nDeliver: Stop A",
      DetailType: "ItemBasedExpenseLineDetail",
      ItemBasedExpenseLineDetail: { ItemRef: { value: "33", name: "Pallets (deleted)" }, Qty: 1, UnitPrice: 100 },
    },
    {
      Id: "2",
      LineNum: 2,
      Amount: 50,
      DetailType: "AccountBasedExpenseLineDetail",
      AccountBasedExpenseLineDetail: { AccountRef: { value: "12", name: "Supplies" } },
    },
  ],
};

function fakeClient(): QuickBooks {
  return {
    getPurchaseOrder: (_id: string, cb: Callback<unknown>) => cb(null, structuredClone(PO_600)),
    findAttachables: (_criteria: unknown, cb: Callback<unknown>) => cb(null, { QueryResponse: {} }),
  } as unknown as QuickBooks;
}

describe("handleGetPurchaseOrder", () => {
  beforeEach(() => clearLookupCache());
  afterEach(() => setOutputMode("stdio"));

  it("po-get-summary — shows the header fields, lines, link and indented description", async () => {
    const result = await handleGetPurchaseOrder(fakeClient(), { id: "600" });
    const text = result.content[0].text;
    for (const expected of [
      "ID: 600",
      "SyncToken: 2",
      "Vendor: North Freight",
      "Ref no.: PO1001",
      "Status: Open",
      "Ship via: Truck",
      "Northtown, CA 11111",
      "Memo: Load 1",
      "Vendor message: Call before delivery",
      "Line 1",
      "Line 2",
      "Bill 700",
    ]) {
      assert.ok(text.includes(expected), `missing ${expected}\n${text}`);
    }
    assert.ok(text.split("\n").includes("    Deliver: Stop A"), text);
  });

  it("po-get-entity-inline — HTTP mode carries the entity with SyncToken and line ids", async () => {
    setOutputMode("http");
    const result = await handleGetPurchaseOrder(fakeClient(), { id: "600" });
    const entity = result.content.map((c: { text: string }) => {
      try { return JSON.parse(c.text); } catch { return undefined; }
    }).find((v: unknown) => v && typeof v === "object");
    assert.equal(entity.SyncToken, "2");
    assert.deepEqual(entity.Line.map((l: { Id: string }) => l.Id), ["1", "2"]);
  });
});
