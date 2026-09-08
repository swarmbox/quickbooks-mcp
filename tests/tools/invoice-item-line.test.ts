// Invoice item-line Amount/Qty/UnitPrice consistency.
//
// QBO validates Amount == Qty * UnitPrice on item lines and returns fault 6070
// when they disagree, so every emitted SalesItemLineDetail has to reconcile.
// Two shapes are pinned here that a naive implementation gets wrong in opposite
// directions: a create line whose amount does not divide evenly (rounding the
// unit price to cents is what BREAKS it), and an edit that changes an existing
// line's amount while its Qty stays put — which used to leave the prior
// UnitPrice in place and ship a knowingly inconsistent triple.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { clearLookupCache } from "../../src/client/index.js";
import { handleCreateInvoice, handleEditInvoice } from "../../src/tools/handlers/invoice.js";

type Callback<T> = (err: unknown, result: T) => void;

const CUSTOMERS = [{ Id: "20", DisplayName: "North Depot" }];
const ITEMS = [{ Id: "30", Name: "Widget", FullyQualifiedName: "Widget" }];

const INVOICE_WITH_QTY_3 = {
  Id: "900",
  SyncToken: "0",
  CustomerRef: { value: "20", name: "North Depot" },
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
    findTerms: (cb: Callback<unknown>) => cb(null, list("Term", [])),
    getInvoice: (_id: string, cb: Callback<unknown>) => cb(null, entity),
    createInvoice: (body: unknown, cb: Callback<unknown>) => {
      sent.created.push(body);
      cb(null, { Id: "901" });
    },
    updateInvoice: (body: unknown, cb: Callback<unknown>) => {
      sent.updated.push(body);
      cb(null, { Id: "900", SyncToken: "1" });
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

describe("invoice item lines", () => {
  beforeEach(() => clearLookupCache());

  it("accepts amount 100.00 at qty 3 and emits a reconciling UnitPrice", async () => {
    const { client, sent } = fakeClient();
    await handleCreateInvoice(client, {
      txn_date: "2026-01-15",
      customer_name: "North Depot",
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
    const { client, sent } = fakeClient(INVOICE_WITH_QTY_3);
    await handleEditInvoice(client, {
      id: "900",
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
    const { client, sent } = fakeClient();
    await assert.rejects(
      () =>
        handleCreateInvoice(client, {
          txn_date: "2026-01-15",
          customer_name: "North Depot",
          lines: [{ item_name: "Widget", unit_price: 10.01, qty: 2.5 }],
          draft: false,
        }),
      /whole number of cents/,
    );
    assert.equal(sent.created.length, 0);
  });
});
