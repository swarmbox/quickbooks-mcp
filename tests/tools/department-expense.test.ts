// Header department on create_expense / edit_expense goes through the shared
// tri-state resolver: omitted keeps, blank clears, a name sets.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { clearLookupCache } from "../../src/client/index.js";
import { handleCreateExpense, handleEditExpense } from "../../src/tools/handlers/expense.js";
import { departmentFinders } from "./department-fixtures.js";

type Callback<T> = (err: unknown, result: T) => void;

const ACCOUNTS = [
  { Id: "10", Name: "Checking", FullyQualifiedName: "Checking", AcctNum: "1000", AccountType: "Bank" },
  { Id: "12", Name: "Supplies", FullyQualifiedName: "Supplies", AcctNum: "6000" },
];

const EXPENSE_IN_NORTH = {
  Id: "700",
  SyncToken: "3",
  TxnDate: "2026-01-15",
  PaymentType: "Check",
  AccountRef: { value: "10", name: "Checking" },
  DepartmentRef: { value: "2", name: "North" },
  Line: [
    {
      Id: "1",
      LineNum: 1,
      Amount: 100.0,
      DetailType: "AccountBasedExpenseLineDetail",
      AccountBasedExpenseLineDetail: { AccountRef: { value: "12", name: "Supplies" } },
    },
  ],
};

function fakeClient() {
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  const list = <T>(key: string, rows: T[]) => ({ QueryResponse: { [key]: rows } });
  const client = {
    ...departmentFinders(),
    findAccounts: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Account", ACCOUNTS)),
    findClasses: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Class", [])),
    getPurchase: (_id: string, cb: Callback<unknown>) => cb(null, EXPENSE_IN_NORTH),
    createPurchase: (body: Record<string, unknown>, cb: Callback<unknown>) => {
      created.push(body);
      cb(null, { Id: "701" });
    },
    updatePurchase: (body: Record<string, unknown>, cb: Callback<unknown>) => {
      updated.push(body);
      cb(null, { Id: "700", SyncToken: "4" });
    },
  } as unknown as QuickBooks;
  return { client, created, updated };
}

beforeEach(() => clearLookupCache());

describe("expense header department", () => {
  it("expense-edit-blank-department-clears: blank sends a cleared DepartmentRef", async () => {
    const { client, updated } = fakeClient();
    await handleEditExpense(client, { id: "700", department_name: "", draft: false });

    assert.equal(updated.length, 1);
    assert.deepEqual(updated[0].DepartmentRef, { value: "" });
    assert.equal(updated[0].PaymentType, "Check");
    assert.equal(updated[0].sparse, true);
  });

  it("expense-edit-omitted-department-keeps: no department argument adds no key", async () => {
    const { client, updated } = fakeClient();
    await handleEditExpense(client, { id: "700", memo: "note", draft: false });

    assert.equal(updated.length, 1);
    assert.equal("DepartmentRef" in updated[0], false);
    assert.equal(updated[0].PrivateNote, "note");
  });

  it("expense-edit-clear-preview: a clear previews as North → (none)", async () => {
    const { client, updated } = fakeClient();
    const result = await handleEditExpense(client, { id: "700", department_name: "", draft: true });

    assert.equal(updated.length, 0);
    assert.match(result.content[0].text, /Department: North → \(none\)/);
  });

  it("expense-create-whitespace-department-none: a single space sets no DepartmentRef", async () => {
    const { client, created } = fakeClient();
    await handleCreateExpense(client, {
      payment_type: "Check",
      payment_account: "1000",
      txn_date: "2026-01-15",
      department_name: " ",
      draft: false,
      lines: [{ amount: 100.0, account_name: "6000" }],
    });

    assert.equal(created.length, 1);
    assert.equal("DepartmentRef" in created[0], false);
  });
});
