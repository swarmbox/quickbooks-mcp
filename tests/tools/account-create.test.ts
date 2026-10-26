// create_account: a draft-first account create. Every check runs against a full
// listing (inactive accounts included) taken in the same call, so a draft and a
// commit each see the books as they are now, and nothing is written unless every
// check has just passed.
//
// The fake tells the two kinds of findAccounts call apart: criteria deep-equal to
// { fetchAll: true, Active: [true, false] } are a full listing, and
// { fetchAll: true } is a cache load (active accounts only).

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { clearLookupCache, getAccountCache } from "../../src/client/index.js";
import { handleCreateAccount } from "../../src/tools/handlers/account.js";
import { executeTool } from "../../src/tools/index.js";

type Callback<T> = (err: unknown, result: T) => void;
type Result = { content: Array<{ type: string; text: string }> };
type CallKind = "full listing" | "cache load";
type Row = Record<string, unknown> & { Id: string; FullyQualifiedName: string };

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
const fault6240 = () =>
  axiosFault(
    "6240",
    "Duplicate Name Exists Error",
    "The name supplied already exists. : An account already has the same display name. Display Name must be unique. Please provide a different display name."
  );
const fault6000Number = () =>
  axiosFault(
    "6000",
    "A business validation error has occurred while processing your request",
    "Business Validation Error: Another account is already using this number.  Please use a different number."
  );
const fault2170 = () =>
  axiosFault("2170", "Invalid Enumeration", "Invalid Enumeration : Invalid Account.AccountType && Account.SubType");

interface FakeOptions {
  // What createAccount does: reject with this value instead of answering.
  createError?: unknown;
  // Rows a full listing also answers once createAccount has rejected.
  afterRejection?: Row[];
}

// Records every call in order, so "no write", "exactly one listing" and "before
// any QBO call" are checked against what the fake saw.
function fakeClient(options: FakeOptions = {}) {
  const calls: string[] = [];
  const listings: CallKind[] = [];
  const created: Array<Record<string, unknown>> = [];
  let cacheLoads = 0;
  let rejected = false;

  const copies = (rows: Row[]) => rows.map((r) => structuredClone(r));

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
      const rows = rejected ? [...FIXTURE_CHART, ...(options.afterRejection ?? [])] : FIXTURE_CHART;
      cb(null, { QueryResponse: { Account: copies(rows) } });
    },
    getAccount: (_id: string, cb: Callback<unknown>) => {
      calls.push("getAccount");
      cb(new Error("getAccount is not expected by create_account"), undefined);
    },
    updateAccount: (_body: unknown, cb: Callback<unknown>) => {
      calls.push("updateAccount");
      cb(new Error("updateAccount is not expected by create_account"), undefined);
    },
    createAccount: (body: Record<string, unknown>, cb: Callback<unknown>) => {
      calls.push("createAccount");
      created.push(body);
      if (options.createError !== undefined) {
        rejected = true;
        return cb(options.createError, undefined);
      }
      const parentId = (body.ParentRef as { value: string } | undefined)?.value;
      const parent = parentId ? FIXTURE_CHART.find((a) => a.Id === parentId) : undefined;
      const name = body.Name as string;
      cb(null, {
        Id: "90",
        SyncToken: "0",
        Active: true,
        ...body,
        FullyQualifiedName: parent ? `${parent.FullyQualifiedName}:${name}` : name,
      });
    },
  } as unknown as QuickBooks;

  return {
    client,
    calls,
    listings,
    created,
    cacheLoads: () => cacheLoads,
    writes: () => calls.filter((c) => c === "createAccount" || c === "updateAccount"),
  };
}

const create = (client: QuickBooks, args: Record<string, unknown>) =>
  handleCreateAccount(client, args as unknown as Parameters<typeof handleCreateAccount>[1]) as Promise<Result>;

const textOf = (result: Result): string => result.content.map((c) => c.text).join("\n");
const linesOf = (result: Result): string[] => textOf(result).split("\n");

async function rejection(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return assert.fail("expected the call to be rejected");
}

// A refusal "lists" an account as a line "  - <FullyQualifiedName> (id <Id>)".
const listed = (message: string, fullName: string, id: string) =>
  assert.ok(
    message.split("\n").includes(`  - ${fullName} (id ${id})`),
    `expected the line "  - ${fullName} (id ${id})" in:\n${message}`
  );

// "In draft and in commit": the case holds with draft omitted and with draft
// false, each on a fresh fake after clearLookupCache.
const MODES: Array<{ label: string; draft: Record<string, unknown> }> = [
  { label: "draft", draft: {} },
  { label: "commit", draft: { draft: false } },
];

const POSTAGE = {
  name: "Postage",
  account_type: "Expense",
  account_subtype: "OfficeGeneralAdministrativeExpenses",
  acct_num: "6500",
  description: "Stamps and mailing",
};

describe("create_account", () => {
  beforeEach(() => clearLookupCache());

  it("create-preview — a draft previews the account from one full listing and writes nothing", async () => {
    const { client, listings, writes } = fakeClient();

    const result = await create(client, { ...POSTAGE });
    const lines = linesOf(result);

    assert.ok(textOf(result).startsWith("DRAFT - Account Preview"));
    for (const line of [
      "Full name: Postage",
      "Type: Expense / OfficeGeneralAdministrativeExpenses",
      "Account Number: 6500",
      "Description: Stamps and mailing",
      "Name check: no other account at this level uses this name.",
    ]) {
      assert.ok(lines.includes(line), `expected the line "${line}" in:\n${textOf(result)}`);
    }
    assert.deepEqual(listings, ["full listing"]);
    assert.deepEqual(writes(), []);
  });

  it("create-commit — draft false posts the account body and reports the new id without a QuickBooks link", async () => {
    const { client, created } = fakeClient();

    const result = await create(client, { ...POSTAGE, draft: false });
    const lines = linesOf(result);

    assert.equal(created.length, 1);
    assert.deepEqual(created[0], {
      Name: "Postage",
      AccountType: "Expense",
      AccountSubType: "OfficeGeneralAdministrativeExpenses",
      AcctNum: "6500",
      Description: "Stamps and mailing",
    });
    for (const line of ["Account Created!", "ID: 90", "Full name: Postage"]) {
      assert.ok(lines.includes(line), `expected the line "${line}" in:\n${textOf(result)}`);
    }
    assert.ok(!lines.some((l) => l.startsWith("View in QuickBooks")));
  });

  it("create-subtype-only — a subtype alone is sent without an AccountType", async () => {
    const { client, created } = fakeClient();

    await create(client, {
      name: "Postage",
      account_subtype: "OfficeGeneralAdministrativeExpenses",
      draft: false,
    });

    assert.equal(created.length, 1);
    assert.deepEqual(created[0], { Name: "Postage", AccountSubType: "OfficeGeneralAdministrativeExpenses" });
  });

  it("create-subaccount-inherits-type — a sub-account takes its parent's type, with no subtype sent", async () => {
    const draftFake = fakeClient();
    const draft = await create(draftFake.client, { name: "Gas", parent: "Utilities" });
    const draftLines = linesOf(draft);
    for (const line of ["Full name: Utilities:Gas", "Type: Expense / (QuickBooks default)"]) {
      assert.ok(draftLines.includes(line), `expected the line "${line}" in:\n${textOf(draft)}`);
    }
    assert.deepEqual(draftFake.writes(), []);

    clearLookupCache();
    const commitFake = fakeClient();
    await create(commitFake.client, { name: "Gas", parent: "Utilities", draft: false });
    assert.equal(commitFake.created.length, 1);
    assert.deepEqual(commitFake.created[0], {
      Name: "Gas",
      AccountType: "Expense",
      SubAccount: true,
      ParentRef: { value: "10" },
    });
  });

  it("create-parent-forms — a parent is addressed by AcctNum, by case-insensitive path, or by Id", async () => {
    const parents: string[] = [];
    for (const parent of ["6110", "repairs:electric", "20"]) {
      clearLookupCache();
      const { client, created } = fakeClient();
      await create(client, { name: "Gas", parent, draft: false });
      assert.equal(created.length, 1);
      parents.push((created[0].ParentRef as { value: string }).value);
    }

    assert.deepEqual(parents, ["11", "21", "20"]);
  });

  for (const { label, draft } of MODES) {
    it(`create-parent-type-mismatch — a type that differs from the parent's is refused in ${label}`, async () => {
      const { client, writes } = fakeClient();

      const message = await rejection(() => create(client, { name: "Gas", parent: "Utilities", account_type: "Income", ...draft }));

      assert.match(message, /must have the same account type as its parent/);
      assert.match(message, /Utilities \(Expense\)/);
      assert.deepEqual(writes(), []);
    });

    it(`create-parent-ambiguous — a parent name shared by two accounts is refused with both listed in ${label}`, async () => {
      const { client, writes } = fakeClient();

      const message = await rejection(() => create(client, { name: "Gas", parent: "Electric", ...draft }));

      assert.match(message, /matches more than one account/);
      listed(message, "Utilities:Electric", "11");
      listed(message, "Repairs:Electric", "21");
      assert.deepEqual(writes(), []);
    });

    it(`create-parent-no-partial — a partial parent name matches nothing and proposes no candidate in ${label}`, async () => {
      const { client, writes } = fakeClient();

      const message = await rejection(() => create(client, { name: "Gas", parent: "Elec", ...draft }));

      assert.ok(message.includes('No account matches "Elec"'), message);
      assert.ok(!message.includes("Utilities:Electric"), message);
      assert.ok(!message.includes("Repairs:Electric"), message);
      assert.deepEqual(writes(), []);
    });

    it(`create-parent-inactive — an inactive parent is refused and listed in ${label}`, async () => {
      const { client, writes } = fakeClient();

      const message = await rejection(() => create(client, { name: "Gas", parent: "Old Supplies", ...draft }));

      assert.match(message, /is inactive/);
      listed(message, "Old Supplies (deleted)", "60");
      assert.deepEqual(writes(), []);
    });

    it(`create-name-taken — a name held by a sibling is refused with the holder listed in ${label}`, async () => {
      const first = fakeClient();
      const topLevel = await rejection(() => create(first.client, { name: " utilities ", account_type: "Expense", ...draft }));
      assert.match(topLevel, /already uses this name/);
      listed(topLevel, "Utilities", "10");
      assert.deepEqual(first.writes(), []);

      clearLookupCache();
      const second = fakeClient();
      const underParent = await rejection(() => create(second.client, { name: "Electric", parent: "Repairs", ...draft }));
      listed(underParent, "Repairs:Electric", "21");
      assert.deepEqual(second.writes(), []);
    });

    it(`create-name-taken-inactive — an inactive sibling still reserves its original name in ${label}`, async () => {
      const { client, writes } = fakeClient();

      const message = await rejection(() => create(client, { name: "Old Supplies", account_type: "Expense", ...draft }));

      listed(message, "Old Supplies (deleted)", "60");
      assert.match(message, /inactive/);
      assert.deepEqual(writes(), []);
    });

    it(`create-acctnum-taken — a number held by an active account is refused with the holder listed in ${label}`, async () => {
      const { client, writes } = fakeClient();

      const message = await rejection(() => create(client, { name: "Postage", account_type: "Expense", acct_num: "6100", ...draft }));

      assert.match(message, /Account number 6100 is already used by/);
      listed(message, "Utilities", "10");
      assert.deepEqual(writes(), []);
    });
  }

  it("create-name-free-under-other-parent — the same name under a different parent is accepted", async () => {
    const { client, writes } = fakeClient();

    const result = await create(client, { name: "Water", parent: "Repairs" });

    assert.ok(linesOf(result).includes("Full name: Repairs:Water"), textOf(result));
    assert.deepEqual(writes(), []);
  });

  it("create-acctnum-inactive-holder-allowed — a number kept by an inactive account is accepted", async () => {
    const { client } = fakeClient();

    const result = await create(client, { name: "Postage", account_type: "Expense", acct_num: "6300" });

    assert.ok(linesOf(result).includes("Account Number: 6300"), textOf(result));
  });

  it("create-local-validation — bad input is refused before any QBO call", async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ name: "   ", account_type: "Expense" }, /name must not be blank/],
      [{ name: "x".repeat(101), account_type: "Expense" }, /name must be at most 100 characters/],
      [{ name: "Bad:Name", account_type: "Expense" }, /name cannot contain a colon or a tab/],
      [{ name: "Bad\tName", account_type: "Expense" }, /name cannot contain a colon or a tab/],
      [{ name: "Postage", account_type: "Expense", description: "x".repeat(101) }, /description must be at most 100 characters/],
      [{ name: "Postage" }, /account_type or account_subtype is required/],
    ];

    for (const [args, expected] of cases) {
      clearLookupCache();
      const { client, calls } = fakeClient();
      const message = await rejection(() => create(client, args));
      assert.match(message, expected);
      assert.deepEqual(calls, [], `a QBO call was made for ${JSON.stringify(args)}`);
    }
  });

  it("create-invalidates-cache — a commit drops the account cache and a draft leaves it", async () => {
    const { client, cacheLoads } = fakeClient();
    await getAccountCache(client);
    assert.equal(cacheLoads(), 1);

    await create(client, { ...POSTAGE });
    await getAccountCache(client);
    assert.equal(cacheLoads(), 1, "the draft must not drop the cache");

    await create(client, { ...POSTAGE, draft: false });
    await getAccountCache(client);
    assert.equal(cacheLoads(), 2, "the commit must drop the cache");
  });

  it("create-6240-names-holder — a duplicate-name fault names the holder from a fresh listing and keeps the cache", async () => {
    const holder: Row = row("91", "Postage", "Postage", "6900", "Expense", "OfficeGeneralAdministrativeExpenses", "Expense", undefined, true, 0, "0");
    const { client, cacheLoads } = fakeClient({ createError: fault6240(), afterRejection: [holder] });
    await getAccountCache(client);

    const message = await rejection(() => create(client, { name: "Postage", account_type: "Expense", draft: false }));
    await getAccountCache(client);

    assert.match(message, /QuickBooks rejected the create:/);
    assert.match(message, /Duplicate Name Exists Error/);
    listed(message, "Postage", "91");
    assert.equal(cacheLoads(), 1, "a failed create must not drop the cache");
  });

  it("create-6000-names-holder — an account-number fault names the holder from a fresh listing and keeps the cache", async () => {
    const holder: Row = row("92", "Shipping", "Shipping", "6500", "Expense", "ShippingFreightDelivery", "Expense", undefined, true, 0, "0");
    const { client, cacheLoads } = fakeClient({ createError: fault6000Number(), afterRejection: [holder] });
    await getAccountCache(client);

    const message = await rejection(() =>
      create(client, { name: "Postage", account_type: "Expense", acct_num: "6500", draft: false })
    );
    await getAccountCache(client);

    assert.match(message, /QuickBooks rejected the create:/);
    assert.match(message, /Account number 6500 is already used by/);
    listed(message, "Shipping", "92");
    assert.equal(cacheLoads(), 1, "a failed create must not drop the cache");
  });

  it("create-other-fault-propagates — any other rejection reaches the caller as the same object", async () => {
    const fault = fault2170();
    const { client } = fakeClient({ createError: fault });

    await assert.rejects(
      () => create(client, { name: "Postage", account_type: "Expense", draft: false }),
      (error) => {
        assert.strictEqual(error, fault);
        return true;
      }
    );
  });
});

// Validation runs before a client is requested, so this needs no credentials.
describe("create_account — argument validation", () => {
  it("create-unknown-parameter — a misspelled parameter is refused by name", async () => {
    const result = await executeTool("create_account", { nme: "Postage" });

    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('Unknown parameter "nme"'), result.content[0].text);
  });
});
