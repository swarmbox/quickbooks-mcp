// Account listing and cache invalidation: loadAllAccounts lists inactive accounts
// too and never touches the cache, and a load in flight across invalidateAccountCache
// or clearLookupCache is returned to its caller but not stored.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";
import {
  clearLookupCache,
  getAccountCache,
  invalidateAccountCache,
  loadAllAccounts,
} from "../../src/client/index.js";

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

const ACTIVE_IDS = ["10", "11", "12", "20", "21", "30", "40", "41", "42", "50"];
const ALL_IDS = [...ACTIVE_IDS, "60", "61", "70"];

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

function answerFor(kind: CallKind) {
  const rows = kind === "full listing" ? FIXTURE_CHART : FIXTURE_CHART.filter((a) => a.Active);
  return { QueryResponse: { Account: rows.map((a) => structuredClone(a)) } };
}

// A fake that answers findAccounts at once, recording what kind of call each was.
function fakeClient() {
  const calls: CallKind[] = [];
  const client = {
    findAccounts: (criteria: unknown, cb: Callback<unknown>) => {
      const kind = kindOf(criteria);
      calls.push(kind);
      cb(null, answerFor(kind));
    },
  } as unknown as QuickBooks;
  return { client, calls };
}

// A fake whose findAccounts holds each callback until the test releases it, so a
// load can be left in flight.
function heldClient() {
  const calls: CallKind[] = [];
  const pending: Array<() => void> = [];
  const client = {
    findAccounts: (criteria: unknown, cb: Callback<unknown>) => {
      const kind = kindOf(criteria);
      calls.push(kind);
      pending.push(() => cb(null, answerFor(kind)));
    },
  } as unknown as QuickBooks;

  async function release(): Promise<void> {
    while (pending.length === 0) await new Promise((r) => setImmediate(r));
    pending.shift()!();
  }

  return { client, release, calls };
}

describe("account listing and cache invalidation", () => {
  beforeEach(() => clearLookupCache());

  it("listing-includes-inactive — loadAllAccounts returns every fixture row, inactive ones included, from one full listing", async () => {
    const { client, calls } = fakeClient();

    const accounts = await loadAllAccounts(client);

    assert.deepEqual(accounts.map((a) => a.Id), ALL_IDS);
    assert.deepEqual(calls, ["full listing"]);
  });

  it("listing-not-cached — loadAllAccounts neither reads nor fills the account cache", async () => {
    const { client, calls } = fakeClient();

    await loadAllAccounts(client);
    await loadAllAccounts(client);
    await getAccountCache(client);

    assert.deepEqual(calls, ["full listing", "full listing", "cache load"]);
  });

  it("invalidate-reloads — invalidateAccountCache makes the next getAccountCache load again", async () => {
    const { client, calls } = fakeClient();
    await getAccountCache(client);

    await getAccountCache(client);
    assert.deepEqual(calls, ["cache load"]);

    invalidateAccountCache();
    await getAccountCache(client);

    assert.deepEqual(calls, ["cache load", "cache load"]);
  });

  it("invalidate-during-load-not-stored — a load in flight across invalidateAccountCache is returned but not stored", async () => {
    const { client, release, calls } = heldClient();

    const inFlight = getAccountCache(client);
    invalidateAccountCache();
    await release();
    const stale = await inFlight;
    assert.deepEqual(stale.items.map((a) => a.Id), ACTIVE_IDS);

    const next = getAccountCache(client);
    await release();
    await next;

    assert.deepEqual(calls, ["cache load", "cache load"]);
  });

  it("clear-during-load-not-stored — a load in flight across clearLookupCache is not stored", async () => {
    const { client, release, calls } = heldClient();

    const inFlight = getAccountCache(client);
    clearLookupCache();
    await release();
    await inFlight;

    const next = getAccountCache(client);
    await release();
    await next;

    assert.deepEqual(calls, ["cache load", "cache load"]);
  });
});
