// sales_term_ref on the invoice and customer tools.
//
// create_invoice, edit_invoice, create_customer and edit_customer each resolve
// a Term by exact name or Id and send SalesTermRef as { value, name }. Those
// payloads and the miss error are pinned here so they hold while the lookups
// move onto the shared term helper. The display cases pin the one deliberate
// change: a SalesTermRef that arrives without a name (as a bill's does) is
// labelled from the term cache instead of reading "(none)".

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { clearLookupCache } from "../../src/client/index.js";
import { handleCreateInvoice, handleEditInvoice, handleGetInvoice } from "../../src/tools/handlers/invoice.js";
import { handleCreateCustomer, handleEditCustomer, handleGetCustomer } from "../../src/tools/handlers/customer.js";

type Callback<T> = (err: unknown, result: T) => void;
type Handler = (client: QuickBooks, args: Record<string, unknown>) => Promise<unknown>;

const TERMS = [
  { Id: "3", Name: "Net 30", Type: "STANDARD", DueDays: 30 },
  { Id: "5", Name: "Net 05", Type: "STANDARD", DueDays: 5 },
  { Id: "8", Name: "15th of month", Type: "DATE_DRIVEN", DayOfMonthDue: 15 },
];
const CUSTOMERS = [{ Id: "20", DisplayName: "North Depot" }];
const ITEMS = [{ Id: "30", Name: "Widget", FullyQualifiedName: "Widget" }];

const INVOICE = {
  Id: "900",
  SyncToken: "0",
  TxnDate: "2026-01-15",
  CustomerRef: { value: "20", name: "North Depot" },
  Line: [],
};
const CUSTOMER = { Id: "20", SyncToken: "0", DisplayName: "North Depot" };

interface Sent {
  created: unknown[];
  updated: unknown[];
  termLookups: number;
}

// findTerms takes the callback as its last argument, so the fake serves both
// the legacy one-argument call and the cache's (criteria, cb) call.
function fakeClient(entities: { invoice?: object; customer?: object } = {}) {
  const sent: Sent = { created: [], updated: [], termLookups: 0 };
  const list = <T>(key: string, rows: T[]) => ({ QueryResponse: { [key]: rows } });

  const client = {
    findCustomers: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Customer", CUSTOMERS)),
    findItems: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Item", ITEMS)),
    findDepartments: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Department", [])),
    findTerms: (...args: unknown[]) => {
      sent.termLookups++;
      (args[args.length - 1] as Callback<unknown>)(null, list("Term", TERMS));
    },
    getInvoice: (_id: string, cb: Callback<unknown>) => cb(null, entities.invoice ?? INVOICE),
    getCustomer: (_id: string, cb: Callback<unknown>) => cb(null, entities.customer ?? CUSTOMER),
    createInvoice: (body: unknown, cb: Callback<unknown>) => {
      sent.created.push(body);
      cb(null, { Id: "901" });
    },
    updateInvoice: (body: unknown, cb: Callback<unknown>) => {
      sent.updated.push(body);
      cb(null, { Id: "900", SyncToken: "1" });
    },
    createCustomer: (body: unknown, cb: Callback<unknown>) => {
      sent.created.push(body);
      cb(null, { Id: "21", DisplayName: "South Yard" });
    },
    updateCustomer: (body: unknown, cb: Callback<unknown>) => {
      sent.updated.push(body);
      cb(null, { Id: "20", SyncToken: "1" });
    },
  } as unknown as QuickBooks;

  return { client, sent };
}

const BASE_INVOICE_ARGS = {
  txn_date: "2026-01-15",
  customer_name: "North Depot",
  lines: [{ item_name: "Widget", amount: 100 }],
};

// Each site with the args that reach its write, and the payload it writes.
const SITES: Array<{
  label: string;
  handler: Handler;
  args: Record<string, unknown>;
  written: (sent: Sent) => unknown[];
}> = [
  {
    label: "create_invoice",
    handler: handleCreateInvoice as Handler,
    args: BASE_INVOICE_ARGS,
    written: (s) => s.created,
  },
  {
    label: "edit_invoice",
    handler: handleEditInvoice as Handler,
    args: { id: "900" },
    written: (s) => s.updated,
  },
  {
    label: "create_customer",
    handler: handleCreateCustomer as Handler,
    args: { display_name: "South Yard" },
    written: (s) => s.created,
  },
  {
    label: "edit_customer",
    handler: handleEditCustomer as Handler,
    args: { id: "20" },
    written: (s) => s.updated,
  },
];

const text = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0].text;

describe("sales_term_ref on invoice and customer", () => {
  beforeEach(() => clearLookupCache());

  it("sibling-term-by-name-or-id — every site writes SalesTermRef as exactly { value, name }", async () => {
    for (const site of SITES) {
      for (const input of ["net 30", "3"]) {
        const { client, sent } = fakeClient();
        await site.handler(client, { ...site.args, sales_term_ref: input, draft: false });

        const payloads = site.written(sent) as Array<Record<string, unknown>>;
        assert.equal(payloads.length, 1, `${site.label} "${input}" writes once`);
        assert.deepEqual(
          payloads[0].SalesTermRef,
          { value: "3", name: "Net 30" },
          `${site.label} "${input}"`
        );
      }
    }
  });

  it("sibling-term-miss — every site rejects with the unchanged text and writes nothing", async () => {
    for (const site of SITES) {
      const { client, sent } = fakeClient();
      await assert.rejects(
        site.handler(client, { ...site.args, sales_term_ref: "Net 5", draft: false }),
        { message: 'Term not found: "Net 5". Available: Net 30, Net 05, 15th of month' },
        site.label
      );
      assert.equal(sent.created.length + sent.updated.length, 0, `${site.label} makes no write`);
    }
  });

  it("sibling-no-terms-no-lookup — every site omits SalesTermRef and never calls findTerms", async () => {
    for (const site of SITES) {
      const { client, sent } = fakeClient();
      await site.handler(client, { ...site.args, draft: false });

      const payloads = site.written(sent) as Array<Record<string, unknown>>;
      assert.equal(payloads.length, 1, `${site.label} writes once`);
      assert.ok(!("SalesTermRef" in payloads[0]), `${site.label} has no SalesTermRef key`);
      assert.equal(sent.termLookups, 0, `${site.label} makes no term lookup`);
    }
  });

  it("sibling-display-nameless-ref — gets and edit previews label a name-less ref from the term cache", async () => {
    const invoice = { ...INVOICE, SalesTermRef: { value: "3" } };
    const customer = { ...CUSTOMER, SalesTermRef: { value: "3" } };

    const got = {
      invoice: text(await handleGetInvoice(fakeClient({ invoice }).client, { id: "900" })),
      customer: text(await handleGetCustomer(fakeClient({ customer }).client, { id: "20" })),
    };
    assert.match(got.invoice, /Terms: Net 30\b/, "get_invoice");
    assert.match(got.customer, /Terms: Net 30\b/, "get_customer");

    const preview = {
      invoice: text(
        await handleEditInvoice(fakeClient({ invoice }).client, { id: "900", sales_term_ref: "Net 05", draft: true })
      ),
      customer: text(
        await handleEditCustomer(fakeClient({ customer }).client, { id: "20", sales_term_ref: "Net 05", draft: true })
      ),
    };
    assert.match(preview.invoice, /Terms: Net 30 → Net 05/, "edit_invoice preview");
    assert.match(preview.customer, /Terms: Net 30 → Net 05/, "edit_customer preview");
  });

  it("sibling-display-named-ref — a named or absent ref displays as today with no term lookup", async () => {
    const named = { value: "3", name: "Net 30" };
    const withTerms = fakeClient({
      invoice: { ...INVOICE, SalesTermRef: named },
      customer: { ...CUSTOMER, SalesTermRef: named },
    });
    const bare = fakeClient();

    const namedInvoice = text(await handleGetInvoice(withTerms.client, { id: "900" }));
    const namedCustomer = text(await handleGetCustomer(withTerms.client, { id: "20" }));
    assert.match(namedInvoice, /Terms: Net 30\b/, "get_invoice named");
    assert.match(namedCustomer, /Terms: Net 30\b/, "get_customer named");

    const bareInvoice = text(await handleGetInvoice(bare.client, { id: "900" }));
    const bareCustomer = text(await handleGetCustomer(bare.client, { id: "20" }));
    assert.match(bareInvoice, /Terms: \(none\)/, "get_invoice absent");
    assert.match(bareCustomer, /Terms: \(none\)/, "get_customer absent");

    assert.equal(withTerms.sent.termLookups, 0, "named refs make no term lookup");
    assert.equal(bare.sent.termLookups, 0, "absent refs make no term lookup");
  });
});
