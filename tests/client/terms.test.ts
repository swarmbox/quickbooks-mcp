// Shared payment-term lookup: the bulk cache, the exact-match resolver, the
// due-days rule and the display label for refs that carry only an Id.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";
import {
  clearLookupCache,
  getTermCache,
  describeTermRef,
  resolveTermRef,
  termDueDays,
  toQboRef,
} from "../../src/client/index.js";
import type { TermRef } from "../../src/client/index.js";

type Callback<T> = (err: unknown, result: T) => void;

// Invented fixtures only — this repository is public (CLAUDE.md).
const TERMS = [
  { Id: "3", Name: "Net 30", Type: "STANDARD", DueDays: 30, Active: true },
  { Id: "5", Name: "Net 05", Type: "STANDARD", DueDays: 5, Active: true },
  { Id: "8", Name: "15th of month", Type: "DATE_DRIVEN", DayOfMonthDue: 15, Active: true },
];

function fakeClient(terms: typeof TERMS = TERMS, error?: unknown) {
  const calls: unknown[] = [];
  const client = {
    findTerms: (criteria: unknown, cb: Callback<unknown>) => {
      calls.push(criteria);
      if (error) return cb(error, undefined);
      cb(null, { QueryResponse: { Term: terms } });
    },
  } as unknown as QuickBooks;
  return { client, calls };
}

describe("term lookup", () => {
  beforeEach(() => clearLookupCache());

  it("term-cache-loads-once — one read per TTL, a fresh read after clearLookupCache", async () => {
    const { client, calls } = fakeClient();
    await getTermCache(client);
    await getTermCache(client);
    clearLookupCache();
    await getTermCache(client);
    assert.equal(calls.length, 2);
    for (const criteria of calls) {
      assert.equal((criteria as { fetchAll?: boolean }).fetchAll, true);
    }
  });

  it("term-resolve-by-id-or-name — Id, then exact name in any case", async () => {
    const { client } = fakeClient();
    const cache = await getTermCache(client);
    for (const input of ["3", "Net 30", "net 30", "NET 30"]) {
      const ref = resolveTermRef(cache, input);
      assert.deepEqual(ref, { value: "3", name: "Net 30", type: "STANDARD", dueDays: 30 });
      assert.deepEqual(toQboRef(ref), { value: "3", name: "Net 30" });
    }
  });

  it("term-resolve-miss-lists-names — a zero-padding miss names every available term", async () => {
    const { client } = fakeClient();
    const cache = await getTermCache(client);
    assert.throws(
      () => resolveTermRef(cache, "Net 5"),
      { message: 'Term not found: "Net 5". Available: Net 30, Net 05, 15th of month' },
    );
  });

  it("term-resolve-id-before-name — an Id match wins over another term's Name", async () => {
    const { client } = fakeClient([
      { Id: "9", Name: "3", Type: "STANDARD", DueDays: 9, Active: true },
      { Id: "3", Name: "Net 30", Type: "STANDARD", DueDays: 30, Active: true },
    ]);
    const cache = await getTermCache(client);
    assert.equal(resolveTermRef(cache, "3").name, "Net 30");
  });
});

describe("termDueDays", () => {
  const ref = (extra: Partial<TermRef>): TermRef => ({ value: "1", name: "T", ...extra });

  it("term-due-days-computable — STANDARD with a whole non-negative DueDays", () => {
    assert.equal(termDueDays(ref({ type: "STANDARD", dueDays: 30 })), 30);
    assert.equal(termDueDays(ref({ type: "STANDARD", dueDays: 0 })), 0);
  });

  it("term-due-days-not-computable — date-driven, missing, negative, fractional or untyped", () => {
    assert.equal(termDueDays(ref({ type: "DATE_DRIVEN" })), undefined);
    assert.equal(termDueDays(ref({ type: "STANDARD" })), undefined);
    assert.equal(termDueDays(ref({ type: "STANDARD", dueDays: -1 })), undefined);
    assert.equal(termDueDays(ref({ type: "STANDARD", dueDays: 1.5 })), undefined);
    assert.equal(termDueDays(ref({ dueDays: 30 })), undefined);
  });
});

describe("describeTermRef", () => {
  beforeEach(() => clearLookupCache());

  it("describe-term-absent — no ref, or an empty value, is (none) with no read", async () => {
    const { client, calls } = fakeClient();
    assert.equal(await describeTermRef(client, undefined), "(none)");
    assert.equal(await describeTermRef(client, null), "(none)");
    assert.equal(await describeTermRef(client, { value: "" }), "(none)");
    assert.equal(calls.length, 0);
  });

  it("describe-term-named — a ref that already has a name makes no read", async () => {
    const { client, calls } = fakeClient();
    assert.equal(await describeTermRef(client, { value: "3", name: "Net 30" }), "Net 30");
    assert.equal(calls.length, 0);
  });

  it("describe-term-resolved — a name-less ref takes the cached term's name", async () => {
    const { client } = fakeClient();
    assert.equal(await describeTermRef(client, { value: "3" }), "Net 30");
  });

  it("describe-term-unknown — an Id missing from the term list says so", async () => {
    const { client } = fakeClient();
    assert.equal(
      await describeTermRef(client, { value: "99" }),
      "id 99 (inactive or unknown term)",
    );
  });

  it("describe-term-load-failure — a failed lookup resolves instead of rejecting", async () => {
    const { client } = fakeClient(TERMS, new Error("lookup failed"));
    assert.equal(
      await describeTermRef(client, { value: "3" }),
      "id 3 (name could not be loaded)",
    );
  });
});
