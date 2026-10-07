// Linked-transaction resolver for bill payments.
//
// A BillPayment line links one A/P transaction: a Bill or VendorCredit, and
// also a JournalEntry, Deposit or Purchase that posts to Accounts Payable for
// the vendor. Each linked transaction sits on one of two sides:
//
//   charge — it credits A/P (the vendor is owed); the payment settles it.
//   credit — it debits A/P (the vendor owes back); the payment applies it.
//
// Sign convention: every derived kind reduces to the signed cents it posts to
// A/P for the vendor. Positive credits A/P (a charge); negative debits A/P (a
// credit). The side is always derived from the fetched transaction — never
// taken from the caller.
//
// Bill and VendorCredit have a fixed side and QBO tracks their open amount
// (`Balance`). The derived kinds carry no Balance, so their open amount is the
// magnitude of their A/P amount minus what the vendor's prior bill payments
// already apply to them.

import QuickBooks from "node-quickbooks";
import { promisify, getAccountCache } from "../../client/index.js";
import { fetcherForEntity, paginatedQuery, SAFETY_LIMIT } from "../../query/pagination.js";
import { mapWithConcurrency, validateAmount, toCents, sumCents, formatDollars } from "../../utils/index.js";

/** The single source of the transaction types a bill payment line can link. */
export const LINKED_TXN_TYPES = ["Bill", "VendorCredit", "JournalEntry", "Deposit", "Purchase"] as const;
export type LinkedTxnType = (typeof LINKED_TXN_TYPES)[number];
export type ApSide = "charge" | "credit";

/** One merged request from bills[], credits[] or linked_txns[], in that order. */
export interface LinkRequest {
  type: LinkedTxnType;
  id: string;
  amountCents?: number;
}

export interface ResolvedLink {
  type: LinkedTxnType;
  id: string;
  doc?: string;
  date?: string;
  side: ApSide;
  openCents: number;
  applyCents: number;
}

/** Reads per resolve call fan out at most this many at a time. */
export const LINK_READ_CONCURRENCY = 4;

interface PayeeRef {
  value: string;
  name?: string;
  type?: string;
}

interface VendorRef {
  value: string;
  name: string;
}

interface LinkedTxnLine {
  Amount?: number;
  JournalEntryLineDetail?: {
    PostingType?: "Debit" | "Credit";
    AccountRef?: PayeeRef;
    Entity?: { Type?: string; EntityRef?: PayeeRef };
  };
  DepositLineDetail?: { AccountRef?: PayeeRef; Entity?: PayeeRef };
  AccountBasedExpenseLineDetail?: { AccountRef?: PayeeRef };
}

/** The fields the resolver reads from any linked transaction. */
export interface LinkedTxnRecord {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  TotalAmt?: number;
  Balance?: number;
  Credit?: boolean;
  VendorRef?: PayeeRef;
  EntityRef?: PayeeRef;
  Line?: LinkedTxnLine[];
}

interface LinkKind {
  /** How error messages name the transaction. */
  label: string;
  fetch(client: QuickBooks, id: string): Promise<LinkedTxnRecord>;
  /** Header payee, for the types that have one. */
  payee?(txn: LinkedTxnRecord): PayeeRef | undefined;
  /** Bill and VendorCredit: QBO fixes the side by type and tracks the open amount itself. */
  tracked?: { side: ApSide; openCents(txn: LinkedTxnRecord): number };
  /** The rest: signed cents this txn posts to A/P for the vendor (positive credits A/P). */
  apCents?(txn: LinkedTxnRecord, vendorId: string, apAccountIds: Set<string>): number;
}

type LinkGetter = "getBill" | "getVendorCredit" | "getJournalEntry" | "getDeposit" | "getPurchase";

const read = (method: LinkGetter) => (client: QuickBooks, id: string) =>
  promisify<unknown>((cb) => client[method](id, cb)) as Promise<LinkedTxnRecord>;

// QBO spells entity types inconsistently ("Vendor" on a JE line, "VENDOR" on a
// deposit line); an absent type is taken as the vendor.
const isVendorType = (type: string | undefined) => type === undefined || type.toLowerCase() === "vendor";

const onAp = (account: PayeeRef | undefined, apAccountIds: Set<string>) =>
  account !== undefined && apAccountIds.has(account.value);

export const LINK_KINDS: Record<LinkedTxnType, LinkKind> = {
  // Always a charge; open amount is QBO's Balance.
  Bill: {
    label: "Bill",
    fetch: read("getBill"),
    payee: (txn) => txn.VendorRef,
    tracked: { side: "charge", openCents: (txn) => toCents(txn.Balance ?? 0) },
  },
  // Always a credit; open amount is the unapplied Balance, else the full TotalAmt.
  VendorCredit: {
    label: "Vendor credit",
    fetch: read("getVendorCredit"),
    payee: (txn) => txn.VendorRef,
    tracked: { side: "credit", openCents: (txn) => toCents(txn.Balance ?? txn.TotalAmt ?? 0) },
  },
  // Net of the vendor's A/P lines: Credit adds, Debit subtracts. Net > 0 is a
  // charge, net < 0 a credit.
  JournalEntry: {
    label: "Journal entry",
    fetch: read("getJournalEntry"),
    apCents: (txn, vendorId, apAccountIds) =>
      sumCents((txn.Line ?? []).map((line) => {
        const detail = line.JournalEntryLineDetail;
        if (!detail || !onAp(detail.AccountRef, apAccountIds)) return 0;
        if (detail.Entity?.EntityRef?.value !== vendorId || !isVendorType(detail.Entity.Type)) return 0;
        const cents = toCents(line.Amount ?? 0);
        return detail.PostingType === "Credit" ? cents : -cents;
      })),
  },
  // Sum of the vendor's A/P deposit lines, which credit their account: a
  // positive line is a charge, a negative one a credit.
  Deposit: {
    label: "Deposit",
    fetch: read("getDeposit"),
    apCents: (txn, vendorId, apAccountIds) =>
      sumCents((txn.Line ?? []).map((line) => {
        const detail = line.DepositLineDetail;
        if (!detail || !onAp(detail.AccountRef, apAccountIds)) return 0;
        if (detail.Entity?.value !== vendorId || !isVendorType(detail.Entity.type)) return 0;
        return toCents(line.Amount ?? 0);
      })),
  },
  // A purchase debits its lines' accounts, so its A/P lines are a credit;
  // `Credit: true` (a refund) reverses that into a charge.
  Purchase: {
    label: "Purchase",
    fetch: read("getPurchase"),
    payee: (txn) => txn.EntityRef,
    apCents: (txn, _vendorId, apAccountIds) => {
      const debited = sumCents((txn.Line ?? []).map((line) =>
        onAp(line.AccountBasedExpenseLineDetail?.AccountRef, apAccountIds) ? toCents(line.Amount ?? 0) : 0
      ));
      return txn.Credit === true ? debited : -debited;
    },
  },
};

const linkKey = (type: LinkedTxnType, id: string) => `${type}:${id}`;

function nameOf(type: LinkedTxnType, txn: LinkedTxnRecord): string {
  return `${LINK_KINDS[type].label} ${txn.Id} (#${txn.DocNumber || "?"})`;
}

function canonicalType(txnType: string): LinkedTxnType {
  const type = LINKED_TXN_TYPES.find((t) => t.toLowerCase() === String(txnType).toLowerCase());
  if (!type) {
    throw new Error(`Unsupported txn_type "${txnType}". Supported: ${LINKED_TXN_TYPES.join(", ")}`);
  }
  return type;
}

/**
 * Merge bills[], credits[] and linked_txns[] into one request list, in that
 * order. Rejects unknown types, duplicates, an empty list and non-positive or
 * over-precise amounts. A request never carries a side.
 */
export function collectLinkRequests(args: {
  bills?: Array<{ bill_id: string; amount?: number }>;
  credits?: Array<{ vendor_credit_id: string; amount?: number }>;
  linked_txns?: Array<{ txn_type: string; txn_id: string; amount?: number }>;
}): LinkRequest[] {
  const entries = [
    ...(args.bills ?? []).map((b) => ({ type: "Bill" as LinkedTxnType, id: b.bill_id, amount: b.amount })),
    ...(args.credits ?? []).map((c) => ({ type: "VendorCredit" as LinkedTxnType, id: c.vendor_credit_id, amount: c.amount })),
    ...(args.linked_txns ?? []).map((l) => ({ type: canonicalType(l.txn_type), id: l.txn_id, amount: l.amount })),
  ];
  if (entries.length === 0) {
    throw new Error("At least one transaction to apply is required (bills, credits or linked_txns)");
  }

  const seen = new Set<string>();
  return entries.map(({ type, id, amount }) => {
    const name = `${LINK_KINDS[type].label} ${id}`;
    const key = linkKey(type, id);
    if (seen.has(key)) throw new Error(`${name} is listed more than once`);
    seen.add(key);

    if (amount === undefined) return { type, id };
    const amountCents = validateAmount(amount, `${name} amount`);
    if (amountCents <= 0) throw new Error(`${name}: amount must be positive`);
    return { type, id, amountCents };
  });
}

/**
 * Decide a fetched transaction's side for the vendor. Throws when it belongs to
 * another payee or posts nothing to A/P for the vendor. `apCents` is returned
 * for the derived kinds only.
 */
export function classifyLink(
  type: LinkedTxnType,
  txn: LinkedTxnRecord,
  vendor: VendorRef,
  apAccountIds: Set<string>,
): { side: ApSide; apCents?: number } {
  const kind = LINK_KINDS[type];

  const payee = kind.payee?.(txn);
  if (kind.payee && (payee?.value !== vendor.value || !isVendorType(payee.type))) {
    // The noun follows the payee's type, so a Purchase paid to a customer says so.
    const noun = payee?.type ? payee.type.toLowerCase() : "vendor";
    throw new Error(
      `${nameOf(type, txn)} belongs to ${noun} "${payee?.name || payee?.value}", not "${vendor.name}"`
    );
  }

  if (kind.tracked) return { side: kind.tracked.side };

  const apCents = kind.apCents!(txn, vendor.value, apAccountIds);
  if (apCents === 0) {
    throw new Error(`${nameOf(type, txn)} posts nothing to Accounts Payable for "${vendor.name}"`);
  }
  return { side: apCents > 0 ? "charge" : "credit", apCents };
}

/**
 * Cents the vendor's existing bill payments already apply to each linked
 * transaction, keyed `${TxnType}:${TxnId}`. One paginated, vendor-filtered
 * scan. A truncated scan throws: a partly known applied total must never reach
 * a money-moving preview.
 */
export async function appliedByLinkedTxn(
  client: QuickBooks,
  vendorId: string,
  vendorName: string = vendorId,
): Promise<Map<string, number>> {
  const result = await paginatedQuery(fetcherForEntity(client, "BillPayment", "findBillPayments"), {
    maxResults: SAFETY_LIMIT,
    startPosition: null,
    baseCriteria: `WHERE VendorRef = '${vendorId.replace(/'/g, "\\'")}'`,
  });
  if (result.truncated) {
    throw new Error(
      `The amount already applied for vendor "${vendorName}" could not be totalled: ` +
      `it has more than ${SAFETY_LIMIT} bill payments`
    );
  }

  const applied = new Map<string, number>();
  for (const bp of result.entities as Array<{ Line?: Array<{ Amount?: number; LinkedTxn?: Array<{ TxnId: string; TxnType: string }> }> }>) {
    for (const line of bp.Line ?? []) {
      const cents = toCents(line.Amount ?? 0);
      for (const txn of line.LinkedTxn ?? []) {
        const key = `${txn.TxnType}:${txn.TxnId}`;
        applied.set(key, sumCents([applied.get(key) ?? 0, cents]));
      }
    }
  }
  return applied;
}

async function apAccountIdsOf(client: QuickBooks): Promise<Set<string>> {
  const cache = await getAccountCache(client);
  return new Set(cache.items.filter((a) => a.AccountType === "Accounts Payable").map((a) => a.Id));
}

/**
 * Fetch, check ownership, classify and size every request for the create path,
 * in request order. The account cache and the applied scan are read only when a
 * derived kind is requested.
 */
export async function resolveLinks(
  client: QuickBooks,
  vendor: VendorRef,
  requests: LinkRequest[],
): Promise<ResolvedLink[]> {
  const txns = await mapWithConcurrency(requests, LINK_READ_CONCURRENCY, (r) =>
    LINK_KINDS[r.type].fetch(client, r.id)
  );

  const derived = requests.some((r) => !LINK_KINDS[r.type].tracked);
  const [apAccountIds, applied] = derived
    ? await Promise.all([apAccountIdsOf(client), appliedByLinkedTxn(client, vendor.value, vendor.name)])
    : [new Set<string>(), new Map<string, number>()];

  return requests.map((request, i) => {
    const { type, id, amountCents } = request;
    const txn = txns[i];
    const { side, apCents } = classifyLink(type, txn, vendor, apAccountIds);
    const tracked = LINK_KINDS[type].tracked;
    const openCents = tracked
      ? tracked.openCents(txn)
      : Math.max(0, Math.abs(apCents!) - (applied.get(linkKey(type, id)) ?? 0));

    const name = nameOf(type, txn);
    if (amountCents === undefined && openCents === 0) {
      throw new Error(side === "charge"
        ? `${name} has no open balance — already paid?`
        : `${name} has no remaining balance — already applied?`);
    }
    const applyCents = amountCents ?? openCents;
    if (applyCents > openCents) {
      throw new Error(
        `${name}: amount $${formatDollars(applyCents)} exceeds ` +
        `${side === "charge" ? "open balance" : "available credit"} $${formatDollars(openCents)}`
      );
    }

    return { type, id, doc: txn.DocNumber, date: txn.TxnDate, side, openCents, applyCents };
  });
}

const isLinkedTxnType = (type: string): type is LinkedTxnType =>
  (LINKED_TXN_TYPES as readonly string[]).includes(type);

/**
 * The side of every transaction linked by a stored bill payment's lines, for the
 * get path, keyed `${TxnType}:${TxnId}`. Unlike `resolveLinks` it never throws
 * for a single link: a type outside the table, a failed read or a failed
 * classification leaves that side `undefined` (unknown), so a read tool cannot
 * fail because one linked transaction is unreadable. Bill and VendorCredit take
 * their fixed side without a fetch; the account cache is read only when a
 * derived kind is linked.
 */
export async function linkSides(
  client: QuickBooks,
  vendorId: string,
  lines: Array<{ LinkedTxn?: Array<{ TxnId: string; TxnType: string }> }>,
): Promise<Map<string, ApSide | undefined>> {
  const sides = new Map<string, ApSide | undefined>();
  const derived: Array<{ type: LinkedTxnType; id: string }> = [];

  for (const line of lines) {
    for (const { TxnType, TxnId } of line.LinkedTxn ?? []) {
      const key = `${TxnType}:${TxnId}`;
      if (sides.has(key)) continue;
      sides.set(key, undefined);
      if (!isLinkedTxnType(TxnType)) continue;
      const tracked = LINK_KINDS[TxnType].tracked;
      if (tracked) sides.set(key, tracked.side);
      else derived.push({ type: TxnType, id: TxnId });
    }
  }
  if (derived.length === 0) return sides;

  // Ownership is checked by id only; the name appears only in thrown messages.
  const vendor = { value: vendorId, name: vendorId };
  let apAccountIds: Set<string>;
  try {
    apAccountIds = await apAccountIdsOf(client);
  } catch {
    return sides;
  }
  await mapWithConcurrency(derived, LINK_READ_CONCURRENCY, async ({ type, id }) => {
    try {
      const txn = await LINK_KINDS[type].fetch(client, id);
      sides.set(linkKey(type, id), classifyLink(type, txn, vendor, apAccountIds).side);
    } catch {
      // Left unknown; the error is deliberately dropped, never surfaced.
    }
  });
  return sides;
}
