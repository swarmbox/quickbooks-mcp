// convert_expense_to_bill_payment: planning and the draft preview. Invented
// fixtures only; nothing here calls QuickBooks. No write is ever expected in
// this half of the tool, in draft or in commit.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { handleConvertExpenseToBillPayment } from "../../src/tools/handlers/convert-expense.js";
import { clearLookupCache } from "../../src/client/cache.js";
import { rejectionOf, NORTH, type FakeClient } from "./bill-payment-fixtures.js";
import {
  ATTACHMENT_FILE,
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
  it("convert-not-carried-lists-fields — class, customer, custom fields and the remit-to address are listed with their values", async () => {
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
      }),
      { expense_id: "760", bills: BILL_110 },
    );

    assert.deepEqual(blockAfter(text, "Not carried over:"), [
      "Line class: Produce",
      "Line customer: North Cafe (NotBillable)",
      "Custom field Crew: A",
      "Remit-to address: 1 Main St, Northville, CA, 90000",
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
