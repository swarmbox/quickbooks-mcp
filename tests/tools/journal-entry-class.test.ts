// Class and department handling on journal entry lines.
//
// Journal entry lines can carry a Class (class_name / class_id) as well as a
// Department. These tests pin the payload shapes, the preserve-on-line_id
// behaviour (a line the edit gives no class or department input keeps what it
// had), the empty-input-clears rule, and that every resolution error surfaces
// before anything is written. An empty department name must clear the line's
// department rather than partial-match the first department in the list.
//
// Invented fixtures only — this repository is public (CLAUDE.md).

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { clearLookupCache } from "../../src/client/index.js";
import {
  handleCreateJournalEntry,
  handleEditJournalEntry,
  handleGetJournalEntry,
} from "../../src/tools/handlers/journal-entry.js";

type Callback<T> = (err: unknown, result: T) => void;
type ToolResult = { content: Array<{ type: string; text: string }> };

const ACCOUNTS = [
  { Id: "12", Name: "Supplies", FullyQualifiedName: "Supplies", AcctNum: "6000" },
  { Id: "13", Name: "Sales", FullyQualifiedName: "Sales", AcctNum: "4000" },
];

const CLASSES = [
  { Id: "60", Name: "North", FullyQualifiedName: "North" },
  { Id: "61", Name: "South", FullyQualifiedName: "South" },
  { Id: "62", Name: "Parent", FullyQualifiedName: "Parent" },
  { Id: "63", Name: "Child", FullyQualifiedName: "Parent:Child" },
];

const DEPARTMENTS = [
  { Id: "70", Name: "East", FullyQualifiedName: "East" },
  { Id: "71", Name: "West", FullyQualifiedName: "West" },
];

// Line 0 carries a class and a department; line 1 carries neither.
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
          ClassRef: { value: "60", name: "North" },
          DepartmentRef: { value: "70", name: "East" },
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

interface Sent {
  created: unknown[];
  updated: unknown[];
}

// One fake standing in for every finder and writer the handlers reach for.
// `entity` seeds the read that the get and edit handlers do first.
function fakeClient(entity?: Record<string, unknown>) {
  const sent: Sent = { created: [], updated: [] };
  const list = <T>(key: string, rows: T[]) => ({ QueryResponse: { [key]: rows } });

  const client = {
    findAccounts: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Account", ACCOUNTS)),
    findDepartments: (_c: unknown, cb: Callback<unknown>) =>
      cb(null, list("Department", DEPARTMENTS)),
    findClasses: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Class", CLASSES)),
    findAttachables: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Attachable", [])),
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

// Narrow the recorded payloads without `any` at every call site.
type Line = Record<string, Record<string, unknown>> & { Amount: number };
function linesOf(body: unknown): Line[] {
  return (body as { Line: Line[] }).Line;
}

const textOf = (result: ToolResult) => result.content[0].text;

// Handler args are typed without class inputs until the feature lands; the
// casts keep these tests compiling either way.
const createArgs = (lines: unknown[], draft?: boolean) =>
  ({ txn_date: "2026-01-15", ...(draft === undefined ? {} : { draft }), lines }) as unknown as Parameters<
    typeof handleCreateJournalEntry
  >[1];

const editArgs = (lines: unknown[], draft?: boolean) =>
  ({ id: "600", ...(draft === undefined ? {} : { draft }), lines }) as unknown as Parameters<
    typeof handleEditJournalEntry
  >[1];

beforeEach(() => {
  // The account/class/department caches are module-level and TTL'd, so a
  // fixture from one test would otherwise answer a lookup in the next.
  clearLookupCache();
});

describe("create_journal_entry line class", () => {
  it("je-create-class-name-sets-classref", async () => {
    const { client, sent } = fakeClient();
    await handleCreateJournalEntry(
      client,
      createArgs(
        [
          { amount: 100.0, posting_type: "Debit", account_name: "6000", class_name: "North" },
          { amount: 100.0, posting_type: "Credit", account_name: "4000" },
        ],
        false
      )
    );

    const [debit, credit] = linesOf(sent.created[0]);
    assert.deepEqual(debit.JournalEntryLineDetail.ClassRef, { value: "60", name: "North" });
    assert.equal("ClassRef" in credit.JournalEntryLineDetail, false);
  });

  it("je-create-class-id-and-leaf-resolve", async () => {
    const { client, sent } = fakeClient();
    await handleCreateJournalEntry(
      client,
      createArgs(
        [
          { amount: 100.0, posting_type: "Debit", account_name: "6000", class_id: "63" },
          { amount: 100.0, posting_type: "Credit", account_name: "4000", class_name: "Child" },
        ],
        false
      )
    );

    const [debit, credit] = linesOf(sent.created[0]);
    const expected = { value: "63", name: "Parent:Child" };
    assert.deepEqual(debit.JournalEntryLineDetail.ClassRef, expected);
    assert.deepEqual(credit.JournalEntryLineDetail.ClassRef, expected);
  });

  it("je-create-unknown-class-rejects", async () => {
    const { client, sent } = fakeClient();
    await assert.rejects(
      handleCreateJournalEntry(
        client,
        createArgs(
          [
            { amount: 100.0, posting_type: "Debit", account_name: "6000", class_name: "Nowhere" },
            { amount: 100.0, posting_type: "Credit", account_name: "4000" },
          ],
          false
        )
      ),
      (err: Error) => {
        assert.ok(err.message.startsWith("Line "), err.message);
        assert.ok(err.message.includes('Class not found: "Nowhere"'), err.message);
        return true;
      }
    );
    assert.equal(sent.created.length, 0);
  });

  it("je-create-preview-shows-class", async () => {
    const { client, sent } = fakeClient();
    const text = textOf(
      await handleCreateJournalEntry(
        client,
        createArgs([
          { amount: 100.0, posting_type: "Debit", account_name: "6000", class_name: "North" },
          { amount: 100.0, posting_type: "Credit", account_name: "4000" },
        ])
      )
    );

    const debitLine = text.split("\n").find((l) => l.includes("Debit"));
    const creditLine = text.split("\n").find((l) => l.includes("Credit"));
    assert.ok(debitLine?.includes("[Class: North]"), text);
    assert.ok(creditLine && !creditLine.includes("[Class:"), text);
    assert.equal(sent.created.length, 0);
  });
});

describe("edit_journal_entry line class", () => {
  it("je-edit-amount-only-keeps-class", async () => {
    const { client, sent } = fakeClient(journalEntry());
    await handleEditJournalEntry(
      client,
      editArgs(
        [
          { line_id: "0", amount: 250.0 },
          { line_id: "1", amount: 250.0 },
        ],
        false
      )
    );

    const [first, second] = linesOf(sent.updated[0]);
    assert.deepEqual(first.JournalEntryLineDetail.ClassRef, { value: "60", name: "North" });
    assert.equal("ClassRef" in second.JournalEntryLineDetail, false);
  });

  it("je-edit-class-name-sets-or-replaces", async () => {
    const { client, sent } = fakeClient(journalEntry());
    await handleEditJournalEntry(
      client,
      editArgs(
        [
          { line_id: "0", class_name: "South" },
          { line_id: "1", class_name: "North" },
        ],
        false
      )
    );

    const [first, second] = linesOf(sent.updated[0]);
    assert.deepEqual(first.JournalEntryLineDetail.ClassRef, { value: "61", name: "South" });
    assert.deepEqual(second.JournalEntryLineDetail.ClassRef, { value: "60", name: "North" });
  });

  it("je-edit-empty-class-name-clears", async () => {
    const { client, sent } = fakeClient(journalEntry());
    await handleEditJournalEntry(client, editArgs([{ line_id: "0", class_name: "" }], false));

    const detail = linesOf(sent.updated[0])[0].JournalEntryLineDetail;
    assert.equal("ClassRef" in detail, false);
    assert.equal((detail.DepartmentRef as { value: string }).value, "70");
  });

  it("je-edit-empty-class-id-clears", async () => {
    const { client, sent } = fakeClient(journalEntry());
    await handleEditJournalEntry(client, editArgs([{ line_id: "0", class_id: "" }], false));

    const detail = linesOf(sent.updated[0])[0].JournalEntryLineDetail;
    assert.equal("ClassRef" in detail, false);
  });

  it("je-edit-new-line-takes-class", async () => {
    const { client, sent } = fakeClient(journalEntry());
    await handleEditJournalEntry(
      client,
      editArgs(
        [
          { line_id: "0", amount: 50.0 },
          { amount: 50.0, posting_type: "Debit", account_name: "6000", class_name: "South" },
        ],
        false
      )
    );

    const lines = linesOf(sent.updated[0]);
    assert.equal(lines.length, 3);
    assert.deepEqual(lines[2].JournalEntryLineDetail.ClassRef, { value: "61", name: "South" });
  });

  it("je-edit-preview-shows-class", async () => {
    const { client, sent } = fakeClient(journalEntry());
    const text = textOf(
      await handleEditJournalEntry(client, editArgs([{ line_id: "1", class_name: "South" }]))
    );

    assert.ok(text.includes("[Class: North]"), text);
    assert.ok(text.includes("[Class: South]"), text);
    assert.equal(sent.updated.length, 0);
  });
});

describe("get_journal_entry line class", () => {
  it("je-get-summary-shows-class", async () => {
    const { client } = fakeClient(journalEntry());
    const text = textOf(await handleGetJournalEntry(client, { id: "600" }));

    const line0 = text.split("\n").find((l) => l.includes("Line 0:"));
    const line1 = text.split("\n").find((l) => l.includes("Line 1:"));
    assert.ok(line0?.includes("[Class: North]"), text);
    assert.ok(line1 && !line1.includes("[Class:"), text);
  });
});

describe("edit_journal_entry line department", () => {
  it("je-edit-empty-department-clears", async () => {
    const { client, sent } = fakeClient(journalEntry());
    await handleEditJournalEntry(client, editArgs([{ line_id: "0", department_name: "" }], false));

    const detail = linesOf(sent.updated[0])[0].JournalEntryLineDetail;
    assert.equal("DepartmentRef" in detail, false);
    assert.equal((detail.ClassRef as { value: string }).value, "60");
  });

  it("je-edit-empty-department-no-partial-match", async () => {
    const { client, sent } = fakeClient(journalEntry());
    await handleEditJournalEntry(client, editArgs([{ line_id: "1", department_name: "" }], false));

    const detail = linesOf(sent.updated[0])[1].JournalEntryLineDetail;
    assert.equal("DepartmentRef" in detail, false);
  });

  it("je-unknown-department-rejects", async () => {
    const { client, sent } = fakeClient(journalEntry());
    await assert.rejects(
      handleEditJournalEntry(client, editArgs([{ line_id: "0", department_name: "Nowhere" }], false)),
      (err: Error) => {
        assert.ok(err.message.includes('Department not found: "Nowhere"'), err.message);
        return true;
      }
    );
    assert.equal(sent.updated.length, 0);
  });
});
