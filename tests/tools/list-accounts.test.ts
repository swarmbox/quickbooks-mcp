// list_accounts: active_only false lists inactive accounts too (a default Account
// query lists active ones only), while the default keeps reading the cache.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";
import { clearLookupCache } from "../../src/client/index.js";
import { handleListAccounts } from "../../src/tools/handlers/index.js";

type Callback<T> = (err: unknown, result: T) => void;

interface FixtureAccount {
  Id: string;
  Name: string;
  FullyQualifiedName: string;
  AcctNum: string;
  AccountType: string;
  AccountSubType: string;
  Classification: string;
  SubAccount: boolean;
  ParentRef?: { value: string };
  Active: boolean;
  CurrentBalance: number;
  SyncToken: string;
}

function row(
  Id: string,
  Name: string,
  FullyQualifiedName: string,
  AcctNum: string,
  AccountType: string,
  AccountSubType: string,
  Classification: string,
  parent: string | undefined,
  Active: boolean,
  CurrentBalance: number,
  SyncToken: string
): FixtureAccount {
  return {
    Id, Name, FullyQualifiedName, AcctNum, AccountType, AccountSubType, Classification,
    SubAccount: parent !== undefined,
    ...(parent !== undefined ? { ParentRef: { value: parent } } : {}),
    Active, CurrentBalance, SyncToken,
  };
}

// Invented fixtures only — this repository is public (CLAUDE.md). Inactive
// account 70 keeps the number "6200" that active account 20 now holds.
const FIXTURE_CHART: FixtureAccount[] = [
  row("10", "Utilities", "Utilities", "6100", "Expense", "Utilities", "Expense", undefined, true, 0, "3"),
  row("11", "Electric", "Utilities:Electric", "6110", "Expense", "Utilities", "Expense", "10", true, 0, "1"),
  row("12", "Water", "Utilities:Water", "6120", "Expense", "Utilities", "Expense", "10", true, 0, "1"),
  row("20", "Repairs", "Repairs", "6200", "Expense", "RepairMaintenance", "Expense", undefined, true, 0, "2"),
  row("21", "Electric", "Repairs:Electric", "6210", "Expense", "RepairMaintenance", "Expense", "20", true, 0, "0"),
  row("30", "Operating Cash", "Operating Cash", "1000", "Bank", "Checking", "Asset", undefined, true, 100, "5"),
  row("40", "Savings", "Savings", "1100", "Bank", "Savings", "Asset", undefined, true, 0, "0"),
  row("41", "Reserve", "Savings:Reserve", "1110", "Bank", "Savings", "Asset", "40", true, 100, "0"),
  row("42", "Petty Cash", "Savings:Petty Cash", "1120", "Bank", "CashOnHand", "Asset", "40", true, 0, "0"),
  row("50", "Sales", "Sales", "4000", "Income", "SalesOfProductIncome", "Revenue", undefined, true, 0, "0"),
  row("60", "Old Supplies (deleted)", "Old Supplies (deleted)", "6300", "Expense", "SuppliesMaterials", "Expense", undefined, false, 0, "4"),
  row("61", "Toner (deleted)", "Old Supplies (deleted):Toner (deleted)", "6310", "Expense", "SuppliesMaterials", "Expense", "60", false, 0, "2"),
  row("70", "Freight (deleted)", "Freight (deleted)", "6200", "Expense", "ShippingFreightDelivery", "Expense", undefined, false, 0, "1"),
];

type CallKind = "full listing" | "cache load";

function kindOf(criteria: unknown): CallKind {
  try {
    assert.deepEqual(criteria, { fetchAll: true, Active: [true, false] });
    return "full listing";
  } catch {
    assert.deepEqual(criteria, { fetchAll: true });
    return "cache load";
  }
}

// A fake that serves the fixture chart: a full listing answers every row, a cache
// load answers the active rows only.
function fakeClient() {
  const calls: CallKind[] = [];
  const client = {
    findAccounts: (criteria: unknown, cb: Callback<unknown>) => {
      const kind = kindOf(criteria);
      calls.push(kind);
      const rows = kind === "full listing" ? FIXTURE_CHART : FIXTURE_CHART.filter((a) => a.Active);
      cb(null, { QueryResponse: { Account: rows.map((a) => structuredClone(a)) } });
    },
  } as unknown as QuickBooks;
  return { client, calls };
}

function lines(result: { content: Array<{ text: string }> }): string[] {
  return result.content[0].text.split("\n");
}

describe("list_accounts", () => {
  beforeEach(() => clearLookupCache());

  it("list-accounts-includes-inactive — active_only false counts the inactive accounts, from one full listing", async () => {
    const { client, calls } = fakeClient();

    const result = await handleListAccounts(client, { active_only: false });

    assert.ok(lines(result).includes("Accounts: 13"));
    assert.deepEqual(calls, ["full listing"]);
  });

  it("list-accounts-default-active — the default lists active accounts only, from the cache load", async () => {
    const { client, calls } = fakeClient();

    const result = await handleListAccounts(client, {});

    assert.ok(lines(result).includes("Accounts: 10"));
    assert.deepEqual(calls, ["cache load"]);
  });

  it("list-accounts-type-filter-inactive — account_type still filters when inactive accounts are included", async () => {
    const { client } = fakeClient();

    const result = await handleListAccounts(client, { active_only: false, account_type: "Bank" });

    assert.ok(lines(result).includes("Accounts: 4"));
  });
});
