// edit_account: a draft-first account edit. Every check runs against a full
// listing (inactive accounts included) taken in the same call, so a draft and a
// commit each see the books as they are now, and updateAccount is never called
// unless every check has just passed. A commit fetches the record again for a
// fresh SyncToken, and reports the name and status the update response carries.
//
// The fake tells the two kinds of findAccounts call apart: criteria deep-equal to
// { fetchAll: true, Active: [true, false] } are a full listing, and
// { fetchAll: true } is a cache load (active accounts only).

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { clearLookupCache, getAccountCache } from "../../src/client/index.js";
import { handleEditAccount } from "../../src/tools/handlers/account.js";
import { executeTool } from "../../src/tools/index.js";

type Callback<T> = (err: unknown, result: T) => void;
type Result = { content: Array<{ type: string; text: string }> };
type CallKind = "full listing" | "cache load";
type Row = Record<string, unknown> & { Id: string; FullyQualifiedName: string; SyncToken: string };

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
): Row {
  return {
    Id, Name, FullyQualifiedName, AcctNum, AccountType, AccountSubType, Classification,
    SubAccount: parent !== undefined,
    ...(parent !== undefined ? { ParentRef: { value: parent } } : {}),
    Active, CurrentBalance, SyncToken,
  };
}

// Invented fixtures only — this repository is public (CLAUDE.md). Inactive
// account 70 keeps the number "6200" that active account 20 now holds.
const FIXTURE_CHART: Row[] = [
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

const fixture = (id: string): Row => structuredClone(FIXTURE_CHART.find((a) => a.Id === id)!);

// The shape node-quickbooks really rejects with on an HTTP 400: an axios-style
// Error with the Fault on response.data rather than on the error itself.
function axiosFault(code: string, message: string, detail: string): Error {
  return Object.assign(new Error("Request failed with status code 400"), {
    response: {
      status: 400,
      data: { Fault: { type: "ValidationFault", Error: [{ code, Message: message, Detail: detail }] } },
    },
  });
}
const fault2010 = () =>
  axiosFault("2010", "Request has invalid or unsupported property", "Request has invalid or unsupported property");
const fault2170 = () =>
  axiosFault("2170", "Invalid Enumeration", "Invalid Enumeration : Invalid Account.AccountType && Account.SubType");

interface FakeOptions {
  // What getAccount answers for this row's Id instead of the fixture row.
  getAccountRow?: Row;
  // What updateAccount answers instead of the default merge.
  updateResponse?: Record<string, unknown>;
  // What updateAccount does: reject with this value instead of answering.
  updateError?: unknown;
}

// Records every call in order, so "no write", "fetched before the write" and
// "before any QBO call" are checked against what the fake saw.
function fakeClient(options: FakeOptions = {}) {
  const calls: string[] = [];
  const listings: CallKind[] = [];
  const fetched: string[] = [];
  const updated: Array<Record<string, unknown>> = [];
  let cacheLoads = 0;

  const copies = (rows: Row[]) => rows.map((r) => structuredClone(r));
  const stored = (id: string): Row =>
    options.getAccountRow?.Id === id ? structuredClone(options.getAccountRow) : fixture(id);

  const client = {
    findAccounts: (criteria: unknown, cb: Callback<unknown>) => {
      calls.push("findAccounts");
      let kind: CallKind;
      try {
        assert.deepEqual(criteria, { fetchAll: true, Active: [true, false] });
        kind = "full listing";
      } catch {
        assert.deepEqual(criteria, { fetchAll: true });
        kind = "cache load";
      }
      listings.push(kind);
      if (kind === "cache load") {
        cacheLoads++;
        return cb(null, { QueryResponse: { Account: copies(FIXTURE_CHART.filter((a) => a.Active)) } });
      }
      cb(null, { QueryResponse: { Account: copies(FIXTURE_CHART) } });
    },
    getAccount: (id: string, cb: Callback<unknown>) => {
      calls.push("getAccount");
      fetched.push(id);
      cb(null, stored(id));
    },
    updateAccount: (body: Record<string, unknown>, cb: Callback<unknown>) => {
      calls.push("updateAccount");
      updated.push(structuredClone(body));
      if (options.updateError !== undefined) return cb(options.updateError, undefined);
      if (options.updateResponse !== undefined) return cb(null, structuredClone(options.updateResponse));
      const base = stored(body.Id as string);
      const { sparse: _sparse, ...sent } = body;
      cb(null, { ...base, ...sent, SyncToken: String(Number(base.SyncToken) + 1) });
    },
    createAccount: (_body: unknown, cb: Callback<unknown>) => {
      calls.push("createAccount");
      cb(new Error("createAccount is not expected by edit_account"), undefined);
    },
  } as unknown as QuickBooks;

  return {
    client,
    calls,
    listings,
    fetched,
    updated,
    cacheLoads: () => cacheLoads,
    writes: () => calls.filter((c) => c === "createAccount" || c === "updateAccount"),
  };
}

const edit = (client: QuickBooks, args: Record<string, unknown>) =>
  handleEditAccount(client, args as unknown as Parameters<typeof handleEditAccount>[1]) as Promise<Result>;

const textOf = (result: Result): string => result.content.map((c) => c.text).join("\n");
const linesOf = (result: Result): string[] => textOf(result).split("\n");

const hasLine = (result: Result, line: string) =>
  assert.ok(linesOf(result).includes(line), `expected the line "${line}" in:\n${textOf(result)}`);

async function rejection(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return assert.fail("expected the call to be rejected");
}

// A refusal "lists" an account as a line "  - <FullyQualifiedName> (id <Id>)".
const listLine = (fullName: string, id: string) => `  - ${fullName} (id ${id})`;
const listed = (text: string, fullName: string, id: string) =>
  assert.ok(
    text.split("\n").includes(listLine(fullName, id)),
    `expected the line "${listLine(fullName, id)}" in:\n${text}`
  );

// The lines directly after a header line, as many as expected, compared as a set.
function linesAfter(result: Result, header: string, expected: string[]) {
  const lines = linesOf(result);
  const at = lines.indexOf(header);
  assert.ok(at >= 0, `expected the line "${header}" in:\n${textOf(result)}`);
  assert.deepEqual(
    [...lines.slice(at + 1, at + 1 + expected.length)].sort(),
    [...expected].sort(),
    `expected ${JSON.stringify(expected)} after "${header}" in:\n${textOf(result)}`
  );
}

// "In draft and in commit": the case holds with draft omitted and with draft
// false, each on a fresh fake after clearLookupCache.
const MODES: Array<{ label: string; draft: Record<string, unknown> }> = [
  { label: "draft", draft: {} },
  { label: "commit", draft: { draft: false } },
];

// A refusal that must hold in draft and in commit, with nothing written.
function refusedInBothModes(
  name: string,
  args: Record<string, unknown>,
  check: (message: string) => void
) {
  for (const { label, draft } of MODES) {
    it(`${name} (${label})`, async () => {
      clearLookupCache();
      const { client, writes } = fakeClient();
      const message = await rejection(() => edit(client, { ...args, ...draft }));
      check(message);
      assert.deepEqual(writes(), []);
    });
  }
}

describe("edit_account", () => {
  beforeEach(() => clearLookupCache());

  it("edit-preview — a draft shows a before → after line per changed field and writes nothing", async () => {
    const { client, writes } = fakeClient();

    const result = await edit(client, { account: "6100", name: "Utility Costs", acct_num: "6150" });

    assert.ok(textOf(result).startsWith("DRAFT - Account Edit Preview"), textOf(result));
    hasLine(result, "ID: 10 (Utilities)");
    hasLine(result, "  Name: Utilities → Utility Costs");
    hasLine(result, "  Account Number: 6100 → 6150");
    assert.deepEqual(writes(), []);
  });

  it("edit-rename-commit — a commit refetches the SyncToken, sends a sparse rename and links nowhere", async () => {
    const { client, fetched, updated } = fakeClient({ getAccountRow: { ...fixture("10"), SyncToken: "7" } });

    const result = await edit(client, { account: "Utilities", name: "Utility Costs", draft: false });

    assert.ok(fetched.includes("10"), `getAccount("10") was not called: ${JSON.stringify(fetched)}`);
    assert.equal(updated.length, 1);
    assert.deepEqual(updated[0], { Id: "10", SyncToken: "7", sparse: true, Name: "Utility Costs" });
    hasLine(result, "Account 10 updated successfully.");
    hasLine(result, "Name: Utilities → Utility Costs");
    assert.ok(!linesOf(result).some((l) => l.startsWith("View in QuickBooks")), textOf(result));
  });

  refusedInBothModes(
    "edit-account-ambiguous — a name shared by two accounts is refused with both listed",
    { account: "Electric", description: "x" },
    (message) => {
      assert.match(message, /matches more than one account/);
      listed(message, "Utilities:Electric", "11");
      listed(message, "Repairs:Electric", "21");
    }
  );

  refusedInBothModes(
    "edit-name-taken — a rename onto an active sibling's name is refused with the holder listed",
    { account: "Utilities:Water", name: "electric" },
    (message) => {
      listed(message, "Utilities:Electric", "11");
      assert.match(message, /already uses this name/);
    }
  );

  it("edit-rename-allowed-cases — a case-only self-rename and a rename onto an inactive account's original name are sent", async () => {
    const names: unknown[] = [];
    for (const args of [
      { account: "Utilities:Water", name: "WATER" },
      { account: "Repairs", name: "Old Supplies" },
    ]) {
      clearLookupCache();
      const { client, updated } = fakeClient();
      await edit(client, { ...args, draft: false });
      assert.equal(updated.length, 1);
      names.push(updated[0].Name);
    }

    assert.deepEqual(names, ["WATER", "Old Supplies"]);
  });

  it("edit-acctnum — an active holder refuses a number, an inactive one does not, and \"\" clears", async () => {
    const taken = fakeClient();
    const message = await rejection(() => edit(taken.client, { account: "Utilities:Water", acct_num: "6110" }));
    assert.match(message, /Account number 6110 is already used by/);
    listed(message, "Utilities:Electric", "11");
    assert.deepEqual(taken.writes(), []);

    clearLookupCache();
    const inactiveHolder = fakeClient();
    await edit(inactiveHolder.client, { account: "Utilities:Water", acct_num: "6300", draft: false });
    assert.equal(inactiveHolder.updated.length, 1);
    assert.equal(inactiveHolder.updated[0].AcctNum, "6300");

    clearLookupCache();
    const cleared = fakeClient();
    await edit(cleared.client, { account: "Utilities:Water", acct_num: "", description: "", draft: false });
    assert.equal(cleared.updated.length, 1);
    assert.deepEqual(cleared.updated[0], { Id: "12", SyncToken: "1", sparse: true, AcctNum: "", Description: "" });
  });

  it("edit-subtype-pairs-type — a subtype alone is sent with the stored type", async () => {
    const { client, updated } = fakeClient();

    await edit(client, { account: "Repairs", account_subtype: "OfficeGeneralAdministrativeExpenses", draft: false });

    assert.equal(updated.length, 1);
    assert.deepEqual(updated[0], {
      Id: "20",
      SyncToken: "2",
      sparse: true,
      AccountType: "Expense",
      AccountSubType: "OfficeGeneralAdministrativeExpenses",
    });
  });

  it("edit-type-and-subtype — a type and subtype given together are sent together", async () => {
    const { client, updated } = fakeClient();

    await edit(client, {
      account: "Sales",
      account_type: "Other Income",
      account_subtype: "OtherMiscellaneousIncome",
      draft: false,
    });

    assert.equal(updated.length, 1);
    assert.deepEqual(updated[0], {
      Id: "50",
      SyncToken: "0",
      sparse: true,
      AccountType: "Other Income",
      AccountSubType: "OtherMiscellaneousIncome",
    });
  });

  refusedInBothModes(
    "edit-type-without-subtype-refused — a changed type without a subtype is refused",
    { account: "Sales", account_type: "Other Income" },
    (message) => assert.match(message, /account_subtype is required when account_type changes/)
  );

  refusedInBothModes(
    "edit-type-refused-children — a type change on an account with active sub-accounts is refused with them listed",
    { account: "Utilities", account_type: "Other Expense", account_subtype: "Depreciation" },
    (message) => {
      assert.match(message, /has active sub-accounts/);
      listed(message, "Utilities:Electric", "11");
      listed(message, "Utilities:Water", "12");
    }
  );

  refusedInBothModes(
    "edit-type-refused-balance — a type change on an account carrying a balance is refused",
    { account: "Operating Cash", account_type: "Other Current Asset", account_subtype: "OtherCurrentAssets" },
    (message) => {
      assert.match(message, /carries a balance/);
      assert.ok(message.includes("Operating Cash: 100.00"), message);
    }
  );

  refusedInBothModes(
    "edit-type-subaccount-must-match — a sub-account cannot change away from its parent's type",
    { account: "Utilities:Water", account_type: "Other Expense", account_subtype: "Depreciation" },
    (message) => assert.match(message, /must have the same account type as its parent/)
  );

  for (const { label, draft } of MODES) {
    it(`edit-move-under-parent — a re-parent previews the new path and sends a sparse ParentRef (${label})`, async () => {
      const { client, updated, writes } = fakeClient();

      const result = await edit(client, { account: "Utilities:Water", parent: "Repairs", ...draft });

      if (label === "draft") {
        hasLine(result, "  Full name: Utilities:Water → Repairs:Water");
        assert.deepEqual(writes(), []);
      } else {
        assert.equal(updated.length, 1);
        assert.deepEqual(updated[0], {
          Id: "12",
          SyncToken: "1",
          sparse: true,
          SubAccount: true,
          ParentRef: { value: "20" },
        });
      }
    });
  }

  for (const args of [
    { account: "Utilities", parent: "Utilities:Electric" },
    { account: "Utilities", parent: "Utilities" },
  ]) {
    refusedInBothModes(
      `edit-move-cycle-refused — moving under ${args.parent} is refused`,
      args,
      (message) => assert.match(message, /cannot be moved under itself or one of its own sub-accounts/)
    );
  }

  refusedInBothModes(
    "edit-move-type-mismatch — a re-parent under another type is refused",
    { account: "Utilities:Water", parent: "Sales" },
    (message) => assert.match(message, /must have the same account type as its parent/)
  );

  refusedInBothModes(
    "edit-move-name-taken — a re-parent onto a level where the name is taken is refused with the holder listed",
    { account: "Utilities:Electric", parent: "Repairs" },
    (message) => {
      listed(message, "Repairs:Electric", "21");
      assert.match(message, /already uses this name/);
    }
  );

  for (const { label, draft } of MODES) {
    it(`edit-top-level-full-update — a move to the top level is a full update of the refetched record (${label})`, async () => {
      const { client, calls, updated, writes } = fakeClient();

      const result = await edit(client, { account: "Utilities:Water", top_level: true, ...draft });

      if (label === "draft") {
        hasLine(result, "  Full name: Utilities:Water → Water");
        assert.deepEqual(writes(), []);
      } else {
        const fetchedAt = calls.indexOf("getAccount");
        assert.ok(fetchedAt >= 0 && fetchedAt < calls.indexOf("updateAccount"), JSON.stringify(calls));
        const { ParentRef: _parent, ...record } = fixture("12");
        assert.equal(updated.length, 1);
        assert.deepEqual(updated[0], { ...record, SubAccount: false, sparse: false });
      }
    });
  }

  refusedInBothModes(
    "edit-top-level-name-taken — a move to the top level onto a taken name is refused with the holder listed",
    { account: "Utilities:Water", top_level: true, name: "Sales" },
    (message) => {
      listed(message, "Sales", "50");
      assert.match(message, /already uses this name/);
    }
  );

  refusedInBothModes(
    "edit-move-under-inactive-parent — a re-parent under an inactive account is refused with it listed",
    { account: "Utilities:Water", parent: "Old Supplies" },
    (message) => {
      assert.match(message, /is inactive/);
      listed(message, "Old Supplies (deleted)", "60");
    }
  );

  refusedInBothModes(
    "edit-shared-number-ambiguous — a number an inactive account keeps and an active one holds is ambiguous",
    { account: "6200", description: "x" },
    (message) => {
      assert.match(message, /matches more than one account/);
      listed(message, "Repairs", "20");
      listed(message, "Freight (deleted)", "70");
    }
  );

  it("edit-top-level-with-parent-refused — top_level with parent is refused before any QBO call", async () => {
    const { client, calls } = fakeClient();

    const message = await rejection(() =>
      edit(client, { account: "Utilities:Water", top_level: true, parent: "Repairs" })
    );

    assert.match(message, /top_level cannot be combined with parent/);
    assert.deepEqual(calls, []);
  });

  for (const { label, draft } of MODES) {
    it(`edit-deactivate-cascade — a deactivation lists the sub-accounts it cascades to and reports the response name (${label})`, async () => {
      const { client, updated, writes } = fakeClient({
        updateResponse: { ...fixture("10"), Active: false, Name: "Utilities (deleted)", SyncToken: "4" },
      });

      const result = await edit(client, { account: "Utilities", active: false, ...draft });

      if (label === "draft") {
        hasLine(result, "  Active: true → false");
        linesAfter(result, "Also deactivated (sub-accounts):", [
          listLine("Utilities:Electric", "11"),
          listLine("Utilities:Water", "12"),
        ]);
        assert.deepEqual(writes(), []);
      } else {
        assert.equal(updated.length, 1);
        assert.deepEqual(updated[0], { Id: "10", SyncToken: "3", sparse: true, Active: false });
        hasLine(result, "Name: Utilities → Utilities (deleted)");
        listed(textOf(result), "Utilities:Electric", "11");
        listed(textOf(result), "Utilities:Water", "12");
      }
    });
  }

  refusedInBothModes(
    "edit-deactivate-balance-refused — deactivating an account with a balance is refused",
    { account: "Operating Cash", active: false },
    (message) => {
      assert.ok(message.includes("Operating Cash: 100.00"), message);
      assert.ok(message.includes("move the balance out first"), message);
    }
  );

  refusedInBothModes(
    "edit-deactivate-nested-balance-refused — a balance on a sub-account refuses the parent's deactivation",
    { account: "Savings", active: false },
    (message) => {
      assert.ok(message.includes("Savings:Reserve: 100.00"), message);
      assert.ok(!message.includes("Savings:Petty Cash:"), message);
    }
  );

  it("edit-deactivate-with-other-change-refused — active=false with another change is refused before any QBO call", async () => {
    const { client, calls } = fakeClient();

    const message = await rejection(() =>
      edit(client, { account: "Utilities", active: false, name: "Utility Costs" })
    );

    assert.match(message, /active=false must be the only change/);
    assert.deepEqual(calls, []);
  });

  refusedInBothModes(
    "edit-inactive-only-reactivate — any other edit on an inactive account is refused",
    { account: "Old Supplies", description: "x" },
    (message) => {
      assert.match(message, /is inactive/);
      assert.match(message, /reactivate it first/);
    }
  );

  for (const { label, draft } of MODES) {
    it(`edit-reactivate — a reactivation by original name notes inactive sub-accounts and reports the response name (${label})`, async () => {
      const { client, updated, writes } = fakeClient({
        updateResponse: { ...fixture("60"), Active: true, Name: "Old Supplies-1", SyncToken: "5" },
      });

      const result = await edit(client, { account: "Old Supplies", active: true, ...draft });

      if (label === "draft") {
        hasLine(result, "ID: 60 (Old Supplies (deleted))");
        hasLine(result, "  Active: false → true");
        linesAfter(result, "Sub-accounts stay inactive:", [listLine("Old Supplies (deleted):Toner (deleted)", "61")]);
        assert.ok(textOf(result).includes('"-1"'), textOf(result));
        assert.deepEqual(writes(), []);
      } else {
        assert.equal(updated.length, 1);
        assert.deepEqual(updated[0], { Id: "60", SyncToken: "4", sparse: true, Active: true });
        hasLine(result, "Name: Old Supplies (deleted) → Old Supplies-1");
      }
    });
  }

  it("edit-reactivate-with-rename — a rename sent with a reactivation is in the same sparse body", async () => {
    const { client, updated } = fakeClient();

    await edit(client, { account: "Old Supplies", active: true, name: "Supplies", draft: false });

    assert.equal(updated.length, 1);
    assert.deepEqual(updated[0], { Id: "60", SyncToken: "4", sparse: true, Active: true, Name: "Supplies" });
  });

  refusedInBothModes(
    "edit-reactivate-under-inactive-parent — reactivating a sub-account of an inactive account is refused",
    { account: "Toner", active: true },
    (message) => {
      assert.match(message, /its parent is inactive/);
      listed(message, "Old Supplies (deleted)", "60");
    }
  );

  refusedInBothModes(
    "edit-reactivate-number-taken — reactivating an account whose number an active one now holds is refused",
    { account: "Freight", active: true },
    (message) => {
      assert.ok(message.includes("Account number 6200 is now used by"), message);
      listed(message, "Repairs", "20");
    }
  );

  it("edit-2010-explained — a bare 2010 is rewritten with its known causes and the original fault", async () => {
    const { client } = fakeClient({ updateError: fault2010() });

    const message = await rejection(() =>
      edit(client, { account: "Utilities", name: "Utility Costs", draft: false })
    );

    assert.ok(message.includes("QuickBooks refused the update without giving a reason (2010)"), message);
    assert.ok(message.includes("Known causes"), message);
    assert.ok(message.includes("Request has invalid or unsupported property"), message);
  });

  it("edit-other-fault-propagates — any other rejection reaches the caller as the same object and keeps the cache", async () => {
    const fault = fault2170();
    const { client, cacheLoads } = fakeClient({ updateError: fault });
    await getAccountCache(client);
    assert.equal(cacheLoads(), 1);

    await assert.rejects(
      () => edit(client, { account: "Repairs", account_subtype: "Travel", draft: false }),
      (error) => {
        assert.strictEqual(error, fault);
        return true;
      }
    );
    await getAccountCache(client);

    assert.equal(cacheLoads(), 1, "a failed update must not drop the cache");
  });

  it("edit-invalidates-cache — a committed update drops the account cache", async () => {
    const { client, cacheLoads } = fakeClient();
    await getAccountCache(client);
    assert.equal(cacheLoads(), 1);

    await edit(client, { account: "Utilities", name: "Utility Costs", draft: false });
    await getAccountCache(client);

    assert.equal(cacheLoads(), 2, "the commit must drop the cache");
  });
});

// Validation runs before a client is requested, so this needs no credentials.
describe("edit_account — argument validation", () => {
  it("edit-nothing-to-change — an edit naming only the account is refused, with or without draft", async () => {
    for (const args of [{ account: "6100" }, { account: "6100", draft: false }]) {
      const result = await executeTool("edit_account", args);

      assert.equal(result.isError, true);
      assert.ok(
        result.content[0].text.includes("edit_account was called with no fields to change"),
        result.content[0].text
      );
    }
  });
});
