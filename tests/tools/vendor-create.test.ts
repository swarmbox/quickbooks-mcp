// create_vendor: a draft-first vendor create that refuses a display name already
// held by any customer, vendor or employee.
//
// QBO display names are one namespace across the three lists, so the handler
// looks the trimmed name up in all of them before the preview and again before
// posting. A holder is named by list, id and stored display name; the handler
// applies no naming convention and proposes no replacement name. The one
// post-write error it rewrites is the duplicate-name fault (6240), which by
// definition committed nothing; every other rejection propagates as the
// original object.
//
// The fake tells the two kinds of findVendors/findCustomers/findEmployees call
// apart: array criteria are holder lookups, `{ fetchAll: true }` is a cache load.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { clearLookupCache, getVendorCache, resolveVendorRef } from "../../src/client/index.js";
import { handleCreateBill } from "../../src/tools/handlers/bill.js";
import { handleCreateVendor } from "../../src/tools/handlers/vendor.js";

type Callback<T> = (err: unknown, result: T) => void;
type Result = { content: Array<{ type: string; text: string }> };
type Kind = "Vendor" | "Customer" | "Employee";
type Row = { Id: string; DisplayName: string };
// One outcome per holder lookup on a list: rows to return, or a value to reject with.
type Outcome = { rows: Row[] } | { reject: unknown };
type Script = Partial<Record<Kind, Outcome[]>>;

// Invented fixtures only — this repository is public (CLAUDE.md).
const NAME = "Acme Supply";
const NORTH_PRODUCE = { Id: "20", DisplayName: "North Produce", Active: true };
const ACCOUNTS = [{ Id: "12", Name: "Supplies", FullyQualifiedName: "Supplies", AcctNum: "6000" }];
const DEPARTMENTS = [{ Id: "40", Name: "North", FullyQualifiedName: "North" }];
const TERMS = [{ Id: "3", Name: "Net 30", Type: "STANDARD", DueDays: 30 }];

const HOLDERS: Record<Kind, Row> = {
  Vendor: { Id: "43", DisplayName: NAME },
  Customer: { Id: "41", DisplayName: NAME },
  Employee: { Id: "42", DisplayName: NAME },
};

const KINDS: Kind[] = ["Vendor", "Customer", "Employee"];

const fault4000 = { Fault: { type: "ValidationFault", Error: [{ code: "4000", Message: "Query parser error" }] } };

// The shape node-quickbooks really rejects with on an HTTP 400: an axios-style
// Error with the Fault on response.data rather than on the error itself.
function axiosFault(code: string, message: string, detail?: string): Error {
  return Object.assign(new Error("Request failed with status code 400"), {
    response: {
      status: 400,
      data: { Fault: { type: "ValidationFault", Error: [{ code, Message: message, ...(detail ? { Detail: detail } : {}) }] } },
    },
  });
}
const fault6240 = (withId = true) =>
  axiosFault(
    "6240",
    "Duplicate Name Exists Error",
    withId ? "The name supplied already exists. : Id=41" : "The name supplied already exists."
  );

interface FakeOptions {
  // Holder lookup answers per list; the last outcome repeats once the script runs out.
  holders?: Script;
  // What createVendor does: reject with a value, or (default) answer with the sent name as id 70.
  createError?: unknown;
}

// Counts holder lookups per list and records every createVendor body, so "no
// write" and "N lookups were made" are checked against what the fake saw.
function fakeClient(options: FakeOptions = {}) {
  const lookups: Record<Kind, unknown[]> = { Vendor: [], Customer: [], Employee: [] };
  const created: Array<Record<string, unknown>> = [];
  let vendorCacheLoads = 0;
  let termLookups = 0;

  const list = (key: string, rows: unknown[]) => ({ QueryResponse: rows.length ? { [key]: rows } : {} });

  const finder = (kind: Kind, cacheRows: unknown[]) => (criteria: unknown, cb: Callback<unknown>) => {
    if (!Array.isArray(criteria)) {
      if (kind === "Vendor") vendorCacheLoads++;
      return cb(null, list(kind, cacheRows.map((row) => ({ ...(row as object) }))));
    }
    lookups[kind].push(criteria);
    const outcomes = options.holders?.[kind] ?? [{ rows: [] }];
    const outcome = outcomes[Math.min(lookups[kind].length, outcomes.length) - 1];
    if ("reject" in outcome) return cb(outcome.reject, undefined);
    cb(null, list(kind, outcome.rows));
  };

  const client = {
    findVendors: finder("Vendor", [NORTH_PRODUCE]),
    findCustomers: finder("Customer", []),
    findEmployees: finder("Employee", []),
    findAccounts: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Account", ACCOUNTS)),
    findDepartments: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Department", DEPARTMENTS)),
    findClasses: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Class", [])),
    findTerms: (...args: unknown[]) => {
      termLookups++;
      (args[args.length - 1] as Callback<unknown>)(null, list("Term", TERMS));
    },
    createVendor: (body: Record<string, unknown>, cb: Callback<unknown>) => {
      created.push(body);
      if (options.createError !== undefined) return cb(options.createError, undefined);
      cb(null, { Id: "70", DisplayName: body.DisplayName, Active: true });
    },
  } as unknown as QuickBooks;

  return {
    client,
    lookups,
    created,
    vendorCacheLoads: () => vendorCacheLoads,
    termLookups: () => termLookups,
    lookupCount: () => KINDS.reduce((n, kind) => n + lookups[kind].length, 0),
  };
}

const create = (client: QuickBooks, args: Record<string, unknown>) =>
  handleCreateVendor(client, args as unknown as Parameters<typeof handleCreateVendor>[1]) as Promise<Result>;

const textOf = (result: Result): string => result.content.map((c) => c.text).join("\n");

async function rejection(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return assert.fail("expected the call to be rejected");
}

const criteriaFor = (value: string) => [{ field: "DisplayName", value, operator: "=" }];

// "In draft and in commit": the case holds with draft omitted and with draft
// false, each on a fresh fake after clearLookupCache.
const MODES: Array<{ label: string; draft: Record<string, unknown> }> = [
  { label: "draft", draft: {} },
  { label: "commit", draft: { draft: false } },
];

beforeEach(() => {
  // The vendor and term caches are module-level and TTL'd. Without a reset, a
  // "findTerms never called" or "one cache load" pin could pass on a cache
  // another test warmed.
  clearLookupCache();
});

describe("create_vendor preview and payload", () => {
  it("vendor-draft-preview — previews a free name after three lookups and writes nothing", async () => {
    const fake = fakeClient();

    const text = textOf(
      await create(fake.client, {
        display_name: NAME,
        company_name: "Acme Supply Co",
        email: "ap@example.com",
      })
    );
    const lines = text.split("\n");

    assert.ok(text.startsWith("DRAFT - Vendor Preview"), text);
    for (const line of [
      "Display Name: Acme Supply",
      "Company: Acme Supply Co",
      "Email: ap@example.com",
      "Name check: no active customer, vendor or employee uses this display name.",
    ]) {
      assert.ok(lines.includes(line), `missing line "${line}" in:\n${text}`);
    }
    assert.equal(lines[lines.length - 1], "Set draft=false to create this vendor.");
    for (const kind of KINDS) assert.equal(fake.lookups[kind].length, 1, `${kind} holder lookups`);
    assert.equal(fake.lookupCount(), 3);
    assert.equal(fake.created.length, 0, "a draft must not write");
  });

  it("vendor-create-payload — sends every given field under its QBO name and reports the created vendor", async () => {
    const fake = fakeClient();

    const text = textOf(
      await create(fake.client, {
        display_name: NAME,
        given_name: "Ada",
        middle_name: "B",
        family_name: "Lovelace",
        suffix: "Jr",
        company_name: "Acme Supply Co",
        email: "ap@example.com",
        phone: "555-0100",
        mobile: "555-0101",
        bill_address: { line1: "100 Main St", city: "Springfield", country_sub_division_code: "IL", postal_code: "62701" },
        print_on_check_name: "Acme Supply Check",
        acct_num: "A-1001",
        sales_term_ref: "net 30",
        draft: false,
      })
    );

    assert.equal(fake.created.length, 1);
    assert.deepEqual(fake.created[0], {
      DisplayName: NAME,
      GivenName: "Ada",
      MiddleName: "B",
      FamilyName: "Lovelace",
      Suffix: "Jr",
      CompanyName: "Acme Supply Co",
      PrimaryEmailAddr: { Address: "ap@example.com" },
      PrimaryPhone: { FreeFormNumber: "555-0100" },
      Mobile: { FreeFormNumber: "555-0101" },
      BillAddr: { Line1: "100 Main St", City: "Springfield", CountrySubDivisionCode: "IL", PostalCode: "62701" },
      PrintOnCheckName: "Acme Supply Check",
      AcctNum: "A-1001",
      TermRef: { value: "3", name: "Net 30" },
    });
    const lines = text.split("\n");
    for (const line of ["Vendor Created!", "ID: 70", "Display Name: Acme Supply"]) {
      assert.ok(lines.includes(line), `missing line "${line}" in:\n${text}`);
    }
  });

  it("vendor-create-minimal-payload — sends only the display name and never looks up terms", async () => {
    const fake = fakeClient();

    await create(fake.client, { display_name: NAME, draft: false });

    assert.deepEqual(fake.created, [{ DisplayName: NAME }]);
    assert.equal(fake.termLookups(), 0);
  });

  it("vendor-display-name-trimmed — looks up, previews and sends the trimmed name", async () => {
    for (const { label, draft } of MODES) {
      clearLookupCache();
      const fake = fakeClient();

      const text = textOf(await create(fake.client, { display_name: "  Acme Supply  ", ...draft }));

      for (const kind of KINDS) {
        assert.deepEqual(fake.lookups[kind], [criteriaFor(NAME)], `${label}: ${kind} holder lookup`);
      }
      if (label === "draft") {
        assert.ok(text.split("\n").includes("Display Name: Acme Supply"), text);
        assert.equal(fake.created.length, 0);
      } else {
        assert.equal(fake.created.length, 1);
        assert.equal(fake.created[0].DisplayName, NAME);
      }
    }
  });
});

describe("create_vendor argument checks", () => {
  it("vendor-display-name-blank — refuses a blank name before any lookup or write", async () => {
    for (const { label, draft } of MODES) {
      clearLookupCache();
      const fake = fakeClient();

      const message = await rejection(() => create(fake.client, { display_name: "   ", ...draft }));

      assert.match(message, /display_name/, label);
      assert.equal(fake.lookupCount(), 0, `${label}: no holder lookup`);
      assert.equal(fake.created.length, 0, `${label}: no write`);
    }
  });

  it("vendor-unknown-term — refuses an unknown term before any write", async () => {
    for (const { label, draft } of MODES) {
      clearLookupCache();
      const fake = fakeClient();

      const message = await rejection(() =>
        create(fake.client, { display_name: NAME, sales_term_ref: "Net 99", ...draft })
      );

      assert.ok(message.startsWith("Term not found"), `${label}: ${message}`);
      assert.equal(fake.created.length, 0, `${label}: no write`);
    }
  });
});

describe("create_vendor refuses a held name", () => {
  it("vendor-held-by-customer — names the customer in draft and commit, and writes nothing", async () => {
    for (const { label, draft } of MODES) {
      clearLookupCache();
      const fake = fakeClient({ holders: { Customer: [{ rows: [HOLDERS.Customer] }] } });

      const message = await rejection(() => create(fake.client, { display_name: NAME, ...draft }));

      assert.ok(message.split("\n").includes('  - Customer 41: "Acme Supply"'), `${label}: ${message}`);
      assert.match(message, /unique across customers, vendors and employees/, label);
      assert.equal(fake.created.length, 0, `${label}: no write`);
    }
  });

  it("vendor-held-by-employee — names the employee in draft and commit, and writes nothing", async () => {
    for (const { label, draft } of MODES) {
      clearLookupCache();
      const fake = fakeClient({ holders: { Employee: [{ rows: [HOLDERS.Employee] }] } });

      const message = await rejection(() => create(fake.client, { display_name: NAME, ...draft }));

      assert.ok(message.split("\n").includes('  - Employee 42: "Acme Supply"'), `${label}: ${message}`);
      assert.equal(fake.created.length, 0, `${label}: no write`);
    }
  });

  it("vendor-held-by-vendor — names the vendor and points at it, in draft and commit, and writes nothing", async () => {
    for (const { label, draft } of MODES) {
      clearLookupCache();
      const fake = fakeClient({ holders: { Vendor: [{ rows: [HOLDERS.Vendor] }] } });

      const message = await rejection(() => create(fake.client, { display_name: NAME, ...draft }));

      assert.ok(message.split("\n").includes('  - Vendor 43: "Acme Supply"'), `${label}: ${message}`);
      assert.ok(message.includes("A vendor with this name already exists (id 43)"), `${label}: ${message}`);
      assert.equal(fake.created.length, 0, `${label}: no write`);
    }
  });

  it("vendor-held-stored-name-reported — reports the holder's stored name, not the requested one", async () => {
    const fake = fakeClient({
      holders: { Customer: [{ rows: [{ Id: "41", DisplayName: "ACME SUPPLY" }] }] },
    });

    const message = await rejection(() => create(fake.client, { display_name: NAME, draft: false }));

    assert.ok(message.split("\n").includes('  - Customer 41: "ACME SUPPLY"'), message);
    assert.equal(fake.created.length, 0);
  });

  it("vendor-refusal-proposes-no-name — lists every holder and quotes only the requested name", async () => {
    const fake = fakeClient({
      holders: { Customer: [{ rows: [HOLDERS.Customer] }], Employee: [{ rows: [HOLDERS.Employee] }] },
    });

    const message = await rejection(() => create(fake.client, { display_name: NAME, draft: false }));

    const lines = message.split("\n");
    assert.ok(lines.includes('  - Customer 41: "Acme Supply"'), message);
    assert.ok(lines.includes('  - Employee 42: "Acme Supply"'), message);
    const quoted = message.match(/"[^"]*"/g) ?? [];
    assert.ok(quoted.length > 0, message);
    for (const piece of quoted) assert.equal(piece, '"Acme Supply"', message);
  });

  it("vendor-lookup-failure-aborts — a failed holder lookup rejects with the original fault and writes nothing", async () => {
    for (const { label, draft } of MODES) {
      clearLookupCache();
      const fake = fakeClient({ holders: { Vendor: [{ reject: fault4000 }] } });

      await assert.rejects(
        create(fake.client, { display_name: NAME, ...draft }),
        (err: unknown) => {
          assert.equal(err, fault4000, label);
          return true;
        }
      );
      assert.equal(fake.created.length, 0, `${label}: no write`);
    }
  });
});

describe("create_vendor duplicate-name fault (6240)", () => {
  it("vendor-6240-names-holder — re-looks the holder up, names it, and remembers nothing", async () => {
    const fake = fakeClient({
      holders: { Customer: [{ rows: [] }, { rows: [HOLDERS.Customer] }] },
      createError: fault6240(),
    });
    await getVendorCache(fake.client);
    assert.equal(fake.vendorCacheLoads(), 1);

    const message = await rejection(() => create(fake.client, { display_name: NAME, draft: false }));

    assert.ok(message.split("\n").includes('  - Customer 41: "Acme Supply"'), message);
    assert.ok(message.includes("[6240]"), message);
    assert.ok(message.includes("QuickBooks rejected the create: "), message);
    assert.equal(fake.created.length, 1);
    const cache = await getVendorCache(fake.client);
    assert.throws(() => resolveVendorRef(cache, NAME), /Vendor not found/);
  });

  it("vendor-6240-no-holder-found — reports the duplicate id when the re-lookup finds nobody", async () => {
    const fake = fakeClient({ createError: fault6240() });

    const message = await rejection(() => create(fake.client, { display_name: NAME, draft: false }));

    assert.ok(message.includes("id 41"), message);
    assert.ok(message.includes("no active customer, vendor or employee"), message);
    assert.ok(message.includes("[6240]"), message);
    assert.ok(message.includes("QuickBooks rejected the create: "), message);
  });

  it("vendor-6240-no-id-detail — drops the id clause when the fault carries none", async () => {
    const fake = fakeClient({ createError: fault6240(false) });

    const message = await rejection(() => create(fake.client, { display_name: NAME, draft: false }));

    assert.ok(message.includes("as a duplicate, but no active customer, vendor or employee"), message);
    assert.ok(message.includes("[6240]"), message);
    assert.ok(!message.includes("of id"), message);
  });

  it("vendor-6240-relookup-fails — a failed re-lookup still reports the id and the original fault", async () => {
    const fake = fakeClient({
      holders: { Customer: [{ rows: [] }, { reject: fault4000 }] },
      createError: fault6240(),
    });

    const message = await rejection(() => create(fake.client, { display_name: NAME, draft: false }));

    assert.ok(message.includes("id 41"), message);
    assert.ok(message.includes("[6240]"), message);
    assert.ok(message.includes("looking up the record that holds it also failed"), message);
  });

  it("vendor-other-error-rethrown — any other rejection propagates as the same object, without a re-lookup", async () => {
    const error = axiosFault("6000", "Business Validation Error");
    const fake = fakeClient({ createError: error });

    await assert.rejects(
      create(fake.client, { display_name: NAME, draft: false }),
      (err: unknown) => {
        assert.equal(err, error);
        return true;
      }
    );
    assert.equal(fake.created.length, 1);
    assert.equal(fake.lookupCount(), 3, "only the pre-flight holder lookups ran");
  });
});

describe("create_vendor and the vendor cache", () => {
  it("vendor-created-resolvable — a created vendor resolves in a later create_bill without a second cache load", async () => {
    const fake = fakeClient();
    const bill = {
      txn_date: "2026-01-15",
      lines: [{ account_name: "Supplies", amount: 100.0 }],
      draft: true,
    };

    await handleCreateBill(fake.client, { ...bill, vendor_name: "North Produce" });
    assert.equal(fake.vendorCacheLoads(), 1);

    await create(fake.client, { display_name: NAME, draft: false });
    const preview = (await handleCreateBill(fake.client, { ...bill, vendor_name: NAME })) as Result;

    const lines = textOf(preview).split("\n").map((l) => l.trim());
    assert.ok(lines.includes("Vendor: Acme Supply"), lines.join("\n"));
    assert.equal(fake.vendorCacheLoads(), 1);
  });
});
