// convert_expense_to_bill_payment: planning, the draft preview and the commit
// sequence. Invented fixtures only; nothing here calls QuickBooks. A draft or a
// refusal never writes; a commit writes create → move attachments → delete →
// set ref no., and stops at the first failure without undoing anything.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { handleConvertExpenseToBillPayment } from "../../src/tools/handlers/convert-expense.js";
import { clearLookupCache } from "../../src/client/cache.js";
import { buildQboUrl } from "../../src/utils/urls.js";
import { rejectionOf, NORTH, type FakeClient } from "./bill-payment-fixtures.js";
import {
  ATTACHMENT_FILE,
  ATTACHMENT_NOTE,
  qboFault,
  PRODUCE_CLASS,
  accountLine,
  convertClient,
  expenseWith,
  type BaseExpenseId,
  type ConvertClientOptions,
} from "./convert-expense-fixtures.js";

beforeEach(() => clearLookupCache());

type Args = Parameters<typeof handleConvertExpenseToBillPayment>[1];
type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };

const WRITES = ["createBillPayment", "updateAttachable", "deletePurchase", "updateBillPayment"];
const HEADER = "Expense 760 cannot be converted to a bill payment:";

function assertNoWrites(fake: FakeClient): void {
  for (const write of WRITES) assert.equal(fake.callsTo(write), 0, `${write} must not be called`);
}

const textOf = (result: Result): string => result.content.map((c) => c.text).join("\n");

/** Run the handler in draft (draft omitted) on `fake` and return the preview text. */
async function previewOf(fake: FakeClient, args: Args): Promise<string> {
  const result = (await handleConvertExpenseToBillPayment(fake.client, args)) as Result;
  assert.equal(result.isError, undefined, textOf(result));
  assertNoWrites(fake);
  return textOf(result);
}

/** The trimmed lines under a header line, up to the first blank line. */
function blockAfter(text: string, header: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(header);
  assert.ok(start >= 0, `expected "${header}" in:\n${text}`);
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    block.push(line.trim());
  }
  return block;
}

const hasLine = (text: string, line: string): boolean => text.split("\n").includes(line);

/** A client whose expense 760 is `base` with `overrides`. */
const clientFor760 = (base: BaseExpenseId, overrides: Record<string, unknown>, options: ConvertClientOptions = {}) =>
  convertClient({ ...options, expenses: { "760": expenseWith(base, overrides) } });

/**
 * Every refusal holds in draft (draft omitted) and in commit (draft false), each
 * on its own fresh fake. Returns both rejection messages; asserts no write call.
 */
async function refusals(
  makeClient: () => FakeClient,
  args: Args,
  inspect?: (fake: FakeClient) => void,
): Promise<string[]> {
  const messages: string[] = [];
  for (const draft of [undefined, false]) {
    clearLookupCache();
    const fake = makeClient();
    messages.push(await rejectionOf(() => handleConvertExpenseToBillPayment(fake.client, { ...args, draft })));
    assertNoWrites(fake);
    inspect?.(fake);
  }
  return messages;
}

/** Refused in draft and in commit with a message containing every fragment. */
async function assertRefused(
  makeClient: () => FakeClient,
  args: Args,
  fragments: string[],
  inspect?: (fake: FakeClient) => void,
): Promise<string[]> {
  const messages = await refusals(makeClient, args, inspect);
  for (const message of messages) {
    for (const fragment of fragments) assert.ok(message.includes(fragment), `expected "${fragment}" in:\n${message}`);
  }
  return messages;
}

const BILL_110: Args["bills"] = [{ bill_id: "110" }];
const BILL_111: Args["bills"] = [{ bill_id: "111" }];

describe("convert_expense_to_bill_payment — draft preview", () => {
  it("convert-draft-check-preview — a Check expense previews the delete, the bill payment and every step", async () => {
    const fake = convertClient({ attachments: [ATTACHMENT_FILE] });
    const text = await previewOf(fake, { expense_id: "750", bills: BILL_110 });
    const lines = text.trimEnd().split("\n");

    assert.equal(lines[0], "DRAFT - Convert Expense to Bill Payment (Check)");
    assert.deepEqual(blockAfter(text, "Expense to replace (will be DELETED):"), [
      "Expense 750 — North Produce, Check, 2026-07-15, Ref no. 1042, $250.00",
      "Payment account: 1010 Checking",
      'Line: 2000 Accounts Payable $250.00 "July produce"',
    ]);
    assert.deepEqual(blockAfter(text, "Bill payment to create:"), [
      "Vendor: North Produce",
      "Pay type: Check (from expense payment type Check)",
      "Bank Account: 1010 Checking",
      "Date: 2026-07-15",
      "Ref no.: 1042 (set after the expense is deleted)",
      "Memo: Paid by check — July produce",
      "Location: North",
      "Print status: NotSet",
    ]);
    assert.deepEqual(blockAfter(text, "Applied:"), [
      "Bill 110 (#B-10, 2026-07-01) — charge: open $250.00, applying $250.00, remaining $0.00",
      "Payment total: $250.00 (equals the expense total)",
    ]);
    assert.deepEqual(blockAfter(text, "Attachments moved to the bill payment: 1"), [
      "Attachment 9001: invoice.pdf (application/pdf, 1000 B)",
    ]);
    assert.deepEqual(blockAfter(text, "Not carried over:"), [
      "Line class: Produce",
      "The bill payment gets a new transaction id and create time.",
    ]);
    assert.ok(
      hasLine(
        text,
        "Steps on draft=false: create bill payment → verify it → move attachments → delete expense 750 → set ref no.",
      ),
    );
    assert.ok(text.includes("counted twice"));
    assert.equal(lines.at(-1), "Set draft=false to convert this expense.");
  });

  it("convert-draft-cash-preview — a Cash expense becomes a Check payment, and absent fields read (none)", async () => {
    const fake = convertClient();
    const text = await previewOf(fake, { expense_id: "751", bills: BILL_111 });

    assert.deepEqual(blockAfter(text, "Bill payment to create:"), [
      "Vendor: North Produce",
      "Pay type: Check (from expense payment type Cash)",
      "Bank Account: 1010 Checking",
      "Date: 2026-07-16",
      "Ref no.: (none)",
      "Memo: (none)",
      "Location: (none)",
    ]);
    assert.ok(hasLine(text, "Attachments moved to the bill payment: none"));
    assert.ok(hasLine(text, "Steps on draft=false: create bill payment → verify it → delete expense 751"));
  });

  it("convert-draft-card-preview — a CreditCard expense previews as a Credit Card payment on a Card Account", async () => {
    const fake = convertClient();
    const text = await previewOf(fake, { expense_id: "752", bills: BILL_111 });

    assert.equal(text.split("\n")[0], "DRAFT - Convert Expense to Bill Payment (Credit Card)");
    assert.deepEqual(blockAfter(text, "Bill payment to create:"), [
      "Vendor: North Produce",
      "Pay type: Credit Card (from expense payment type CreditCard)",
      "Card Account: 2100 Company Card",
      "Date: 2026-07-17",
      "Ref no.: C-7 (set after the expense is deleted)",
      "Memo: Card payment",
      "Location: (none)",
    ]);
  });

  it("convert-draft-partial-bill — a partial amount shows what remains open on the bill", async () => {
    const fake = convertClient();
    const text = await previewOf(fake, { expense_id: "751", bills: [{ bill_id: "110", amount: 100 }] });

    assert.deepEqual(blockAfter(text, "Applied:"), [
      "Bill 110 (#B-10, 2026-07-01) — charge: open $250.00, applying $100.00, remaining $150.00",
      "Payment total: $100.00 (equals the expense total)",
    ]);
  });

  it("print status follows the payload — shown for a Cash expense that has one, never for a card", async () => {
    const cash = await previewOf(clientFor760("751", { PrintStatus: "NeedToPrint" }), {
      expense_id: "760",
      bills: BILL_111,
    });
    assert.ok(blockAfter(cash, "Bill payment to create:").includes("Print status: NeedToPrint"));

    clearLookupCache();
    const card = await previewOf(clientFor760("752", { PrintStatus: "NeedToPrint" }), {
      expense_id: "760",
      bills: BILL_111,
    });
    assert.ok(!card.includes("Print status"), card);
  });

  it("the steps line lists the move step for an attachment even without a ref no.", async () => {
    // Attachment 9001 is linked to Purchase 750; link it to 760 for this expense.
    const linked = { ...ATTACHMENT_FILE, AttachableRef: [{ EntityRef: { type: "Purchase", value: "760" } }] };
    const text = await previewOf(clientFor760("750", { DocNumber: undefined }, { attachments: [linked] }), {
      expense_id: "760",
      bills: BILL_110,
    });

    assert.ok(hasLine(text, "Steps on draft=false: create bill payment → verify it → move attachments → delete expense 760"), text);
    assert.ok(blockAfter(text, "Bill payment to create:").includes("Ref no.: (none)"), text);
  });
});

describe("convert_expense_to_bill_payment — memo rule", () => {
  it("convert-memo-description-only — a missing memo falls back to the line description", async () => {
    const text = await previewOf(clientFor760("750", { PrivateNote: undefined }), { expense_id: "760", bills: BILL_110 });
    assert.ok(hasLine(text, "Memo: July produce"), text);
  });

  it("convert-memo-same-not-repeated — a memo equal to the description is not repeated", async () => {
    const text = await previewOf(clientFor760("750", { PrivateNote: "July produce" }), { expense_id: "760", bills: BILL_110 });
    assert.ok(hasLine(text, "Memo: July produce"), text);
  });

  it("convert-memo-description-excluded — include_line_description false keeps only the memo and lists the description as not carried", async () => {
    const text = await previewOf(convertClient(), {
      expense_id: "750",
      bills: BILL_110,
      include_line_description: false,
    });

    assert.ok(hasLine(text, "Memo: Paid by check"), text);
    assert.deepEqual(blockAfter(text, "Not carried over:"), [
      "Line description: July produce",
      "Line class: Produce",
      "The bill payment gets a new transaction id and create time.",
    ]);
  });

  it("the memo rule is applied to the trimmed memo and description", async () => {
    const text = await previewOf(
      clientFor760("750", {
        PrivateNote: "  Paid by check  ",
        Line: [accountLine(250, { description: " July produce ", detail: { ClassRef: PRODUCE_CLASS } })],
      }),
      { expense_id: "760", bills: BILL_110 },
    );
    assert.ok(hasLine(text, "Memo: Paid by check — July produce"), text);
  });

  it("convert-memo-too-long-refused — a memo over 4,000 characters is refused, never truncated", async () => {
    const make = () =>
      clientFor760("750", {
        PrivateNote: "x".repeat(3990),
        Line: [accountLine(250, { description: "y".repeat(20) })],
      });

    // 3990 + " — " (3) + 20 = 4013, in draft and in commit.
    await assertRefused(make, { expense_id: "760", bills: BILL_110 }, [
      "would be 4013 characters",
      "4,000",
      "include_line_description: false",
    ]);

    clearLookupCache();
    const text = await previewOf(make(), { expense_id: "760", bills: BILL_110, include_line_description: false });
    assert.equal(text.split("\n")[0], "DRAFT - Convert Expense to Bill Payment (Check)");
  });
});

describe("convert_expense_to_bill_payment — not carried over", () => {
  it("convert-not-carried-lists-fields — class, customer, custom fields, the remit-to address and the payment method are listed with their values", async () => {
    // The customer and billable status sit on the line detail; custom fields and
    // the remit-to address sit on the expense header, as QuickBooks stores them.
    const text = await previewOf(
      clientFor760("750", {
        Line: [
          accountLine(250, {
            description: "July produce",
            detail: {
              ClassRef: PRODUCE_CLASS,
              CustomerRef: { value: "8", name: "North Cafe" },
              BillableStatus: "NotBillable",
            },
          }),
        ],
        CustomField: [
          { Name: "Crew", StringValue: "A" },
          { Name: "Empty", StringValue: "" },
        ],
        RemitToAddr: { Line1: "1 Main St", City: "Northville", CountrySubDivisionCode: "CA", PostalCode: "90000" },
        PaymentMethodRef: { value: "2", name: "Check" },
      }),
      { expense_id: "760", bills: BILL_110 },
    );

    assert.deepEqual(blockAfter(text, "Not carried over:"), [
      "Line class: Produce",
      "Line customer: North Cafe (NotBillable)",
      "Custom field Crew: A",
      "Remit-to address: 1 Main St, Northville, CA, 90000",
      "Payment method: Check",
      "The bill payment gets a new transaction id and create time.",
    ]);
  });
});

describe("convert_expense_to_bill_payment — expense refusals", () => {
  it("convert-refuse-payment-type — a payment type other than Check, Cash or CreditCard is refused", async () => {
    const messages = await assertRefused(
      () => clientFor760("750", { PaymentType: "Electronic" }),
      { expense_id: "760", bills: BILL_110 },
      ['payment type "Electronic" is not Check, Cash or CreditCard'],
    );
    for (const message of messages) assert.equal(message.split("\n")[0], HEADER);
  });

  it("convert-refuse-credit — a card credit (refund) is refused", async () => {
    await assertRefused(
      () => clientFor760("752", { Credit: true }),
      { expense_id: "760", bills: BILL_111 },
      ["it is a credit card credit (refund), not a payment"],
    );
  });

  it("convert-refuse-payee — an expense with no payee is refused without scanning bill payments", async () => {
    await assertRefused(
      () => clientFor760("750", { EntityRef: undefined }),
      { expense_id: "760", bills: BILL_110 },
      ["it has no payee — a bill payment needs a vendor"],
      (fake) => assert.equal(fake.callsTo("findBillPayments"), 0),
    );
  });

  it("convert-refuse-payee — a payee that is a Customer is refused without scanning bill payments", async () => {
    await assertRefused(
      () => clientFor760("750", { EntityRef: { value: "8", name: "North Cafe", type: "Customer" } }),
      { expense_id: "760", bills: BILL_110 },
      ['its payee "North Cafe" is a Customer, not a vendor'],
      (fake) => assert.equal(fake.callsTo("findBillPayments"), 0),
    );
  });

  it("convert-refuse-line-shape — an expense with two lines is refused", async () => {
    await assertRefused(
      () => clientFor760("750", { Line: [accountLine(125), { ...accountLine(125), Id: "2" }] }),
      { expense_id: "760", bills: BILL_110 },
      ["it has 2 lines — only a single-line expense can be converted"],
    );
  });

  it("convert-refuse-line-shape — an item-based line is refused", async () => {
    const itemLine = {
      Id: "1",
      Amount: 250,
      DetailType: "ItemBasedExpenseLineDetail",
      ItemBasedExpenseLineDetail: { ItemRef: { value: "7", name: "Widget" }, Qty: 1, UnitPrice: 250 },
    };
    await assertRefused(
      () => clientFor760("750", { Line: [itemLine] }),
      { expense_id: "760", bills: BILL_110 },
      ["its line posts to an item, not an account"],
    );
  });

  it("convert-refuse-line-not-ap — a line on a non-Accounts-Payable account is refused", async () => {
    await assertRefused(
      () =>
        clientFor760("750", {
          Line: [accountLine(250, { account: { value: "60", name: "6000 Office Supplies" } })],
        }),
      { expense_id: "760", bills: BILL_110 },
      ["its line posts to 6000 Office Supplies (Expense), not an Accounts Payable account"],
    );
  });

  it("convert-refuse-total-mismatch — a total that differs from the line amount is refused", async () => {
    await assertRefused(
      () => clientFor760("750", { TotalAmt: 260 }),
      { expense_id: "760", bills: BILL_110 },
      ["its total $260.00 does not equal its line amount $250.00"],
    );
  });

  it("convert-refuse-payment-account-type — a Check paid from a card account is refused", async () => {
    await assertRefused(
      () => clientFor760("750", { AccountRef: { value: "30" } }),
      { expense_id: "760", bills: BILL_110 },
      ["its payment account 2100 Company Card is a Credit Card account; a Check expense converts only from a Bank account"],
    );
  });

  it("convert-refuse-payment-account-type — a CreditCard expense paid from a bank account is refused", async () => {
    await assertRefused(
      () => clientFor760("752", { AccountRef: { value: "10" } }),
      { expense_id: "760", bills: BILL_111 },
      ["its payment account 1010 Checking is a Bank account; a CreditCard expense converts only from a Credit Card account"],
    );
  });

  it("an account id missing from the cache is named as not found", async () => {
    const messages = await refusals(
      () => clientFor760("750", { AccountRef: { value: "99" } }),
      { expense_id: "760", bills: BILL_110 },
    );
    for (const message of messages) assert.match(message, /account 99 \(not found\)/);
  });

  it("convert-refuse-currency — a foreign-currency expense is refused", async () => {
    await assertRefused(
      () => clientFor760("750", { CurrencyRef: { value: "EUR" } }),
      { expense_id: "760", bills: BILL_110 },
      ["its currency EUR is not the home currency USD"],
    );
  });

  it("the currency check compares only when both currencies are present", async () => {
    const noExpenseCurrency = await previewOf(clientFor760("750", { CurrencyRef: undefined }), {
      expense_id: "760",
      bills: BILL_110,
    });
    assert.ok(noExpenseCurrency.startsWith("DRAFT"));

    clearLookupCache();
    const noHomeCurrency = await previewOf(
      clientFor760("750", { CurrencyRef: { value: "EUR" } }, { preferences: {} }),
      { expense_id: "760", bills: BILL_110 },
    );
    assert.ok(noHomeCurrency.startsWith("DRAFT"));
  });

  it("convert-refuse-closed-period — an expense on or before the closing date is refused; one after it previews", async () => {
    const closedOn = (BookCloseDate: string) => () =>
      convertClient({ preferences: { AccountingInfoPrefs: { BookCloseDate }, CurrencyPrefs: { HomeCurrency: { value: "USD" } } } });
    const args: Args = { expense_id: "750", bills: BILL_110 };

    await assertRefused(closedOn("2026-07-31"), args, ["it is dated 2026-07-15, on or before the closing date 2026-07-31"]);
    await assertRefused(closedOn("2026-07-15"), args, ["it is dated 2026-07-15, on or before the closing date 2026-07-15"]);

    clearLookupCache();
    const text = await previewOf(closedOn("2026-06-30")(), args);
    assert.equal(text.split("\n")[0], "DRAFT - Convert Expense to Bill Payment (Check)");
  });

  it("convert-refuse-already-applied — an expense a bill payment already applies is refused", async () => {
    const applied = () => [
      {
        Id: "800", TxnDate: "2026-07-20", VendorRef: NORTH, PayType: "Check",
        Line: [{ Amount: 250, LinkedTxn: [{ TxnId: "750", TxnType: "Purchase" }] }],
      },
    ];
    await assertRefused(
      () => convertClient({ findBillPayments: (criteria) => (/STARTPOSITION\s+(\d+)/i.exec(criteria)?.[1] ?? "1") === "1" ? applied() : [] }),
      { expense_id: "750", bills: BILL_110 },
      ["a bill payment already applies $250.00 of it — deleting it would change that payment"],
    );
  });

  it("convert-refuse-collects-all — every failing check is listed, in order, and no bill is read", async () => {
    const messages = await assertRefused(
      () => clientFor760("752", { Credit: true, CurrencyRef: { value: "EUR" } }),
      { expense_id: "760", bills: BILL_111 },
      ["it is a credit card credit (refund), not a payment", "its currency EUR is not the home currency USD"],
      (fake) => assert.equal(fake.callsTo("getBill"), 0),
    );
    for (const message of messages) {
      assert.equal(message.split("\n")[0], HEADER);
      assert.ok(
        message.indexOf("it is a credit card credit (refund), not a payment") <
          message.indexOf("its currency EUR is not the home currency USD"),
        message,
      );
    }
  });

  it("convert-refuse-not-found — a 610 fault on the expense says it may already be converted or deleted", async () => {
    const fault = { Fault: { type: "ValidationFault", Error: [{ code: "610", Message: "Object Not Found" }] } };
    const messages = await refusals(
      () => convertClient({ fail: { getPurchase: { error: fault, id: "999" } } }),
      { expense_id: "999", bills: BILL_110 },
    );
    for (const message of messages) {
      assert.ok(
        message.startsWith("Expense 999 was not found — it may already have been converted or deleted."),
        message,
      );
    }
  });

  it("any other failure reading the expense propagates unchanged", async () => {
    const messages = await refusals(
      () => convertClient({ fail: { getPurchase: { error: new Error("read refused"), id: "750" } } }),
      { expense_id: "750", bills: BILL_110 },
    );
    for (const message of messages) assert.equal(message, "read refused");
  });
});

describe("convert_expense_to_bill_payment — bill refusals", () => {
  it("convert-refuse-bill-other-vendor — a bill that belongs to another vendor is refused", async () => {
    await assertRefused(
      () => convertClient(),
      { expense_id: "750", bills: [{ bill_id: "201" }] },
      ['belongs to vendor "South Dairy", not "North Produce"'],
    );
  });

  it("convert-refuse-bill-other-ap — a bill on a different Accounts Payable account is refused", async () => {
    await assertRefused(
      () => convertClient(),
      { expense_id: "750", bills: [{ bill_id: "112" }] },
      ["Bill 112 (#B-12) is on 2010 Accounts Payable Other, but the expense line posts to 2000 Accounts Payable"],
    );
  });

  it("convert-refuse-bill-other-ap — a bill that names no Accounts Payable account is refused", async () => {
    await assertRefused(
      () => convertClient(),
      { expense_id: "750", bills: [{ bill_id: "113" }] },
      [
        "Bill 113 (#B-13) does not name its Accounts Payable account, so it cannot be matched to the expense line's 2000 Accounts Payable",
      ],
    );
  });

  it("the per-bill Accounts Payable check runs before the total check", async () => {
    // Bill 112 is on the wrong A/P account and its $100.00 would also fall short of $250.00.
    await assertRefused(
      () => convertClient(),
      { expense_id: "750", bills: [{ bill_id: "112", amount: 100 }] },
      ["Bill 112 (#B-12) is on 2010 Accounts Payable Other, but the expense line posts to 2000 Accounts Payable"],
    );
  });

  it("convert-refuse-bill-total — bills that fall short of the expense are refused", async () => {
    await assertRefused(
      () => convertClient(),
      { expense_id: "750", bills: BILL_111 },
      ["Bills apply $100.00 but the expense is $250.00 (short by $150.00)"],
    );
  });

  it("convert-refuse-bill-total — bills that exceed the expense are refused", async () => {
    await assertRefused(
      () => convertClient(),
      { expense_id: "751", bills: BILL_110 },
      ["Bills apply $250.00 but the expense is $100.00 (over by $150.00)"],
    );
  });
});

describe("convert_expense_to_bill_payment — arguments", () => {
  it("convert-refuse-no-bills — an empty bills list is refused before any call", async () => {
    for (const draft of [undefined, false]) {
      const fake = convertClient();
      const message = await rejectionOf(() =>
        handleConvertExpenseToBillPayment(fake.client, { expense_id: "750", bills: [], draft }),
      );
      assert.equal(message, "At least one bill is required");
      assert.deepEqual(fake.calls, []);
    }
  });

  it("a bill listed twice is refused before any call", async () => {
    for (const draft of [undefined, false]) {
      const fake = convertClient();
      const message = await rejectionOf(() =>
        handleConvertExpenseToBillPayment(fake.client, {
          expense_id: "750",
          bills: [{ bill_id: "110" }, { bill_id: "110" }],
          draft,
        }),
      );
      assert.ok(message.includes("listed more than once"), message);
      assert.deepEqual(fake.calls, []);
    }
  });

  it("a non-positive or over-precise bill amount is refused before any call", async () => {
    for (const amount of [0, 10.005]) {
      const fake = convertClient();
      await rejectionOf(() =>
        handleConvertExpenseToBillPayment(fake.client, { expense_id: "750", bills: [{ bill_id: "110", amount }] }),
      );
      assert.deepEqual(fake.calls, []);
    }
  });
});

// ---------------------------------------------------------------------------
// Commit (draft: false)
// ---------------------------------------------------------------------------

const BP_URL = buildQboUrl("billpayment", "txnId", "950");
const DELETE_BILL_PAYMENT = 'delete_entity (entity_type "bill_payment", id "950", confirm true)';
const DELETE_EXPENSE_750 = 'delete_entity (entity_type "expense", id "750", confirm true)';

/** Run the handler with draft false on `fake`. */
async function commitOn(fake: FakeClient, args: Omit<Args, "draft">): Promise<Result> {
  return (await handleConvertExpenseToBillPayment(fake.client, { ...args, draft: false })) as Result;
}

/** The write methods the fake saw, in order (a rejected write included). */
const writeOrder = (fake: FakeClient): string[] => fake.writes.map((w) => w.method);

/** A create response: the payload echoed as Id 950, with `change` applied to it. */
const bookedAs =
  (change: (booked: Record<string, unknown>) => void) =>
  (payload: Record<string, unknown>): Record<string, unknown> => {
    const booked: Record<string, unknown> = { ...structuredClone(payload), Id: "950", SyncToken: "0" };
    change(booked);
    return booked;
  };

/**
 * Every stop report: isError, the heading with its reason, never "Converted",
 * and the closing "Do not re-run" line followed by the bill payment link.
 */
function assertStopReport(result: Result, reason: string): string {
  const text = textOf(result);
  const lines = text.trimEnd().split("\n");
  assert.equal(result.isError, true, text);
  assert.equal(lines[0], `Expense Conversion Stopped — ${reason}`, text);
  assert.ok(!text.includes("Converted"), text);
  assert.equal(lines.at(-2), "Do not re-run this conversion.", text);
  assert.equal(lines.at(-1), `View in QuickBooks: ${BP_URL}`, text);
  return text;
}

function assertIncludes(text: string, fragments: string[]): void {
  for (const fragment of fragments) assert.ok(text.includes(fragment), `expected "${fragment}" in:\n${text}`);
}

describe("convert_expense_to_bill_payment — commit", () => {
  it("convert-commit-check-payload — a Check expense sends exactly the previewed Check bill payment", async () => {
    const fake = convertClient({ attachments: [ATTACHMENT_FILE] });
    const result = await commitOn(fake, { expense_id: "750", bills: BILL_110 });

    assert.equal(result.isError, undefined, textOf(result));
    assert.equal(fake.sent.length, 1);
    assert.deepEqual(fake.sent[0], {
      VendorRef: { value: "5", name: "North Produce" },
      TxnDate: "2026-07-15",
      TotalAmt: 250,
      PayType: "Check",
      CheckPayment: { BankAccountRef: { value: "10", name: "1010 Checking" }, PrintStatus: "NotSet" },
      PrivateNote: "Paid by check — July produce",
      DepartmentRef: { value: "1", name: "North" },
      Line: [{ Amount: 250, LinkedTxn: [{ TxnId: "110", TxnType: "Bill" }] }],
    });
  });

  it("convert-commit-cash-payload — a Cash expense sends a bare Check payment and sets no ref no.", async () => {
    const fake = convertClient();
    const result = await commitOn(fake, { expense_id: "751", bills: BILL_111 });
    const text = textOf(result);

    assert.equal(result.isError, undefined, text);
    assert.equal(fake.sent.length, 1);
    assert.deepEqual(fake.sent[0], {
      VendorRef: { value: "5", name: "North Produce" },
      TxnDate: "2026-07-16",
      TotalAmt: 100,
      PayType: "Check",
      CheckPayment: { BankAccountRef: { value: "10", name: "1010 Checking" } },
      Line: [{ Amount: 100, LinkedTxn: [{ TxnId: "111", TxnType: "Bill" }] }],
    });
    assert.equal(fake.callsTo("updateBillPayment"), 0);
    // The fresh-SyncToken read exists only for the ref no. update.
    assert.equal(fake.callsTo("getBillPayment"), 0);
    assert.deepEqual(writeOrder(fake), ["createBillPayment", "deletePurchase"]);
    assert.ok(hasLine(text, "Ref no.: (none)"), text);
  });

  it("convert-commit-card-payload — a CreditCard expense sends a Credit Card payment on its card account", async () => {
    const fake = convertClient();
    const result = await commitOn(fake, { expense_id: "752", bills: BILL_111 });
    const text = textOf(result);

    assert.equal(result.isError, undefined, text);
    assert.equal(fake.sent.length, 1);
    assert.deepEqual(fake.sent[0], {
      VendorRef: { value: "5", name: "North Produce" },
      TxnDate: "2026-07-17",
      TotalAmt: 100,
      PayType: "CreditCard",
      CreditCardPayment: { CCAccountRef: { value: "30", name: "2100 Company Card" } },
      PrivateNote: "Card payment",
      Line: [{ Amount: 100, LinkedTxn: [{ TxnId: "111", TxnType: "Bill" }] }],
    });
    assert.equal(text.split("\n")[0], "Expense Converted to Bill Payment (Credit Card)");
  });

  it("convert-commit-call-order — create, move each attachment, delete, then set the ref no. on a fresh SyncToken", async () => {
    const fake = convertClient({ attachments: [ATTACHMENT_FILE, ATTACHMENT_NOTE] });
    const result = await commitOn(fake, { expense_id: "750", bills: BILL_110 });
    assert.equal(result.isError, undefined, textOf(result));

    assert.deepEqual(writeOrder(fake), [
      "createBillPayment",
      "updateAttachable",
      "updateAttachable",
      "deletePurchase",
      "updateBillPayment",
    ]);

    const bodyOf = (method: string) => fake.writes.filter((w) => w.method === method).map((w) => w.body);
    assert.deepEqual(bodyOf("deletePurchase"), [{ Id: "750", SyncToken: "2" }]);

    const deleteAt = fake.calls.indexOf("deletePurchase");
    const updateAt = fake.calls.indexOf("updateBillPayment");
    assert.ok(
      fake.calls.slice(deleteAt + 1, updateAt).includes("getBillPayment"),
      `expected a getBillPayment read between deletePurchase and updateBillPayment: ${fake.calls.join(", ")}`,
    );
    assert.deepEqual(bodyOf("updateBillPayment"), [
      {
        Id: "950",
        SyncToken: "0",
        sparse: true,
        VendorRef: { value: "5", name: "North Produce" },
        PayType: "Check",
        DocNumber: "1042",
      },
    ]);

    const moved = JSON.parse(JSON.stringify(bodyOf("updateAttachable"))) as Array<Record<string, unknown>>;
    assert.deepEqual(moved.map((a) => a.Id), ["9001", "9002"]);
    assert.deepEqual(moved[0].AttachableRef, [
      { EntityRef: { type: "BillPayment", value: "950" } },
      { EntityRef: { type: "Vendor", value: "5" } },
    ]);
    assert.deepEqual(moved[1].AttachableRef, [{ EntityRef: { type: "BillPayment", value: "950" } }]);
  });

  it("the ref no. update carries the SyncToken read just before it, not the one create returned", async () => {
    // Moving an attachment may bump the bill payment's SyncToken: stand in for
    // that with a read that returns a token newer than create's "0".
    const fake = convertClient({ attachments: [ATTACHMENT_FILE] });
    const client = fake.client as unknown as Record<string, unknown>;
    const read = client.getBillPayment as (id: string, cb: (err: unknown, record: unknown) => void) => void;
    client.getBillPayment = (id: string, cb: (err: unknown, record: unknown) => void) =>
      read(id, (err, record) => cb(err, err ? record : { ...(record as object), SyncToken: "3" }));

    const result = await commitOn(fake, { expense_id: "750", bills: BILL_110 });
    assert.equal(result.isError, undefined, textOf(result));
    const update = fake.writes.find((w) => w.method === "updateBillPayment");
    assert.equal(update?.body.SyncToken, "3");
  });

  it("convert-commit-success-text — the result names both ids, the booked header, the ref no. and the moved attachments", async () => {
    const fake = convertClient({ attachments: [ATTACHMENT_FILE, ATTACHMENT_NOTE] });
    const result = await commitOn(fake, { expense_id: "750", bills: BILL_110 });
    const text = textOf(result);
    const lines = text.trimEnd().split("\n");

    assert.equal(result.isError, undefined, text);
    assert.equal(lines[0], "Expense Converted to Bill Payment (Check)");
    assert.ok(hasLine(text, "Bill payment 950 created; expense 750 deleted."), text);
    assert.ok(hasLine(text, "Ref no.: 1042"), text);
    assert.ok(hasLine(text, "Attachments moved: 2"), text);
    assert.ok(lines.at(-1)!.startsWith("View in QuickBooks: "), text);
    assert.equal(lines.at(-1), `View in QuickBooks: ${BP_URL}`);
    assert.equal(
      blockAfter(text, "Applied:")[0],
      "Bill 110 (#B-10, 2026-07-01) — charge: open $250.00, applying $250.00, remaining $0.00",
    );
    assertIncludes(text, ["North Produce", "1010 Checking", "2026-07-15", "Paid by check — July produce", "North"]);
    assert.ok(!text.includes("Stopped"), text);
  });

  it("the booked header lines are read from the create response, not the payload", async () => {
    // A memo QBO booked differently would stop the run, so use a field the
    // check does not compare: a location name, where only the id is compared.
    const fake = convertClient({
      createBillPayment: bookedAs((b) => {
        b.DepartmentRef = { value: "1", name: "North Booked" };
      }),
    });
    const text = textOf(await commitOn(fake, { expense_id: "750", bills: BILL_110 }));
    assert.ok(text.includes("North Booked"), text);
  });

  it("the draft=false placeholder is gone", async () => {
    const fake = convertClient();
    const text = textOf(await commitOn(fake, { expense_id: "750", bills: BILL_110 }));
    assert.ok(!text.includes("not implemented"), text);
  });
});

describe("convert_expense_to_bill_payment — verify the created bill payment", () => {
  it("convert-stop-lines-mismatch — a booked line that differs from the one sent stops before any other write", async () => {
    const fake = convertClient({
      attachments: [ATTACHMENT_FILE],
      createBillPayment: bookedAs((b) => {
        b.Line = [{ Amount: 250, LinkedTxn: [{ TxnId: "111", TxnType: "Bill" }] }];
      }),
    });
    const result = await commitOn(fake, { expense_id: "750", bills: BILL_110 });
    const text = assertStopReport(result, "BILL PAYMENT NOT AS PREVIEWED");

    assertIncludes(text, [
      "Bill 110: sent $250.00, not booked",
      "counted twice",
      DELETE_BILL_PAYMENT,
      DELETE_EXPENSE_750,
      "Do not re-run this conversion.",
    ]);
    assert.equal(fake.calls.at(-1), "createBillPayment");
    assert.deepEqual(writeOrder(fake), ["createBillPayment"]);
  });

  it("convert-stop-header-mismatch — a dropped location stops before any other write", async () => {
    const fake = convertClient({
      createBillPayment: bookedAs((b) => {
        delete b.DepartmentRef;
      }),
    });
    const result = await commitOn(fake, { expense_id: "750", bills: BILL_110 });
    const text = assertStopReport(result, "BILL PAYMENT NOT AS PREVIEWED");

    assertIncludes(text, ['Location: sent "1", booked "(none)"', "counted twice", DELETE_BILL_PAYMENT, DELETE_EXPENSE_750]);
    assert.equal(fake.calls.at(-1), "createBillPayment");
  });

  it("every compared header field is reported in order, as sent then booked", async () => {
    const fake = convertClient({
      createBillPayment: bookedAs((b) => {
        b.VendorRef = { value: "6", name: "South Dairy" };
        b.TxnDate = "2026-07-16";
        b.CheckPayment = { BankAccountRef: { value: "11" }, PrintStatus: "NeedToPrint" };
        b.PrivateNote = "Other memo";
        b.DepartmentRef = { value: "2" };
      }),
    });
    const text = assertStopReport(await commitOn(fake, { expense_id: "750", bills: BILL_110 }), "BILL PAYMENT NOT AS PREVIEWED");

    const expected = [
      'Vendor: sent "5", booked "6"',
      'Date: sent "2026-07-15", booked "2026-07-16"',
      'Payment account: sent "10", booked "11"',
      'Memo: sent "Paid by check — July produce", booked "Other memo"',
      'Location: sent "1", booked "2"',
      'Print status: sent "NotSet", booked "NeedToPrint"',
    ];
    const trimmed = text.split("\n").map((l) => l.trim());
    const at = expected.map((line) => trimmed.indexOf(line));
    for (const [i, index] of at.entries()) assert.ok(index >= 0, `expected "${expected[i]}" in:\n${text}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at, `header differences out of order:\n${text}`);
    assert.equal(fake.calls.at(-1), "createBillPayment");
  });

  it("a booked pay type that differs from the one sent stops the run", async () => {
    const fake = convertClient({ createBillPayment: bookedAs((b) => (b.PayType = "CreditCard")) });
    const text = assertStopReport(await commitOn(fake, { expense_id: "750", bills: BILL_110 }), "BILL PAYMENT NOT AS PREVIEWED");
    assertIncludes(text, ['Pay type: sent "Check", booked "CreditCard"']);
    assert.equal(fake.calls.at(-1), "createBillPayment");
  });

  it("a card payment's account is compared on CCAccountRef", async () => {
    const fake = convertClient({
      createBillPayment: bookedAs((b) => (b.CreditCardPayment = { CCAccountRef: { value: "31" } })),
    });
    const text = assertStopReport(await commitOn(fake, { expense_id: "752", bills: BILL_111 }), "BILL PAYMENT NOT AS PREVIEWED");
    assertIncludes(text, ['Payment account: sent "30", booked "31"']);
  });

  it("an absent memo equals an empty one, and a location or print status not sent is not compared", async () => {
    // Expense 751 sends no memo, location or print status.
    const fake = convertClient({
      createBillPayment: bookedAs((b) => {
        b.PrivateNote = "";
        b.DepartmentRef = { value: "2" };
        b.CheckPayment = { ...(b.CheckPayment as Record<string, unknown>), PrintStatus: "NotSet" };
      }),
    });
    const result = await commitOn(fake, { expense_id: "751", bills: BILL_111 });
    assert.equal(result.isError, undefined, textOf(result));
    assert.deepEqual(writeOrder(fake), ["createBillPayment", "deletePurchase"]);
  });

  it("the mismatch report lists header differences, then line differences, then what QuickBooks booked", async () => {
    const fake = convertClient({
      createBillPayment: bookedAs((b) => {
        delete b.DepartmentRef;
        b.Line = [{ Amount: 250, LinkedTxn: [{ TxnId: "111", TxnType: "Bill" }] }];
      }),
    });
    const text = assertStopReport(await commitOn(fake, { expense_id: "750", bills: BILL_110 }), "BILL PAYMENT NOT AS PREVIEWED");

    const header = text.indexOf('Location: sent "1", booked "(none)"');
    const line = text.indexOf("Bill 110: sent $250.00, not booked");
    const booked = text.indexOf("Booked by QuickBooks:");
    assert.ok(header >= 0 && line > header && booked > line, text);
    assert.deepEqual(blockAfter(text, "Booked by QuickBooks:"), ["Bill 111: $250.00 (not sent)", "Total: $250.00"]);
  });
});

describe("convert_expense_to_bill_payment — stops after create", () => {
  it("convert-stop-attachment-failure — a failed attachment move stops before the delete and says how to re-link", async () => {
    const fake = convertClient({
      attachments: [ATTACHMENT_FILE, ATTACHMENT_NOTE],
      fail: { updateAttachable: { error: qboFault("2500", "Invalid Reference Id"), id: "9002" } },
    });
    const result = await commitOn(fake, { expense_id: "750", bills: BILL_110 });
    const text = assertStopReport(result, "ATTACHMENTS NOT MOVED");

    assertIncludes(text, ["[2500]", "counted twice", DELETE_EXPENSE_750, DELETE_BILL_PAYMENT, "Do not re-run this conversion."]);
    // The moved and the unmoved attachment are both named, with the tool that re-links them.
    assertIncludes(text, ["9001", "9002", "edit_attachment"]);
    assert.equal(fake.callsTo("deletePurchase"), 0);
    assert.equal(fake.callsTo("updateBillPayment"), 0);
    // Nothing is undone: the moved attachment is not moved back.
    assert.deepEqual(writeOrder(fake), ["createBillPayment", "updateAttachable", "updateAttachable"]);
  });

  it("convert-stop-delete-failure — a failed delete stops before the ref no.", async () => {
    const fake = convertClient({ fail: { deletePurchase: { error: qboFault("5010", "Stale Object Error") } } });
    const result = await commitOn(fake, { expense_id: "750", bills: BILL_110 });
    const text = assertStopReport(result, "EXPENSE NOT DELETED");

    assertIncludes(text, ["[5010]", "counted twice", DELETE_EXPENSE_750, DELETE_BILL_PAYMENT, "Do not re-run this conversion."]);
    assert.equal(fake.callsTo("updateBillPayment"), 0);
    assert.deepEqual(writeOrder(fake), ["createBillPayment", "deletePurchase"]);
  });

  it("convert-stop-ref-no-failure — a failed ref no. update reports the conversion otherwise complete", async () => {
    const fake = convertClient({
      fail: { updateBillPayment: { error: qboFault("6140", "Duplicate Document Number Error") } },
    });
    const result = await commitOn(fake, { expense_id: "750", bills: BILL_110 });
    const text = assertStopReport(result, "REF NO. NOT SET");

    assertIncludes(text, ["[6140]", "set ref no. 1042 on bill payment 950 in QuickBooks", "otherwise complete", "Do not re-run this conversion."]);
    assert.ok(!text.includes("counted twice"), text);
    assert.deepEqual(writeOrder(fake), ["createBillPayment", "deletePurchase", "updateBillPayment"]);
  });

  it("convert-stop-ref-no-failure — a failed SyncToken read before the ref no. update is a ref-no. stop, not a throw", async () => {
    const fake = convertClient({
      fail: { getBillPayment: { error: qboFault("3200", "Authentication failed"), id: "950" } },
    });
    const result = await commitOn(fake, { expense_id: "750", bills: BILL_110 });
    const text = assertStopReport(result, "REF NO. NOT SET");

    assertIncludes(text, ["[3200]", "set ref no. 1042 on bill payment 950 in QuickBooks"]);
    assert.ok(!text.includes("counted twice"), text);
    assert.equal(fake.callsTo("updateBillPayment"), 0);
  });

  it("convert-stop-ref-no-mismatch — an update that returns a different ref no. is a ref-no. stop", async () => {
    const fake = convertClient({ updateBillPayment: (body) => ({ ...body, SyncToken: "1", DocNumber: "999" }) });
    const result = await commitOn(fake, { expense_id: "750", bills: BILL_110 });
    const text = assertStopReport(result, "REF NO. NOT SET");

    assertIncludes(text, ['QuickBooks returned ref no. "999"']);
  });

  it("convert-stop-create-error-propagates — a rejected create propagates unchanged and nothing else is written", async () => {
    const fake = convertClient({ fail: { createBillPayment: { error: new Error("create refused") } } });
    const message = await rejectionOf(() => commitOn(fake, { expense_id: "750", bills: BILL_110 }));

    assert.equal(message, "create refused");
    assert.equal(fake.calls.at(-1), "createBillPayment");
    assert.deepEqual(writeOrder(fake), ["createBillPayment"]);
  });

  it("convert-stop-never-leaks-token — a failure carrying request config is reported without its credentials", async () => {
    const leaky = {
      config: { headers: { Authorization: "Bearer secret-token-123" } },
      response: {
        status: 400,
        data: { Fault: { type: "ValidationFault", Error: [{ code: "6000", Message: "Business Validation Error" }] } },
      },
    };
    const fake = convertClient({ fail: { deletePurchase: { error: leaky } } });
    const result = await commitOn(fake, { expense_id: "750", bills: BILL_110 });
    const text = textOf(result);

    assert.equal(result.isError, true, text);
    assert.ok(text.includes("[6000]"), text);
    assert.ok(!text.includes("secret-token-123"), text);
    assert.ok(!text.includes("Authorization"), text);
  });
});
