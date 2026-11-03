// Journal entry lines resolve departments through the shared resolver.
//
// Pins the two intentional behavior changes (an unknown department_id on a
// create line rejects before any write; an edit line's department_name may
// carry a department Id) and two regressions the swap must not break (a Id
// resolves on create; blank input means no department).
//
// Invented fixtures only — this repository is public (CLAUDE.md).

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { clearLookupCache } from "../../src/client/index.js";
import {
  handleCreateJournalEntry,
  handleEditJournalEntry,
} from "../../src/tools/handlers/journal-entry.js";
import { departmentFinders } from "./department-fixtures.js";

type Callback<T> = (err: unknown, result: T) => void;

const ACCOUNTS = [
  { Id: "12", Name: "Supplies", FullyQualifiedName: "Supplies", AcctNum: "6000" },
  { Id: "13", Name: "Sales", FullyQualifiedName: "Sales", AcctNum: "4000" },
];

// Line 0 carries department North East (Id 1); line 1 carries none.
function journalEntry() {
  return {
    Id: "600",
    SyncToken: "0",
    TxnDate: "2026-01-15",
    TotalAmt: 100.0,
    Line: [
      {
        Id: "0",
        LineNum: 1,
        Amount: 100.0,
        DetailType: "JournalEntryLineDetail",
        JournalEntryLineDetail: {
          PostingType: "Debit",
          AccountRef: { value: "12", name: "Supplies" },
          DepartmentRef: { value: "1", name: "North East" },
        },
      },
      {
        Id: "1",
        LineNum: 2,
        Amount: 100.0,
        DetailType: "JournalEntryLineDetail",
        JournalEntryLineDetail: {
          PostingType: "Credit",
          AccountRef: { value: "13", name: "Sales" },
        },
      },
    ],
  };
}

function fakeClient(entity?: Record<string, unknown>) {
  const sent = { created: [] as unknown[], updated: [] as unknown[] };
  const empty = (key: string) => (_c: unknown, cb: Callback<unknown>) =>
    cb(null, { QueryResponse: { [key]: [] } });

  const client = {
    ...departmentFinders(),
    findAccounts: (_c: unknown, cb: Callback<unknown>) =>
      cb(null, { QueryResponse: { Account: ACCOUNTS } }),
    findClasses: empty("Class"),
    findAttachables: empty("Attachable"),
    getJournalEntry: (_id: string, cb: Callback<unknown>) => cb(null, entity),
    createJournalEntry: (body: unknown, cb: Callback<unknown>) => {
      sent.created.push(body);
      cb(null, { Id: "601" });
    },
    updateJournalEntry: (body: unknown, cb: Callback<unknown>) => {
      sent.updated.push(body);
      cb(null, { Id: "600", SyncToken: "1" });
    },
  } as unknown as QuickBooks;

  return { client, sent };
}

type Line = Record<string, Record<string, unknown>>;
const linesOf = (body: unknown) => (body as { Line: Line[] }).Line;

const createArgs = (lines: unknown[]) =>
  ({ txn_date: "2026-01-15", draft: false, lines }) as unknown as Parameters<
    typeof handleCreateJournalEntry
  >[1];

const editArgs = (lines: unknown[]) =>
  ({ id: "600", draft: false, lines }) as unknown as Parameters<
    typeof handleEditJournalEntry
  >[1];

const pair = (debitExtra: Record<string, unknown>) => [
  { amount: 100.0, posting_type: "Debit", account_name: "6000", ...debitExtra },
  { amount: 100.0, posting_type: "Credit", account_name: "4000" },
];

beforeEach(() => {
  clearLookupCache();
});

describe("journal entry line departments", () => {
  it("je-create-unknown-department-id-rejects: unknown id rejects before any write", async () => {
    const { client, sent } = fakeClient();
    await assert.rejects(
      handleCreateJournalEntry(client, createArgs(pair({ department_id: "999" }))),
      /Department not found/
    );
    assert.equal(sent.created.length, 0);
  });

  it("je-create-department-id-resolves: a known id sets DepartmentRef", async () => {
    const { client, sent } = fakeClient();
    await handleCreateJournalEntry(client, createArgs(pair({ department_id: "3" })));
    const [debit] = linesOf(sent.created[0]);
    assert.equal(
      (debit.JournalEntryLineDetail.DepartmentRef as { value: string }).value,
      "3"
    );
  });

  it("je-create-whitespace-department-none: a blank name leaves DepartmentRef out", async () => {
    const { client, sent } = fakeClient();
    await handleCreateJournalEntry(client, createArgs(pair({ department_name: " " })));
    const [debit] = linesOf(sent.created[0]);
    assert.equal("DepartmentRef" in debit.JournalEntryLineDetail, false);
  });

  it("je-edit-department-id-tier: department_name equal to a department Id resolves by Id", async () => {
    const { client, sent } = fakeClient(journalEntry());
    await handleEditJournalEntry(
      client,
      editArgs([{ line_id: "0", department_name: "3" }])
    );
    const [line0] = linesOf(sent.updated[0]);
    assert.equal(
      (line0.JournalEntryLineDetail.DepartmentRef as { value: string }).value,
      "3"
    );
  });
});
