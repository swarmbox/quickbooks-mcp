// Shared fake client and invented fixtures for the bill-payment test files.
//
// Not a *.test.ts file, so the runner's glob never runs it on its own. Every
// fixture is invented: vendors North Produce / South Dairy, a four-account
// chart and round amounts.
//
// The fake records every method call by name, so a test can assert both what
// was read and what was never read. A missing id rejects, as QBO does.

import type QuickBooks from "node-quickbooks";

type Callback<T> = (err: unknown, result: T) => void;
type Ref = { value: string; name?: string };

export const NORTH = { value: "5", name: "North Produce" };
export const SOUTH = { value: "6", name: "South Dairy" };

export const ACCOUNTS = [
  { Id: "10", Name: "Checking", FullyQualifiedName: "1010 Checking", AcctNum: "1010", AccountType: "Bank", Classification: "Asset" },
  { Id: "20", Name: "Accounts Payable", FullyQualifiedName: "2000 Accounts Payable", AcctNum: "2000", AccountType: "Accounts Payable", Classification: "Liability" },
  { Id: "13", Name: "Prepaid Expenses", FullyQualifiedName: "1300 Prepaid Expenses", AcctNum: "1300", AccountType: "Other Current Asset", Classification: "Asset" },
  { Id: "60", Name: "Office Supplies", FullyQualifiedName: "6000 Office Supplies", AcctNum: "6000", AccountType: "Expense", Classification: "Expense" },
];

const AP = { value: "20", name: "2000 Accounts Payable" };
const PREPAID = { value: "13", name: "1300 Prepaid Expenses" };
const SUPPLIES = { value: "60", name: "6000 Office Supplies" };
const CHECKING = { value: "10", name: "1010 Checking" };

export const VENDORS = [
  { Id: "5", DisplayName: "North Produce", Active: true },
  { Id: "6", DisplayName: "South Dairy", Active: true },
];

export const BILLS: Record<string, Record<string, unknown>> = {
  "101": { Id: "101", DocNumber: "B-1", TxnDate: "2026-07-01", TotalAmt: 250, Balance: 250, VendorRef: NORTH },
  "102": { Id: "102", DocNumber: "B-2", TxnDate: "2026-06-20", TotalAmt: 75, Balance: 0, VendorRef: NORTH },
  "103": { Id: "103", DocNumber: "B-3", TxnDate: "2026-07-02", TotalAmt: 300, Balance: 100, VendorRef: NORTH },
  "201": { Id: "201", DocNumber: "B-9", TxnDate: "2026-07-05", TotalAmt: 500, Balance: 500, VendorRef: SOUTH },
};

export const VENDOR_CREDITS: Record<string, Record<string, unknown>> = {
  "401": { Id: "401", DocNumber: "VC-1", TxnDate: "2026-07-04", TotalAmt: 50, Balance: 50, VendorRef: NORTH },
  // No Balance field: the open amount falls back to TotalAmt.
  "402": { Id: "402", DocNumber: "VC-2", TxnDate: "2026-07-06", TotalAmt: 40, VendorRef: NORTH },
};

function jeLine(
  id: string,
  postingType: "Debit" | "Credit",
  amount: number,
  account: Ref,
  entity?: { Type?: string; EntityRef: Ref },
): Record<string, unknown> {
  return {
    Id: id,
    Amount: amount,
    DetailType: "JournalEntryLineDetail",
    JournalEntryLineDetail: { PostingType: postingType, AccountRef: account, ...(entity && { Entity: entity }) },
  };
}

const northVendor = { Type: "Vendor", EntityRef: NORTH };
const southVendor = { Type: "Vendor", EntityRef: SOUTH };

export const JOURNAL_ENTRIES: Record<string, Record<string, unknown>> = {
  // North Produce A/P nets to a 300.00 Debit (400 Dr − 100 Cr): a credit side.
  // The South Dairy A/P line and the Prepaid line must not count.
  "300": {
    Id: "300", DocNumber: "JE-1", TxnDate: "2026-07-03",
    Line: [
      jeLine("0", "Debit", 400, AP, northVendor),
      jeLine("1", "Credit", 100, AP, northVendor),
      jeLine("2", "Debit", 70, AP, southVendor),
      jeLine("3", "Credit", 370, PREPAID),
    ],
  },
  // North Produce A/P nets to a 100.00 Credit: a charge side.
  "301": {
    Id: "301", DocNumber: "JE-2", TxnDate: "2026-07-07",
    Line: [
      jeLine("0", "Credit", 100, AP, northVendor),
      jeLine("1", "Debit", 100, SUPPLIES),
    ],
  },
  // The only A/P line is South Dairy's; North Produce appears off A/P only.
  "302": {
    Id: "302", DocNumber: "JE-3", TxnDate: "2026-07-08",
    Line: [
      jeLine("0", "Debit", 50, AP, southVendor),
      jeLine("1", "Credit", 50, PREPAID, northVendor),
    ],
  },
  // 400.00 A/P Debit for North Produce; prior bill payments apply 150.00 of it.
  "303": {
    Id: "303", DocNumber: "JE-4", TxnDate: "2026-07-09",
    Line: [
      jeLine("0", "Debit", 400, AP, northVendor),
      jeLine("1", "Credit", 400, PREPAID),
    ],
  },
  // 100.00 A/P Debit for North Produce, already fully applied by a prior payment.
  "305": {
    Id: "305", DocNumber: "JE-5", TxnDate: "2026-07-10",
    Line: [
      jeLine("0", "Debit", 100, AP, northVendor),
      jeLine("1", "Credit", 100, PREPAID),
    ],
  },
  // The A/P line's entity is a Customer that happens to share the vendor's id.
  "306": {
    Id: "306", DocNumber: "JE-6", TxnDate: "2026-07-11",
    Line: [
      jeLine("0", "Debit", 50, AP, { Type: "Customer", EntityRef: { value: "5", name: "North Cafe" } }),
      jeLine("1", "Credit", 50, PREPAID),
    ],
  },
};

export const DEPOSITS: Record<string, Record<string, unknown>> = {
  // A positive deposit line credits its account: on A/P, a charge for the vendor.
  "500": {
    Id: "500", DocNumber: "D-1", TxnDate: "2026-07-12", TotalAmt: 60, DepositToAccountRef: CHECKING,
    Line: [{
      Id: "1", Amount: 60, DetailType: "DepositLineDetail",
      DepositLineDetail: { AccountRef: AP, Entity: { value: "5", name: "North Produce", type: "VENDOR" } },
    }],
  },
  // North Produce, but on an expense account: nothing on A/P.
  "501": {
    Id: "501", DocNumber: "D-2", TxnDate: "2026-07-13", TotalAmt: 25, DepositToAccountRef: CHECKING,
    Line: [{
      Id: "1", Amount: 25, DetailType: "DepositLineDetail",
      DepositLineDetail: { AccountRef: SUPPLIES, Entity: { value: "5", name: "North Produce", type: "VENDOR" } },
    }],
  },
};

function apExpenseLine(amount: number): Record<string, unknown> {
  return {
    Id: "1", Amount: amount, DetailType: "AccountBasedExpenseLineDetail",
    AccountBasedExpenseLineDetail: { AccountRef: AP },
  };
}

export const PURCHASES: Record<string, Record<string, unknown>> = {
  // A purchase debits its line accounts: on A/P, a credit side.
  "700": {
    Id: "700", DocNumber: "P-1", TxnDate: "2026-07-14", PaymentType: "CreditCard", Credit: false, TotalAmt: 80,
    EntityRef: { ...NORTH, type: "Vendor" }, Line: [apExpenseLine(80)],
  },
  // Credit: true reverses the posting: a charge side.
  "701": {
    Id: "701", DocNumber: "P-2", TxnDate: "2026-07-15", PaymentType: "CreditCard", Credit: true, TotalAmt: 30,
    EntityRef: { ...NORTH, type: "Vendor" }, Line: [apExpenseLine(30)],
  },
  "702": {
    Id: "702", DocNumber: "P-3", TxnDate: "2026-07-16", PaymentType: "CreditCard", Credit: false, TotalAmt: 20,
    EntityRef: { ...SOUTH, type: "Vendor" }, Line: [apExpenseLine(20)],
  },
};

function bpLine(amount: number, txnType: string, txnId: string): Record<string, unknown> {
  return { Amount: amount, LinkedTxn: [{ TxnId: txnId, TxnType: txnType }] };
}

// What findBillPayments returns for North Produce. The Deposit 303 line shares
// an id with JournalEntry 303, so applied amounts must be keyed by type and id.
export const PRIOR_BILL_PAYMENTS: Array<Record<string, unknown>> = [
  {
    Id: "800", TxnDate: "2026-07-20", VendorRef: NORTH, PayType: "Check",
    Line: [bpLine(150, "JournalEntry", "303"), bpLine(40, "Deposit", "303")],
  },
  {
    Id: "801", TxnDate: "2026-07-21", VendorRef: NORTH, PayType: "Check",
    Line: [bpLine(25, "Bill", "103"), bpLine(100, "JournalEntry", "305")],
  },
];

function storedBillPayment(
  id: string,
  totalAmt: number,
  lines: Array<Record<string, unknown>>,
  checkPayment: Record<string, unknown> = { BankAccountRef: CHECKING },
): Record<string, unknown> {
  return {
    Id: id, SyncToken: "0", TxnDate: "2026-07-25", TotalAmt: totalAmt, PayType: "Check",
    VendorRef: NORTH, CheckPayment: checkPayment, Line: lines,
  };
}

// Served by getBillPayment only, never by findBillPayments.
export const STORED_BILL_PAYMENTS: Record<string, Record<string, unknown>> = {
  // One of every type: 250 + 60 + 30 − 100 − 80 = 160.
  "900": storedBillPayment("900", 160, [
    bpLine(250, "Bill", "101"), bpLine(100, "JournalEntry", "300"), bpLine(80, "Purchase", "700"),
    bpLine(60, "Deposit", "500"), bpLine(30, "Purchase", "701"),
  ]),
  // A $0 application: no bank account, the JournalEntry credit offsets the bill.
  "901": storedBillPayment("901", 0, [bpLine(250, "Bill", "101"), bpLine(250, "JournalEntry", "300")], {
    PrintStatus: "NotSet",
  }),
  // Net applied 150.00 against a 200.00 total: 50.00 unapplied.
  "902": storedBillPayment("902", 200, [bpLine(250, "Bill", "101"), bpLine(100, "JournalEntry", "300")]),
  // JournalEntry 999 is in no table, so reading it fails.
  "903": storedBillPayment("903", 100, [bpLine(100, "Bill", "101"), bpLine(50, "JournalEntry", "999")]),
  // Bill and VendorCredit sides are fixed: nothing is fetched.
  "904": storedBillPayment("904", 200, [bpLine(250, "Bill", "101"), bpLine(50, "VendorCredit", "401")]),
  // Invoice is not a type a bill payment can link.
  "905": storedBillPayment("905", 30, [bpLine(40, "Bill", "101"), bpLine(10, "Invoice", "77")]),
};

type Records = Record<string, Record<string, unknown>>;

export interface FakeClientOptions {
  /** Replaces the default findBillPayments page: returns the BillPayment rows for one page. */
  findBillPayments?: (criteria: string) => Array<Record<string, unknown>>;
  /** Replaces the default createBillPayment echo: returns the BillPayment QBO would book for the payload. */
  createBillPayment?: (payload: Record<string, unknown>) => Record<string, unknown>;
  /** Extra or replacement records, keyed by entity then id. */
  records?: Partial<Record<"Bill" | "VendorCredit" | "JournalEntry" | "Deposit" | "Purchase" | "BillPayment", Records>>;
  /** Delay every get* read so concurrency can be observed. */
  delayMs?: number;
  /** Rows appended to `ACCOUNTS` for findAccounts. */
  accounts?: Array<Record<string, unknown>>;
  /** What getPreferences returns. Defaults to a USD home currency and no close date. */
  preferences?: Record<string, unknown>;
  /**
   * What findAttachables draws from: only the Attachables whose refs name the entity
   * type (case-insensitive) and id in the criteria are returned. Absent, nothing is.
   */
  attachables?: Array<Record<string, unknown>>;
  /**
   * Methods to make reject, by name. With `id`, only a call whose first argument is
   * that id (or an object with that `Id`) rejects. The call is still recorded.
   */
  fail?: Record<string, { error: unknown; id?: string }>;
}

export interface FakeClient {
  client: QuickBooks;
  /** Every method call, by name, in call order. */
  calls: string[];
  /** The criteria of each findBillPayments call. */
  billPaymentQueries: string[];
  /** Each payload passed to createBillPayment. */
  sent: Array<Record<string, unknown>>;
  /** How many times a method was called. */
  callsTo(name: string): number;
  /** The most get* reads that were ever in flight at once. */
  maxInFlight(): number;
}

export function fakeClient(options: FakeClientOptions = {}): FakeClient {
  const calls: string[] = [];
  const billPaymentQueries: string[] = [];
  const sent: Array<Record<string, unknown>> = [];
  let inFlight = 0;
  let peak = 0;

  const extra = options.records ?? {};
  const tables: Record<string, Records> = {
    Bill: { ...BILLS, ...extra.Bill },
    VendorCredit: { ...VENDOR_CREDITS, ...extra.VendorCredit },
    JournalEntry: { ...JOURNAL_ENTRIES, ...extra.JournalEntry },
    Deposit: { ...DEPOSITS, ...extra.Deposit },
    Purchase: { ...PURCHASES, ...extra.Purchase },
    BillPayment: { ...STORED_BILL_PAYMENTS, ...extra.BillPayment },
  };

  const getter = (method: string, entity: string) => (id: string, cb: Callback<unknown>) => {
    calls.push(method);
    inFlight++;
    peak = Math.max(peak, inFlight);
    const respond = () => {
      inFlight--;
      const found = tables[entity]?.[id];
      if (found) cb(null, structuredClone(found));
      else cb(new Error(`${entity} ${id} not found`), undefined);
    };
    if (options.delayMs) setTimeout(respond, options.delayMs);
    else respond();
  };

  const defaultBillPaymentPage = (criteria: string): Array<Record<string, unknown>> => {
    const start = Number(/STARTPOSITION\s+(\d+)/i.exec(criteria)?.[1] ?? "1");
    if (start > 1) return [];
    const vendorId = /VendorRef\s*=\s*'([^']*)'/i.exec(criteria)?.[1];
    return PRIOR_BILL_PAYMENTS.filter(
      (bp) => vendorId === undefined || (bp.VendorRef as Ref).value === vendorId,
    );
  };

  const attachablesFor = (criteria: unknown): Array<Record<string, unknown>> => {
    const text = typeof criteria === "string" ? criteria : JSON.stringify(criteria);
    const type = /EntityRef\.Type\s*=\s*'([^']*)'/i.exec(text)?.[1]?.toLowerCase();
    const id = /EntityRef\.value\s*=\s*'([^']*)'/i.exec(text)?.[1];
    return (options.attachables ?? []).filter((a) =>
      ((a.AttachableRef ?? []) as Array<{ EntityRef: { type: string; value: string } }>).some(
        (r) => r.EntityRef.type.toLowerCase() === type && r.EntityRef.value === id,
      ),
    );
  };

  const methods = {
    findAccounts: (_criteria: unknown, cb: Callback<unknown>) => {
      calls.push("findAccounts");
      cb(null, { QueryResponse: { Account: structuredClone([...ACCOUNTS, ...(options.accounts ?? [])]) } });
    },
    getPreferences: (cb: Callback<unknown>) => {
      calls.push("getPreferences");
      cb(null, structuredClone(options.preferences ?? { CurrencyPrefs: { HomeCurrency: { value: "USD" } } }));
    },
    findVendors: (_criteria: unknown, cb: Callback<unknown>) => {
      calls.push("findVendors");
      cb(null, { QueryResponse: { Vendor: structuredClone(VENDORS) } });
    },
    getBill: getter("getBill", "Bill"),
    getVendorCredit: getter("getVendorCredit", "VendorCredit"),
    getJournalEntry: getter("getJournalEntry", "JournalEntry"),
    getDeposit: getter("getDeposit", "Deposit"),
    getPurchase: getter("getPurchase", "Purchase"),
    getBillPayment: getter("getBillPayment", "BillPayment"),
    // Not a type a bill payment can link: present only so a test can assert it
    // was never read.
    getInvoice: (id: string, cb: Callback<unknown>) => {
      calls.push("getInvoice");
      cb(new Error(`Invoice ${id} not found`), undefined);
    },
    findBillPayments: (criteria: unknown, cb: Callback<unknown>) => {
      calls.push("findBillPayments");
      const text = typeof criteria === "string" ? criteria : JSON.stringify(criteria);
      billPaymentQueries.push(text);
      try {
        const page = (options.findBillPayments ?? defaultBillPaymentPage)(text);
        cb(null, { QueryResponse: { BillPayment: structuredClone(page) } });
      } catch (error) {
        cb(error, undefined);
      }
    },
    createBillPayment: (payload: Record<string, unknown>, cb: Callback<unknown>) => {
      calls.push("createBillPayment");
      sent.push(payload);
      cb(null, options.createBillPayment?.(payload) ?? { ...structuredClone(payload), Id: "950", SyncToken: "0" });
    },
    findAttachables: (criteria: unknown, cb: Callback<unknown>) => {
      calls.push("findAttachables");
      const found = attachablesFor(criteria);
      cb(null, { QueryResponse: found.length > 0 ? { Attachable: structuredClone(found) } : {} });
    },
  };

  // A failing method records its call and rejects without running the original.
  const wrapped: Record<string, unknown> = { ...methods };
  for (const [name, { error, id }] of Object.entries(options.fail ?? {})) {
    const original = wrapped[name] as ((...args: unknown[]) => void) | undefined;
    wrapped[name] = (...args: unknown[]) => {
      const cb = args[args.length - 1] as Callback<unknown>;
      const first = args[0] as string | { Id?: unknown } | undefined;
      const subject = typeof first === "object" ? first?.Id : first;
      if (id === undefined || String(subject) === id) {
        calls.push(name);
        cb(error, undefined);
      } else if (original) {
        original(...args);
      } else {
        cb(new Error(`${name} is not faked`), undefined);
      }
    };
  }
  const client = wrapped as unknown as QuickBooks;

  return {
    client,
    calls,
    billPaymentQueries,
    sent,
    callsTo: (name) => calls.filter((c) => c === name).length,
    maxInFlight: () => peak,
  };
}

/** Run fn and return its rejection message; fails the test if it resolves. */
export async function rejectionOf(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to be rejected");
}
