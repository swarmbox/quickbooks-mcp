// Sales receipt item-line Amount/Qty/UnitPrice consistency.
//
// The sibling of the invoice suite: the same two derivation shapes, against the
// handler that carried a byte-identical copy of the same code. A create whose
// amount does not divide evenly must keep unit-price precision rather than
// round to cents, and an edit that changes an existing line's amount must
// recompute UnitPrice against the Qty already on the line.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { clearLookupCache } from "../../src/client/index.js";
import {
  handleCreateSalesReceipt,
  handleEditSalesReceipt,
} from "../../src/tools/handlers/sales-receipt.js";

type Callback<T> = (err: unknown, result: T) => void;

const CUSTOMERS = [{ Id: "20", DisplayName: "South Depot" }];
const ITEMS = [{ Id: "30", Name: "Widget", FullyQualifiedName: "Widget" }];

const RECEIPT_WITH_QTY_3 = {
  Id: "700",
  SyncToken: "0",
  CustomerRef: { value: "20", name: "South Depot" },
  Line: [
    {
      Id: "1",
      DetailType: "SalesItemLineDetail",
      Amount: 30.0,
      SalesItemLineDetail: {
        ItemRef: { value: "30", name: "Widget" },
        Qty: 3,
        UnitPrice: 10.0,
      },
    },
  ],
};

interface Sent {
  created: unknown[];
  updated: unknown[];
}

function fakeClient(entity?: Record<string, unknown>) {
  const sent: Sent = { created: [], updated: [] };
  const list = <T>(key: string, rows: T[]) => ({ QueryResponse: { [key]: rows } });

  const client = {
    findCustomers: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Customer", CUSTOMERS)),
    findItems: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Item", ITEMS)),
    findDepartments: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Department", [])),
    findAccounts: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Account", [])),
    getSalesReceipt: (_id: string, cb: Callback<unknown>) => cb(null, entity),
    createSalesReceipt: (body: unknown, cb: Callback<unknown>) => {
      sent.created.push(body);
      cb(null, { Id: "701" });
    },
    updateSalesReceipt: (body: unknown, cb: Callback<unknown>) => {
      sent.updated.push(body);
      cb(null, { Id: "700", SyncToken: "1" });
    },
  } as unknown as QuickBooks;

  return { client, sent };
}

interface ItemLine {
  Amount: number;
  SalesItemLineDetail: { Qty: number; UnitPrice: number };
}
const itemLines = (body: unknown): ItemLine[] =>
  (body as { Line: ItemLine[] }).Line.filter((l) => l.SalesItemLineDetail);

describe("sales receipt item lines", () => {
  beforeEach(() => clearLookupCache());

  it("accepts amount 100.00 at qty 3 and emits a reconciling UnitPrice", async () => {
    const { client, sent } = fakeClient();
    await handleCreateSalesReceipt(client, {
      txn_date: "2026-01-15",
      customer_name: "South Depot",
      lines: [{ item_name: "Widget", amount: 100.0, qty: 3 }],
      draft: false,
    });

    const [line] = itemLines(sent.created[0]);
    assert.equal(line.Amount, 100);
    assert.equal(line.SalesItemLineDetail.Qty, 3);
    assert.notEqual(line.SalesItemLineDetail.UnitPrice, 33.33);
    assert.equal(
      Number((line.SalesItemLineDetail.Qty * line.SalesItemLineDetail.UnitPrice).toFixed(2)),
      line.Amount,
    );
  });

  it("recomputes UnitPrice when an existing line amount changes at qty 3", async () => {
    const { client, sent } = fakeClient(RECEIPT_WITH_QTY_3);
    await handleEditSalesReceipt(client, {
      id: "700",
      lines: [{ line_id: "1", amount: 12.0 }],
      draft: false,
    });

    const [line] = itemLines(sent.updated[0]);
    assert.equal(line.Amount, 12);
    assert.equal(line.SalesItemLineDetail.Qty, 3);
    assert.equal(line.SalesItemLineDetail.UnitPrice, 4);
    assert.equal(
      Number((line.SalesItemLineDetail.Qty * line.SalesItemLineDetail.UnitPrice).toFixed(2)),
      line.Amount,
    );
  });

  it("rejects a sub-cent line without issuing a write", async () => {
    // Parity with the invoice suite: the two handlers are byte-similar and
    // should not diverge in coverage of the no-write-on-throw guarantee.
    const { client, sent } = fakeClient();
    await assert.rejects(
      () =>
        handleCreateSalesReceipt(client, {
          txn_date: "2026-01-15",
          customer_name: "South Depot",
          lines: [{ item_name: "Widget", unit_price: 10.01, qty: 2.5 }],
          draft: false,
        }),
      /whole number of cents/,
    );
    assert.equal(sent.created.length, 0);
  });
});
