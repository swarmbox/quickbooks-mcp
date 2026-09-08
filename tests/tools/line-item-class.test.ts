// Item-based and class-tagged expense lines on the bill and expense tools.
//
// A bill or expense line can post against an Item instead of a GL account, and
// either shape can carry a Class. The read paths have always understood both;
// the write paths could express neither until now. These tests pin the emitted
// payload shapes, the mutual exclusion between item and account, and the
// arithmetic the shared helper owns.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { clearLookupCache } from "../../src/client/index.js";
import { handleCreateBill } from "../../src/tools/handlers/bill.js";
import { handleCreateExpense } from "../../src/tools/handlers/expense.js";

type Callback<T> = (err: unknown, result: T) => void;

// Invented fixtures only — this repository is public (CLAUDE.md).
const ACCOUNTS = [
  { Id: "10", Name: "Checking", FullyQualifiedName: "Checking", AcctNum: "1000", AccountType: "Bank" },
  { Id: "12", Name: "Supplies", FullyQualifiedName: "Supplies", AcctNum: "6000" },
];

const VENDORS = [{ Id: "20", DisplayName: "Acme Supply Co" }];
const CUSTOMERS = [{ Id: "30", DisplayName: "Northwind Trading" }];
const CLASSES = [
  { Id: "60", Name: "North", FullyQualifiedName: "North" },
  { Id: "61", Name: "South", FullyQualifiedName: "South" },
];
const ITEMS = [
  { Id: "50", Name: "Widget", FullyQualifiedName: "Widget", Active: true },
  { Id: "51", Name: "Consulting Hours", FullyQualifiedName: "Consulting Hours", Active: true },
];

interface Sent {
  created: unknown[];
}

function fakeClient() {
  const sent: Sent = { created: [] };
  const list = <T>(key: string, rows: T[]) => ({ QueryResponse: { [key]: rows } });

  const client = {
    findAccounts: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Account", ACCOUNTS)),
    findDepartments: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Department", [])),
    findClasses: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Class", CLASSES)),
    findVendors: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Vendor", VENDORS)),
    findEmployees: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Employee", [])),
    findCustomers: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Customer", CUSTOMERS)),
    // resolveItem queries by exact Name, then by Id, then LIKE — mirror enough
    // of that for the fixtures above to resolve the way QBO would.
    findItems: (criteria: unknown, cb: Callback<unknown>) => {
      const terms = criteria as Array<{ field: string; value: string }>;
      const idTerm = terms.find(t => t.field === "Id");
      if (idTerm) return cb(null, list("Item", ITEMS.filter(i => i.Id === idTerm.value)));
      const nameTerm = terms.find(t => t.field === "Name");
      if (!nameTerm) return cb(null, list("Item", []));
      const raw = nameTerm.value;
      const bare = raw.replace(/%/g, "").toLowerCase();
      return cb(null, list("Item", raw.includes("%")
        ? ITEMS.filter(i => i.Name.toLowerCase().includes(bare))
        : ITEMS.filter(i => i.Name.toLowerCase() === bare)));
    },
    createBill: (body: unknown, cb: Callback<unknown>) => {
      sent.created.push(body);
      cb(null, { Id: "801" });
    },
    createPurchase: (body: unknown, cb: Callback<unknown>) => {
      sent.created.push(body);
      cb(null, { Id: "701" });
    },
  } as unknown as QuickBooks;

  return { client, sent };
}

type Line = Record<string, Record<string, unknown>> & { Amount: number };
function linesOf(body: unknown): Line[] {
  return (body as { Line: Line[] }).Line;
}

async function rejection(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return assert.fail("expected the call to be rejected");
}

const BILL_BASE = { vendor_name: "Acme Supply Co", txn_date: "2026-01-31", draft: false };
const EXPENSE_BASE = {
  payment_type: "Check" as const,
  payment_account: "Checking",
  txn_date: "2026-01-31",
  draft: false,
};

beforeEach(() => {
  // Account, vendor, class and item caches are module-level and TTL'd, so a
  // fixture from one test would otherwise answer a lookup in the next. The item
  // cache matters most: it is a lazy per-entry map, not a bulk load.
  clearLookupCache();
});

describe("item lines on create", () => {
  it("emits ItemBasedExpenseLineDetail and no account detail on a bill", async () => {
    const { client, sent } = fakeClient();
    await handleCreateBill(client, {
      ...BILL_BASE,
      lines: [{ item_name: "Widget", amount: 100.0 }],
    });

    const [line] = linesOf(sent.created[0]);
    assert.equal(line.DetailType, "ItemBasedExpenseLineDetail");
    assert.equal(line.AccountBasedExpenseLineDetail, undefined);
    const detail = line.ItemBasedExpenseLineDetail;
    assert.deepEqual(detail.ItemRef, { value: "50", name: "Widget" });
    assert.equal(detail.Qty, 1);
    assert.equal(detail.UnitPrice, 100.0);
    assert.equal(line.Amount, 100.0);
  });

  it("emits an item line on an expense too", async () => {
    const { client, sent } = fakeClient();
    await handleCreateExpense(client, {
      ...EXPENSE_BASE,
      lines: [{ item_name: "Widget", amount: 40.0 }],
    });

    const [line] = linesOf(sent.created[0]);
    assert.equal(line.DetailType, "ItemBasedExpenseLineDetail");
    assert.equal(line.AccountBasedExpenseLineDetail, undefined);
    assert.deepEqual(line.ItemBasedExpenseLineDetail.ItemRef, { value: "50", name: "Widget" });
  });

  it("resolves item_id as well as item_name", async () => {
    const { client, sent } = fakeClient();
    await handleCreateBill(client, {
      ...BILL_BASE,
      lines: [{ item_id: "51", amount: 100.0 }],
    });

    const [line] = linesOf(sent.created[0]);
    assert.deepEqual(line.ItemBasedExpenseLineDetail.ItemRef, {
      value: "51",
      name: "Consulting Hours",
    });
  });

  it("rejects a line naming both an item and an account, naming the line", async () => {
    const { client } = fakeClient();
    const message = await rejection(() =>
      handleCreateBill(client, {
        ...BILL_BASE,
        lines: [{ item_name: "Widget", account_name: "Supplies", amount: 100.0 }],
      })
    );
    assert.match(message, /Line 1/);
    assert.match(message, /Widget/);
    assert.match(message, /Supplies/);
  });

  it("still requires one of an item or an account", async () => {
    const { client } = fakeClient();
    const message = await rejection(() =>
      handleCreateBill(client, { ...BILL_BASE, lines: [{ amount: 100.0 }] })
    );
    assert.match(message, /item/i);
    assert.match(message, /account/i);
  });
});

describe("class on create", () => {
  it("puts ClassRef inside an item line's detail", async () => {
    const { client, sent } = fakeClient();
    await handleCreateBill(client, {
      ...BILL_BASE,
      lines: [{ item_name: "Widget", class_name: "North", amount: 100.0 }],
    });

    const [line] = linesOf(sent.created[0]);
    assert.deepEqual(line.ItemBasedExpenseLineDetail.ClassRef, { value: "60", name: "North" });
  });

  it("puts ClassRef inside an account line's detail on an expense", async () => {
    const { client, sent } = fakeClient();
    await handleCreateExpense(client, {
      ...EXPENSE_BASE,
      lines: [{ account_name: "Supplies", class_name: "South", amount: 25.0 }],
    });

    const [line] = linesOf(sent.created[0]);
    assert.equal(line.DetailType, "AccountBasedExpenseLineDetail");
    assert.deepEqual(line.AccountBasedExpenseLineDetail.ClassRef, { value: "61", name: "South" });
  });

  it("carries class on both detail types within one expense", async () => {
    const { client, sent } = fakeClient();
    await handleCreateExpense(client, {
      ...EXPENSE_BASE,
      lines: [
        { item_name: "Widget", class_name: "North", amount: 100.0 },
        { account_name: "Supplies", class_name: "North", amount: 25.0 },
      ],
    });

    const [itemLine, acctLine] = linesOf(sent.created[0]);
    assert.deepEqual(itemLine.ItemBasedExpenseLineDetail.ClassRef, { value: "60", name: "North" });
    assert.deepEqual(acctLine.AccountBasedExpenseLineDetail.ClassRef, { value: "60", name: "North" });
  });
});

describe("item line arithmetic", () => {
  it("accepts amount over a qty that does not divide into cents", async () => {
    // 100.00 / 3 has no exact cent representation. QBO rounds Qty x UnitPrice to
    // the cent before comparing, so the full-precision quotient reconciles and a
    // round-to-cents derivation (33.33 x 3 = 99.99) would earn a 6070.
    const { client, sent } = fakeClient();
    await handleCreateBill(client, {
      ...BILL_BASE,
      lines: [{ item_name: "Widget", amount: 100.0, qty: 3 }],
    });

    const [line] = linesOf(sent.created[0]);
    const detail = line.ItemBasedExpenseLineDetail;
    assert.equal(detail.Qty, 3);
    assert.equal(line.Amount, 100.0);
    assert.equal(
      Number(((detail.Qty as number) * (detail.UnitPrice as number)).toFixed(2)),
      line.Amount
    );
    assert.notEqual(detail.UnitPrice, 33.33);
  });

  it("derives Amount from qty and unit_price when amount is omitted", async () => {
    const { client, sent } = fakeClient();
    await handleCreateBill(client, {
      ...BILL_BASE,
      lines: [{ item_name: "Widget", qty: 4, unit_price: 25.0 }],
    });

    const [line] = linesOf(sent.created[0]);
    assert.equal(line.Amount, 100.0);
    assert.equal(line.ItemBasedExpenseLineDetail.UnitPrice, 25.0);
  });

  it("rejects a sub-cent amount from a fractional qty, naming the line", async () => {
    const { client } = fakeClient();
    const message = await rejection(() =>
      handleCreateBill(client, {
        ...BILL_BASE,
        lines: [{ item_name: "Widget", qty: 2.5, unit_price: 10.01 }],
      })
    );
    assert.match(message, /Line 1/);
  });

  it("rejects a non-positive qty rather than emitting Infinity", async () => {
    const { client } = fakeClient();
    const message = await rejection(() =>
      handleCreateBill(client, {
        ...BILL_BASE,
        lines: [{ item_name: "Widget", amount: 100.0, qty: 0 }],
      })
    );
    assert.match(message, /Line 1/);
    assert.match(message, /qty/);
  });
});

describe("account lines are unchanged by this feature", () => {
  it("emits the same bill payload as before for a plain account line", async () => {
    const { client, sent } = fakeClient();
    await handleCreateBill(client, {
      ...BILL_BASE,
      lines: [{ account_name: "Supplies", amount: 100.0, description: "Restock" }],
    });

    const [line] = linesOf(sent.created[0]);
    assert.equal(line.DetailType, "AccountBasedExpenseLineDetail");
    assert.equal(line.ItemBasedExpenseLineDetail, undefined);
    assert.equal(line.Description, "Restock");
    assert.deepEqual(line.AccountBasedExpenseLineDetail, {
      AccountRef: { value: "12", name: "Supplies" },
      BillableStatus: "NotBillable",
    });
  });

  it("keeps the expense handler's BillableStatus convention", async () => {
    // bill.ts writes NotBillable on every line; expense.ts writes it only
    // alongside a CustomerRef. That divergence is deliberate.
    const { client, sent } = fakeClient();
    await handleCreateExpense(client, {
      ...EXPENSE_BASE,
      lines: [{ account_name: "Supplies", amount: 25.0 }],
    });

    const [line] = linesOf(sent.created[0]);
    assert.equal(line.AccountBasedExpenseLineDetail.BillableStatus, undefined);
  });

  it("marks an expense item line NotBillable only alongside a customer", async () => {
    const { client, sent } = fakeClient();
    await handleCreateExpense(client, {
      ...EXPENSE_BASE,
      lines: [{ item_name: "Widget", amount: 100.0, customer_name: "Northwind Trading" }],
    });

    const [line] = linesOf(sent.created[0]);
    const detail = line.ItemBasedExpenseLineDetail;
    assert.deepEqual(detail.CustomerRef, { value: "30", name: "Northwind Trading" });
    assert.equal(detail.BillableStatus, "NotBillable");
  });
});
