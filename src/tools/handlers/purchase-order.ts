// Handlers for purchase order tools.
//
// A purchase order (PO) has bill-shaped lines (see expense-lines.ts), but QBO
// stores a PO differently from what a caller would assume, and it drops or
// re-folds what it does not like without an error. Every behaviour below that
// looks defensive comes from a sandbox probe (the "Verified QBO facts" table in
// docs/issues/features/20261118-create-purchase-order.md); each helper cites the
// fact it enforces. The rule they share: refuse or normalize client-side, so the
// preview is what gets stored, then compare the booking with what was sent.

import QuickBooks from "node-quickbooks";
import {
  resolveExpenseLines,
  expenseLinePayload,
  formatResolvedExpenseLine,
  formatStoredExpenseLine,
  formatPayloadExpenseLine,
  applyExpenseLineChanges,
  type ExpenseLineInput,
  type ExpenseLineChange,
  type QboExpenseLine,
} from "./expense-lines.js";
import {
  promisify,
  promisifyWrite,
  getAccountCache,
  getClassCache,
  getVendorCache,
  resolveVendorRefExact,
  CLEARED_REF,
} from "../../client/index.js";
import { extractQueryResults } from "../../client/cache.js";
import {
  formatAddress,
  formatDollars,
  sumCents,
  toCents,
  fieldDifferences,
  outputReport,
  formatUpdateResult,
  type QBAddress,
} from "../../utils/index.js";
import { formatAttachmentLines } from "./attachment.js";

type Ref = { value: string; name?: string };

/** QBO caps a PO Ref no. (DocNumber) at 21 characters; 22 is fault 2050. */
const MAX_DOC_NUMBER = 21;
/** A line Description over 4000 characters is fault 2050. */
const MAX_DESCRIPTION = 4000;
/** ShipAddr has Line1 to Line5; Line6 is fault 2010. */
const MAX_SHIP_TO_LINES = 5;
/** The joined ShipAddr lines, separators counted, over 2000 characters are fault 6000. */
const MAX_SHIP_TO_CHARS = 2000;

const PO_STATUSES = ["Open", "Closed"] as const;
type PurchaseOrderStatus = (typeof PO_STATUSES)[number];

/**
 * A purchase order as this tool sends it and as QBO answers. Every field is
 * optional because a sparse update sends only what changed and a response may
 * omit what it did not store; `Id`, `SyncToken`, `APAccountRef` and `LinkedTxn`
 * are read-only and only ever arrive from QBO.
 */
export interface PurchaseOrderBody {
  Id?: string;
  SyncToken?: string;
  /** Set on an update so QBO changes only the keys sent. */
  sparse?: boolean;
  VendorRef?: Ref;
  TxnDate?: string;
  DocNumber?: string;
  POStatus?: string;
  ShipMethodRef?: Ref;
  ShipAddr?: QBAddress;
  /** The memo, which QBO keeps private. */
  PrivateNote?: string;
  /** The vendor message printed on the PO. */
  Memo?: string;
  TotalAmt?: number;
  APAccountRef?: Ref;
  LinkedTxn?: Array<{ TxnId: string; TxnType: string }>;
  Line?: QboExpenseLine[];
}

const SHIP_ADDR_KEYS = ["Line1", "Line2", "Line3", "Line4", "Line5"] as const;

/**
 * Split ship_to into the address rows QBO will keep.
 *
 * Sandbox facts enforced (Verified QBO facts, ShipAddr): QBO splits an embedded
 * newline into the following lines and folds rows 6 and up onto Line5, and it
 * refuses more than 2000 joined characters. So a string is split on \r?\n, and
 * so is each array element (no element can hide a newline for QBO to re-fold),
 * each row is trimmed (indentation means nothing in an address line) and blank
 * rows are dropped. More than 5 rows are refused rather than folded: folding
 * rewrites the caller's layout, and the caller knows which rows belong together.
 * Empty input is no address at all, which is how a create omits ShipAddr and an
 * edit clears it.
 */
export function normalizeShipTo(input: string | string[] | undefined): { lines: string[] } {
  const elements = input === undefined ? [] : Array.isArray(input) ? input : [input];
  const lines = elements
    .flatMap(element => String(element).split(/\r?\n/))
    .map(row => row.trim())
    .filter(row => row !== "");

  if (lines.length > MAX_SHIP_TO_LINES) {
    throw new Error(
      [
        `ship_to has ${lines.length} rows, but QuickBooks keeps ${MAX_SHIP_TO_LINES} address lines:`,
        ...lines.map((row, i) => `  ${i + 1}. ${row}`),
        `Combine rows so that at most ${MAX_SHIP_TO_LINES} remain.`,
      ].join("\n")
    );
  }

  const joinedLength = lines.join("\n").length;
  if (joinedLength > MAX_SHIP_TO_CHARS) {
    throw new Error(
      `ship_to is ${joinedLength} characters with one separator between rows, ` +
      `over QuickBooks' ${MAX_SHIP_TO_CHARS}-character limit. Shorten it.`
    );
  }

  return { lines };
}

/** The ShipAddr a normalized ship_to is sent as: Line1 to LineN only, no City or other key. */
export function shipAddrFromLines(lines: string[]): QBAddress {
  const addr: QBAddress = {};
  lines.forEach((row, i) => { addr[SHIP_ADDR_KEYS[i]] = row; });
  return addr;
}

/**
 * Refuse a Ref no. another purchase order already holds.
 *
 * Sandbox fact enforced (Verified QBO facts, DocNumber): QBO accepts a duplicate
 * DocNumber on a PO (the company has custom transaction numbers off), so nothing
 * but this query stops two POs sharing a number. The DocNumber criterion is
 * quoted and escaped by the client. `excludeId` lets an edit keep its own
 * number. Runs in draft and in commit.
 */
export async function assertDocNumberFree(
  client: QuickBooks,
  docNumber: string,
  excludeId?: string
): Promise<void> {
  const found = extractQueryResults<{
    Id: string;
    VendorRef?: Ref;
    TxnDate?: string;
  }>(
    await promisify<unknown>((cb) =>
      client.findPurchaseOrders([{ field: "DocNumber", value: docNumber, operator: "=" }], cb)
    ),
    "PurchaseOrder"
  );

  const holder = found.find(po => po.Id !== excludeId);
  if (holder) {
    throw new Error(
      `Ref no. ${docNumber} is already used by purchase order ${holder.Id} ` +
      `(${holder.VendorRef?.name || holder.VendorRef?.value || "no vendor"}, ${holder.TxnDate || "no date"}). ` +
      `Pick another, or omit doc_number to have QuickBooks assign one.`
    );
  }
}

/**
 * Trim the two header strings a stray space would corrupt.
 *
 * QBO stores a Ref no. and a Ship via exactly as sent, so a trailing space
 * would be booked, and the preview (which shows the trimmed text a reader sees)
 * would no longer be what was stored. Create and edit both go through here so
 * the two cannot disagree; `""` stays `""`, which each caller reads in its own
 * way (absent on create, a clear on edit for ship_method, a refusal on edit
 * for doc_number).
 */
export function trimHeaderText(input: { doc_number?: string; ship_method?: string }): {
  doc_number?: string;
  ship_method?: string;
} {
  return { doc_number: input.doc_number?.trim(), ship_method: input.ship_method?.trim() };
}

/** A line Description is at most 4000 characters (Verified QBO facts, Description: 4001 gives fault 2050). */
export function assertDescriptionLength(description: string | undefined, label: string): void {
  if (description && description.length > MAX_DESCRIPTION) {
    throw new Error(
      `${label} description is ${description.length} characters, over QuickBooks' ${MAX_DESCRIPTION}-character limit.`
    );
  }
}

/** doc_number must be 1 to 21 characters (Verified QBO facts, DocNumber: 22 gives fault 2050). */
export function assertDocNumberLength(docNumber: string): void {
  if (docNumber.length > MAX_DOC_NUMBER) {
    throw new Error(
      `doc_number "${docNumber}" is ${docNumber.length} characters, over QuickBooks' ${MAX_DOC_NUMBER}-character limit.`
    );
  }
}

// A value as the comparison sees it: an absent key, null and "" are all
// "nothing", which is how QBO answers a cleared field.
const text = (value: unknown): string | undefined =>
  value === undefined || value === null || value === "" ? undefined : String(value);

const money = (dollars: number | undefined): string | undefined =>
  dollars === undefined ? undefined : formatDollars(toCents(dollars));

// Compare two refs by value (the name QBO adds, or changes, is not a difference),
// naming both sides in full only when they do differ.
function refRow(label: string, sent: Ref | undefined, booked: Ref | undefined) {
  const describe = (ref: Ref | undefined) =>
    text(ref?.value) === undefined ? undefined : ref!.name ? `${ref!.name} (id ${ref!.value})` : ref!.value;
  return text(sent?.value) === text(booked?.value)
    ? { label, sent: text(sent?.value), booked: text(booked?.value) }
    : { label, sent: describe(sent), booked: describe(booked) };
}

/**
 * How QBO booked a purchase order differently from what was sent; empty when it
 * matches.
 *
 * Sandbox facts enforced: QBO accepts a PO with HTTP 200 and still drops a field
 * (DueDate, SalesTermRef, a header ClassRef are silently dropped) or re-folds
 * address lines, so a 200 is not proof the preview was booked. The create
 * response carries the booked record, so this compares with no further QBO call.
 *
 * The comparison is field by field over only the keys `sent` carries, so an
 * edit's partial payload is checked on what it changed and a UI-entered City or
 * PostalCode is never a false alarm. For a payload with `Line`, every line is
 * compared by position (DetailType, item or account ref value, Description,
 * Amount, Qty, ClassRef value, CustomerRef value) and the total is the sum of
 * the sent amounts. ShipAddr compares Line1 to Line5 only, and a cleared field
 * (`{}` or `{ value: "" }`) matches an absent or empty one. Money compares in
 * cents. The response's extra keys (ShipAddr Id, the ShipMethodRef name,
 * APAccountRef, line Ids) are never read.
 */
export function poBookedDifferences(sent: PurchaseOrderBody, booked: PurchaseOrderBody): string[] {
  const rows: Array<{ label: string; sent: string | undefined; booked: string | undefined }> = [];
  const scalar = (label: string, sentValue: unknown, bookedValue: unknown, key: keyof PurchaseOrderBody) => {
    if (sent[key] !== undefined) rows.push({ label, sent: text(sentValue), booked: text(bookedValue) });
  };

  if (sent.VendorRef !== undefined) rows.push(refRow("Vendor", sent.VendorRef, booked.VendorRef));
  scalar("Date", sent.TxnDate, booked.TxnDate, "TxnDate");
  scalar("Ref no.", sent.DocNumber, booked.DocNumber, "DocNumber");
  scalar("Status", sent.POStatus, booked.POStatus, "POStatus");
  if (sent.ShipMethodRef !== undefined) rows.push(refRow("Ship via", sent.ShipMethodRef, booked.ShipMethodRef));
  if (sent.ShipAddr !== undefined) {
    SHIP_ADDR_KEYS.forEach((key, i) => {
      rows.push({ label: `Ship to line ${i + 1}`, sent: text(sent.ShipAddr![key]), booked: text(booked.ShipAddr?.[key]) });
    });
  }
  scalar("Memo", sent.PrivateNote, booked.PrivateNote, "PrivateNote");
  scalar("Vendor message", sent.Memo, booked.Memo, "Memo");

  if (sent.Line !== undefined) {
    const sentLines = sent.Line;
    const bookedLines = booked.Line ?? [];
    rows.push({
      label: "Total",
      sent: formatDollars(sumCents(sentLines.map(l => toCents(l.Amount)))),
      booked: money(booked.TotalAmt),
    });
    rows.push({ label: "Lines", sent: String(sentLines.length), booked: String(bookedLines.length) });

    for (let i = 0; i < Math.min(sentLines.length, bookedLines.length); i++) {
      const s = sentLines[i];
      const b = bookedLines[i];
      const n = `Line ${i + 1}`;
      const sentItem = s.ItemBasedExpenseLineDetail;
      const bookedItem = b.ItemBasedExpenseLineDetail;
      const sentDetail = sentItem ?? s.AccountBasedExpenseLineDetail;
      const bookedDetail = bookedItem ?? b.AccountBasedExpenseLineDetail;

      rows.push({ label: `${n} type`, sent: text(s.DetailType), booked: text(b.DetailType) });
      rows.push(
        sentItem
          ? refRow(`${n} item`, sentItem.ItemRef, bookedItem?.ItemRef)
          : refRow(`${n} account`, s.AccountBasedExpenseLineDetail?.AccountRef, b.AccountBasedExpenseLineDetail?.AccountRef)
      );
      rows.push({ label: `${n} description`, sent: text(s.Description), booked: text(b.Description) });
      rows.push({ label: `${n} amount`, sent: money(s.Amount), booked: money(b.Amount) });
      if (sentItem?.Qty !== undefined) {
        rows.push({ label: `${n} qty`, sent: text(sentItem.Qty), booked: text(bookedItem?.Qty) });
      }
      rows.push(refRow(`${n} class`, sentDetail?.ClassRef, bookedDetail?.ClassRef));
      rows.push(refRow(`${n} customer`, sentDetail?.CustomerRef, bookedDetail?.CustomerRef));
    }
  }

  return fieldDifferences(rows);
}

// The rows of a created PO that say what QBO stored beyond the one-line summary.
function bookedLines(po: PurchaseOrderBody): string[] {
  return [
    `Ship via: ${po.ShipMethodRef?.name || po.ShipMethodRef?.value || "(none)"}`,
    ...formatAddress(po.ShipAddr, "Ship to"),
    `Memo: ${po.PrivateNote || "(none)"}`,
    `Vendor message: ${po.Memo || "(none)"}`,
    `Total: $${(po.TotalAmt ?? 0).toFixed(2)}`,
    "Lines:",
    ...(po.Line ?? []).flatMap(line => formatStoredExpenseLine(line, { descriptionLayout: "indented" }) ?? []),
  ];
}

export async function handleCreatePurchaseOrder(
  client: QuickBooks,
  args: {
    vendor_name?: string;
    vendor_id?: string;
    txn_date: string;
    doc_number?: string;
    status?: PurchaseOrderStatus;
    ship_method?: string;
    ship_to?: string | string[];
    memo?: string;
    vendor_message?: string;
    lines: ExpenseLineInput[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const {
    vendor_name, vendor_id, txn_date, status = "Open",
    ship_to, memo, vendor_message, lines, draft = true,
  } = args;
  const { doc_number, ship_method } = trimHeaderText(args);

  if (!lines || lines.length === 0) {
    throw new Error("At least one line is required");
  }
  if (!PO_STATUSES.includes(status)) {
    throw new Error(`status must be one of ${PO_STATUSES.join(", ")} (got "${status}").`);
  }

  const [acctCache, classCache, vendorCache] = await Promise.all([
    getAccountCache(client),
    getClassCache(client),
    getVendorCache(client),
  ]);

  // Every refusal below runs in draft and in commit and before any write.
  // Order: exact vendor and items (the lines' amounts resolve with them), line
  // description length, ship_to, the doc_number length, then the duplicate lookup.
  let vendorRef: { value: string; name: string };
  if (vendor_id) {
    vendorRef = resolveVendorRefExact(vendorCache, vendor_id, "id");
  } else if (vendor_name) {
    vendorRef = resolveVendorRefExact(vendorCache, vendor_name, "name");
  } else {
    throw new Error("Either vendor_name or vendor_id is required");
  }

  const resolvedLines = await resolveExpenseLines(client, lines, {
    accounts: acctCache,
    classes: classCache,
    itemMatch: "exact",
  });
  resolvedLines.forEach((line, i) => assertDescriptionLength(line.description, `Line ${i + 1}`));

  const shipTo = normalizeShipTo(ship_to).lines;

  // "" means absent (QBO auto-assigns), as on create_bill.
  if (doc_number) {
    assertDocNumberLength(doc_number);
    await assertDocNumberFree(client, doc_number);
  }

  const totalCents = sumCents(resolvedLines.map(l => l.amount_cents));

  const poObject: PurchaseOrderBody = {
    VendorRef: vendorRef,
    TxnDate: txn_date,
    POStatus: status,
    ...(doc_number && { DocNumber: doc_number }),
    ...(ship_method && { ShipMethodRef: { value: ship_method, name: ship_method } }),
    ...(shipTo.length > 0 && { ShipAddr: shipAddrFromLines(shipTo) }),
    ...(memo && { PrivateNote: memo }),
    ...(vendor_message && { Memo: vendor_message }),
    Line: resolvedLines.map(expenseLinePayload),
  };

  if (draft) {
    // The Ship to rows and every line are read off what the payload carries, so
    // the preview cannot say something the write does not send.
    const preview = [
      "DRAFT - Purchase Order Preview",
      "",
      `Vendor: ${vendorRef.name}`,
      `Date: ${txn_date}`,
      `Ref no.: ${doc_number || "(auto-assign)"}`,
      `Status: ${status}`,
      `Ship via: ${poObject.ShipMethodRef?.name || "(none)"}`,
      ...formatAddress(poObject.ShipAddr, "Ship to"),
      `Memo: ${memo || "(none)"}`,
      `Vendor message: ${vendor_message || "(none)"}`,
      `Total: $${formatDollars(totalCents)}`,
      "",
      "Lines:",
      ...resolvedLines.map(l => formatResolvedExpenseLine(l, { descriptionLayout: "indented" })),
      "",
      "Set draft=false to create this purchase order.",
    ].join("\n");

    return { content: [{ type: "text", text: preview }] };
  }

  const result = await promisifyWrite<unknown>((cb) =>
    client.createPurchaseOrder(poObject, cb)
  ) as PurchaseOrderBody;

  const summary = [
    `ID: ${result.Id}`,
    `Vendor: ${vendorRef.name}`,
    `Ref no.: ${result.DocNumber || "(auto-assigned)"}`,
    `Date: ${txn_date}`,
    `Status: ${result.POStatus || status}`,
  ];

  // Returned, not thrown: the purchase order exists, so the caller must be told
  // what was booked rather than see a failure and retry. Nothing is undone here.
  const differences = poBookedDifferences(poObject, result);
  if (differences.length > 0) {
    const mismatch = [
      "Purchase Order Created — NOT AS PREVIEWED",
      "",
      `QuickBooks created purchase order ${result.Id} but booked it differently from what was sent:`,
      ...differences.map(d => `  ${d}`),
      "",
      "Booked by QuickBooks:",
      ...bookedLines(result),
      "",
      ...summary,
      "",
      "Nothing was undone. Review this purchase order in QuickBooks; if it is not wanted, delete it with " +
        `delete_entity (entity_type "purchase_order", id "${result.Id}").`,
      "Do not re-run create_purchase_order for this purchase order: a repeat would book a second one.",
    ].join("\n");

    return { content: [{ type: "text", text: mismatch }], isError: true };
  }

  const response = [
    "Purchase Order Created!",
    "",
    ...summary,
    `Total: $${formatDollars(totalCents)}`,
  ].join("\n");

  return { content: [{ type: "text", text: response }] };
}

export async function handleGetPurchaseOrder(
  client: QuickBooks,
  args: { id: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const po = await promisify<unknown>((cb) => client.getPurchaseOrder(args.id, cb)) as PurchaseOrderBody;
  const id = String(po.Id ?? args.id);

  const lines: string[] = [
    "Purchase Order",
    "==============",
    `ID: ${id}`,
    `SyncToken: ${po.SyncToken}`,
    `Vendor: ${po.VendorRef?.name || po.VendorRef?.value || "(none)"}`,
    `Date: ${po.TxnDate}`,
    `Ref no.: ${po.DocNumber || "(none)"}`,
    `Status: ${po.POStatus || "(none)"}`,
    `Ship via: ${po.ShipMethodRef?.name || po.ShipMethodRef?.value || "(none)"}`,
    ...formatAddress(po.ShipAddr, "Ship to"),
    `Memo: ${po.PrivateNote || "(none)"}`,
    `Vendor message: ${po.Memo || "(none)"}`,
    `AP Account: ${po.APAccountRef?.name || po.APAccountRef?.value || "Accounts Payable"}`,
    `Total: $${(po.TotalAmt ?? 0).toFixed(2)}`,
    "",
    "Lines:",
  ];

  for (const line of po.Line ?? []) {
    const row = formatStoredExpenseLine(line, { descriptionLayout: "indented" });
    if (row !== undefined) lines.push(row);
  }

  const linked = (po.LinkedTxn ?? []).map(t => `Linked: ${t.TxnType} ${t.TxnId}`);
  if (linked.length > 0) lines.push("", ...linked);

  lines.push("", ...(await formatAttachmentLines(client, "PurchaseOrder", id)));

  return outputReport(`purchase-order-${id}`, po, lines.join("\n"));
}

/**
 * Edit a purchase order: always sparse, and minimal.
 *
 * The payload is `{ Id, SyncToken, sparse: true }` plus exactly the fields this
 * call changes (Verified QBO facts: a sparse update needs no VendorRef). With
 * `lines` it is the full Line array, because a sparse update replaces Line
 * wholesale: the stored lines minus LineNum, with the changes applied by
 * applyExpenseLineChanges (exact item match). A stored line no change names is
 * never re-resolved, so a line whose item has gone inactive survives an edit of
 * another line.
 *
 * ship_to is a whole replacement (QBO replaces ShipAddr wholesale, which also
 * drops a UI-entered City or PostalCode), and `""` or `[]` clears it with
 * `ShipAddr: {}`. `ship_method: ""` clears via CLEARED_REF. After the write the
 * booking is compared with what was sent, and only what was sent: a field the
 * edit did not name is never read, so it cannot raise a false alarm.
 */
export async function handleEditPurchaseOrder(
  client: QuickBooks,
  args: {
    id: string;
    vendor_name?: string;
    vendor_id?: string;
    txn_date?: string;
    doc_number?: string;
    status?: PurchaseOrderStatus;
    ship_method?: string;
    ship_to?: string | string[];
    memo?: string;
    vendor_message?: string;
    lines?: ExpenseLineChange[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const { id, vendor_name, vendor_id, txn_date, status, ship_to, memo, vendor_message, lines: lineChanges, draft = true } = args;
  const { doc_number, ship_method } = trimHeaderText(args);

  if (status !== undefined && !PO_STATUSES.includes(status)) {
    throw new Error(`status must be one of ${PO_STATUSES.join(", ")} (got "${status}").`);
  }
  // An empty array would send no line change at all, which on its own is an
  // empty edit; say so rather than letting it pass as "lines were handled".
  if (lineChanges !== undefined && lineChanges.length === 0) {
    throw new Error("lines is empty. Give at least one line change, or omit lines to leave the lines as they are.");
  }

  const current = await promisify<unknown>((cb) => client.getPurchaseOrder(id, cb)) as PurchaseOrderBody;

  // Every refusal below runs in draft and in commit and before any write.
  // Order: exact vendor and items, line description length, ship_to, the
  // doc_number checks, then the duplicate lookup (as on create).
  let vendorRef: { value: string; name: string } | undefined;
  if (vendor_id !== undefined || vendor_name !== undefined) {
    const vendorCache = await getVendorCache(client);
    vendorRef = vendor_id
      ? resolveVendorRefExact(vendorCache, vendor_id, "id")
      : resolveVendorRefExact(vendorCache, vendor_name ?? "", "name");
  }

  let newLines: QboExpenseLine[] | undefined;
  if (lineChanges) {
    newLines = await applyExpenseLineChanges(client, current.Line ?? [], lineChanges, {
      entityLabel: "purchase order",
      itemMatch: "exact",
    });
    // A purchase order needs at least one line, as on create; refuse an edit
    // that deletes them all rather than leave the refusal to QuickBooks.
    if (newLines.length === 0) {
      throw new Error("At least one line is required: this edit would delete every line on the purchase order");
    }
    lineChanges.forEach((change, i) =>
      assertDescriptionLength(change.description, change.line_id ? `Line ${change.line_id}` : `New line (lines[${i}])`)
    );
  }

  const shipTo = ship_to === undefined ? undefined : normalizeShipTo(ship_to).lines;

  if (doc_number !== undefined) {
    if (doc_number === "") {
      throw new Error(
        "doc_number cannot be empty on an edit: QuickBooks keeps the Ref no. it has. " +
        "Give the new number, or omit doc_number to leave it."
      );
    }
    assertDocNumberLength(doc_number);
    await assertDocNumberFree(client, doc_number, id);
  }

  const updated: PurchaseOrderBody = {
    Id: current.Id,
    SyncToken: current.SyncToken,
    sparse: true,
    ...(vendorRef && { VendorRef: vendorRef }),
    ...(txn_date !== undefined && { TxnDate: txn_date }),
    ...(doc_number !== undefined && { DocNumber: doc_number }),
    ...(status !== undefined && { POStatus: status }),
    ...(ship_method !== undefined && {
      ShipMethodRef: ship_method === "" ? CLEARED_REF : { value: ship_method, name: ship_method },
    }),
    ...(shipTo !== undefined && { ShipAddr: shipAddrFromLines(shipTo) }),
    ...(memo !== undefined && { PrivateNote: memo }),
    ...(vendor_message !== undefined && { Memo: vendor_message }),
    ...(newLines && { Line: newLines }),
  };

  if (draft) {
    // Every row is read off the payload (or the stored record, for "before"),
    // so the preview cannot say something the write does not send.
    const preview = [
      "DRAFT - Purchase Order Edit Preview",
      "",
      `ID: ${id}`,
      `SyncToken: ${current.SyncToken}`,
      "",
      "Changes:",
    ];
    const change = (label: string, before: string | undefined, after: string | undefined) =>
      preview.push(`  ${label}: ${before || "(none)"} → ${after || "(none)"}`);

    if (vendorRef) change("Vendor", current.VendorRef?.name || current.VendorRef?.value, vendorRef.name);
    if (txn_date !== undefined) change("Date", current.TxnDate, txn_date);
    if (doc_number !== undefined) change("Ref no.", current.DocNumber, doc_number);
    if (status !== undefined) change("Status", current.POStatus, status);
    if (ship_method !== undefined) {
      change("Ship via", current.ShipMethodRef?.name || current.ShipMethodRef?.value, ship_method);
    }
    if (memo !== undefined) change("Memo", current.PrivateNote, memo);
    if (vendor_message !== undefined) change("Vendor message", current.Memo, vendor_message);
    if (updated.ShipAddr) {
      preview.push(
        ...formatAddress(current.ShipAddr, "Ship to (before)"),
        ...formatAddress(updated.ShipAddr, "Ship to (after)"),
        "  Note: ship_to replaces the whole address; any city, state or postal code now stored on it is removed."
      );
    }

    if (updated.Line) {
      preview.push("", "Updated Lines:");
      for (const line of updated.Line) {
        const row = formatPayloadExpenseLine(line, { description: true });
        if (row !== undefined) preview.push(row);
      }
    }

    preview.push("", "Set draft=false to apply these changes.");
    return { content: [{ type: "text", text: preview.join("\n") }] };
  }

  const result = await promisifyWrite<unknown>((cb) =>
    client.updatePurchaseOrder(updated, cb)
  ) as PurchaseOrderBody;

  // Returned, not thrown: the purchase order was updated, so the caller must be
  // told what was booked rather than see a failure and retry. Nothing is undone.
  const differences = poBookedDifferences(updated, result);
  if (differences.length > 0) {
    const mismatch = [
      "Purchase Order Updated — NOT AS PREVIEWED",
      "",
      `QuickBooks updated purchase order ${id} but booked it differently from what was sent:`,
      ...differences.map(d => `  ${d}`),
      "",
      "Booked by QuickBooks:",
      ...bookedLines(result),
      "",
      `ID: ${id}`,
      `New SyncToken: ${result.SyncToken}`,
      "",
      "Nothing was undone. Read the purchase order back with get_purchase_order before editing it again, " +
        "because its SyncToken has advanced.",
    ].join("\n");

    return { content: [{ type: "text", text: mismatch }], isError: true };
  }

  return {
    content: [{ type: "text", text: formatUpdateResult("Purchase Order", id, current.SyncToken, result.SyncToken) }],
  };
}
