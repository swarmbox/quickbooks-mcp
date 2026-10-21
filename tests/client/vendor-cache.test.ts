// Vendor cache insert: a vendor created this session resolves by name before the
// bulk cache's TTL lapses, and a load that was in flight across the insert (or
// across clearLookupCache) is not stored over it.

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
const NORTH_PRODUCE: CachedVendor = { Id: "20", DisplayName: "North Produce", Active: true };
const ACME_SUPPLY: CachedVendor = { Id: "70", DisplayName: "Acme Supply", Active: true };

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

// A fake whose findVendors holds each callback until the test releases it with
// the listing that load should return, so a load can be left in flight.
function heldClient() {
  const pending: Callback<unknown>[] = [];
  let loads = 0;
  const client = {
    findVendors: (_criteria: unknown, cb: Callback<unknown>) => {
      loads++;
      pending.push(cb);
    },
  } as unknown as QuickBooks;

  async function release(rows: CachedVendor[]): Promise<void> {
    while (pending.length === 0) await new Promise((r) => setImmediate(r));
    pending.shift()!(null, { QueryResponse: { Vendor: rows.map((v) => ({ ...v })) } });
  }

  return { client, release, loads: () => loads };
}

describe("vendor cache insert", () => {
  beforeEach(() => clearLookupCache());

  it("cache-remember-loaded — a remembered vendor resolves by name and id without a reload or a TTL extension", async () => {
    const { client, loads } = fakeClient([NORTH_PRODUCE]);
    const fetchedAt = (await getVendorCache(client)).fetchedAt;

    rememberVendor({ ...ACME_SUPPLY });
    const cache = await getVendorCache(client);

    for (const input of ["acme supply", "70"]) {
      assert.deepEqual(resolveVendorRef(cache, input), { value: "70", name: "Acme Supply" });
    }
    assert.equal(loads(), 1);
    assert.equal(cache.fetchedAt, fetchedAt);
  });

  it("cache-remember-unloaded — remembering into an unloaded cache creates no partial cache", async () => {
    const { client, loads } = fakeClient([NORTH_PRODUCE]);

    rememberVendor({ ...ACME_SUPPLY });
    const cache = await getVendorCache(client);

    assert.equal(loads(), 1);
    assert.deepEqual(cache.items, [NORTH_PRODUCE]);
  });

  it("cache-load-race — a load in flight across rememberVendor is returned but not stored", async () => {
    const { client, release, loads } = heldClient();

    const inFlight = getVendorCache(client);
    rememberVendor({ ...ACME_SUPPLY });
    await release([NORTH_PRODUCE]);
    const stale = await inFlight;
    assert.deepEqual(stale.items, [NORTH_PRODUCE]);

    const next = getVendorCache(client);
    await release([NORTH_PRODUCE, ACME_SUPPLY]);
    const cache = await next;

    assert.equal(loads(), 2);
    assert.equal(resolveVendorRef(cache, "Acme Supply").value, "70");
  });

  it("cache-clear-discards-inflight — a load in flight across clearLookupCache is not stored", async () => {
    const { client, release, loads } = heldClient();

    const inFlight = getVendorCache(client);
    clearLookupCache();
    await release([NORTH_PRODUCE]);
    await inFlight;

    const next = getVendorCache(client);
    await release([NORTH_PRODUCE]);
    await next;

    assert.equal(loads(), 2);
  });
});
