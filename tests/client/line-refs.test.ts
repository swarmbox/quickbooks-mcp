// Shared line-ref resolvers: class refs, and the tri-state item/class inputs
// the bill and expense line paths use.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";
import {
  clearLookupCache,
  getClassCache,
  resolveClassRef,
  resolveClassInput,
  resolveItemInput,
  resolveItem,
} from "../../src/client/index.js";

type Callback<T> = (err: unknown, result: T) => void;

// Invented fixtures only — this repository is public (CLAUDE.md).
const CLASSES = [
  { Id: "60", Name: "North", FullyQualifiedName: "North" },
  { Id: "61", Name: "Downtown", FullyQualifiedName: "South:Downtown" },
];

const ITEMS = [
  { Id: "50", Name: "Widget", FullyQualifiedName: "Widget", Active: true },
];

interface Sent {
  itemQueries: unknown[];
}

function fakeClient(items: typeof ITEMS = ITEMS) {
  const sent: Sent = { itemQueries: [] };
  const list = <T>(key: string, rows: T[]) => ({ QueryResponse: { [key]: rows } });

  const client = {
    findClasses: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Class", CLASSES)),
    findItems: (criteria: unknown, cb: Callback<unknown>) => {
      sent.itemQueries.push(criteria);
      // Mirror QBO: only return a row when the criteria actually match a field
      // this fake understands, so a name query for an id string comes back empty.
      const c = criteria as Array<{ field: string; value: string }>;
      const nameTerm = c.find(t => t.field === "Name");
      const idTerm = c.find(t => t.field === "Id");
      if (idTerm) {
        return cb(null, list("Item", items.filter(i => i.Id === idTerm.value)));
      }
      if (nameTerm) {
        const raw = nameTerm.value;
        const bare = raw.replace(/%/g, "").toLowerCase();
        const matches = raw.includes("%")
          ? items.filter(i => i.Name.toLowerCase().includes(bare))
          : items.filter(i => i.Name.toLowerCase() === bare);
        return cb(null, list("Item", matches));
      }
      return cb(null, list("Item", []));
    },
  } as unknown as QuickBooks;

  return { client, sent };
}

describe("resolveClassRef", () => {
  beforeEach(() => {
    // The class cache is module-level and TTL'd, so a fixture from one test
    // would otherwise answer a lookup in the next.
    clearLookupCache();
  });

  it("resolves by internal Id", async () => {
    const { client } = fakeClient();
    const cache = await getClassCache(client);
    assert.deepEqual(resolveClassRef(cache, "60"), { value: "60", name: "North" });
  });

  it("resolves by exact leaf name, case-insensitively", async () => {
    const { client } = fakeClient();
    const cache = await getClassCache(client);
    assert.deepEqual(resolveClassRef(cache, "downtown"), { value: "61", name: "South:Downtown" });
  });

  it("resolves by fully-qualified name and returns it as the display name", async () => {
    const { client } = fakeClient();
    const cache = await getClassCache(client);
    assert.deepEqual(resolveClassRef(cache, "South:Downtown"), {
      value: "61",
      name: "South:Downtown",
    });
  });

  it("falls back to a partial match on the qualified name", async () => {
    const { client } = fakeClient();
    const cache = await getClassCache(client);
    assert.deepEqual(resolveClassRef(cache, "Downt"), { value: "61", name: "South:Downtown" });
  });

  it("throws naming the input when nothing matches", async () => {
    const { client } = fakeClient();
    const cache = await getClassCache(client);
    assert.throws(() => resolveClassRef(cache, "Nowhere"), /Class not found: "Nowhere"/);
  });
});

describe("resolveItem by Id", () => {
  beforeEach(() => clearLookupCache());

  it("resolves a bare Id, which the error message already promises", async () => {
    const { client } = fakeClient();
    // "50" is an id, not a name — the name query returns nothing and the Id
    // query is what has to find it.
    assert.deepEqual(await resolveItem(client, "50"), { value: "50", name: "Widget" });
  });

  it("still prefers a name match over an id-shaped lookup", async () => {
    // An item literally named "50" wins its own name, mirroring resolveCustomer.
    const named = [{ Id: "51", Name: "50", FullyQualifiedName: "50", Active: true }];
    const { client } = fakeClient(named);
    assert.deepEqual(await resolveItem(client, "50"), { value: "51", name: "50" });
  });
});

describe("tri-state line inputs", () => {
  beforeEach(() => clearLookupCache());

  it("returns undefined when no class input is present, so an edit preserves it", async () => {
    const { client } = fakeClient();
    const cache = await getClassCache(client);
    assert.equal(resolveClassInput(cache, {}, "Line 1"), undefined);
  });

  it("returns null for an explicitly empty class, so an edit clears it", async () => {
    const { client } = fakeClient();
    const cache = await getClassCache(client);
    assert.equal(resolveClassInput(cache, { class_name: "" }, "Line 1"), null);
  });

  it("resolves a class ref when a name is given", async () => {
    const { client } = fakeClient();
    const cache = await getClassCache(client);
    assert.deepEqual(resolveClassInput(cache, { class_name: "North" }, "Line 1"), {
      value: "60",
      name: "North",
    });
  });

  it("labels a class resolution failure with the caller's line", async () => {
    const { client } = fakeClient();
    const cache = await getClassCache(client);
    assert.throws(
      () => resolveClassInput(cache, { class_name: "Nowhere" }, "Line 2"),
      /Line 2: Class not found: "Nowhere"/
    );
  });

  it("returns undefined / null / ref for the three item input states", async () => {
    const { client } = fakeClient();
    assert.equal(await resolveItemInput(client, {}, "Line 1"), undefined);
    assert.equal(await resolveItemInput(client, { item_name: "" }, "Line 1"), null);
    assert.deepEqual(await resolveItemInput(client, { item_name: "Widget" }, "Line 1"), {
      value: "50",
      name: "Widget",
    });
  });

  it("labels an item resolution failure with the caller's line", async () => {
    const { client } = fakeClient();
    await assert.rejects(
      () => resolveItemInput(client, { item_name: "Nowhere" }, "Line 3"),
      /Line 3: Item not found: "Nowhere"/
    );
  });

  it("prefers item_id over item_name when both name the same line", async () => {
    const { client } = fakeClient();
    assert.deepEqual(
      await resolveItemInput(client, { item_id: "50", item_name: "ignored" }, "Line 1"),
      { value: "50", name: "Widget" }
    );
  });
});
