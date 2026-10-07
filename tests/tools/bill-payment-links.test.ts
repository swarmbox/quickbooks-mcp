import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  LINKED_TXN_TYPES,
  LINK_KINDS,
  collectLinkRequests,
  appliedByLinkedTxn,
  resolveLinks,
  type LinkRequest,
  type ResolvedLink,
} from "../../src/tools/handlers/bill-payment-links.js";
import { clearLookupCache } from "../../src/client/cache.js";
import { BATCH_SIZE, SAFETY_LIMIT } from "../../src/query/pagination.js";
import { NORTH, SOUTH, fakeClient, rejectionOf } from "./bill-payment-fixtures.js";

beforeEach(() => clearLookupCache());

function find(links: ResolvedLink[], type: string, id: string): ResolvedLink {
  const link = links.find((l) => l.type === type && l.id === id);
  assert.ok(link, `expected ${type} ${id} among the resolved links`);
  return link;
}

describe("bill-payment links — the supported-type table", () => {
  it("lists every type a bill payment line can link, in order", () => {
    assert.deepEqual([...LINKED_TXN_TYPES], ["Bill", "VendorCredit", "JournalEntry", "Deposit", "Purchase"]);
  });

  it("labels each type the way error messages name it", () => {
    assert.deepEqual(
      Object.fromEntries(LINKED_TXN_TYPES.map((t) => [t, LINK_KINDS[t].label])),
      {
        Bill: "Bill",
        VendorCredit: "Vendor credit",
        JournalEntry: "Journal entry",
        Deposit: "Deposit",
        Purchase: "Purchase",
      },
    );
  });
});

describe("bill-payment links — collectLinkRequests", () => {
  it("links-merge-order — merges bills, then credits, then linked_txns; only explicit amounts carry cents", async () => {
    const requests = await collectLinkRequests({
      bills: [{ bill_id: "101" }],
      credits: [{ vendor_credit_id: "401" }],
      linked_txns: [{ txn_type: "JournalEntry", txn_id: "300", amount: 100 }],
    });
    assert.deepEqual(
      requests.map((r) => [r.type, r.id]),
      [["Bill", "101"], ["VendorCredit", "401"], ["JournalEntry", "300"]],
    );
    assert.equal(requests[0].amountCents, undefined);
    assert.equal(requests[1].amountCents, undefined);
    assert.equal(requests[2].amountCents, 10000);
  });

  it("links-unknown-type-rejected — names the type and every supported one", async () => {
    const message = await rejectionOf(() =>
      collectLinkRequests({ linked_txns: [{ txn_type: "Invoice", txn_id: "9" }] }),
    );
    assert.equal(
      message,
      'Unsupported txn_type "Invoice". Supported: Bill, VendorCredit, JournalEntry, Deposit, Purchase',
    );
  });

  it("links-unknown-type-rejected — the supported list comes from LINKED_TXN_TYPES", async () => {
    const message = await rejectionOf(() =>
      collectLinkRequests({ linked_txns: [{ txn_type: "Invoice", txn_id: "9" }] }),
    );
    assert.ok(message.endsWith(`Supported: ${LINKED_TXN_TYPES.join(", ")}`), message);
  });

  it("links-type-case-insensitive — normalises txn_type to its canonical spelling", async () => {
    const requests = await collectLinkRequests({ linked_txns: [{ txn_type: "journalentry", txn_id: "300" }] });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].type, "JournalEntry");
    assert.equal(requests[0].id, "300");
  });

  it("links-duplicate-rejected — the same type and id across lists is rejected", async () => {
    const message = await rejectionOf(() =>
      collectLinkRequests({
        bills: [{ bill_id: "101" }],
        linked_txns: [{ txn_type: "Bill", txn_id: "101" }],
      }),
    );
    assert.equal(message, "Bill 101 is listed more than once");
  });

  it("links-duplicate-rejected — the same id under different types is not a duplicate", async () => {
    const requests = await collectLinkRequests({
      linked_txns: [
        { txn_type: "JournalEntry", txn_id: "303" },
        { txn_type: "Deposit", txn_id: "303" },
      ],
    });
    assert.deepEqual(requests.map((r) => r.type), ["JournalEntry", "Deposit"]);
  });

  it("names a duplicate vendor credit by its label", async () => {
    const message = await rejectionOf(() =>
      collectLinkRequests({
        credits: [{ vendor_credit_id: "401" }],
        linked_txns: [{ txn_type: "vendorcredit", txn_id: "401" }],
      }),
    );
    assert.equal(message, "Vendor credit 401 is listed more than once");
  });

  it("links-empty-rejected — all three lists absent", async () => {
    const message = await rejectionOf(() => collectLinkRequests({}));
    assert.ok(message.startsWith("At least one transaction to apply is required"), message);
  });

  it("links-empty-rejected — all three lists empty", async () => {
    const message = await rejectionOf(() =>
      collectLinkRequests({ bills: [], credits: [], linked_txns: [] }),
    );
    assert.ok(message.startsWith("At least one transaction to apply is required"), message);
  });

  it("links-amount-validated — more than two decimal places is the validateAmount error", async () => {
    const message = await rejectionOf(() =>
      collectLinkRequests({ bills: [{ bill_id: "101", amount: 10.001 }] }),
    );
    assert.match(message, /\$10\.001 has 3 decimal places\. QuickBooks only supports 2 decimal places \(cents\)\./);
  });

  it("links-amount-validated — a zero amount must be positive", async () => {
    const message = await rejectionOf(() =>
      collectLinkRequests({ bills: [{ bill_id: "101", amount: 0 }] }),
    );
    assert.equal(message, "Bill 101: amount must be positive");
  });

  it("links-amount-validated — a negative amount must be positive", async () => {
    const message = await rejectionOf(() =>
      collectLinkRequests({ bills: [{ bill_id: "101", amount: -5 }] }),
    );
    assert.equal(message, "Bill 101: amount must be positive");
  });

  it("names a non-bill entry by its label when its amount is not positive", async () => {
    const message = await rejectionOf(() =>
      collectLinkRequests({ linked_txns: [{ txn_type: "JournalEntry", txn_id: "300", amount: 0 }] }),
    );
    assert.equal(message, "Journal entry 300: amount must be positive");
  });

  it("carries no side: an extra side field on an entry never reaches the request", async () => {
    const requests = await collectLinkRequests({
      linked_txns: [{ txn_type: "JournalEntry", txn_id: "300", side: "charge" } as never],
    });
    assert.ok(!("side" in requests[0]), "a request must not carry a caller-declared side");
  });
});

describe("bill-payment links — resolveLinks on Bill and VendorCredit", () => {
  const requests: LinkRequest[] = [
    { type: "Bill", id: "103" },
    { type: "VendorCredit", id: "401" },
    { type: "VendorCredit", id: "402" },
  ];

  it("links-tracked-bill-and-credit — fixed sides and QBO's own open amount", async () => {
    const { client } = fakeClient();
    const links = await resolveLinks(client, NORTH, requests);

    const bill = find(links, "Bill", "103");
    assert.equal(bill.side, "charge");
    assert.equal(bill.openCents, 10000);
    assert.equal(bill.applyCents, 10000);

    const vc401 = find(links, "VendorCredit", "401");
    assert.equal(vc401.side, "credit");
    assert.equal(vc401.openCents, 5000);

    const vc402 = find(links, "VendorCredit", "402");
    assert.equal(vc402.side, "credit");
    assert.equal(vc402.openCents, 4000);
  });

  it("links-tracked-bill-and-credit — findBillPayments is never called", async () => {
    const fake = fakeClient();
    await resolveLinks(fake.client, NORTH, requests);
    assert.equal(fake.callsTo("findBillPayments"), 0);
  });

  it("links-tracked-bill-and-credit — the account cache is not read for tracked kinds alone", async () => {
    const fake = fakeClient();
    await resolveLinks(fake.client, NORTH, requests);
    assert.equal(fake.callsTo("findAccounts"), 0);
  });

  it("links-tracked-bill-and-credit — carries the doc number and date through", async () => {
    const { client } = fakeClient();
    const links = await resolveLinks(client, NORTH, requests);
    const bill = find(links, "Bill", "103");
    assert.equal(bill.doc, "B-3");
    assert.equal(bill.date, "2026-07-02");
  });
});

describe("bill-payment links — resolveLinks on JournalEntry", () => {
  it("links-je-nets-vendor-ap-lines — nets only the vendor's A/P lines", async () => {
    const { client } = fakeClient();
    const [je] = await resolveLinks(client, NORTH, [{ type: "JournalEntry", id: "300" }]);
    assert.equal(je.type, "JournalEntry");
    assert.equal(je.id, "300");
    assert.equal(je.side, "credit");
    assert.equal(je.openCents, 30000);
    assert.equal(je.applyCents, 30000);
  });

  it("links-je-net-credit-is-charge — an A/P Credit for the vendor is a charge", async () => {
    const { client } = fakeClient();
    const [je] = await resolveLinks(client, NORTH, [{ type: "JournalEntry", id: "301" }]);
    assert.equal(je.side, "charge");
    assert.equal(je.openCents, 10000);
  });

  it("links-non-vendor-entity-ignored — a Customer entity sharing the vendor's id does not count", async () => {
    const { client } = fakeClient();
    const message = await rejectionOf(() =>
      resolveLinks(client, NORTH, [{ type: "JournalEntry", id: "306" }]),
    );
    assert.equal(message, 'Journal entry 306 (#JE-6) posts nothing to Accounts Payable for "North Produce"');
  });

  it("counts a vendor A/P line whose entity carries no Type", async () => {
    const { client } = fakeClient({
      records: {
        JournalEntry: {
          "307": {
            Id: "307", DocNumber: "JE-7", TxnDate: "2026-07-18",
            Line: [
              { Id: "0", Amount: 20, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "20" }, Entity: { EntityRef: NORTH } } },
              { Id: "1", Amount: 20, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "13" } } },
            ],
          },
        },
      },
    });
    const [je] = await resolveLinks(client, NORTH, [{ type: "JournalEntry", id: "307" }]);
    assert.equal(je.side, "credit");
    assert.equal(je.openCents, 2000);
  });

  it("derives the side from the transaction even when the request carries a side", async () => {
    const { client } = fakeClient();
    const [je] = await resolveLinks(client, NORTH, [
      { type: "JournalEntry", id: "300", side: "charge" } as LinkRequest,
    ]);
    assert.equal(je.side, "credit");
  });
});

describe("bill-payment links — the applied scan", () => {
  it("links-open-net-of-prior-payments — JournalEntry open is net of prior bill payment lines", async () => {
    const { client } = fakeClient();
    const links = await resolveLinks(client, NORTH, [
      { type: "JournalEntry", id: "303" },
      { type: "Deposit", id: "500" },
    ]);
    const je = find(links, "JournalEntry", "303");
    assert.equal(je.side, "credit");
    // 400.00 − 150.00 applied; the 40.00 line links Deposit 303, not this entry.
    assert.equal(je.openCents, 25000);
    assert.equal(je.applyCents, 25000);
    assert.equal(find(links, "Deposit", "500").openCents, 6000);
  });

  it("links-open-net-of-prior-payments — findBillPayments runs once, filtered on the vendor", async () => {
    const fake = fakeClient();
    await resolveLinks(fake.client, NORTH, [
      { type: "JournalEntry", id: "303" },
      { type: "Deposit", id: "500" },
    ]);
    assert.equal(fake.callsTo("findBillPayments"), 1);
    assert.match(fake.billPaymentQueries[0], /VendorRef = '5'/);
  });

  it("links-open-net-of-prior-payments — appliedByLinkedTxn keys applied cents by type and id", async () => {
    const { client } = fakeClient();
    const applied = await appliedByLinkedTxn(client, "5");
    assert.equal(applied.get("JournalEntry:303"), 15000);
    assert.equal(applied.get("Deposit:303"), 4000);
    assert.equal(applied.get("Bill:103"), 2500);
    assert.equal(applied.get("JournalEntry:305"), 10000);
    assert.equal(applied.get("Deposit:500"), undefined);
  });

  it("links-applied-scan-incomplete-rejected — a truncated scan is an error, never a partial total", async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      Id: String(10000 + i),
      VendorRef: NORTH,
      Line: [{ Amount: 1, LinkedTxn: [{ TxnId: "101", TxnType: "Bill" }] }],
    }));
    const { client } = fakeClient({ findBillPayments: () => fullPage });

    let links: ResolvedLink[] | undefined;
    const message = await rejectionOf(async () => {
      links = await resolveLinks(client, NORTH, [{ type: "JournalEntry", id: "303" }]);
    });
    assert.match(message, /North Produce/);
    assert.match(message, /could not be totalled/);
    assert.equal(links, undefined);
  });

  it("links-applied-scan-incomplete-rejected — the scan pages up to SAFETY_LIMIT before giving up", async () => {
    const fullPage = Array.from({ length: BATCH_SIZE }, (_, i) => ({
      Id: String(10000 + i),
      VendorRef: NORTH,
      Line: [{ Amount: 1, LinkedTxn: [{ TxnId: "101", TxnType: "Bill" }] }],
    }));
    const fake = fakeClient({ findBillPayments: () => fullPage });
    await rejectionOf(() => resolveLinks(fake.client, NORTH, [{ type: "JournalEntry", id: "303" }]));
    assert.equal(fake.callsTo("findBillPayments"), SAFETY_LIMIT / BATCH_SIZE);
  });
});

describe("bill-payment links — resolveLinks on Deposit and Purchase", () => {
  it("links-deposit-ap-line-is-charge — a vendor's A/P deposit line is a charge, type compared case-insensitively", async () => {
    const { client } = fakeClient();
    const [deposit] = await resolveLinks(client, NORTH, [{ type: "Deposit", id: "500" }]);
    assert.equal(deposit.side, "charge");
    assert.equal(deposit.openCents, 6000);
    assert.equal(deposit.applyCents, 6000);
  });

  it("links-purchase-side-follows-credit-flag — Credit false is a credit side, Credit true a charge", async () => {
    const { client } = fakeClient();
    const links = await resolveLinks(client, NORTH, [
      { type: "Purchase", id: "700" },
      { type: "Purchase", id: "701" },
    ]);
    const p700 = find(links, "Purchase", "700");
    assert.equal(p700.side, "credit");
    assert.equal(p700.openCents, 8000);
    const p701 = find(links, "Purchase", "701");
    assert.equal(p701.side, "charge");
    assert.equal(p701.openCents, 3000);
  });

  it("counts only a purchase's expense lines on A/P", async () => {
    const { client } = fakeClient({
      records: {
        Purchase: {
          "704": {
            Id: "704", DocNumber: "P-5", TxnDate: "2026-07-19", PaymentType: "CreditCard", Credit: false, TotalAmt: 100,
            EntityRef: { ...NORTH, type: "Vendor" },
            Line: [
              { Id: "1", Amount: 80, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: "20" } } },
              { Id: "2", Amount: 20, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: "60" } } },
            ],
          },
        },
      },
    });
    const [purchase] = await resolveLinks(client, NORTH, [{ type: "Purchase", id: "704" }]);
    assert.equal(purchase.side, "credit");
    assert.equal(purchase.openCents, 8000);
  });

  it("ignores a deposit A/P line whose entity is a customer sharing the vendor's id", async () => {
    const { client } = fakeClient({
      records: {
        Deposit: {
          "502": {
            Id: "502", DocNumber: "D-3", TxnDate: "2026-07-19", TotalAmt: 60, DepositToAccountRef: { value: "10" },
            Line: [{
              Id: "1", Amount: 60, DetailType: "DepositLineDetail",
              DepositLineDetail: { AccountRef: { value: "20" }, Entity: { value: "5", name: "North Cafe", type: "CUSTOMER" } },
            }],
          },
        },
      },
    });
    const message = await rejectionOf(() => resolveLinks(client, NORTH, [{ type: "Deposit", id: "502" }]));
    assert.equal(message, 'Deposit 502 (#D-3) posts nothing to Accounts Payable for "North Produce"');
  });

  it("sums A/P amounts in integer cents", async () => {
    const { client } = fakeClient({
      records: {
        Purchase: {
          "703": {
            Id: "703", DocNumber: "P-4", TxnDate: "2026-07-17", PaymentType: "CreditCard", Credit: false,
            EntityRef: { ...NORTH, type: "Vendor" },
            Line: [
              { Id: "1", Amount: 0.1, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: "20" } } },
              { Id: "2", Amount: 0.2, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: "20" } } },
            ],
          },
        },
      },
    });
    const [purchase] = await resolveLinks(client, NORTH, [{ type: "Purchase", id: "703" }]);
    assert.equal(purchase.openCents, 30);
    assert.ok(Number.isInteger(purchase.applyCents));
  });
});

describe("bill-payment links — ownership", () => {
  it("links-payee-mismatch-rejected — a bill for another vendor", async () => {
    const { client } = fakeClient();
    const message = await rejectionOf(() => resolveLinks(client, NORTH, [{ type: "Bill", id: "201" }]));
    assert.equal(message, 'Bill 201 (#B-9) belongs to vendor "South Dairy", not "North Produce"');
  });

  it("links-payee-mismatch-rejected — a purchase paid to another vendor", async () => {
    const { client } = fakeClient();
    const message = await rejectionOf(() => resolveLinks(client, NORTH, [{ type: "Purchase", id: "702" }]));
    assert.equal(message, 'Purchase 702 (#P-3) belongs to vendor "South Dairy", not "North Produce"');
  });

  it("names a vendor credit for another vendor by its label", async () => {
    const { client } = fakeClient({
      records: {
        VendorCredit: {
          "403": { Id: "403", DocNumber: "VC-3", TxnDate: "2026-07-19", TotalAmt: 10, Balance: 10, VendorRef: SOUTH },
        },
      },
    });
    const message = await rejectionOf(() => resolveLinks(client, NORTH, [{ type: "VendorCredit", id: "403" }]));
    assert.equal(message, 'Vendor credit 403 (#VC-3) belongs to vendor "South Dairy", not "North Produce"');
  });

  it("links-no-ap-posting-rejected — a journal entry whose only A/P line is another vendor's", async () => {
    const { client } = fakeClient();
    const message = await rejectionOf(() => resolveLinks(client, NORTH, [{ type: "JournalEntry", id: "302" }]));
    assert.equal(message, 'Journal entry 302 (#JE-3) posts nothing to Accounts Payable for "North Produce"');
  });

  it("links-no-ap-posting-rejected — a deposit line for the vendor on a non-A/P account", async () => {
    const { client } = fakeClient();
    const message = await rejectionOf(() => resolveLinks(client, NORTH, [{ type: "Deposit", id: "501" }]));
    assert.equal(message, 'Deposit 501 (#D-2) posts nothing to Accounts Payable for "North Produce"');
  });
});

describe("bill-payment links — amounts against the open balance", () => {
  it("links-partial-amount-within-open — applies the explicit amount on both sides", async () => {
    const { client } = fakeClient();
    const links = await resolveLinks(client, NORTH, [
      { type: "JournalEntry", id: "300", amountCents: 15000 },
      { type: "Bill", id: "103", amountCents: 4000 },
    ]);
    const je = find(links, "JournalEntry", "300");
    assert.equal(je.openCents, 30000);
    assert.equal(je.applyCents, 15000);
    const bill = find(links, "Bill", "103");
    assert.equal(bill.openCents, 10000);
    assert.equal(bill.applyCents, 4000);
  });

  it("links-amount-above-open-rejected — a charge above its open balance", async () => {
    const { client } = fakeClient();
    const message = await rejectionOf(() =>
      resolveLinks(client, NORTH, [{ type: "Bill", id: "103", amountCents: 12000 }]),
    );
    assert.match(message, /exceeds open balance \$100\.00/);
  });

  it("links-amount-above-open-rejected — a credit above its available credit", async () => {
    const { client } = fakeClient();
    const message = await rejectionOf(() =>
      resolveLinks(client, NORTH, [{ type: "JournalEntry", id: "300", amountCents: 35000 }]),
    );
    assert.match(message, /exceeds available credit \$300\.00/);
  });

  it("links-nothing-open-rejected — a paid bill", async () => {
    const { client } = fakeClient();
    const message = await rejectionOf(() => resolveLinks(client, NORTH, [{ type: "Bill", id: "102" }]));
    assert.match(message, /has no open balance — already paid\?/);
    assert.match(message, /Bill 102 \(#B-2\)/);
  });

  it("links-nothing-open-rejected — a journal entry already fully applied", async () => {
    const { client } = fakeClient();
    const message = await rejectionOf(() => resolveLinks(client, NORTH, [{ type: "JournalEntry", id: "305" }]));
    assert.match(message, /has no remaining balance — already applied\?/);
    assert.match(message, /Journal entry 305 \(#JE-5\)/);
  });
});

describe("bill-payment links — reads", () => {
  const mixed: LinkRequest[] = [
    { type: "JournalEntry", id: "301" },
    { type: "Bill", id: "101" },
    { type: "VendorCredit", id: "401" },
    { type: "Purchase", id: "700" },
    { type: "Deposit", id: "500" },
    { type: "Bill", id: "103" },
    { type: "VendorCredit", id: "402" },
    { type: "JournalEntry", id: "300" },
    { type: "Purchase", id: "701" },
  ];

  it("resolves links in request order", async () => {
    const { client } = fakeClient({ delayMs: 2 });
    const links = await resolveLinks(client, NORTH, mixed);
    assert.deepEqual(
      links.map((l) => `${l.type} ${l.id}`),
      mixed.map((r) => `${r.type} ${r.id}`),
    );
  });

  it("fans entity reads out four at a time", async () => {
    const fake = fakeClient({ delayMs: 5 });
    await resolveLinks(fake.client, NORTH, mixed);
    assert.equal(fake.maxInFlight(), 4);
  });

  it("reads each linked transaction once, through its own getter", async () => {
    const fake = fakeClient();
    await resolveLinks(fake.client, NORTH, mixed);
    assert.equal(fake.callsTo("getJournalEntry"), 2);
    assert.equal(fake.callsTo("getBill"), 2);
    assert.equal(fake.callsTo("getVendorCredit"), 2);
    assert.equal(fake.callsTo("getPurchase"), 2);
    assert.equal(fake.callsTo("getDeposit"), 1);
    assert.equal(fake.callsTo("findBillPayments"), 1);
  });

  it("propagates a failed read without printing the raw error", async () => {
    const { client } = fakeClient();
    const printed: unknown[] = [];
    const saved = { error: console.error, log: console.log, warn: console.warn };
    console.error = console.log = console.warn = (...args: unknown[]) => { printed.push(args); };
    let message: string;
    try {
      message = await rejectionOf(() => resolveLinks(client, NORTH, [{ type: "JournalEntry", id: "999" }]));
    } finally {
      Object.assign(console, saved);
    }
    assert.match(message, /JournalEntry 999 not found/);
    assert.deepEqual(printed, []);
  });
});
