// Department handling on create_bill, edit_bill and create_vendor_credit.
//
// The header department goes through the shared resolver: absent input leaves
// the payload alone, blank input clears (edit) or means "none" (create), and a
// name or Id becomes a ref. Fixtures are invented (this repository is public).

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { clearLookupCache } from "../../src/client/index.js";
import { handleCreateBill, handleEditBill } from "../../src/tools/handlers/bill.js";
import { handleCreateVendorCredit } from "../../src/tools/handlers/vendor-credit.js";
import { departmentFinders } from "./department-fixtures.js";

type Callback<T> = (err: unknown, result: T) => void;
type Result = { content: Array<{ type: string; text: string }> };

const ACCOUNTS = [{ Id: "12", Name: "Supplies", FullyQualifiedName: "Supplies", AcctNum: "6000" }];
const VENDORS = [{ Id: "20", DisplayName: "Acme Produce" }];

const ACCOUNT_LINE = {
  Id: "1",
  Amount: 100.0,
  DetailType: "AccountBasedExpenseLineDetail",
  AccountBasedExpenseLineDetail: { AccountRef: { value: "12", name: "Supplies" } },
};

const BILL_IN_NORTH = {
  Id: "800",
  SyncToken: "3",
  TxnDate: "2026-01-15",
  DueDate: "2026-02-14",
  DepartmentRef: { value: "2", name: "North" },
  VendorRef: { value: "20", name: "Acme Produce" },
  Line: [ACCOUNT_LINE],
};

interface Sent {
  created: Array<Record<string, unknown>>;
  updated: Array<Record<string, unknown>>;
}

function fakeClient(entity?: Record<string, unknown>) {
  const sent: Sent = { created: [], updated: [] };
  const list = <T>(key: string, rows: T[]) => ({ QueryResponse: { [key]: rows } });
  const client = {
    ...departmentFinders(),
    findAccounts: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Account", ACCOUNTS)),
    findClasses: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Class", [])),
    findVendors: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Vendor", VENDORS)),
    findEmployees: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Employee", [])),
    findTerms: (...args: unknown[]) =>
      (args[args.length - 1] as Callback<unknown>)(null, list("Term", [])),
    createBill: (body: Record<string, unknown>, cb: Callback<unknown>) => {
      sent.created.push(body);
      cb(null, { Id: "802" });
    },
    createVendorCredit: (body: Record<string, unknown>, cb: Callback<unknown>) => {
      sent.created.push(body);
      cb(null, { Id: "902" });
    },
    getBill: (_id: string, cb: Callback<unknown>) => cb(null, entity),
    updateBill: (body: Record<string, unknown>, cb: Callback<unknown>) => {
      sent.updated.push(body);
      cb(null, { Id: "800", SyncToken: "4" });
    },
  } as unknown as QuickBooks;
  return { client, sent };
}

const createBill = (client: QuickBooks, args: Record<string, unknown>) =>
  handleCreateBill(client, args as unknown as Parameters<typeof handleCreateBill>[1]);
const editBill = (client: QuickBooks, args: Record<string, unknown>) =>
  handleEditBill(client, args as unknown as Parameters<typeof handleEditBill>[1]);
const createCredit = (client: QuickBooks, args: Record<string, unknown>) =>
  handleCreateVendorCredit(client, args as unknown as Parameters<typeof handleCreateVendorCredit>[1]);

const textOf = (result: Result): string => result.content.map(c => c.text).join("\n");

const LINES = [{ account_name: "Supplies", amount: 100.0 }];
const CREATE_BASE = { vendor_name: "Acme Produce", txn_date: "2026-01-15", lines: LINES };

beforeEach(() => {
  clearLookupCache();
});

describe("edit_bill department", () => {
  it("bill-edit-blank-department-clears: a blank name sends the cleared ref and matches nothing", async () => {
    const { client, sent } = fakeClient({ ...BILL_IN_NORTH });
    await editBill(client, { id: "800", department_name: "", draft: false });
    assert.equal(sent.updated.length, 1);
    assert.deepEqual(sent.updated[0].DepartmentRef, { value: "" });
    assert.deepEqual(sent.updated[0].VendorRef, { value: "20", name: "Acme Produce" });
  });

  it("bill-edit-omitted-department-keeps: no department input adds no DepartmentRef key", async () => {
    const { client, sent } = fakeClient({ ...BILL_IN_NORTH });
    await editBill(client, { id: "800", memo: "changed", draft: false });
    assert.equal(sent.updated.length, 1);
    assert.equal("DepartmentRef" in sent.updated[0], false);
  });

  it("bill-edit-clear-preview: a clear previews North → (none) and sends nothing", async () => {
    const { client, sent } = fakeClient({ ...BILL_IN_NORTH });
    const result = await editBill(client, { id: "800", department_name: "", draft: true });
    assert.match(textOf(result), /Department: North → \(none\)/);
    assert.equal(sent.updated.length, 0);
  });

  it("bill-edit-department-id-tier: an internal Id in department_name resolves to that department", async () => {
    const { client, sent } = fakeClient({ ...BILL_IN_NORTH });
    await editBill(client, { id: "800", department_name: "3", draft: false });
    assert.equal(sent.updated.length, 1);
    assert.equal((sent.updated[0].DepartmentRef as { value: string }).value, "3");
  });

  it("bill-edit-set-preview-resolved-name: the preview shows the resolved name, not the raw input", async () => {
    const { client } = fakeClient({ ...BILL_IN_NORTH });
    const result = await editBill(client, { id: "800", department_name: "sou", draft: true });
    assert.match(textOf(result), /Department: North → South/);
    assert.doesNotMatch(textOf(result), /→ sou\b/);
  });
});

describe("create_bill department", () => {
  it("bill-create-blank-id-shadows-name: a blank department_id wins over department_name, so no ref is sent", async () => {
    const { client, sent } = fakeClient();
    await createBill(client, { ...CREATE_BASE, department_id: "", department_name: "North", draft: false });
    assert.equal(sent.created.length, 1);
    assert.equal("DepartmentRef" in sent.created[0], false);
  });

  it("bill-create-whitespace-department-none: a lone space sends no DepartmentRef", async () => {
    const { client, sent } = fakeClient();
    await createBill(client, { ...CREATE_BASE, department_name: " ", draft: false });
    assert.equal(sent.created.length, 1);
    assert.equal("DepartmentRef" in sent.created[0], false);
  });
});

describe("create_vendor_credit department", () => {
  it("vendor-credit-create-whitespace-department-none: a lone space sends no DepartmentRef", async () => {
    const { client, sent } = fakeClient();
    await createCredit(client, { ...CREATE_BASE, department_name: " ", draft: false });
    assert.equal(sent.created.length, 1);
    assert.equal("DepartmentRef" in sent.created[0], false);
  });
});
