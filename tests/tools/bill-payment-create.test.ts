import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { handleCreateBillPayment } from "../../src/tools/handlers/bill-payment.js";
import { clearLookupCache } from "../../src/client/cache.js";
import { NORTH, fakeClient, rejectionOf, type FakeClient } from "./bill-payment-fixtures.js";

beforeEach(() => clearLookupCache());

type CreateArgs = Parameters<typeof handleCreateBillPayment>[1];
// No cast: a call without bills or payment_account must type-check against the
// handler's own args type.
type Request = Omit<CreateArgs, "txn_date"> & { txn_date?: string };

const CHECKING_REF = { value: "10", name: "1010 Checking" };

async function create(fake: FakeClient, args: Request): Promise<string> {
  const result = await handleCreateBillPayment(fake.client, {
    vendor_name: "North Produce",
    txn_date: "2026-07-15",
    ...args,
  });
  return result.content.map((c) => c.text).join("\n");
}

function onlySent(fake: FakeClient): Record<string, unknown> {
  assert.equal(fake.sent.length, 1, "expected exactly one createBillPayment payload");
  return fake.sent[0];
}

function linesOf(payload: Record<string, unknown>): Array<[number, string, string]> {
  return (payload.Line as Array<{ Amount: number; LinkedTxn: Array<{ TxnId: string; TxnType: string }> }>).map(
    (l) => {
      assert.equal(l.LinkedTxn.length, 1, "each line links exactly one transaction");
      return [l.Amount, l.LinkedTxn[0].TxnType, l.LinkedTxn[0].TxnId];
    },
  );
}

/** The indented lines under "Applied:", up to the first blank line. */
function appliedBlock(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf("Applied:");
  assert.ok(start >= 0, `expected an "Applied:" block in:\n${text}`);
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    block.push(line.trim());
  }
  return block;
}

const DRAFT_PREVIEW_ARGS: Request = {
  payment_account: "1010",
  bills: [{ bill_id: "101" }, { bill_id: "103", amount: 40 }],
  credits: [{ vendor_credit_id: "401" }],
};

const DRAFT_PREVIEW_LINES = [
  "Bill 101 (#B-1, 2026-07-01) — charge: open $250.00, applying $250.00, remaining $0.00",
  "Bill 103 (#B-3, 2026-07-02) — charge: open $100.00, applying $40.00, remaining $60.00",
  "VendorCredit 401 (#VC-1, 2026-07-04) — credit: open $50.00, applying $50.00, remaining $0.00",
];

describe("create_bill_payment — payload", () => {
  it("create-legacy-payload-unchanged — a bills + credits call sends the same payload as before linked_txns", async () => {
    const fake = fakeClient();
    await create(fake, {
      payment_account: "1010",
      bills: [{ bill_id: "101" }, { bill_id: "103" }],
      credits: [{ vendor_credit_id: "401" }],
      draft: false,
    });
    assert.deepEqual(onlySent(fake), {
      VendorRef: { value: NORTH.value, name: NORTH.name },
      PayType: "Check",
      CheckPayment: { BankAccountRef: CHECKING_REF },
      TxnDate: "2026-07-15",
      TotalAmt: 300,
      Line: [
        { Amount: 250, LinkedTxn: [{ TxnId: "101", TxnType: "Bill" }] },
        { Amount: 100, LinkedTxn: [{ TxnId: "103", TxnType: "Bill" }] },
        { Amount: 50, LinkedTxn: [{ TxnId: "401", TxnType: "VendorCredit" }] },
      ],
    });
  });

  it("create-every-type-payload — nets charges against credits across every type, lines in request order", async () => {
    const fake = fakeClient();
    await create(fake, {
      payment_account: "1010",
      bills: [{ bill_id: "101" }],
      linked_txns: [
        { txn_type: "Deposit", txn_id: "500" },
        { txn_type: "Purchase", txn_id: "701" },
        { txn_type: "JournalEntry", txn_id: "300", amount: 100 },
        { txn_type: "Purchase", txn_id: "700" },
      ],
      draft: false,
    });
    const payload = onlySent(fake);
    // 250 + 60 + 30 charges − (100 + 80) credits.
    assert.equal(payload.TotalAmt, 160);
    assert.deepEqual(linesOf(payload), [
      [250, "Bill", "101"],
      [60, "Deposit", "500"],
      [30, "Purchase", "701"],
      [100, "JournalEntry", "300"],
      [80, "Purchase", "700"],
    ]);
    for (const [amount] of linesOf(payload)) assert.ok(amount > 0, "every line Amount is positive");
  });

  it("create-every-type-payload — the same request as a draft sends nothing", async () => {
    const fake = fakeClient();
    await create(fake, {
      payment_account: "1010",
      bills: [{ bill_id: "101" }],
      linked_txns: [
        { txn_type: "Deposit", txn_id: "500" },
        { txn_type: "Purchase", txn_id: "701" },
        { txn_type: "JournalEntry", txn_id: "300", amount: 100 },
        { txn_type: "Purchase", txn_id: "700" },
      ],
    });
    assert.equal(fake.callsTo("createBillPayment"), 0);
  });
});

describe("create_bill_payment — partial credit and the $0 application", () => {
  const args: Request = {
    bills: [{ bill_id: "101" }],
    linked_txns: [{ txn_type: "JournalEntry", txn_id: "300", amount: 250 }],
  };

  it("create-partial-je-credit-zero-total — the draft shows the partly applied credit and no bank account", async () => {
    const fake = fakeClient();
    const text = await create(fake, args);
    assert.ok(
      text.includes("JournalEntry 300 (#JE-1, 2026-07-03) — credit: open $300.00, applying $250.00, remaining $50.00"),
      text,
    );
    assert.ok(text.includes("Bank Account: (none — $0 application)"), text);
    assert.ok(text.includes("Payment total: $0.00"), text);
    assert.equal(fake.callsTo("createBillPayment"), 0);
  });

  it("create-partial-je-credit-zero-total — the committed payload is $0 with a PrintStatus-only CheckPayment", async () => {
    const fake = fakeClient();
    await create(fake, { ...args, draft: false });
    const payload = onlySent(fake);
    assert.equal(payload.TotalAmt, 0);
    assert.deepEqual(payload.CheckPayment, { PrintStatus: "NotSet" });
    assert.ok(!("BankAccountRef" in (payload.CheckPayment as object)));
    assert.deepEqual(linesOf(payload), [
      [250, "Bill", "101"],
      [250, "JournalEntry", "300"],
    ]);
  });

  it("create-zero-total-keeps-given-account — a given payment_account is sent even when the total is $0", async () => {
    const fake = fakeClient();
    await create(fake, { ...args, payment_account: "1010", draft: false });
    const payload = onlySent(fake);
    assert.equal(payload.TotalAmt, 0);
    assert.deepEqual(payload.CheckPayment, { BankAccountRef: CHECKING_REF });
  });
});

describe("create_bill_payment — credits that exceed charges are rejected, never capped", () => {
  it("create-excess-credit-names-amount — names the amount to set on the last large-enough credit", async () => {
    const fake = fakeClient();
    const message = await rejectionOf(() =>
      create(fake, {
        payment_account: "1010",
        bills: [{ bill_id: "101" }],
        linked_txns: [{ txn_type: "JournalEntry", txn_id: "300" }],
        draft: false,
      }),
    );
    assert.ok(message.includes("Credits ($300.00) exceed charges ($250.00) by $50.00"), message);
    assert.ok(message.includes("set amount: 250.00 on Journal entry 300 (#JE-1)"), message);
    assert.equal(fake.callsTo("createBillPayment"), 0);
  });

  it("create-excess-credit-names-removal — names the credit to remove when it equals the excess", async () => {
    const fake = fakeClient();
    const message = await rejectionOf(() =>
      create(fake, {
        payment_account: "1010",
        bills: [{ bill_id: "103" }],
        linked_txns: [
          { txn_type: "JournalEntry", txn_id: "300", amount: 100 },
          { txn_type: "VendorCredit", txn_id: "401" },
        ],
        draft: false,
      }),
    );
    assert.ok(message.includes("remove Vendor credit 401 (#VC-1)"), message);
    assert.equal(fake.callsTo("createBillPayment"), 0);
  });

  it("create-excess-credit-reduce-total — asks for a total reduction when no single credit covers the excess", async () => {
    const fake = fakeClient();
    const message = await rejectionOf(() =>
      create(fake, {
        payment_account: "1010",
        bills: [{ bill_id: "103", amount: 10 }],
        credits: [{ vendor_credit_id: "401" }],
        linked_txns: [{ txn_type: "Purchase", txn_id: "700" }],
        draft: false,
      }),
    );
    assert.ok(message.includes("Reduce the credit amounts by $120.00 in total"), message);
    assert.equal(fake.callsTo("createBillPayment"), 0);
  });
});

describe("create_bill_payment — other rejections", () => {
  it("create-nothing-to-pay-rejected — credits alone are rejected", async () => {
    const fake = fakeClient();
    const message = await rejectionOf(() =>
      create(fake, { payment_account: "1010", credits: [{ vendor_credit_id: "401" }], draft: false }),
    );
    assert.ok(message.startsWith("Nothing to pay"), message);
    assert.equal(fake.callsTo("createBillPayment"), 0);
  });

  it("create-account-required-above-zero — payment_account may be omitted only for a $0 application", async () => {
    const fake = fakeClient();
    const message = await rejectionOf(() => create(fake, { bills: [{ bill_id: "101" }] }));
    assert.ok(message.includes("payment_account is required: the payment total is $250.00"), message);
    assert.equal(fake.callsTo("createBillPayment"), 0);
  });

  it("create-account-required-above-zero — committing without an account is rejected too", async () => {
    const fake = fakeClient();
    const message = await rejectionOf(() => create(fake, { bills: [{ bill_id: "101" }], draft: false }));
    assert.ok(message.includes("payment_account is required: the payment total is $250.00"), message);
    assert.equal(fake.callsTo("createBillPayment"), 0);
  });

  it("create-account-bank-only — payment_account resolves Bank-type accounts only", async () => {
    const fake = fakeClient();
    const message = await rejectionOf(() =>
      create(fake, { payment_account: "2000", bills: [{ bill_id: "101" }], draft: false }),
    );
    assert.ok(message.includes("No Bank-type account matches"), message);
    assert.equal(fake.callsTo("createBillPayment"), 0);
  });
});

describe("create_bill_payment — preview and result text", () => {
  it("create-draft-preview-lines — the draft lists each applied line with its open, applied and remaining amounts", async () => {
    const fake = fakeClient();
    const text = await create(fake, DRAFT_PREVIEW_ARGS);
    assert.ok(text.includes("Bank Account: 1010 Checking"), text);
    assert.deepEqual(appliedBlock(text), DRAFT_PREVIEW_LINES);
    assert.ok(text.includes("Charges: $290.00"), text);
    assert.ok(text.includes("Credits: $50.00"), text);
    assert.ok(text.includes("Payment total: $240.00"), text);
    assert.equal(fake.callsTo("createBillPayment"), 0);
  });

  it("create-result-lists-applied — the created result lists the same applied lines and ends with the QBO link", async () => {
    const fake = fakeClient();
    const text = await create(fake, { ...DRAFT_PREVIEW_ARGS, draft: false });
    assert.ok(text.startsWith("Bill Payment Created!"), text);
    for (const line of DRAFT_PREVIEW_LINES) assert.ok(text.includes(line), `missing "${line}" in:\n${text}`);
    assert.ok(text.includes("Payment total: $240.00"), text);
    assert.match(text, /View in QuickBooks: \S+$/);
    assert.equal(onlySent(fake).TotalAmt, 240);
  });

  it("create-result-lists-applied — the preview and the result render the Applied block identically", async () => {
    const draft = await create(fakeClient(), DRAFT_PREVIEW_ARGS);
    clearLookupCache();
    const created = await create(fakeClient(), { ...DRAFT_PREVIEW_ARGS, draft: false });
    assert.deepEqual(appliedBlock(created), appliedBlock(draft));
  });
});
