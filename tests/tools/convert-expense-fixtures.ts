// Invented fixtures for the convert_expense_to_bill_payment tests, on top of the
// shared fake client in bill-payment-fixtures.ts.
//
// Everything is options-driven and additive: `convertClient()` with no options
// is the default fake plus the accounts, bills and expenses below. Vendors are
// North Produce / South Dairy, amounts are round, and nothing here is a real
// record.

import {
  NORTH,
  fakeClient,
  type FakeClient,
  type FakeClientOptions,
} from "./bill-payment-fixtures.js";

type Ref = { value: string; name?: string };
type Rec = Record<string, unknown>;

export const AP_REF: Ref = { value: "20", name: "2000 Accounts Payable" };
export const AP_OTHER_REF: Ref = { value: "21", name: "2010 Accounts Payable Other" };
export const CHECKING_REF: Ref = { value: "10", name: "1010 Checking" };
export const CARD_REF: Ref = { value: "30", name: "2100 Company Card" };
export const PRODUCE_CLASS: Ref = { value: "3", name: "Produce" };

/** Accounts the shared fake does not have: a credit card and a second Accounts Payable. */
export const CONVERT_ACCOUNTS: Rec[] = [
  { Id: "30", Name: "Company Card", FullyQualifiedName: "2100 Company Card", AcctNum: "2100", AccountType: "Credit Card", Classification: "Liability" },
  { Id: "21", Name: "Accounts Payable Other", FullyQualifiedName: "2010 Accounts Payable Other", AcctNum: "2010", AccountType: "Accounts Payable", Classification: "Liability" },
];

function bill(id: string, doc: string, date: string, open: number, apAccount?: Ref): Rec {
  return {
    Id: id, DocNumber: doc, TxnDate: date, TotalAmt: open, Balance: open, VendorRef: NORTH,
    ...(apAccount && { APAccountRef: apAccount }),
  };
}

/** Bills 110-113; 113 names no A/P account. Bill 201 (South Dairy) comes from the shared fake. */
export const CONVERT_BILLS: Record<string, Rec> = {
  "110": bill("110", "B-10", "2026-07-01", 250, AP_REF),
  "111": bill("111", "B-11", "2026-07-02", 100, AP_REF),
  "112": bill("112", "B-12", "2026-07-03", 250, AP_OTHER_REF),
  "113": bill("113", "B-13", "2026-07-04", 250),
};

/** One AccountBasedExpenseLineDetail line; `detail` is merged into the line detail (class, customer, ...). */
export function accountLine(
  amount: number,
  options: { account?: Ref; description?: string; detail?: Rec } = {},
): Rec {
  return {
    Id: "1",
    Amount: amount,
    DetailType: "AccountBasedExpenseLineDetail",
    ...(options.description !== undefined && { Description: options.description }),
    AccountBasedExpenseLineDetail: { AccountRef: options.account ?? AP_REF, ...options.detail },
  };
}

const NORTH_PAYEE = { ...NORTH, type: "Vendor" };

export type BaseExpenseId = "750" | "751" | "752";

export const CONVERT_EXPENSES: Record<BaseExpenseId, Rec> = {
  // A Check with every optional field the conversion carries or reports.
  "750": {
    Id: "750", SyncToken: "2", PaymentType: "Check", AccountRef: CHECKING_REF, EntityRef: NORTH_PAYEE,
    TxnDate: "2026-07-15", DocNumber: "1042", PrivateNote: "Paid by check",
    DepartmentRef: { value: "1", name: "North" }, PrintStatus: "NotSet",
    CurrencyRef: { value: "USD" }, TotalAmt: 250,
    Line: [accountLine(250, { description: "July produce", detail: { ClassRef: PRODUCE_CLASS } })],
  },
  // A bare Cash expense: no ref no., memo, location, print status or description.
  "751": {
    Id: "751", SyncToken: "0", PaymentType: "Cash", AccountRef: CHECKING_REF, EntityRef: NORTH_PAYEE,
    TxnDate: "2026-07-16", TotalAmt: 100,
    Line: [accountLine(100)],
  },
  "752": {
    Id: "752", SyncToken: "1", PaymentType: "CreditCard", Credit: false, AccountRef: CARD_REF,
    EntityRef: NORTH_PAYEE, TxnDate: "2026-07-17", DocNumber: "C-7", PrivateNote: "Card payment",
    TotalAmt: 100,
    Line: [accountLine(100)],
  },
};

/**
 * A copy of expense `base` as id "760", with `overrides` laid over it. An
 * override whose value is `undefined` removes that field.
 */
export function expenseWith(base: BaseExpenseId, overrides: Rec = {}): Rec {
  const expense: Rec = { ...structuredClone(CONVERT_EXPENSES[base]), Id: "760" };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete expense[key];
    else expense[key] = value;
  }
  return expense;
}

/** A file attachment linked to Purchase 750 and to its vendor. */
export const ATTACHMENT_FILE: Rec = {
  Id: "9001", SyncToken: "0", FileName: "invoice.pdf", ContentType: "application/pdf", Size: 1000,
  AttachableRef: [
    { EntityRef: { type: "Purchase", value: "750" } },
    { EntityRef: { type: "Vendor", value: "5" } },
  ],
};

/** A note linked to Purchase 750 only. */
export const ATTACHMENT_NOTE: Rec = {
  Id: "9002", SyncToken: "1", Note: "Paid at the counter",
  AttachableRef: [{ EntityRef: { type: "Purchase", value: "750" } }],
};

export interface ConvertClientOptions extends FakeClientOptions {
  /** Extra or replacement expenses by id, laid over 750-752. */
  expenses?: Record<string, Rec>;
  /** Exactly the attachments findAttachables can return; each is matched by its refs. */
  attachments?: Rec[];
}

/** The shared fake with the conversion's accounts, bills, expenses and attachments in place. */
export function convertClient(options: ConvertClientOptions = {}): FakeClient {
  const { expenses, attachments, ...rest } = options;
  return fakeClient({
    ...rest,
    accounts: [...CONVERT_ACCOUNTS, ...(rest.accounts ?? [])],
    attachables: attachments ?? rest.attachables,
    records: {
      ...rest.records,
      Bill: { ...CONVERT_BILLS, ...rest.records?.Bill },
      Purchase: { ...CONVERT_EXPENSES, ...expenses, ...rest.records?.Purchase },
    },
  });
}
