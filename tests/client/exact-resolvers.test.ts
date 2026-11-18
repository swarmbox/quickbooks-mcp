// Strict vendor and item resolvers for the purchase-order tools.
//
// The shared resolvers (resolveVendorRef, resolveItem) fall through to a partial
// match, so a typo can book a purchase order to the wrong vendor or item. The
// exact resolvers never guess: the caller names the route ("id" or "name"), an Id
// route matches only an Id, a name route never consults Ids, and a miss is
// refused rather than approximated.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";
import {
  clearLookupCache,
  getVendorCache,
  resolveVendorRefExact,
  resolveItemExact,
  resolveItemInput,
} from "../../src/client/index.js";

type Callback<T> = (err: unknown, result: T) => void;
interface Criterion {
  field: string;
  value: string | boolean;
  operator: string;
}

// Invented fixtures only — this repository is public (CLAUDE.md).
const VENDORS = [
  { Id: "20", DisplayName: "North Freight", Active: true },
  { Id: "21", DisplayName: "North Freight Lines", Active: true },
  { Id: "22", DisplayName: "South Haulage", Active: true },
];

const ITEMS = [
  { Id: "30", Name: "Shipping", FullyQualifiedName: "Freight:Shipping", Active: true },
  { Id: "31", Name: "Shipping", FullyQualifiedName: "Supplies:Shipping", Active: true },
  { Id: "32", Name: "Fuel Surcharge", FullyQualifiedName: "Freight:Fuel Surcharge", Active: true },
  { Id: "33", Name: "Pallets (deleted)", FullyQualifiedName: "Pallets (deleted)", Active: false },
];

// findItems takes a criteria array. With no Active criterion it answers active
// rows only, as QBO does. Every call is recorded so a test can assert which
// operators and fields were used.
function fakeClient() {
  const calls: Criterion[][] = [];
  const client = {
    findVendors: (_c: unknown, cb: Callback<unknown>) =>
      cb(null, { QueryResponse: { Vendor: VENDORS.map((v) => ({ ...v })) } }),
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
      cb(null, { QueryResponse: { Item: rows.map((i) => ({ ...i })) } });
    },
  } as unknown as QuickBooks;
  return { client, calls };
}

const usedLike = (calls: Criterion[][]) => calls.some((c) => c.some((t) => t.operator.toUpperCase() === "LIKE"));
const usedName = (calls: Criterion[][]) => calls.some((c) => c.some((t) => t.field === "Name"));

describe("resolveVendorRefExact", () => {
  beforeEach(() => clearLookupCache());

  it("vendor-exact-by-id — the id route returns the vendor with that Id", async () => {
    const { client } = fakeClient();
    const cache = await getVendorCache(client);
    assert.deepEqual(resolveVendorRefExact(cache, "20", "id"), { value: "20", name: "North Freight" });
  });

  it("vendor-exact-digit-name — an all-digit name is never taken as an Id", async () => {
    const { client } = fakeClient();
    const cache = await getVendorCache(client);
    assert.throws(() => resolveVendorRefExact(cache, "20", "name"), Error);
  });

  it("vendor-exact-by-name — the name route is trimmed and case-insensitive", async () => {
    const { client } = fakeClient();
    const cache = await getVendorCache(client);
    assert.deepEqual(resolveVendorRefExact(cache, "  north freight ", "name"), {
      value: "20",
      name: "North Freight",
    });
  });

  it("vendor-exact-refuses-partial — a partial name is refused, quoting the input", async () => {
    const { client } = fakeClient();
    const cache = await getVendorCache(client);
    assert.throws(
      () => resolveVendorRefExact(cache, "North", "name"),
      (err: Error) => {
        assert.match(err.message, /"North"/);
        assert.match(err.message, /no vendor matches .*exactly/i);
        return true;
      }
    );
  });

  it("vendor-exact-miss — a miss on either route is refused, quoting the input", async () => {
    const { client } = fakeClient();
    const cache = await getVendorCache(client);
    assert.throws(() => resolveVendorRefExact(cache, "East Haulage", "name"), /"East Haulage"/);
    assert.throws(() => resolveVendorRefExact(cache, "99", "id"), /"99"/);
  });
});

describe("resolveItemExact", () => {
  beforeEach(() => clearLookupCache());

  it("item-exact-by-path — a Parent:Child path matches the fully qualified name", async () => {
    const { client, calls } = fakeClient();
    assert.deepEqual(await resolveItemExact(client, "freight:shipping", "name"), {
      value: "30",
      name: "Freight:Shipping",
    });
    assert.equal(usedLike(calls), false);
  });

  it("item-exact-unique-leaf — a leaf name that only one item holds resolves", async () => {
    const { client } = fakeClient();
    assert.deepEqual(await resolveItemExact(client, "Fuel Surcharge", "name"), {
      value: "32",
      name: "Freight:Fuel Surcharge",
    });
  });

  it("item-exact-by-id — the id route returns the item, and a miss never falls back to a name", async () => {
    const { client, calls } = fakeClient();
    assert.deepEqual(await resolveItemExact(client, "32", "id"), {
      value: "32",
      name: "Freight:Fuel Surcharge",
    });
    calls.length = 0;
    await assert.rejects(() => resolveItemExact(client, "99", "id"), /"99"/);
    assert.equal(usedName(calls), false);
  });

  it("item-exact-ambiguous-leaf — a leaf shared by two items lists every candidate", async () => {
    const { client } = fakeClient();
    await assert.rejects(
      () => resolveItemExact(client, "Shipping", "name"),
      (err: Error) => {
        assert.match(err.message, /Freight:Shipping \(id 30\)/);
        assert.match(err.message, /Supplies:Shipping \(id 31\)/);
        assert.match(err.message, /Id/);
        assert.match(err.message, /full path/i);
        return true;
      }
    );
  });

  it("item-exact-refuses-partial — a partial name is refused without a LIKE query", async () => {
    const { client, calls } = fakeClient();
    await assert.rejects(() => resolveItemExact(client, "Ship", "name"), Error);
    assert.equal(usedLike(calls), false);
  });

  it("item-exact-inactive — an inactive item is refused as inactive, naming its Id", async () => {
    const { client } = fakeClient();
    await assert.rejects(
      () => resolveItemExact(client, "Pallets", "name"),
      (err: Error) => {
        assert.match(err.message, /inactive/);
        assert.match(err.message, /id 33/);
        return true;
      }
    );
  });

  it("item-exact-inactive — an inactive item named by Id is refused as inactive", async () => {
    const { client } = fakeClient();
    await assert.rejects(
      () => resolveItemExact(client, "33", "id"),
      (err: Error) => {
        assert.match(err.message, /inactive/);
        assert.match(err.message, /id 33/);
        return true;
      }
    );
  });

  it("item-exact-miss — an unknown item is refused as a miss, not as inactive", async () => {
    const { client } = fakeClient();
    await assert.rejects(
      () => resolveItemExact(client, "Crates", "name"),
      (err: Error) => {
        assert.match(err.message, /"Crates"/);
        assert.doesNotMatch(err.message, /inactive/);
        return true;
      }
    );
  });
});

describe("resolveItemInput exact option", () => {
  beforeEach(() => clearLookupCache());

  it("item-input-exact-option — exact mode refuses a partial name, label-prefixed; the default path still guesses", async () => {
    const { client, calls } = fakeClient();
    await assert.rejects(
      () => resolveItemInput(client, { item_name: "Ship" }, "Line 1", { exact: true }),
      (err: Error) => err.message.startsWith("Line 1")
    );
    assert.equal(usedLike(calls), false);

    const loose = await resolveItemInput(client, { item_name: "Ship" }, "Line 1");
    assert.ok(loose && typeof loose === "object" && "value" in loose);
    assert.equal(usedLike(calls), true);
  });
});
