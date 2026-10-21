// edit_vendor rename safety: a changed display name is checked across the
// Vendor, Customer and Employee lists (the vendor itself excluded) before the
// preview and again before the commit, and refused with each holder named. A
// duplicate-name rejection from QuickBooks on update (6240 for a vendor holder,
// 6000 "name is being used by another …" for a customer or employee) is routed
// to the same holder-naming message; every other rejection propagates as the
// original object. The session vendor cache follows every committed edit, from
// the update response rather than the request.
//
// The fake tells the two kinds of findVendors/findCustomers/findEmployees call
// apart: array criteria are holder lookups, `{ fetchAll: true }` is a cache load.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { clearLookupCache, getVendorCache, resolveVendorRef } from "../../src/client/index.js";
import { handleEditVendor } from "../../src/tools/handlers/vendor.js";

type Callback<T> = (err: unknown, result: T) => void;
type Result = { content: Array<{ type: string; text: string }> };
type Kind = "Vendor" | "Customer" | "Employee";
type Row = { Id: string; DisplayName: string };
// One outcome per holder lookup on a list: rows to return, or a value to reject with.
type Outcome = { rows: Row[] } | { reject: unknown };
type Script = Partial<Record<Kind, Outcome[]>>;

// Invented fixtures only — this repository is public (CLAUDE.md).
const NAME = "Acme Supply";
const STORED = {
  Id: "42",
  SyncToken: "7",
  DisplayName: "Acme Supply Co",
  Active: true,
};
const STORED_INACTIVE = { Id: "42", SyncToken: "7", DisplayName: "Acme Supply Co (deleted)", Active: false };
const ACME_SUPPLY_CO = { Id: "42", DisplayName: "Acme Supply Co", Active: true };
const NORTH_PRODUCE = { Id: "20", DisplayName: "North Produce", Active: true };

const HOLDERS: Record<Kind, Row> = {
  Vendor: { Id: "43", DisplayName: NAME },
  Customer: { Id: "41", DisplayName: NAME },
  Employee: { Id: "45", DisplayName: NAME },
};
const SELF: Row = { Id: "42", DisplayName: "Acme Supply Co" };

const KINDS: Kind[] = ["Vendor", "Customer", "Employee"];

const fault4000 = { Fault: { type: "ValidationFault", Error: [{ code: "4000", Message: "Query parser error" }] } };

// The shape node-quickbooks really rejects with on an HTTP 400: an axios-style
// Error with the Fault on response.data rather than on the error itself. The
// texts below are QuickBooks' own generic strings for an update.
function axiosFault(code: string, message: string, detail?: string): Error {
  return Object.assign(new Error("Request failed with status code 400"), {
    response: {
      status: 400,
      data: { Fault: { type: "ValidationFault", Error: [{ code, Message: message, ...(detail ? { Detail: detail } : {}) }] } },
    },
  });
}
const BUSINESS_VALIDATION = "A business validation error has occurred while processing your request";
const fault6240 = () =>
  axiosFault(
    "6240",
    "Duplicate Name Exists Error",
    "The name supplied already exists. : Another Vendor is already using this name.  Please use a different name."
  );
const fault6000NameInUse = (holder: "customer" | "employee" = "customer") =>
  axiosFault(
    "6000",
    BUSINESS_VALIDATION,
    `Business Validation Error: This name is being used by another ${holder}. Please use a different name. You can merge names only when their type (customer, vendor or employee) matches.`
  );
const fault6000Other = () =>
  axiosFault("6000", BUSINESS_VALIDATION, "Business Validation Error: An invented rule that is not about names failed.");

interface FakeOptions {
  // The vendor getVendor serves (cloned per call).
  stored?: Record<string, unknown>;
  // Holder lookup answers per list; the last outcome repeats once the script runs out.
  holders?: Script;
  // Rows a vendor cache load lists.
  cacheRows?: Array<{ Id: string; DisplayName: string; Active?: boolean }>;
  // What updateVendor does: reject with a value, answer with a scripted response, or
  // (default) answer with { ...stored, ...sent body, SyncToken: "8" }.
  updateError?: unknown;
  updateResponse?: Record<string, unknown>;
}

// Counts getVendor calls, holder lookups per list and vendor cache loads, and
// records every updateVendor body and the order of lookups and writes, so "no
// write", "N lookups" and "the write came after the lookups" are checked against
// what the fake saw.
function fakeClient(options: FakeOptions = {}) {
  const stored = options.stored ?? STORED;
  const lookups: Record<Kind, unknown[]> = { Vendor: [], Customer: [], Employee: [] };
  const updated: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  let vendorCacheLoads = 0;
  let getVendorCalls = 0;

  const list = (key: string, rows: unknown[]) => ({ QueryResponse: rows.length ? { [key]: rows } : {} });

  const finder = (kind: Kind) => (criteria: unknown, cb: Callback<unknown>) => {
    if (!Array.isArray(criteria)) {
      if (kind === "Vendor") vendorCacheLoads++;
      const rows = kind === "Vendor" ? options.cacheRows ?? [NORTH_PRODUCE] : [];
      return cb(null, list(kind, rows.map((row) => ({ ...row }))));
    }
    lookups[kind].push(criteria);
    events.push(`lookup:${kind}`);
    const outcomes = options.holders?.[kind] ?? [{ rows: [] }];
    const outcome = outcomes[Math.min(lookups[kind].length, outcomes.length) - 1];
    if ("reject" in outcome) return cb(outcome.reject, undefined);
    cb(null, list(kind, outcome.rows));
  };

  const client = {
    findVendors: finder("Vendor"),
    findCustomers: finder("Customer"),
    findEmployees: finder("Employee"),
    findTerms: (...args: unknown[]) => (args[args.length - 1] as Callback<unknown>)(null, list("Term", [])),
    getVendor: (_id: string, cb: Callback<unknown>) => {
      getVendorCalls++;
      cb(null, structuredClone(stored));
    },
    updateVendor: (body: Record<string, unknown>, cb: Callback<unknown>) => {
      updated.push(body);
      events.push("update");
      if (options.updateError !== undefined) return cb(options.updateError, undefined);
      cb(null, options.updateResponse ?? { ...stored, ...body, SyncToken: "8" });
    },
  } as unknown as QuickBooks;

  return {
    client,
    lookups,
    updated,
    events,
    getVendorCalls: () => getVendorCalls,
    vendorCacheLoads: () => vendorCacheLoads,
    lookupCount: () => KINDS.reduce((n, kind) => n + lookups[kind].length, 0),
  };
}

const edit = (client: QuickBooks, args: Record<string, unknown>) =>
  handleEditVendor(client, args as unknown as Parameters<typeof handleEditVendor>[1]) as Promise<Result>;

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
  // The vendor cache is module-level and TTL'd. Without a reset, a "one cache
  // load" pin could pass on a cache another test warmed.
  clearLookupCache();
});

describe("edit_vendor renames a free name", () => {
  it("edit-rename-free-draft — previews a free rename after three lookups and writes nothing", async () => {
    const fake = fakeClient();

    const text = textOf(await edit(fake.client, { id: "42", display_name: NAME }));
    const lines = text.split("\n");

    assert.ok(lines.includes("  Display Name: Acme Supply Co → Acme Supply"), text);
    const footer = lines.indexOf("Fields not listed are left unchanged. Set draft=false to apply these changes.");
    assert.ok(footer > 0, text);
    assert.equal(
      lines[footer - 1],
      "Name check: no other active customer, vendor or employee uses this display name.",
      text
    );
    for (const kind of KINDS) assert.deepEqual(fake.lookups[kind], [criteriaFor(NAME)], `${kind} holder lookup`);
    assert.equal(fake.lookupCount(), 3);
    assert.equal(fake.updated.length, 0, "a draft must not write");
  });

  it("edit-rename-free-commit — writes the trimmed rename once, after the three lookups", async () => {
    const fake = fakeClient();

    const text = textOf(await edit(fake.client, { id: "42", display_name: NAME, draft: false }));

    assert.deepEqual(fake.updated, [{ Id: "42", SyncToken: "7", sparse: true, DisplayName: NAME }]);
    assert.equal(fake.updated.length, 1);
    assert.equal(fake.lookupCount(), 3);
    assert.equal(fake.events.indexOf("update"), 3, `the write came after the lookups: ${fake.events.join(", ")}`);
    assert.ok(text.split("\n").includes("Vendor 42 updated successfully."), text);
  });

  it("edit-rename-trimmed — looks up, previews and sends the trimmed name", async () => {
    for (const { label, draft } of MODES) {
      clearLookupCache();
      const fake = fakeClient();

      const text = textOf(await edit(fake.client, { id: "42", display_name: "  Acme Supply  ", ...draft }));

      for (const kind of KINDS) {
        assert.deepEqual(fake.lookups[kind], [criteriaFor(NAME)], `${label}: ${kind} holder lookup`);
      }
      if (label === "draft") {
        assert.ok(text.split("\n").includes("  Display Name: Acme Supply Co → Acme Supply"), text);
        assert.equal(fake.updated.length, 0);
      } else {
        assert.equal(fake.updated.length, 1);
        assert.equal(fake.updated[0].DisplayName, NAME);
      }
    }
  });
});

describe("edit_vendor argument checks", () => {
  it("edit-rename-blank — refuses a blank name before any fetch, lookup or write", async () => {
    for (const { label, draft } of MODES) {
      clearLookupCache();
      const fake = fakeClient();

      const message = await rejection(() => edit(fake.client, { id: "42", display_name: "   ", ...draft }));

      assert.ok(message.includes("display_name must not be blank"), `${label}: ${message}`);
      assert.equal(fake.getVendorCalls(), 0, `${label}: getVendor was never called`);
      assert.equal(fake.lookupCount(), 0, `${label}: no holder lookup`);
      assert.equal(fake.updated.length, 0, `${label}: no write`);
    }
  });

  it("edit-rename-with-deactivate-refused — refuses a rename sent with active=false before any fetch", async () => {
    for (const { label, draft } of MODES) {
      clearLookupCache();
      const fake = fakeClient();

      const message = await rejection(() =>
        edit(fake.client, { id: "42", display_name: NAME, active: false, ...draft })
      );

      assert.ok(message.includes("display_name cannot be combined with active=false"), `${label}: ${message}`);
      assert.ok(message.includes("Rename and deactivate in two separate edits."), `${label}: ${message}`);
      assert.equal(fake.getVendorCalls(), 0, `${label}: getVendor was never called`);
      assert.equal(fake.lookupCount(), 0, `${label}: no holder lookup`);
      assert.equal(fake.updated.length, 0, `${label}: no write`);
    }
  });
});

describe("edit_vendor checks only a changed name", () => {
  it("edit-name-unchanged-no-lookup — a name equal to the stored one makes no lookup and carries no check line", async () => {
    for (const { label, draft } of MODES) {
      clearLookupCache();
      const fake = fakeClient();

      const text = textOf(await edit(fake.client, { id: "42", display_name: " Acme Supply Co ", ...draft }));

      assert.equal(fake.lookupCount(), 0, `${label}: no holder lookup`);
      if (label === "draft") {
        assert.ok(!text.split("\n").some((line) => line.startsWith("Name check:")), text);
      } else {
        assert.equal(fake.updated.length, 1);
        assert.equal(fake.updated[0].DisplayName, "Acme Supply Co");
      }
    }
  });

  it("edit-no-name-no-lookup — an edit with no display_name makes no lookup and carries no check line", async () => {
    for (const { label, draft } of MODES) {
      clearLookupCache();
      const fake = fakeClient();

      const text = textOf(await edit(fake.client, { id: "42", phone: "555-0199", ...draft }));

      assert.equal(fake.lookupCount(), 0, `${label}: no holder lookup`);
      if (label === "draft") {
        assert.ok(!text.split("\n").some((line) => line.startsWith("Name check:")), text);
      }
    }
  });
});

describe("edit_vendor refuses a held name", () => {
  it("edit-held-by-customer — names the customer in draft and commit, and writes nothing", async () => {
    for (const { label, draft } of MODES) {
      clearLookupCache();
      const fake = fakeClient({ holders: { Customer: [{ rows: [HOLDERS.Customer] }] } });

      const message = await rejection(() => edit(fake.client, { id: "42", display_name: NAME, ...draft }));

      const lines = message.split("\n");
      assert.ok(lines.includes('  - Customer 41: "Acme Supply"'), `${label}: ${message}`);
      assert.ok(message.includes("unique across customers, vendors and employees"), `${label}: ${message}`);
      assert.ok(lines.includes("Choose a different display_name, or rename the record that holds it."), `${label}: ${message}`);
      assert.equal(fake.updated.length, 0, `${label}: no write`);
    }
  });

  it("edit-held-by-employee — names the employee in draft and commit, and writes nothing", async () => {
    for (const { label, draft } of MODES) {
      clearLookupCache();
      const fake = fakeClient({ holders: { Employee: [{ rows: [HOLDERS.Employee] }] } });

      const message = await rejection(() => edit(fake.client, { id: "42", display_name: NAME, ...draft }));

      assert.ok(message.split("\n").includes('  - Employee 45: "Acme Supply"'), `${label}: ${message}`);
      assert.equal(fake.updated.length, 0, `${label}: no write`);
    }
  });

  it("edit-held-by-vendor — names the vendor without advising to use it instead, and writes nothing", async () => {
    for (const { label, draft } of MODES) {
      clearLookupCache();
      const fake = fakeClient({ holders: { Vendor: [{ rows: [HOLDERS.Vendor] }] } });

      const message = await rejection(() => edit(fake.client, { id: "42", display_name: NAME, ...draft }));

      assert.ok(message.split("\n").includes('  - Vendor 43: "Acme Supply"'), `${label}: ${message}`);
      assert.ok(!message.includes("A vendor with this name already exists"), `${label}: ${message}`);
      assert.ok(!message.includes("instead of creating one"), `${label}: ${message}`);
      assert.equal(fake.updated.length, 0, `${label}: no write`);
    }
  });

  it("edit-self-case-rename-allowed — the vendor itself is not a holder of its own name", async () => {
    const fake = fakeClient({ holders: { Vendor: [{ rows: [SELF] }] } });

    await edit(fake.client, { id: "42", display_name: "ACME SUPPLY CO", draft: false });

    assert.equal(fake.updated.length, 1);
    assert.equal(fake.updated[0].DisplayName, "ACME SUPPLY CO");
    assert.equal(fake.lookupCount(), 3);
  });

  it("edit-self-and-other-holder — reports only the other holder, never the vendor itself", async () => {
    for (const { label, draft } of MODES) {
      clearLookupCache();
      const fake = fakeClient({
        holders: {
          Vendor: [{ rows: [SELF] }],
          Customer: [{ rows: [{ Id: "41", DisplayName: "ACME SUPPLY CO" }] }],
        },
      });

      const message = await rejection(() => edit(fake.client, { id: "42", display_name: "ACME SUPPLY CO", ...draft }));

      const lines = message.split("\n");
      assert.ok(lines.includes('  - Customer 41: "ACME SUPPLY CO"'), `${label}: ${message}`);
      assert.ok(!lines.some((line) => line.startsWith("  - Vendor 42")), `${label}: ${message}`);
      assert.equal(fake.updated.length, 0, `${label}: no write`);
    }
  });
});

describe("edit_vendor duplicate-name fault on a rename", () => {
  it("edit-update-6240-names-holder — re-looks the holder up, names it, and remembers nothing", async () => {
    const fake = fakeClient({
      cacheRows: [ACME_SUPPLY_CO, NORTH_PRODUCE],
      holders: { Vendor: [{ rows: [] }, { rows: [HOLDERS.Vendor] }] },
      updateError: fault6240(),
    });
    await getVendorCache(fake.client);
    assert.equal(fake.vendorCacheLoads(), 1);

    const message = await rejection(() => edit(fake.client, { id: "42", display_name: NAME, draft: false }));

    assert.ok(message.split("\n").includes('  - Vendor 43: "Acme Supply"'), message);
    assert.ok(message.includes("QuickBooks rejected the update:"), message);
    assert.ok(message.includes("[6240]"), message);
    assert.ok(!message.includes("instead of creating one"), message);
    assert.equal(fake.updated.length, 1);
    const cache = await getVendorCache(fake.client);
    assert.equal(resolveVendorRef(cache, "42").name, "Acme Supply Co");
    assert.equal(fake.vendorCacheLoads(), 1, "nothing was remembered");
  });

  it("edit-update-6000-names-holder — a 6000 name-in-use fault names the customer that holds it", async () => {
    const fake = fakeClient({
      holders: { Customer: [{ rows: [] }, { rows: [HOLDERS.Customer] }] },
      updateError: fault6000NameInUse(),
    });

    const message = await rejection(() => edit(fake.client, { id: "42", display_name: NAME, draft: false }));

    assert.ok(message.split("\n").includes('  - Customer 41: "Acme Supply"'), message);
    assert.ok(message.includes("QuickBooks rejected the update:"), message);
    assert.ok(message.includes("[6000]"), message);
    assert.equal(fake.updated.length, 1);
  });

  it("edit-update-6000-employee-names-holder — a 6000 name-in-use fault names the employee that holds it", async () => {
    const fake = fakeClient({
      holders: { Employee: [{ rows: [] }, { rows: [HOLDERS.Employee] }] },
      updateError: fault6000NameInUse("employee"),
    });

    const message = await rejection(() => edit(fake.client, { id: "42", display_name: NAME, draft: false }));

    assert.ok(message.split("\n").includes('  - Employee 45: "Acme Supply"'), message);
    assert.ok(message.includes("QuickBooks rejected the update:"), message);
    assert.ok(message.includes("[6000]"), message);
    assert.equal(fake.updated.length, 1);
  });

  it("edit-update-dup-no-other-holder — the vendor itself is never named as the holder in the fallback", async () => {
    const fake = fakeClient({
      holders: { Vendor: [{ rows: [] }, { rows: [SELF] }] },
      updateError: fault6240(),
    });

    const message = await rejection(() => edit(fake.client, { id: "42", display_name: NAME, draft: false }));

    assert.ok(
      message.includes(
        'QuickBooks rejected display name "Acme Supply" as a duplicate, but no active customer, vendor or employee with that name was found.'
      ),
      message
    );
    assert.ok(message.includes("[6240]"), message);
    assert.ok(!message.includes("of id"), message);
    assert.ok(!message.split("\n").some((line) => line.startsWith("  - Vendor 42")), message);
  });

  it("edit-update-dup-relookup-fails — a failed re-lookup still reports the original fault", async () => {
    const fake = fakeClient({
      holders: { Customer: [{ rows: [] }, { reject: fault4000 }] },
      updateError: fault6000NameInUse(),
    });

    const message = await rejection(() => edit(fake.client, { id: "42", display_name: NAME, draft: false }));

    assert.ok(message.includes("looking up the record that holds it also failed"), message);
    assert.ok(message.includes("[6000]"), message);
  });
});

describe("edit_vendor rethrows every other rejection", () => {
  it("edit-dup-fault-without-rename-rethrown — a duplicate-name fault on an edit that did not rename is the same object", async () => {
    const error = fault6240();
    const fake = fakeClient({ updateError: error });

    await assert.rejects(
      edit(fake.client, { id: "42", active: true, draft: false }),
      (err: unknown) => {
        assert.equal(err, error);
        return true;
      }
    );
    assert.equal(fake.lookupCount(), 0, "no holder lookup");
  });

  it("edit-other-6000-rethrown — a 6000 that is not about names propagates as the same object, without a re-lookup", async () => {
    const error = fault6000Other();
    const fake = fakeClient({ updateError: error });

    await assert.rejects(
      edit(fake.client, { id: "42", display_name: NAME, draft: false }),
      (err: unknown) => {
        assert.equal(err, error);
        return true;
      }
    );
    assert.equal(fake.lookupCount(), 3, "only the pre-write holder lookups ran");
  });

  it("edit-lookup-failure-aborts — a failed holder lookup rejects with the original fault and writes nothing", async () => {
    for (const { label, draft } of MODES) {
      clearLookupCache();
      const fake = fakeClient({ holders: { Vendor: [{ reject: fault4000 }] } });

      await assert.rejects(
        edit(fake.client, { id: "42", display_name: NAME, ...draft }),
        (err: unknown) => {
          assert.equal(err, fault4000, label);
          return true;
        }
      );
      assert.equal(fake.updated.length, 0, `${label}: no write`);
    }
  });
});

describe("edit_vendor and the vendor cache", () => {
  it("edit-renamed-resolvable — a renamed vendor resolves by its new name only, without a second cache load", async () => {
    const fake = fakeClient({ cacheRows: [ACME_SUPPLY_CO, NORTH_PRODUCE] });
    await getVendorCache(fake.client);

    const text = textOf(await edit(fake.client, { id: "42", display_name: NAME, draft: false }));

    const cache = await getVendorCache(fake.client);
    for (const input of ["Acme Supply", "42"]) {
      assert.deepEqual(resolveVendorRef(cache, input), { value: "42", name: "Acme Supply" }, input);
    }
    assert.throws(() => resolveVendorRef(cache, "Acme Supply Co"), /Vendor not found/);
    assert.equal(fake.vendorCacheLoads(), 1);
    const lines = text.split("\n");
    assert.equal(lines[lines.length - 1], "Display Name: Acme Supply Co → Acme Supply", text);
  });

  it("edit-deactivated-unresolvable — a deactivated vendor stops resolving and the result shows the final name", async () => {
    const fake = fakeClient({
      cacheRows: [ACME_SUPPLY_CO, NORTH_PRODUCE],
      updateResponse: { Id: "42", SyncToken: "8", DisplayName: "Acme Supply Co (deleted)", Active: false },
    });
    await getVendorCache(fake.client);

    const text = textOf(await edit(fake.client, { id: "42", active: false, draft: false }));

    const cache = await getVendorCache(fake.client);
    for (const input of ["42", "Acme Supply Co"]) {
      assert.throws(() => resolveVendorRef(cache, input), /Vendor not found/, input);
    }
    assert.equal(fake.vendorCacheLoads(), 1);
    const lines = text.split("\n");
    assert.ok(lines.includes("Vendor 42 updated successfully."), text);
    assert.equal(lines[lines.length - 1], "Display Name: Acme Supply Co → Acme Supply Co (deleted)", text);
  });

  it("edit-reactivated-resolvable — a reactivated vendor resolves by the name QuickBooks returned, with no lookup", async () => {
    const fake = fakeClient({
      stored: STORED_INACTIVE,
      cacheRows: [NORTH_PRODUCE],
      updateResponse: { Id: "42", SyncToken: "8", DisplayName: "Acme Supply Co-1", Active: true },
    });
    await getVendorCache(fake.client);

    const text = textOf(await edit(fake.client, { id: "42", active: true, draft: false }));

    const cache = await getVendorCache(fake.client);
    for (const input of ["acme supply co-1", "42"]) {
      assert.deepEqual(resolveVendorRef(cache, input), { value: "42", name: "Acme Supply Co-1" }, input);
    }
    assert.equal(fake.vendorCacheLoads(), 1);
    assert.equal(fake.lookupCount(), 0, "no holder lookup");
    const lines = text.split("\n");
    assert.equal(lines[lines.length - 1], "Display Name: Acme Supply Co (deleted) → Acme Supply Co-1", text);
  });
});

describe("edit_vendor commit text", () => {
  it("edit-commit-text-name-unchanged — carries no Display Name line when the response name is the stored one", async () => {
    const fake = fakeClient();

    const text = textOf(await edit(fake.client, { id: "42", phone: "555-0199", draft: false }));

    assert.ok(!text.split("\n").some((line) => line.startsWith("Display Name:")), text);
  });
});
