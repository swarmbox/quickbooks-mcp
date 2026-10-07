// Handlers for bill payment tools (create, get)
//
// A BillPayment is the QBO entity behind the "check" / "pay bills" flow. Each
// line applies one A/P transaction for the vendor: Bills and the other charges
// it settles, and VendorCredits and the other credits it applies against them
// (see bill-payment-links.ts for the full set and how each side is decided).
// This is distinct from an Expense (Purchase), which books expense lines
// directly and does NOT touch existing bills.

import QuickBooks from "node-quickbooks";
import { formatAttachmentLines } from "./attachment.js";
import {
  collectLinkRequests,
  resolveLinks,
  linkSides,
  linkKey,
  LINK_KINDS,
  type BillPaymentLine,
  type ResolvedLink,
} from "./bill-payment-links.js";
import {
  promisify,
  promisifyWrite,
  getAccountCache,
  getVendorCache,
  resolveAccountRef,
  resolveVendorRef,
  toQboRef,
} from "../../client/index.js";
import { buildQboUrl, toCents, toDollars, formatDollars, sumCents, outputReport } from "../../utils/index.js";

/** Error messages name a link by its label, e.g. `Journal entry 300 (#JE-1)`. */
function linkLabel(link: ResolvedLink): string {
  return `${LINK_KINDS[link.type].label} ${link.id} (#${link.doc || "?"})`;
}

/**
 * The applied lines shared by the draft preview and the created result. Listings
 * name a link by its QBO TxnType and show what stays open after this payment.
 */
function formatLinkLines(links: ResolvedLink[]): string[] {
  return links.map((l) =>
    `  ${l.type} ${l.id} (#${l.doc || "?"}, ${l.date || "?"}) — ${l.side}: ` +
    `open $${formatDollars(l.openCents)}, applying $${formatDollars(l.applyCents)}, ` +
    `remaining $${formatDollars(l.openCents - l.applyCents)}`
  );
}

/**
 * The rejection for credits that exceed charges. Never caps a credit: it names
 * the last credit-side entry, in input order, large enough to absorb the excess
 * on its own, and the change that brings the total to exactly $0.
 */
function excessCreditMessage(links: ResolvedLink[], chargeCents: number, creditCents: number): string {
  const excessCents = creditCents - chargeCents;
  const opening =
    `Credits ($${formatDollars(creditCents)}) exceed charges ($${formatDollars(chargeCents)}) ` +
    `by $${formatDollars(excessCents)}, and a bill payment total cannot be negative.`;

  const absorber = links.filter((l) => l.side === "credit" && l.applyCents >= excessCents).pop();
  if (!absorber) {
    return `${opening} Reduce the credit amounts by $${formatDollars(excessCents)} in total.`;
  }
  return absorber.applyCents > excessCents
    ? `${opening} To bring it to $0, set amount: ${formatDollars(absorber.applyCents - excessCents)} on ${linkLabel(absorber)}.`
    : `${opening} To bring it to $0, remove ${linkLabel(absorber)}.`;
}

/** The fields of QBO's created BillPayment that the check and its report read. */
interface CreatedBillPayment {
  Id: string;
  DocNumber?: string;
  TotalAmt?: number;
  Line?: BillPaymentLine[];
}

/** One amount QBO booked: on a linked transaction, or `link` undefined for a line that links none. */
interface BookedEntry {
  link?: { type: string; id: string };
  cents: number;
}

/**
 * Every amount a created payment books, in response order. A line linking several
 * transactions attributes its Amount to each, as get_bill_payment does, and a line
 * with no LinkedTxn is one entry with no link.
 */
function bookedEntries(result: CreatedBillPayment): BookedEntry[] {
  return (result.Line ?? []).flatMap((line): BookedEntry[] => {
    const cents = toCents(line.Amount ?? 0);
    const linked = line.LinkedTxn ?? [];
    return linked.length === 0
      ? [{ cents }]
      : linked.map((txn) => ({ link: { type: txn.TxnType, id: txn.TxnId }, cents }));
  });
}

/**
 * How QBO's created payment differs from what was sent; empty when it matches.
 *
 * QuickBooks can accept a link with HTTP 200 and drop it (verified for Purchase), so
 * a 200 is not proof the preview was booked. The create response carries the booked
 * TotalAmt and Line[].LinkedTxn, so this compares them in cents with no further QBO
 * call. Lines are keyed by TxnType and TxnId, so their order does not matter, and
 * one link split across lines is summed. An absent TotalAmt reads as 0, as it does
 * in get_bill_payment.
 */
function bookedDifferences(links: ResolvedLink[], totalCents: number, result: CreatedBillPayment): string[] {
  const entries = bookedEntries(result);
  const bookedByKey = new Map<string, number>();
  for (const { link, cents } of entries) {
    if (link) {
      const key = linkKey(link.type, link.id);
      bookedByKey.set(key, sumCents([bookedByKey.get(key) ?? 0, cents]));
    }
  }

  const differences: string[] = [];
  const bookedTotalCents = toCents(result.TotalAmt ?? 0);
  if (bookedTotalCents !== totalCents) {
    differences.push(`Total: sent $${formatDollars(totalCents)}, booked $${formatDollars(bookedTotalCents)}`);
  }

  const sentKeys = new Set<string>();
  for (const l of links) {
    const key = linkKey(l.type, l.id);
    sentKeys.add(key);
    const bookedCents = bookedByKey.get(key);
    if (bookedCents === undefined) {
      differences.push(`${l.type} ${l.id}: sent $${formatDollars(l.applyCents)}, not booked`);
    } else if (bookedCents !== l.applyCents) {
      differences.push(`${l.type} ${l.id}: sent $${formatDollars(l.applyCents)}, booked $${formatDollars(bookedCents)}`);
    }
  }

  const reported = new Set<string>();
  for (const { link, cents } of entries) {
    if (!link) {
      differences.push(`Line with no linked transaction: not sent, booked $${formatDollars(cents)}`);
      continue;
    }
    const key = linkKey(link.type, link.id);
    if (sentKeys.has(key) || reported.has(key)) continue;
    reported.add(key);
    differences.push(`${link.type} ${link.id}: not sent, booked $${formatDollars(bookedByKey.get(key)!)}`);
  }
  return differences;
}

/**
 * What QBO booked, one entry per booked line per linked transaction. A credit is
 * signed negative by the side of the matching sent link, as in get_bill_payment.
 */
function formatBookedLines(links: ResolvedLink[], result: CreatedBillPayment): string[] {
  const sideByKey = new Map(links.map((l) => [linkKey(l.type, l.id), l.side]));
  const entries = bookedEntries(result).map(({ link, cents }) => {
    if (!link) return `  Line with no linked transaction: $${formatDollars(cents)}`;
    const side = sideByKey.get(linkKey(link.type, link.id));
    const label = side ?? "not sent";
    return `  ${link.type} ${link.id}: ${side === "credit" ? "-" : ""}$${formatDollars(cents)} (${label})`;
  });
  return [...entries, `  Total: $${formatDollars(toCents(result.TotalAmt ?? 0))}`];
}

export async function handleCreateBillPayment(
  client: QuickBooks,
  args: {
    vendor_name?: string;
    vendor_id?: string;
    payment_account?: string;
    txn_date: string;
    memo?: string;
    doc_number?: string;
    bills?: Array<{ bill_id: string; amount?: number }>;
    credits?: Array<{ vendor_credit_id: string; amount?: number }>;
    linked_txns?: Array<{ txn_type: string; txn_id: string; amount?: number }>;
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const { vendor_name, vendor_id, payment_account, txn_date, memo, doc_number, draft = true } = args;

  // Merge bills, credits and linked_txns in that order: the payload keeps
  // today's line order for bills/credits callers.
  const requests = collectLinkRequests(args);

  const vendorKey = vendor_id || vendor_name;
  if (!vendorKey) {
    throw new Error("Either vendor_name or vendor_id is required");
  }
  const vendorRef = resolveVendorRef(await getVendorCache(client), vendorKey);

  // Resolve bank account. Restricted to Bank-type: this tool moves money, and an
  // unrestricted partial match can land on an account that merely shares digits or
  // words with the intended one (on this chart of accounts "Payroll" resolves to
  // an accrued-wages liability, not the payroll checking account). A Check-type
  // BillPayment requires a Bank account anyway.
  const bankAccountRef = payment_account
    ? toQboRef(
        resolveAccountRef(await getAccountCache(client), payment_account, {
          label: "Payment account",
          accountType: "Bank",
        })
      )
    : undefined;

  const links = await resolveLinks(client, vendorRef, requests);

  const chargeCents = sumCents(links.filter((l) => l.side === "charge").map((l) => l.applyCents));
  const creditCents = sumCents(links.filter((l) => l.side === "credit").map((l) => l.applyCents));
  const totalCents = chargeCents - creditCents;

  if (chargeCents === 0) {
    throw new Error(
      "Nothing to pay: at least one charge-side transaction is required (a Bill, or a JournalEntry " +
      "or Deposit that credits Accounts Payable for the vendor)"
    );
  }
  if (totalCents < 0) {
    throw new Error(excessCreditMessage(links, chargeCents, creditCents));
  }
  // QBO stores a $0 application with no bank account; anything that moves
  // money needs one.
  if (!bankAccountRef && totalCents > 0) {
    throw new Error(
      `payment_account is required: the payment total is $${formatDollars(totalCents)}. ` +
      "Only a $0 application may omit it."
    );
  }

  // Build QuickBooks BillPayment object (Check pay type — covers EFT/ACH too).
  // A $0 application without an account is sent as QBO itself stores one.
  const bpObject: Record<string, unknown> = {
    VendorRef: vendorRef,
    PayType: "Check",
    CheckPayment: bankAccountRef ? { BankAccountRef: bankAccountRef } : { PrintStatus: "NotSet" },
    TxnDate: txn_date,
    TotalAmt: toDollars(totalCents),
    ...(memo && { PrivateNote: memo }),
    ...(doc_number && { DocNumber: doc_number }),
    Line: links.map((l) => ({
      Amount: toDollars(l.applyCents),
      LinkedTxn: [{ TxnId: l.id, TxnType: l.type }],
    })),
  };

  const bankAccountLine = `Bank Account: ${bankAccountRef ? bankAccountRef.name : "(none — $0 application)"}`;
  const appliedSection = [
    "Applied:",
    ...formatLinkLines(links),
    "",
    `Charges: $${formatDollars(chargeCents)}`,
    `Credits: $${formatDollars(creditCents)}`,
    `Payment total: $${formatDollars(totalCents)}`,
  ];

  if (draft) {
    const preview = [
      "DRAFT - Bill Payment (Check) Preview",
      "",
      `Vendor: ${vendorRef.name}`,
      bankAccountLine,
      `Date: ${txn_date}`,
      `Ref no.: ${doc_number || "(auto-assign)"}`,
      `Memo: ${memo || "(none)"}`,
      "",
      ...appliedSection,
      "",
      "Set draft=false to create this bill payment.",
    ].join("\n");

    return {
      content: [{ type: "text", text: preview }],
    };
  }

  // Create the bill payment
  const result = await promisifyWrite<unknown>((cb) =>
    client.createBillPayment(bpObject, cb)
  ) as CreatedBillPayment;

  const qboUrl = buildQboUrl("billpayment", "txnId", result.Id);

  const paymentLines = [
    `Vendor: ${vendorRef.name}`,
    bankAccountLine,
    `Ref no.: ${result.DocNumber || "(auto-assigned)"}`,
    `Date: ${txn_date}`,
  ];

  // Returned, not thrown: the payment exists, so the caller must be told what was
  // booked rather than see a failure and retry. Nothing is undone here.
  const differences = bookedDifferences(links, totalCents, result);
  if (differences.length > 0) {
    const mismatch = [
      "Bill Payment Created — NOT AS PREVIEWED",
      "",
      `QuickBooks created bill payment ${result.Id} but booked it differently from what was sent:`,
      ...differences.map((d) => `  ${d}`),
      "",
      "Booked by QuickBooks:",
      ...formatBookedLines(links, result),
      "",
      ...paymentLines,
      "",
      "Nothing was undone. Review this payment in QuickBooks; if it is not wanted, delete it with " +
        `delete_entity (entity_type "bill_payment", id "${result.Id}").`,
      "Do not re-run create_bill_payment for this payment: a repeat would book a second one.",
      `View in QuickBooks: ${qboUrl}`,
    ].join("\n");

    return {
      content: [{ type: "text", text: mismatch }],
      isError: true,
    };
  }

  const response = [
    "Bill Payment Created!",
    "",
    ...paymentLines,
    "",
    ...appliedSection,
    "",
    `View in QuickBooks: ${qboUrl}`,
  ].join("\n");

  return {
    content: [{ type: "text", text: response }],
  };
}

export async function handleGetBillPayment(
  client: QuickBooks,
  args: { id: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id } = args;

  const bp = await promisify<unknown>((cb) =>
    client.getBillPayment(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    DocNumber?: string;
    PrivateNote?: string;
    TotalAmt?: number;
    PayType?: string;
    VendorRef?: { value: string; name?: string };
    CheckPayment?: { BankAccountRef?: { value: string; name?: string } };
    CreditCardPayment?: { CCAccountRef?: { value: string; name?: string } };
    Line?: BillPaymentLine[];
  };
  const qboUrl = buildQboUrl("billpayment", "txnId", bp.Id);

  const payAcct = bp.CheckPayment?.BankAccountRef || bp.CreditCardPayment?.CCAccountRef;

  // Each line is signed by the side its linked transaction posts to A/P:
  // QBO stores every Amount positive, but TotalAmt is charges minus credits.
  // A side that cannot be determined is unknown and suppresses the net check
  // rather than guessing. Surfaces any unapplied remainder — a common source
  // of bills that stay open after a payment was matched.
  const sides = await linkSides(client, bp.VendorRef?.value ?? "", bp.Line || []);
  const linked = (bp.Line || []).flatMap((l) =>
    (l.LinkedTxn || []).map((txn) => ({ txn, cents: toCents(l.Amount ?? 0), side: sides.get(linkKey(txn.TxnType, txn.TxnId)) }))
  );
  const unknownCount = linked.filter((l) => l.side === undefined).length;
  const appliedCents = sumCents(linked.map((l) => (l.side === "credit" ? -l.cents : l.cents)));
  const totalCents = toCents(bp.TotalAmt || 0);
  const unappliedCents = totalCents - appliedCents;

  const lines: string[] = [
    'Bill Payment',
    '============',
    `ID: ${bp.Id}`,
    `SyncToken: ${bp.SyncToken}`,
    `Vendor: ${bp.VendorRef?.name || bp.VendorRef?.value || '(none)'}`,
    `Date: ${bp.TxnDate}`,
    `Ref no.: ${bp.DocNumber || '(none)'}`,
    `Pay Type: ${bp.PayType || '(unknown)'}`,
    `Account: ${payAcct?.name || payAcct?.value || '(none)'}`,
    `Memo: ${bp.PrivateNote || '(none)'}`,
    `Total: $${formatDollars(totalCents)}`,
    '',
    'Applied to:',
  ];

  for (const { txn, cents, side } of linked) {
    const sign = side === "credit" ? "-" : "";
    const label = side ?? "side unknown";
    lines.push(`  ${txn.TxnType} ${txn.TxnId}: ${sign}$${formatDollars(cents)} (${label})`);
  }

  if (unknownCount > 0) {
    lines.push('', `*** Net applied not verified: could not classify ${unknownCount} linked transaction(s)`);
  } else if (unappliedCents !== 0) {
    lines.push('');
    lines.push(unappliedCents > 0
      ? `*** UNAPPLIED AMOUNT: $${formatDollars(unappliedCents)} — payment total exceeds applied lines`
      : `*** OVER-APPLIED: applied lines exceed payment total by $${formatDollars(-unappliedCents)}`);
  }

  lines.push('', ...(await formatAttachmentLines(client, 'BillPayment', bp.Id)));
  lines.push('');
  lines.push(`View in QuickBooks: ${qboUrl}`);

  return outputReport(`bill-payment-${bp.Id}`, bp, lines.join('\n'));
}
