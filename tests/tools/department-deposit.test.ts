// Header department handling on deposits, through the shared resolver.
//
// create_deposit and edit_deposit take department_name / department_id. A blank
// name must clear (edit) or leave out (create) the department rather than
// partial-match the first department in the list, and an omitted department on
// edit must leave the existing one alone.
//
// Invented fixtures only — this repository is public (CLAUDE.md).

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { clearLookupCache } from "../../src/client/index.js";
import { handleCreateDeposit, handleEditDeposit } from "../../src/tools/handlers/deposit.js";
import { departmentFinders } from "./department-fixtures.js";

type Callback<T> = (err: unknown, result: T) => void;

const ACCOUNTS = [
  { Id: "12", Name: "Checking", FullyQualifiedName: "Checking", AcctNum: "1000" },
  { Id: "13", Name: "Sales", FullyQualifiedName: "Sales", AcctNum: "4000" },
];

function deposit() {
  return {
    Id: "700",
    SyncToken: "3",
    TxnDate: "2026-01-15",
    TotalAmt: 100.0,
    PrivateNote: "old",
    DepositToAccountRef: { value: "12", name: "Checking" },
    DepartmentRef: { value: "2", name: "North" },
    Line: [
      {
        Id: "0",
        Amount: 100.0,
        DetailType: "DepositLineDetail",
        DepositLineDetail: { AccountRef: { value: "13", name: "Sales" } },
      },
    ],
  };
}

function fakeClient() {
  const sent: { created: Record<string, unknown>[]; updated: Record<string, unknown>[] } = {
    created: [],
    updated: [],
  };
  const client = {
    ...departmentFinders(),
    findAccounts: (_c: unknown, cb: Callback<unknown>) =>
      cb(null, { QueryResponse: { Account: ACCOUNTS } }),
    getDeposit: (_id: string, cb: Callback<unknown>) => cb(null, deposit()),
    createDeposit: (body: Record<string, unknown>, cb: Callback<unknown>) => {
      sent.created.push(body);
      cb(null, { Id: "701" });
    },
    updateDeposit: (body: Record<string, unknown>, cb: Callback<unknown>) => {
      sent.updated.push(body);
      cb(null, { Id: "700", SyncToken: "4" });
    },
  } as unknown as QuickBooks;
  return { client, sent };
}

beforeEach(() => {
  clearLookupCache();
});

describe("deposit header department", () => {
  it("deposit-edit-blank-department-clears: blank department_name sends { value: '' }", async () => {
    const { client, sent } = fakeClient();
    await handleEditDeposit(client, { id: "700", department_name: "", draft: false });
    assert.equal(sent.updated.length, 1);
    assert.deepEqual(sent.updated[0].DepartmentRef, { value: "" });
    assert.deepEqual(sent.updated[0].DepositToAccountRef, { value: "12", name: "Checking" });
    assert.equal(sent.updated[0].sparse, true);
  });

  it("deposit-edit-omitted-department-keeps: memo-only edit has no DepartmentRef key", async () => {
    const { client, sent } = fakeClient();
    await handleEditDeposit(client, { id: "700", memo: "new", draft: false });
    assert.equal(sent.updated.length, 1);
    assert.equal("DepartmentRef" in sent.updated[0], false);
    assert.equal(sent.updated[0].PrivateNote, "new");
  });

  it("deposit-edit-clear-preview: preview shows North → (none)", async () => {
    const { client, sent } = fakeClient();
    const result = await handleEditDeposit(client, { id: "700", department_name: "", draft: true });
    assert.equal(sent.updated.length, 0);
    assert.match(result.content[0].text, /Department: North → \(none\)/);
  });

  it("deposit-create-whitespace-department-none: one-space department_name leaves DepartmentRef out", async () => {
    const { client, sent } = fakeClient();
    await handleCreateDeposit(client, {
      deposit_to_account: "Checking",
      txn_date: "2026-01-15",
      lines: [{ amount: 100, account_name: "Sales" }],
      department_name: " ",
      draft: false,
    });
    assert.equal(sent.created.length, 1);
    assert.equal("DepartmentRef" in sent.created[0], false);
  });
});
