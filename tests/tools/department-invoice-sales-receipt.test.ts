// Department handling on invoices and sales receipts.
//
// Both tools carry a header-level department. Edits must tell absent input
// (keep) from blank input (clear), and a whitespace-only department on create
// must mean "none" rather than partial-match a department with a space in its
// name. The fixture departments put `North East` first so an untrimmed " "
// would partial-match it.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { clearLookupCache } from "../../src/client/index.js";
import {
  handleCreateInvoice,
  handleEditInvoice,
} from "../../src/tools/handlers/invoice.js";
import {
  handleCreateSalesReceipt,
  handleEditSalesReceipt,
} from "../../src/tools/handlers/sales-receipt.js";
import { departmentFinders } from "./department-fixtures.js";

type Callback<T> = (err: unknown, result: T) => void;
type Handler = (client: QuickBooks, args: Record<string, unknown>) => Promise<unknown>;

const CUSTOMERS = [{ Id: "20", DisplayName: "South Depot" }];
const ITEMS = [{ Id: "30", Name: "Widget", FullyQualifiedName: "Widget" }];
const NORTH = { value: "2", name: "North" };

const ENTITY = {
  Id: "900",
  SyncToken: "0",
  TxnDate: "2026-01-15",
  CustomerRef: { value: "20", name: "South Depot" },
  DepartmentRef: NORTH,
  Line: [],
};

interface Sent {
  created: unknown[];
  updated: unknown[];
}

function fakeClient() {
  const sent: Sent = { created: [], updated: [] };
  const list = <T>(key: string, rows: T[]) => ({ QueryResponse: { [key]: rows } });

  const client = {
    ...departmentFinders(),
    findCustomers: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Customer", CUSTOMERS)),
    findItems: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Item", ITEMS)),
    findAccounts: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Account", [])),
    findTerms: (...args: unknown[]) =>
      (args[args.length - 1] as Callback<unknown>)(null, list("Term", [])),
    getInvoice: (_id: string, cb: Callback<unknown>) => cb(null, ENTITY),
    getSalesReceipt: (_id: string, cb: Callback<unknown>) => cb(null, ENTITY),
    createInvoice: (body: unknown, cb: Callback<unknown>) => {
      sent.created.push(body);
      cb(null, { Id: "901" });
    },
    createSalesReceipt: (body: unknown, cb: Callback<unknown>) => {
      sent.created.push(body);
      cb(null, { Id: "901" });
    },
    updateInvoice: (body: unknown, cb: Callback<unknown>) => {
      sent.updated.push(body);
      cb(null, { Id: "900", SyncToken: "1" });
    },
    updateSalesReceipt: (body: unknown, cb: Callback<unknown>) => {
      sent.updated.push(body);
      cb(null, { Id: "900", SyncToken: "1" });
    },
  } as unknown as QuickBooks;

  return { client, sent };
}

const text = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0].text;

const CREATE_ARGS = {
  txn_date: "2026-01-15",
  customer_name: "South Depot",
  lines: [{ item_name: "Widget", amount: 100 }],
};

interface CaseNames {
  group: string;
  blank: string;
  omitted: string;
  preview: string;
  whitespace: string;
}

function defineCases(names: CaseNames, edit: Handler, create: Handler): void {
  describe(names.group, () => {
    beforeEach(() => clearLookupCache());

    it(names.blank, async () => {
      const { client, sent } = fakeClient();
      await edit(client, { id: "900", department_name: "", draft: false });

      assert.equal(sent.updated.length, 1);
      assert.deepEqual((sent.updated[0] as Record<string, unknown>).DepartmentRef, { value: "" });
    });

    it(names.omitted, async () => {
      const { client, sent } = fakeClient();
      await edit(client, { id: "900", memo: "updated", draft: false });

      assert.equal(sent.updated.length, 1);
      assert.ok(!("DepartmentRef" in (sent.updated[0] as object)));
    });

    it(names.preview, async () => {
      const { client, sent } = fakeClient();
      const out = text(await edit(client, { id: "900", department_name: "", draft: true }));

      assert.match(out, /Department: North → \(none\)/);
      assert.equal(sent.updated.length, 0);
    });

    it(names.whitespace, async () => {
      const { client, sent } = fakeClient();
      await create(client, { ...CREATE_ARGS, department_name: " ", draft: false });

      assert.equal(sent.created.length, 1);
      assert.ok(!("DepartmentRef" in (sent.created[0] as object)));
    });
  });
}

defineCases(
  {
    group: "invoice department",
    blank: "invoice-edit-blank-department-clears: a blank department_name sends DepartmentRef { value \"\" }",
    omitted: "invoice-edit-omitted-department-keeps: an edit without a department sends no DepartmentRef",
    preview: "invoice-edit-clear-preview: the preview shows North → (none)",
    whitespace: "invoice-create-whitespace-department-none: a one-space department_name sends no DepartmentRef",
  },
  handleEditInvoice as Handler,
  handleCreateInvoice as Handler,
);

defineCases(
  {
    group: "sales receipt department",
    blank: "sales-receipt-edit-blank-department-clears: a blank department_name sends DepartmentRef { value \"\" }",
    omitted: "sales-receipt-edit-omitted-department-keeps: an edit without a department sends no DepartmentRef",
    preview: "sales-receipt-edit-clear-preview: the preview shows North → (none)",
    whitespace: "sales-receipt-create-whitespace-department-none: a one-space department_name sends no DepartmentRef",
  },
  handleEditSalesReceipt as Handler,
  handleCreateSalesReceipt as Handler,
);
