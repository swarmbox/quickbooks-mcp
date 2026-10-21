// Vendor cache upsert: rememberVendor records a vendor as a committed create or
// edit left it. A rename replaces the entry in place and the old name stops
// resolving; an inactive vendor is removed, since a bulk load lists active
// vendors only.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";
import {
  clearLookupCache,
  getVendorCache,
  rememberVendor,
  resolveVendorRef,
} from "../../src/client/index.js";
import type { CachedVendor } from "../../src/types/index.js";

type Callback<T> = (err: unknown, result: T) => void;

// Invented fixtures only — this repository is public (CLAUDE.md).
const ACME_SUPPLY_CO: CachedVendor = { Id: "42", DisplayName: "Acme Supply Co", Active: true };
const NORTH_PRODUCE: CachedVendor = { Id: "20", DisplayName: "North Produce", Active: true };

// A fake whose findVendors answers immediately with the next queued listing.
function fakeClient(...listings: CachedVendor[][]) {
  let loads = 0;
  const client = {
    findVendors: (_criteria: unknown, cb: Callback<unknown>) => {
      const rows = listings[loads] ?? [];
      loads++;
      cb(null, { QueryResponse: { Vendor: rows.map((v) => ({ ...v })) } });
    },
  } as unknown as QuickBooks;
  return { client, loads: () => loads };
}

describe("vendor cache upsert", () => {
  beforeEach(() => clearLookupCache());

  it("cache-rename-replaces-in-place — a renamed vendor resolves by its new name and keeps its position", async () => {
    const { client, loads } = fakeClient([ACME_SUPPLY_CO, NORTH_PRODUCE]);
    const fetchedAt = (await getVendorCache(client)).fetchedAt;

    rememberVendor({ Id: "42", DisplayName: "Acme Supply", Active: true });
    const cache = await getVendorCache(client);

    for (const input of ["acme supply", "42"]) {
      assert.deepEqual(resolveVendorRef(cache, input), { value: "42", name: "Acme Supply" });
    }
    assert.throws(() => resolveVendorRef(cache, "Acme Supply Co"), /Vendor not found/);
    assert.deepEqual(cache.items, [
      { Id: "42", DisplayName: "Acme Supply", Active: true },
      NORTH_PRODUCE,
    ]);
    assert.equal(loads(), 1);
    assert.equal(cache.fetchedAt, fetchedAt);
  });

  it("cache-inactive-removed — an inactive vendor stops resolving by id and by every name", async () => {
    const { client, loads } = fakeClient([ACME_SUPPLY_CO, NORTH_PRODUCE]);
    await getVendorCache(client);

    rememberVendor({ Id: "42", DisplayName: "Acme Supply Co (deleted)", Active: false });
    const cache = await getVendorCache(client);

    for (const input of ["42", "Acme Supply Co", "Acme Supply Co (deleted)"]) {
      assert.throws(() => resolveVendorRef(cache, input), /Vendor not found/);
    }
    assert.deepEqual(cache.items, [NORTH_PRODUCE]);
    assert.equal(loads(), 1);
  });

  it("cache-inactive-uncached-noop — an inactive vendor that was never cached leaves the cache alone", async () => {
    const { client, loads } = fakeClient([NORTH_PRODUCE]);
    await getVendorCache(client);

    rememberVendor({ Id: "42", DisplayName: "Acme Supply Co (deleted)", Active: false });
    const cache = await getVendorCache(client);

    assert.deepEqual(cache.items, [NORTH_PRODUCE]);
    assert.throws(() => resolveVendorRef(cache, "42"), /Vendor not found/);
    assert.equal(loads(), 1);
  });

  it("cache-active-undefined-kept — a vendor with no Active key is treated as active", async () => {
    const { client } = fakeClient([NORTH_PRODUCE]);
    await getVendorCache(client);

    rememberVendor({ Id: "42", DisplayName: "Acme Supply Co" });
    const cache = await getVendorCache(client);

    for (const input of ["acme supply co", "42"]) {
      assert.deepEqual(resolveVendorRef(cache, input), { value: "42", name: "Acme Supply Co" });
    }
  });

  it("cache-old-key-of-another-vendor-kept — renaming a vendor leaves a name key now held by another vendor", async () => {
    const { client } = fakeClient([ACME_SUPPLY_CO]);
    await getVendorCache(client);
    rememberVendor({ Id: "70", DisplayName: "Acme Supply Co", Active: true });

    rememberVendor({ Id: "42", DisplayName: "Acme Supply", Active: true });
    const cache = await getVendorCache(client);

    assert.equal(resolveVendorRef(cache, "Acme Supply Co").value, "70");
    assert.equal(resolveVendorRef(cache, "Acme Supply").value, "42");
  });
});
