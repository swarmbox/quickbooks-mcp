// Handler for convert_expense_to_bill_payment
//
// QuickBooks Online lets its own UI turn an existing Expense or Check (a
// Purchase) into a Bill Payment by re-typing the transaction in place. The
// public Accounting API cannot: a Purchase that carries a link to a Bill is
// accepted and the link silently dropped, and a BillPayment that links a
// Purchase drops that line. The only API route to the same result is to create
// a bill payment on the expense's payment account against the vendor's open
// bills, then delete the expense. That gives the payment a new transaction id
// and create time, and it takes writes that are not atomic.
//
// Because of that this operation exists only for an explicit request to convert
// an expense, never as a side effect of another tool or as a way to fix an
// expense. See "Converting an Expense to a Bill Payment" in
// docs/quickbooks-api-limitations.md.
//
// This file holds the planning half: every read, every eligibility check, the
// bill payment payload and the draft preview. `planConversion` returns
// everything a commit needs, so draft and commit share one build and cannot
// drift apart. It makes no write call of any kind.

import QuickBooks from "node-quickbooks";
import { fetchAttachments, describeAttachable, type Attachable } from "./attachment.js";
import {
  appliedByLinkedTxn,
  collectLinkRequests,
  linkKey,
  resolveLinks,
  type BillPaymentLine,
  type ResolvedLink,
} from "./bill-payment-links.js";
import { billPaymentLines, formatLinkLines } from "./bill-payment.js";
import type { Preferences } from "./preferences.js";
import { getAccountCache, promisify } from "../../client/index.js";
import { extractQboFault, formatDollars, sumCents, toCents, toDollars } from "../../utils/index.js";
import type { AccountCache, QBRef } from "../../types/index.js";

/** QBO's `PrivateNote` limit, in characters. */
const MEMO_LIMIT = 4000;

/** Fault code QBO returns for an object that does not exist (or no longer does). */
const NOT_FOUND_CODE = "610";

interface ExpenseLine {
  Amount?: number;
  Description?: string;
  DetailType?: string;
  AccountBasedExpenseLineDetail?: {
    AccountRef?: QBRef;
    ClassRef?: QBRef;
    CustomerRef?: QBRef;
    BillableStatus?: string;
  };
}

/** The fields of a Purchase this conversion reads. */
interface Expense {
  Id: string;
  SyncToken?: string;
  PaymentType?: string;
  Credit?: boolean;
  AccountRef?: QBRef;
  EntityRef?: QBRef & { type?: string };
  TxnDate: string;
  DocNumber?: string;
  PrivateNote?: string;
  DepartmentRef?: QBRef;
  PrintStatus?: string;
  CurrencyRef?: QBRef;
  PaymentMethodRef?: QBRef;
  TotalAmt?: number;
  CustomField?: Array<{ Name?: string; StringValue?: string }>;
  RemitToAddr?: Record<string, string | undefined>;
  Line?: ExpenseLine[];
}

/** The BillPayment create payload: what a commit sends and what its response is checked against. */
export interface ConversionPayload {
  VendorRef: QBRef;
  TxnDate: string;
  TotalAmt: number;
  PayType: "Check" | "CreditCard";
  CheckPayment?: { BankAccountRef: QBRef; PrintStatus?: string };
  CreditCardPayment?: { CCAccountRef: QBRef };
  PrivateNote?: string;
  DepartmentRef?: QBRef;
  Line: BillPaymentLine[];
}

/** Everything a commit needs, built once from the reads. */
export interface ConversionPlan {
  expenseId: string;
  /** The expense as read; its SyncToken is the one a delete must carry. */
  expense: Expense;
  vendor: { value: string; name: string };
  isCard: boolean;
  links: ResolvedLink[];
  totalCents: number;
  payload: ConversionPayload;
  /** The expense's ref no., set on the bill payment after the expense is deleted. */
  docNumber?: string;
  /** What the expense holds that the bill payment will not. */
  notCarried: string[];
  attachments: Attachable[];
  paymentAccountName: string;
  lineAccountName: string;
}

/** The account type each convertible expense payment type draws on. */
const CONVERSIONS = new Map<string, { accountType: string }>([
  ["Check", { accountType: "Bank" }],
  ["Cash", { accountType: "Bank" }],
  ["CreditCard", { accountType: "Credit Card" }],
]);

/** A ref carrying only the fields QBO reads: the id, and the name when there is one. */
const toRef = (ref: QBRef): QBRef => ({ value: ref.value, ...(ref.name && { name: ref.name }) });

/** An account's display name from the cache, or undefined when its id is not there. */
function accountNameOf(accounts: AccountCache, id: string): string | undefined {
  const account = accounts.byId.get(id);
  return account ? account.FullyQualifiedName || account.Name : undefined;
}

const accountLabel = (accounts: AccountCache, id: string): string =>
  accountNameOf(accounts, id) ?? `account ${id} (not found)`;

/**
 * Why the expense cannot be converted, one reason per failed check in Design
 * order. A check whose input an earlier failure makes meaningless is skipped:
 * the account checks need a single account line, the payment-account check
 * needs a known payment type, and the already-applied check needs a vendor.
 */
function expenseRefusals(
  expense: Expense,
  accounts: AccountCache,
  prefs: Preferences,
  applied: Map<string, number> | undefined,
): string[] {
  const reasons: string[] = [];
  const conversion = CONVERSIONS.get(expense.PaymentType ?? "");

  if (!conversion) {
    reasons.push(`payment type "${expense.PaymentType ?? ""}" is not Check, Cash or CreditCard`);
  }
  if (expense.Credit === true) {
    reasons.push("it is a credit card credit (refund), not a payment");
  }

  const payee = expense.EntityRef;
  if (!payee) {
    reasons.push("it has no payee — a bill payment needs a vendor");
  } else if (payee.type?.toLowerCase() !== "vendor") {
    reasons.push(`its payee "${payee.name || payee.value}" is a ${payee.type ?? "payee of unknown type"}, not a vendor`);
  }

  const lines = expense.Line ?? [];
  const line = lines.length === 1 ? lines[0] : undefined;
  if (lines.length !== 1) {
    reasons.push(`it has ${lines.length} lines — only a single-line expense can be converted`);
  } else if (line?.DetailType !== "AccountBasedExpenseLineDetail") {
    reasons.push(
      line?.DetailType === "ItemBasedExpenseLineDetail"
        ? "its line posts to an item, not an account"
        : "its line is not an account-based expense line"
    );
  }

  const lineAccountId = line?.AccountBasedExpenseLineDetail?.AccountRef?.value;
  if (line?.DetailType === "AccountBasedExpenseLineDetail") {
    const account = lineAccountId ? accounts.byId.get(lineAccountId) : undefined;
    if (account?.AccountType !== "Accounts Payable") {
      const posts = lineAccountId
        ? `${accountLabel(accounts, lineAccountId)}${account ? ` (${account.AccountType ?? "unknown type"})` : ""}`
        : "no account";
      reasons.push(`its line posts to ${posts}, not an Accounts Payable account`);
    }
    const totalCents = toCents(expense.TotalAmt ?? 0);
    const lineCents = toCents(line.Amount ?? 0);
    if (totalCents !== lineCents) {
      reasons.push(
        `its total $${formatDollars(totalCents)} does not equal its line amount $${formatDollars(lineCents)}`
      );
    }
  }

  if (conversion) {
    const paymentAccountId = expense.AccountRef?.value;
    if (!paymentAccountId) {
      reasons.push("it has no payment account");
    } else {
      const account = accounts.byId.get(paymentAccountId);
      if (!account) {
        reasons.push(`its payment account is ${accountLabel(accounts, paymentAccountId)}, so its type cannot be checked`);
      } else if (account.AccountType !== conversion.accountType) {
        reasons.push(
          `its payment account ${accountLabel(accounts, paymentAccountId)} is a ${account.AccountType ?? "unknown type"} ` +
          `account; a ${expense.PaymentType} expense converts only from a ${conversion.accountType} account`
        );
      }
    }
  }

  const homeCurrency = prefs.CurrencyPrefs?.HomeCurrency?.value;
  const currency = expense.CurrencyRef?.value;
  if (currency && homeCurrency && currency !== homeCurrency) {
    reasons.push(`its currency ${currency} is not the home currency ${homeCurrency}`);
  }

  const closeDate = prefs.AccountingInfoPrefs?.BookCloseDate;
  if (closeDate && expense.TxnDate <= closeDate) {
    reasons.push(`it is dated ${expense.TxnDate}, on or before the closing date ${closeDate}`);
  }

  const appliedCents = applied?.get(linkKey("Purchase", expense.Id));
  if (appliedCents !== undefined) {
    reasons.push(
      `a bill payment already applies $${formatDollars(appliedCents)} of it — deleting it would change that payment`
    );
  }
  return reasons;
}

/**
 * The bill payment's memo: the expense's memo, with the line description folded
 * in after it unless that is switched off, empty, or already the memo. Both are
 * trimmed. A memo over QBO's limit is refused, never truncated. `descriptionInMemo`
 * is false only when a description exists and the memo does not carry its text.
 */
function buildMemo(
  expense: Expense,
  description: string,
  includeLineDescription: boolean,
): { memo: string; descriptionInMemo: boolean } {
  const note = (expense.PrivateNote ?? "").trim();
  const memo =
    !includeLineDescription || !description || description === note ? note
    : !note ? description
    : `${note} — ${description}`;

  if (memo.length > MEMO_LIMIT) {
    throw new Error(
      `The bill payment memo would be ${memo.length} characters, over QuickBooks' ${MEMO_LIMIT.toLocaleString("en-US")}-character ` +
      "limit, and a memo is never truncated. Shorten the expense memo, or set include_line_description: false " +
      "to leave the line description out of the memo."
    );
  }
  return { memo, descriptionInMemo: !description || includeLineDescription || description === note };
}

/** What the expense holds that a bill payment cannot, as preview lines. Always ends with the new-id note. */
function buildNotCarried(expense: Expense, line: ExpenseLine, description: string, descriptionInMemo: boolean): string[] {
  const detail = line.AccountBasedExpenseLineDetail;
  const out: string[] = [];

  if (!descriptionInMemo) out.push(`Line description: ${description}`);
  if (detail?.ClassRef) out.push(`Line class: ${detail.ClassRef.name || detail.ClassRef.value}`);
  if (detail?.CustomerRef) {
    const status = detail.BillableStatus ? ` (${detail.BillableStatus})` : "";
    out.push(`Line customer: ${detail.CustomerRef.name || detail.CustomerRef.value}${status}`);
  }
  for (const field of expense.CustomField ?? []) {
    const value = field.StringValue?.trim();
    if (value) out.push(`Custom field ${field.Name ?? "(unnamed)"}: ${value}`);
  }
  const addr = expense.RemitToAddr;
  if (addr) {
    const parts = [
      addr.Line1, addr.Line2, addr.Line3, addr.Line4, addr.Line5,
      addr.City, addr.CountrySubDivisionCode, addr.PostalCode, addr.Country,
    ].filter((part): part is string => !!part?.trim());
    if (parts.length > 0) out.push(`Remit-to address: ${parts.join(", ")}`);
  }
  if (expense.PaymentMethodRef) {
    out.push(`Payment method: ${expense.PaymentMethodRef.name || expense.PaymentMethodRef.value}`);
  }
  out.push("The bill payment gets a new transaction id and create time.");
  return out;
}

/** The expense as QBO holds it; a 610 becomes "not found", anything else propagates unchanged. */
async function readExpense(client: QuickBooks, id: string): Promise<Expense> {
  try {
    return (await promisify<unknown>((cb) => client.getPurchase(id, cb))) as Expense;
  } catch (error) {
    if (extractQboFault(error)?.errors.some((e) => e.code === NOT_FOUND_CODE)) {
      throw new Error(`Expense ${id} was not found — it may already have been converted or deleted.`);
    }
    throw error;
  }
}

/**
 * Read everything, check everything, build the payload. Throws one message
 * listing every failed expense check, or the first bill-side failure. Used by
 * draft and commit alike; commit re-reads rather than trusting an earlier draft.
 */
async function planConversion(
  client: QuickBooks,
  args: { expense_id: string; bills: Array<{ bill_id: string; amount?: number }>; include_line_description: boolean },
): Promise<ConversionPlan> {
  const { expense_id, bills, include_line_description } = args;
  if (bills.length === 0) throw new Error("At least one bill is required");
  const requests = collectLinkRequests({ bills });

  const expense = await readExpense(client, expense_id);
  const payee = expense.EntityRef;
  const isVendor = payee?.type?.toLowerCase() === "vendor";

  const [accounts, prefs, attachments, applied] = await Promise.all([
    getAccountCache(client),
    promisify<unknown>((cb) => client.getPreferences(cb)) as Promise<Preferences>,
    fetchAttachments(client, "Purchase", expense_id),
    isVendor ? appliedByLinkedTxn(client, payee.value, payee.name) : undefined,
  ]);

  const reasons = expenseRefusals(expense, accounts, prefs, applied);
  if (reasons.length > 0) {
    throw new Error(
      [`Expense ${expense_id} cannot be converted to a bill payment:`, ...reasons.map((r) => `  - ${r}`)].join("\n")
    );
  }

  // Every check passed, so the payee is a vendor, the payment type is known and
  // the expense has one account-based line on an Accounts Payable account.
  const vendor = { value: payee!.value, name: payee!.name || payee!.value };
  const line = expense.Line![0];
  const lineAccountId = line.AccountBasedExpenseLineDetail!.AccountRef!.value;
  const lineAccountName = accountLabel(accounts, lineAccountId);
  const isCard = expense.PaymentType === "CreditCard";
  const totalCents = toCents(expense.TotalAmt ?? 0);

  const links = await resolveLinks(client, vendor, requests);

  const misplaced = links.flatMap((l) => {
    const name = `Bill ${l.id} (#${l.doc || "?"})`;
    if (!l.apAccountId) {
      return [`${name} does not name its Accounts Payable account, so it cannot be matched to the expense line's ${lineAccountName}`];
    }
    return l.apAccountId === lineAccountId
      ? []
      : [`${name} is on ${accountLabel(accounts, l.apAccountId)}, but the expense line posts to ${lineAccountName}`];
  });
  if (misplaced.length > 0) throw new Error(misplaced.join("\n"));

  const linkedCents = sumCents(links.map((l) => l.applyCents));
  if (linkedCents !== totalCents) {
    const gap = Math.abs(totalCents - linkedCents);
    throw new Error(
      `Bills apply $${formatDollars(linkedCents)} but the expense is $${formatDollars(totalCents)} ` +
      `(${linkedCents < totalCents ? "short" : "over"} by $${formatDollars(gap)}).`
    );
  }

  const description = (line.Description ?? "").trim();
  const { memo, descriptionInMemo } = buildMemo(expense, description, include_line_description);
  const paymentAccount = toRef(expense.AccountRef!);
  const payload: ConversionPayload = {
    VendorRef: toRef(vendor),
    TxnDate: expense.TxnDate,
    TotalAmt: toDollars(totalCents),
    ...(isCard
      ? { PayType: "CreditCard", CreditCardPayment: { CCAccountRef: paymentAccount } }
      : {
          PayType: "Check",
          CheckPayment: { BankAccountRef: paymentAccount, ...(expense.PrintStatus && { PrintStatus: expense.PrintStatus }) },
        }),
    ...(memo && { PrivateNote: memo }),
    ...(expense.DepartmentRef && { DepartmentRef: toRef(expense.DepartmentRef) }),
    Line: billPaymentLines(links),
  };

  return {
    expenseId: expense_id,
    expense,
    vendor,
    isCard,
    links,
    totalCents,
    payload,
    docNumber: expense.DocNumber?.trim() || undefined,
    notCarried: buildNotCarried(expense, line, description, descriptionInMemo),
    attachments,
    paymentAccountName: accountLabel(accounts, paymentAccount.value),
    lineAccountName,
  };
}

/** The draft preview: what will be deleted, what will be created, and the steps a commit will run. */
function renderDraft(plan: ConversionPlan): string {
  const { expense, expenseId, vendor, isCard, links, payload, docNumber, attachments } = plan;
  const line = expense.Line![0];
  const description = (line.Description ?? "").trim();
  const label = isCard ? "Credit Card" : "Check";
  const indent = (lines: string[]) => lines.map((l) => `  ${l}`);

  const steps = [
    "create bill payment",
    "verify it",
    ...(attachments.length > 0 ? ["move attachments"] : []),
    `delete expense ${expenseId}`,
    ...(docNumber ? ["set ref no."] : []),
  ];

  return [
    `DRAFT - Convert Expense to Bill Payment (${label})`,
    "",
    "Expense to replace (will be DELETED):",
    ...[
      `Expense ${expenseId} — ${vendor.name}, ${expense.PaymentType}, ${expense.TxnDate}, ` +
        `Ref no. ${docNumber ?? "(none)"}, $${formatDollars(plan.totalCents)}`,
      `Payment account: ${plan.paymentAccountName}`,
      `Line: ${plan.lineAccountName} $${formatDollars(toCents(line.Amount ?? 0))}${description ? ` "${description}"` : ""}`,
    ],
    "",
    "Bill payment to create:",
    ...[
      `Vendor: ${vendor.name}`,
      `Pay type: ${label} (from expense payment type ${expense.PaymentType})`,
      `${isCard ? "Card" : "Bank"} Account: ${plan.paymentAccountName}`,
      `Date: ${payload.TxnDate}`,
      `Ref no.: ${docNumber ? `${docNumber} (set after the expense is deleted)` : "(none)"}`,
      `Memo: ${payload.PrivateNote || "(none)"}`,
      `Location: ${payload.DepartmentRef?.name || payload.DepartmentRef?.value || "(none)"}`,
      ...(payload.CheckPayment?.PrintStatus ? [`Print status: ${payload.CheckPayment.PrintStatus}`] : []),
    ],
    "",
    "Applied:",
    ...formatLinkLines(links),
    `  Payment total: $${formatDollars(plan.totalCents)} (equals the expense total)`,
    "",
    attachments.length > 0
      ? ["Attachments moved to the bill payment: " + attachments.length, ...attachments.map((a) => `  ${describeAttachable(a)}`)].join("\n")
      : "Attachments moved to the bill payment: none",
    "",
    "Not carried over:",
    ...indent(plan.notCarried),
    "",
    `Steps on draft=false: ${steps.join(" → ")}`,
    "Until the expense is deleted the payment is counted twice in Accounts Payable and the payment account. " +
      "If a step fails, nothing is undone: the result says what was done and how to finish or undo it.",
    "",
    "Set draft=false to convert this expense.",
  ].join("\n");
}

export async function handleConvertExpenseToBillPayment(
  client: QuickBooks,
  args: {
    expense_id: string;
    bills: Array<{ bill_id: string; amount?: number }>;
    include_line_description?: boolean;
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const { expense_id, bills, include_line_description = true, draft = true } = args;

  const plan = await planConversion(client, { expense_id, bills, include_line_description });

  if (draft) {
    return { content: [{ type: "text", text: renderDraft(plan) }] };
  }

  throw new Error("convert_expense_to_bill_payment: draft=false is not implemented yet");
}
