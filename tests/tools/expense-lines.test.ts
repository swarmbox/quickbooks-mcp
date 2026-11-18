// The shared expense-line module that bill uses and the purchase-order tools
// will adopt.
//
// Bill's own behaviour is pinned byte for byte in bill-output-pin.test.ts. This
// file covers what the module adds for its second caller: an exact item match
// that never guesses, an indented description layout, and a description flag on
// the payload-line formatter. Each option's default must be bill's behaviour.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { clearLookupCache, getAccountCache, getClassCache } from "../../src/client/index.js";
import {
  resolveExpenseLines,
  formatResolvedExpenseLine,
  formatStoredExpenseLine,
  formatPayloadExpenseLine,
  type QboExpenseLine,
} from "../../src/tools/handlers/expense-lines.js";

type Callback<T> = (err: unknown, result: T) => void;
interface Criterion {
  field: string;
  value: string | boolean;
  operator: string;
}

// Invented fixtures only — this repository is public (CLAUDE.md).
const ACCOUNTS = [{ Id: "12", Name: "Supplies", FullyQualifiedName: "Supplies", AcctNum: "6000" }];
const CLASSES = [{ Id: "50", Name: "North", FullyQualifiedName: "North" }];
const ITEMS = [
  { Id: "30", Name: "Shipping", FullyQualifiedName: "Freight:Shipping", Active: true },
  { Id: "31", Name: "Shipping", FullyQualifiedName: "Supplies:Shipping", Active: true },
  { Id: "32", Name: "Fuel Surcharge", FullyQualifiedName: "Freight:Fuel Surcharge", Active: true },
  { Id: "33", Name: "Pallets (deleted)", FullyQualifiedName: "Pallets (deleted)", Active: false },
];

const TWO_ROW_DESCRIPTION = "Pickup: Dock 4\nDeliver: Stop A";

// findItems takes a criteria array: Name "=" is case-insensitive equality, Name
// LIKE a substring match, and with no Active criterion only active rows answer,
// as QBO does. Every call is recorded.
function fakeClient() {
  const calls: Criterion[][] = [];
  const list = <T>(key: string, rows: T[]) => ({ QueryResponse: { [key]: rows } });
  const client = {
    findAccounts: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Account", ACCOUNTS)),
    findClasses: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Class", CLASSES)),
    findItems: (criteria: Criterion[], cb: Callback<unknown>) => {
      calls.push(criteria);
      const active = criteria.find((c) => c.field === "Active");
      let rows = ITEMS.filter((i) => i.Active === (active ? active.value : true));
      for (const c of criteria) {
        const v = String(c.value).toLowerCase();
        if (c.field === "Name" && c.operator === "=") rows = rows.filter((i) => i.Name.toLowerCase() === v);
        if (c.field === "Name" && c.operator === "LIKE") {
          rows = rows.filter((i) => i.Name.toLowerCase().includes(v.replace(/%/g, "")));
        }
        if (c.field === "Id" && c.operator === "=") rows = rows.filter((i) => i.Id === c.value);
      }
      cb(null, list("Item", rows.map((i) => ({ ...i }))));
    },
  } as unknown as QuickBooks;
  return { client, calls };
}

async function cachesFor(client: QuickBooks) {
  const [accounts, classes] = await Promise.all([getAccountCache(client), getClassCache(client)]);
  return { accounts, classes };
}

beforeEach(() => clearLookupCache());

describe("resolveExpenseLines item matching", () => {
  it("expense-lines-exact-mode — exact refuses a partial item name; the default resolves it as bill does", async () => {
    const { client } = fakeClient();
    const caches = await cachesFor(client);
    const lines = [{ item_name: "Ship", amount: 10 }];

    await assert.rejects(
      () => resolveExpenseLines(client, lines, { ...caches, itemMatch: "exact" }),
      (err: Error) => err.message.startsWith("Line 1")
    );

    // Bill's loose path: no exact Name hit, so a LIKE query picks the first
    // partial match.
    assert.deepEqual(await resolveExpenseLines(client, lines, caches), [{
      item_name: "Ship",
      amount: 10,
      amount_cents: 1000,
      item_ref: { value: "30", name: "Shipping" },
      class_ref: undefined,
      customer_ref: undefined,
      qty: 1,
      unit_price: 10,
    }]);
  });
});

describe("description layout", () => {
  it("description-layout-option — indented puts each description row on its own row; the default is bill's inline form", async () => {
    const { client } = fakeClient();
    const [resolved] = await resolveExpenseLines(
      client,
      [{ account_name: "Supplies", amount: 100, description: TWO_ROW_DESCRIPTION }],
      await cachesFor(client)
    );
    const stored: QboExpenseLine = {
      Id: "2",
      Amount: 100,
      Description: TWO_ROW_DESCRIPTION,
      DetailType: "AccountBasedExpenseLineDetail",
      AccountBasedExpenseLineDetail: { AccountRef: { value: "12", name: "Supplies" } },
    };

    assert.deepEqual(formatResolvedExpenseLine(resolved, { descriptionLayout: "indented" }).split("\n"), [
      "  6000 Supplies: $100.00",
      "    Pickup: Dock 4",
      "    Deliver: Stop A",
    ]);
    assert.deepEqual(formatStoredExpenseLine(stored, { descriptionLayout: "indented" })?.split("\n"), [
      "  Line 2: Supplies $100.00",
      "    Pickup: Dock 4",
      "    Deliver: Stop A",
    ]);

    assert.equal(formatResolvedExpenseLine(resolved), `  6000 Supplies: $100.00 "${TWO_ROW_DESCRIPTION}"`);
    assert.equal(formatStoredExpenseLine(stored), `  Line 2: Supplies $100.00 "${TWO_ROW_DESCRIPTION}"`);
  });

  it("payload-line-description-flag — the payload-line row shows the description only when asked", () => {
    const line: QboExpenseLine = {
      Amount: 100,
      Description: "Pickup: Dock 4",
      DetailType: "AccountBasedExpenseLineDetail",
      AccountBasedExpenseLineDetail: { AccountRef: { value: "12", name: "Supplies" } },
    };

    assert.match(formatPayloadExpenseLine(line, { description: true }) ?? "", /Pickup: Dock 4/);
    const bare = formatPayloadExpenseLine(line, { description: false });
    assert.equal(bare, "  Supplies: $100.00");
    assert.doesNotMatch(bare ?? "", /Pickup/);
  });
});
