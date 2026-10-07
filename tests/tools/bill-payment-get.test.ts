import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { handleGetBillPayment } from "../../src/tools/handlers/bill-payment.js";
import { clearLookupCache } from "../../src/client/cache.js";
import { fakeClient, type FakeClient } from "./bill-payment-fixtures.js";

beforeEach(() => clearLookupCache());

async function get(fake: FakeClient, id: string): Promise<string> {
  const result = await handleGetBillPayment(fake.client, { id });
  return result.content.map((c) => c.text).join("\n");
}

/** The indented lines under "Applied to:", up to the first blank line. */
function appliedLines(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf("Applied to:");
  assert.ok(start >= 0, `expected an "Applied to:" block in:\n${text}`);
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    block.push(line.trim());
  }
  return block;
}

describe("get_bill_payment — signing by side", () => {
  it("get-signs-every-type — every linked type is signed by the side it posts to A/P", async () => {
    const fake = fakeClient();
    const text = await get(fake, "900");
    assert.deepEqual(appliedLines(text), [
      "Bill 101: $250.00 (charge)",
      "JournalEntry 300: -$100.00 (credit)",
      "Purchase 700: -$80.00 (credit)",
      "Deposit 500: $60.00 (charge)",
      "Purchase 701: $30.00 (charge)",
    ]);
    assert.ok(text.includes("Account: 1010 Checking"));
    assert.ok(!text.includes("UNAPPLIED"), text);
    assert.ok(!text.includes("OVER-APPLIED"), text);
    assert.ok(!text.includes("Net applied not verified"), text);
  });

  it("get-zero-je-payment-not-over-applied — a $0 payment applying a JournalEntry credit is not over-applied", async () => {
    const fake = fakeClient();
    const text = await get(fake, "901");
    assert.ok(appliedLines(text).includes("JournalEntry 300: -$250.00 (credit)"), text);
    assert.ok(text.includes("Account: (none)"), text);
    assert.ok(!text.includes("OVER-APPLIED"), text);
    assert.ok(!text.includes("UNAPPLIED"), text);
  });

  it("get-unapplied-still-flagged — a total above the signed net is still flagged UNAPPLIED", async () => {
    const fake = fakeClient();
    const text = await get(fake, "902");
    assert.ok(text.includes("UNAPPLIED AMOUNT: $50.00"), text);
    assert.ok(!text.includes("OVER-APPLIED"), text);
  });
});

describe("get_bill_payment — a line that cannot be classified", () => {
  it("get-unknown-side-not-flagged — an unreadable JournalEntry gets side unknown and no false flag", async () => {
    const fake = fakeClient();
    const text = await get(fake, "903");
    const applied = appliedLines(text);
    assert.ok(applied.includes("JournalEntry 999: $50.00 (side unknown)"), text);
    assert.ok(applied.includes("Bill 101: $100.00 (charge)"), text);
    assert.ok(text.includes("Net applied not verified: could not classify 1 linked transaction(s)"), text);
    assert.ok(!text.includes("UNAPPLIED"), text);
    assert.ok(!text.includes("OVER-APPLIED"), text);
    // The fake rejects with "JournalEntry 999 not found"; that text must not leak.
    assert.ok(!text.includes("not found"), text);
  });

  it("get-unsupported-type-side-unknown — a type outside the table is not read and gets side unknown", async () => {
    const fake = fakeClient();
    const text = await get(fake, "905");
    assert.ok(appliedLines(text).includes("Invoice 77: $10.00 (side unknown)"), text);
    assert.ok(text.includes("Net applied not verified: could not classify 1 linked transaction(s)"), text);
    assert.ok(!text.includes("UNAPPLIED"), text);
    assert.ok(!text.includes("OVER-APPLIED"), text);
    assert.equal(fake.callsTo("getInvoice"), 0, "Invoice 77 must never be read");
    const reads = fake.calls.filter((c) => c.startsWith("get"));
    assert.deepEqual(reads, ["getBillPayment"], "only the bill payment itself is read");
  });
});

describe("get_bill_payment — what is fetched", () => {
  it("get-fixed-sides-not-fetched — Bill and VendorCredit lines take their fixed side without any read", async () => {
    const fake = fakeClient();
    const text = await get(fake, "904");
    assert.equal(fake.callsTo("getBill"), 0);
    assert.equal(fake.callsTo("getVendorCredit"), 0);
    assert.equal(fake.callsTo("findAccounts"), 0);
    assert.deepEqual(appliedLines(text), ["Bill 101: $250.00 (charge)", "VendorCredit 401: -$50.00 (credit)"]);
    assert.ok(!text.includes("UNAPPLIED"), text);
    assert.ok(!text.includes("OVER-APPLIED"), text);
    assert.ok(!text.includes("Net applied not verified"), text);
  });

  it("get-signs-every-type — the account cache is read once, and only because derived kinds are linked", async () => {
    const fake = fakeClient();
    await get(fake, "900");
    assert.equal(fake.callsTo("getBill"), 0, "the Bill line is not fetched");
    assert.equal(fake.callsTo("findAccounts"), 1);
    assert.equal(fake.callsTo("getJournalEntry"), 1);
    assert.equal(fake.callsTo("getDeposit"), 1);
    assert.equal(fake.callsTo("getPurchase"), 2);
  });
});
