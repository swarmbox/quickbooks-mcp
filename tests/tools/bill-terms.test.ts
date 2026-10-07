// Payment terms on create_bill, edit_bill and get_bill.
//
// The two no-terms pins come first and characterize today's behaviour: a call
// without sales_term_ref must keep sending exactly the payload it sends now,
// because these tools post to a live ledger. Everything after them covers the
// feature: sales_term_ref resolves a Term by name or Id, a due date that comes
// from terms is computed client-side and always sent explicitly, and the
// previews and get_bill show the terms.
//
// Calls that carry sales_term_ref go through a non-literal args object (see
// `create` and `edit`), so this file compiles against a handler signature that
// does not declare the parameter yet.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { clearLookupCache } from "../../src/client/index.js";
import { handleCreateBill, handleEditBill, handleGetBill } from "../../src/tools/handlers/bill.js";
import { toolDefinitions } from "../../src/tools/definitions.js";
import { validateToolArguments, ToolArgumentError, type ToolSchema } from "../../src/tools/validate.js";

type Callback<T> = (err: unknown, result: T) => void;
type Result = { content: Array<{ type: string; text: string }> };

// Invented fixtures only — this repository is public (CLAUDE.md).
const ACCOUNTS = [{ Id: "12", Name: "Supplies", FullyQualifiedName: "Supplies", AcctNum: "6000" }];
const VENDORS = [{ Id: "20", DisplayName: "North Produce" }];
const DEPARTMENTS = [{ Id: "40", Name: "North", FullyQualifiedName: "North" }];
const TERMS = [
  { Id: "3", Name: "Net 30", Type: "STANDARD", DueDays: 30 },
  { Id: "5", Name: "Net 05", Type: "STANDARD", DueDays: 5 },
  { Id: "8", Name: "15th of month", Type: "DATE_DRIVEN", DayOfMonthDue: 15 },
];
const NET_01 = { Id: "1", Name: "Net 01", Type: "STANDARD", DueDays: 1 };

const ACCOUNT_LINE = {
  Id: "1",
  Amount: 100.0,
  DetailType: "AccountBasedExpenseLineDetail",
  AccountBasedExpenseLineDetail: { AccountRef: { value: "12", name: "Supplies" } },
};

// A bill's raw SalesTermRef carries only `value`, which is why the display
// paths have to look the name up.
const TERMED_BILL = {
  Id: "800",
  SyncToken: "3",
  TxnDate: "2026-01-15",
  DueDate: "2026-02-14",
  SalesTermRef: { value: "3" },
  VendorRef: { value: "20", name: "North Produce" },
  Line: [ACCOUNT_LINE],
};

const UNTERMED_BILL = {
  Id: "801",
  SyncToken: "0",
  TxnDate: "2026-01-15",
  DueDate: "2026-02-14",
  VendorRef: { value: "20", name: "North Produce" },
  Line: [ACCOUNT_LINE],
};

interface Sent {
  created: unknown[];
  updated: unknown[];
  termLookups: number;
}

// findTerms takes the callback as its last argument and counts its calls, so a
// "no term lookup" pin fails the moment any code path touches it.
function fakeClient(entity?: Record<string, unknown>, extraTerms: object[] = []) {
  const sent: Sent = { created: [], updated: [], termLookups: 0 };
  const list = <T>(key: string, rows: T[]) => ({ QueryResponse: { [key]: rows } });

  const client = {
    findAccounts: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Account", ACCOUNTS)),
    findDepartments: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Department", DEPARTMENTS)),
    findClasses: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Class", [])),
    findVendors: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Vendor", VENDORS)),
    findEmployees: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Employee", [])),
    findTerms: (...args: unknown[]) => {
      sent.termLookups++;
      (args[args.length - 1] as Callback<unknown>)(null, list("Term", [...TERMS, ...extraTerms]));
    },
    createBill: (body: unknown, cb: Callback<unknown>) => {
      sent.created.push(body);
      cb(null, { Id: "802" });
    },
    getBill: (_id: string, cb: Callback<unknown>) => cb(null, entity),
    updateBill: (body: unknown, cb: Callback<unknown>) => {
      sent.updated.push(body);
      cb(null, { Id: "800", SyncToken: "4" });
    },
  } as unknown as QuickBooks;

  return { client, sent };
}

const create = (client: QuickBooks, args: Record<string, unknown>) =>
  handleCreateBill(client, args as unknown as Parameters<typeof handleCreateBill>[1]);
const edit = (client: QuickBooks, args: Record<string, unknown>) =>
  handleEditBill(client, args as unknown as Parameters<typeof handleEditBill>[1]);

const textOf = (result: Result): string => result.content.map(c => c.text).join("\n");
const linesOfText = (result: Result): string[] => textOf(result).split("\n").map(l => l.trim());

async function rejection(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return assert.fail("expected the call to be rejected");
}

const BILL_LINES = [{ account_name: "Supplies", amount: 100.0 }];
const CREATE_BASE = { vendor_name: "North Produce", txn_date: "2026-01-15", lines: BILL_LINES };

beforeEach(() => {
  // The term, vendor and account caches are module-level and TTL'd. Without a
  // reset, a "findTerms never called" pin could pass on a cache another test
  // warmed.
  clearLookupCache();
});

describe("calls without sales_term_ref are unchanged", () => {
  it("bill-no-terms-create-payload — sends today's payload and makes no term lookup", async () => {
    const { client, sent } = fakeClient();
    const full = {
      vendor_name: "North Produce",
      txn_date: "2026-01-15",
      due_date: "2026-02-14",
      memo: "Monthly supplies",
      doc_number: "1001",
      department_name: "North",
      lines: BILL_LINES,
      draft: false,
    };

    await create(client, full);
    await create(client, { ...full, due_date: undefined });
    await create(client, { ...full, sales_term_ref: "" });

    const expected = {
      VendorRef: { value: "20", name: "North Produce" },
      TxnDate: "2026-01-15",
      DueDate: "2026-02-14",
      PrivateNote: "Monthly supplies",
      DocNumber: "1001",
      DepartmentRef: { value: "40", name: "North" },
      Line: [{
        Amount: 100,
        DetailType: "AccountBasedExpenseLineDetail",
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: "12", name: "Supplies" },
          BillableStatus: "NotBillable",
        },
      }],
    };
    const { DueDate: _dropped, ...withoutDueDate } = expected;

    assert.deepEqual(sent.created[0], expected);
    assert.deepEqual(sent.created[1], withoutDueDate);
    assert.deepEqual(sent.created[2], expected);
    assert.equal(sent.termLookups, 0);
  });

  it("bill-no-terms-edit-payload — sends only the fields given and makes no term lookup", async () => {
    const { client, sent } = fakeClient(TERMED_BILL);
    const sparse = {
      Id: "800",
      SyncToken: "3",
      VendorRef: { value: "20", name: "North Produce" },
      sparse: true,
    };

    await edit(client, { id: "800", txn_date: "2026-01-20", draft: false });
    await edit(client, { id: "800", due_date: "2026-02-28", draft: false });
    await edit(client, { id: "800", due_date: "", draft: false });

    assert.deepEqual(sent.updated[0], { ...sparse, TxnDate: "2026-01-20" });
    assert.deepEqual(sent.updated[1], { ...sparse, DueDate: "2026-02-28" });
    assert.deepEqual(sent.updated[2], { ...sparse, DueDate: "" });
    assert.equal(sent.termLookups, 0);
  });
});

describe("create_bill with sales_term_ref", () => {
  it("bill-create-due-date-from-terms — computes the due date and shows it with the terms", async () => {
    const { client, sent } = fakeClient();
    const args = { ...CREATE_BASE, sales_term_ref: "Net 30" };

    const written = textOf(await create(client, { ...args, draft: false }));
    const payload = sent.created[0] as Record<string, unknown>;
    assert.equal(payload.DueDate, "2026-02-14");
    assert.deepEqual(payload.SalesTermRef, { value: "3", name: "Net 30" });
    assert.match(written, /Due Date: 2026-02-14/);
    assert.match(written, /Terms: Net 30/);

    const preview = textOf(await create(client, { ...args, draft: true }));
    const dueAt = preview.indexOf("Due Date: 2026-02-14 (Net 30: 30 days after 2026-01-15)");
    assert.notEqual(dueAt, -1, preview);
    assert.ok(preview.indexOf("Terms: Net 30", dueAt) > dueAt, "Terms line must follow the Due Date line");
    assert.equal(sent.created.length, 1, "a draft must not write");
  });

  it("bill-create-given-due-date-kept — sends an explicit due date as given and says when terms differ", async () => {
    const { client, sent } = fakeClient();
    const args = { ...CREATE_BASE, sales_term_ref: "Net 30" };

    await create(client, { ...args, due_date: "2026-02-20", draft: false });
    await create(client, { ...args, due_date: "2026-02-14", draft: false });
    assert.equal((sent.created[0] as Record<string, unknown>).DueDate, "2026-02-20");
    assert.equal((sent.created[1] as Record<string, unknown>).DueDate, "2026-02-14");

    const differing = linesOfText(await create(client, { ...args, due_date: "2026-02-20", draft: true }));
    assert.ok(
      differing.includes("Due Date: 2026-02-20 (as given; Net 30 gives 2026-02-14)"),
      differing.join("\n")
    );

    const matching = linesOfText(await create(client, { ...args, due_date: "2026-02-14", draft: true }));
    assert.ok(matching.includes("Due Date: 2026-02-14"), matching.join("\n"));
  });

  it("bill-create-date-driven — refuses date-driven terms without a due date, accepts one with it", async () => {
    const { client, sent } = fakeClient();
    const args = { ...CREATE_BASE, sales_term_ref: "15th of month" };

    for (const draft of [true, false]) {
      const message = await rejection(() => create(client, { ...args, draft }));
      assert.match(message, /15th of month/);
      assert.match(message, /due_date/);
    }
    assert.equal(sent.created.length, 0);

    await create(client, { ...args, due_date: "2026-02-15", draft: false });
    const payload = sent.created[0] as Record<string, unknown>;
    assert.equal(payload.DueDate, "2026-02-15");
    assert.deepEqual(payload.SalesTermRef, { value: "8", name: "15th of month" });
  });

  it("bill-create-bad-txn-date — refuses a txn_date it cannot compute from, before any write", async () => {
    const { client, sent } = fakeClient();
    const message = await rejection(() =>
      create(client, { ...CREATE_BASE, txn_date: "2026-02-30", sales_term_ref: "Net 30", draft: false })
    );

    assert.match(message, /txn_date/);
    assert.match(message, /2026-02-30/);
    assert.equal(sent.created.length, 0);
  });

  it("bill-create-unknown-term — refuses an unknown term with the available names", async () => {
    const { client, sent } = fakeClient();
    const message = await rejection(() =>
      create(client, { ...CREATE_BASE, sales_term_ref: "Net 5", draft: false })
    );

    assert.ok(message.startsWith('Term not found: "Net 5"'), message);
    assert.equal(sent.created.length, 0);
  });

  it("bill-create-hint-skipped — an explicit due date is never refused over an unusable txn_date", async () => {
    const { client, sent } = fakeClient();
    const args = {
      ...CREATE_BASE,
      txn_date: "2026-02-30",
      due_date: "2026-03-15",
      sales_term_ref: "Net 30",
    };

    const preview = linesOfText(await create(client, { ...args, draft: true }));
    assert.ok(preview.includes("Due Date: 2026-03-15"), preview.join("\n"));

    await create(client, { ...args, draft: false });
    const payload = sent.created[0] as Record<string, unknown>;
    assert.equal(payload.DueDate, "2026-03-15");
    assert.deepEqual(payload.SalesTermRef, { value: "3", name: "Net 30" });
  });

  it("bill-create-one-day-term — says 1 day, not 1 days", async () => {
    const { client } = fakeClient(undefined, [NET_01]);
    const preview = textOf(await create(client, { ...CREATE_BASE, sales_term_ref: "Net 01", draft: true }));

    assert.match(preview, /Due Date: 2026-01-16 \(Net 01: 1 day after 2026-01-15\)/);
  });
});

describe("edit_bill with sales_term_ref", () => {
  it("bill-edit-terms-recompute — recomputes the due date from the current or the new transaction date", async () => {
    const { client, sent } = fakeClient(TERMED_BILL);

    await edit(client, { id: "800", sales_term_ref: "Net 05", draft: false });
    const preview = textOf(await edit(client, { id: "800", sales_term_ref: "Net 05", draft: true }));
    await edit(client, { id: "800", sales_term_ref: "Net 30", txn_date: "2026-03-01", draft: false });

    const first = sent.updated[0] as Record<string, unknown>;
    assert.deepEqual(first.SalesTermRef, { value: "5", name: "Net 05" });
    assert.equal(first.DueDate, "2026-01-20");
    assert.match(preview, /Terms: Net 30 → Net 05/);
    assert.match(preview, /Due Date: 2026-02-14 → 2026-01-20 \(Net 05: 5 days after 2026-01-15\)/);

    const last = sent.updated[1] as Record<string, unknown>;
    assert.equal(last.TxnDate, "2026-03-01");
    assert.equal(last.DueDate, "2026-03-31");
    assert.equal(sent.updated.length, 2, "a draft must not write");
  });

  it("bill-edit-terms-given-due-date — keeps an explicit due date alongside new terms", async () => {
    const { client, sent } = fakeClient(TERMED_BILL);
    await edit(client, { id: "800", sales_term_ref: "Net 05", due_date: "2026-02-28", draft: false });

    const payload = sent.updated[0] as Record<string, unknown>;
    assert.equal(payload.DueDate, "2026-02-28");
    assert.deepEqual(payload.SalesTermRef, { value: "5", name: "Net 05" });
  });

  it("bill-edit-date-driven-refused — refuses date-driven terms without a due date in both draft modes", async () => {
    const { client, sent } = fakeClient(TERMED_BILL);

    for (const draft of [true, false]) {
      const message = await rejection(() =>
        edit(client, { id: "800", sales_term_ref: "15th of month", draft })
      );
      assert.match(message, /15th of month/);
      assert.match(message, /due_date/);
    }
    assert.equal(sent.updated.length, 0);
  });

  it("bill-edit-txn-date-note — a txn_date-only draft on a termed bill notes the due date is untouched", async () => {
    const termed = fakeClient(TERMED_BILL);
    const termedPreview = linesOfText(await edit(termed.client, { id: "800", txn_date: "2026-01-20", draft: true }));
    const note = termedPreview.find(l => l.startsWith("Note:"));
    assert.ok(note, termedPreview.join("\n"));
    assert.match(note, /Net 30/);
    assert.match(note, /2026-02-14/);
    assert.match(note, /sales_term_ref/);

    clearLookupCache();
    const plain = fakeClient(UNTERMED_BILL);
    const plainPreview = linesOfText(await edit(plain.client, { id: "801", txn_date: "2026-01-20", draft: true }));
    assert.equal(plainPreview.some(l => l.startsWith("Note:")), false, plainPreview.join("\n"));
  });
});

describe("get_bill terms", () => {
  it("bill-get-terms-line — prints Terms after Due Date, naming a name-less ref and skipping the lookup when absent", async () => {
    const termed = fakeClient(TERMED_BILL);
    const termedLines = linesOfText(await handleGetBill(termed.client, { id: "800" }));
    const dueAt = termedLines.findIndex(l => l.startsWith("Due Date:"));
    assert.notEqual(dueAt, -1);
    assert.equal(termedLines[dueAt + 1], "Terms: Net 30");

    clearLookupCache();
    const plain = fakeClient(UNTERMED_BILL);
    const plainLines = linesOfText(await handleGetBill(plain.client, { id: "801" }));
    assert.ok(plainLines.includes("Terms: (none)"), plainLines.join("\n"));
    assert.equal(plain.sent.termLookups, 0);
  });
});

describe("bill tool schemas", () => {
  function schemaFor(toolName: string): ToolSchema {
    const definition = toolDefinitions.find(t => t.name === toolName);
    assert.ok(definition, `no tool definition named ${toolName}`);
    return definition.inputSchema as unknown as ToolSchema;
  }
  const check = (toolName: string, args: Record<string, unknown>) =>
    validateToolArguments(toolName, schemaFor(toolName), args);

  it("bill-schema-declares-terms — accepts sales_term_ref on both bill tools and still rejects undeclared keys", () => {
    assert.doesNotThrow(() => check("create_bill", { ...CREATE_BASE, sales_term_ref: "Net 30" }));
    assert.doesNotThrow(() => check("edit_bill", { id: "800", sales_term_ref: "Net 30" }));
    assert.throws(
      () => check("create_bill", { ...CREATE_BASE, terms: "Net 30" }),
      (error: unknown) => error instanceof ToolArgumentError && /Unknown parameter "terms"/.test(error.message)
    );
  });
});
