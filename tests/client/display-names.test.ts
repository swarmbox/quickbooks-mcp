// Display-name holder lookup: QBO display names are one namespace across the
// Vendor, Customer and Employee lists, so a name is "held" if any of the three
// answers an exact query for it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";
import { findDisplayNameHolders } from "../../src/client/display-names.js";

type Callback<T> = (err: unknown, result: T) => void;
type Kind = "Vendor" | "Customer" | "Employee";
type Row = { Id: string; DisplayName: string };
// One outcome per call to a list's finder: rows to return, or a value to reject with.
type Outcome = { rows: Row[] } | { reject: unknown };

// Invented fixtures only — this repository is public (CLAUDE.md).
const HOLDERS: Record<Kind, Row> = {
  Vendor: { Id: "43", DisplayName: "Acme Supply" },
  Customer: { Id: "41", DisplayName: "Acme Supply" },
  Employee: { Id: "42", DisplayName: "Acme Supply" },
};

const fault4000 = { Fault: { type: "ValidationFault", Error: [{ code: "4000", Message: "Query parser error" }] } };

// Each list answers from its outcome script; the last outcome repeats once the
// script runs out. Every call's criteria is recorded per list.
function fakeClient(script: Partial<Record<Kind, Outcome[]>> = {}) {
  const calls: Record<Kind, unknown[]> = { Vendor: [], Customer: [], Employee: [] };
  const finder = (kind: Kind) => (criteria: unknown, cb: Callback<unknown>) => {
    calls[kind].push(criteria);
    const outcomes = script[kind] ?? [{ rows: [] }];
    const outcome = outcomes[Math.min(calls[kind].length, outcomes.length) - 1];
    if ("reject" in outcome) return cb(outcome.reject, undefined);
    cb(null, { QueryResponse: outcome.rows.length ? { [kind]: outcome.rows } : {} });
  };
  const client = {
    findVendors: finder("Vendor"),
    findCustomers: finder("Customer"),
    findEmployees: finder("Employee"),
  } as unknown as QuickBooks;
  return { client, calls };
}

const criteriaFor = (value: string) => [{ field: "DisplayName", value, operator: "=" }];

describe("findDisplayNameHolders", () => {
  it("holders-none-found — resolves [] after one exact, unfiltered query per list", async () => {
    const { client, calls } = fakeClient();

    const holders = await findDisplayNameHolders(client, "Acme Supply");

    assert.deepEqual(holders, []);
    for (const kind of ["Vendor", "Customer", "Employee"] as const) {
      assert.deepEqual(calls[kind], [criteriaFor("Acme Supply")], `${kind} lookup criteria`);
    }
  });

  it("holders-trims-name — every lookup carries the trimmed value", async () => {
    const { client, calls } = fakeClient();

    await findDisplayNameHolders(client, "  Acme Supply  ");

    for (const kind of ["Vendor", "Customer", "Employee"] as const) {
      assert.deepEqual(calls[kind], [criteriaFor("Acme Supply")], `${kind} lookup criteria`);
    }
  });

  it("holders-each-list — each list reports its own holder, all three in Vendor, Customer, Employee order", async () => {
    for (const kind of ["Vendor", "Customer", "Employee"] as const) {
      const { client } = fakeClient({ [kind]: [{ rows: [HOLDERS[kind]] }] });
      const holders = await findDisplayNameHolders(client, "Acme Supply");
      assert.deepEqual(holders, [{ type: kind, id: HOLDERS[kind].Id, displayName: "Acme Supply" }]);
    }

    const { client } = fakeClient({
      Employee: [{ rows: [HOLDERS.Employee] }],
      Customer: [{ rows: [HOLDERS.Customer] }],
      Vendor: [{ rows: [HOLDERS.Vendor] }],
    });
    const holders = await findDisplayNameHolders(client, "Acme Supply");
    assert.deepEqual(holders, [
      { type: "Vendor", id: "43", displayName: "Acme Supply" },
      { type: "Customer", id: "41", displayName: "Acme Supply" },
      { type: "Employee", id: "42", displayName: "Acme Supply" },
    ]);
  });

  it("holders-throttle-retried — a 429 on one list is retried, not read as 'no holder'", async () => {
    const { client, calls } = fakeClient({
      Customer: [{ reject: { status: 429 } }, { rows: [HOLDERS.Customer] }],
    });

    const holders = await findDisplayNameHolders(client, "Acme Supply");

    assert.deepEqual(holders, [{ type: "Customer", id: "41", displayName: "Acme Supply" }]);
    assert.equal(calls.Customer.length, 2);
  });

  it("holders-lookup-failure-throws — a failed list rejects with the original fault, never a partial list", async () => {
    const { client } = fakeClient({
      Vendor: [{ rows: [HOLDERS.Vendor] }],
      Employee: [{ reject: fault4000 }],
    });

    await assert.rejects(
      findDisplayNameHolders(client, "Acme Supply"),
      (err: unknown) => {
        assert.equal(err, fault4000);
        return true;
      },
    );
  });
});
