// Handlers for bill tools (create, get, edit)

import QuickBooks from "node-quickbooks";
import { formatAttachmentLines } from "./attachment.js";
import {
  resolveExpenseLines,
  expenseLinePayload,
  formatResolvedExpenseLine,
  formatStoredExpenseLine,
  applyExpenseLineChanges,
  formatPayloadExpenseLine,
  type ExpenseLineInput,
  type ExpenseLineChange,
  type QboExpenseLine,
} from "./expense-lines.js";
import {
  promisify,
  promisifyWrite,
  getAccountCache,
  getClassCache,
  getDepartmentCache,
  getVendorCache,
  getTermCache,
  describeTermRef,
  resolveVendor,
  resolveAccountRef,
  resolveVendorRef,
  resolveDepartmentInput,
  CLEARED_REF,
  resolveTermRef,
  termDueDays,
  toQboRef,
  type TermRef,
} from "../../client/index.js";
import { buildQboUrl, formatDollars, sumCents, outputReport, formatUpdateResult, addDays, isIsoDate } from "../../utils/index.js";

interface PlannedDueDate {
  date?: string;   // DueDate to send; undefined omits the key
  note: string;    // preview annotation; "" when there is nothing to say
}

// The one due-date rule create_bill and edit_bill share, so the payload and the
// preview can never disagree. An explicit date always wins and is sent as given;
// terms only fill in a date the caller left out, computed here rather than left
// for QBO to derive. A term with no fixed day count, or a txn_date that is not a
// real date, cannot be computed from and is refused. The same two conditions
// only skip the "terms would give a different date" hint when a date was given.
function planDueDate(given: string | undefined, term: TermRef | undefined, txnDate: string): PlannedDueDate {
  const days = term ? termDueDays(term) : undefined;

  if (given !== undefined) {
    if (!term || given === "" || days === undefined || !isIsoDate(txnDate)) {
      return { date: given, note: "" };
    }
    const computed = addDays(txnDate, days);
    return { date: given, note: computed === given ? "" : `(as given; ${term.name} gives ${computed})` };
  }

  if (!term) return { note: "" };
  if (days === undefined) {
    throw new Error(
      `Terms "${term.name}" have no fixed number of days (Type ${term.type ?? "unknown"}), ` +
      `so the due date cannot be computed from them — pass due_date.`
    );
  }
  if (!isIsoDate(txnDate)) {
    throw new Error(
      `txn_date "${txnDate}" is not a valid YYYY-MM-DD date, so the due date cannot be ` +
      `computed from terms "${term.name}" — fix txn_date or pass due_date.`
    );
  }
  return {
    date: addDays(txnDate, days),
    note: `(${term.name}: ${days} ${days === 1 ? "day" : "days"} after ${txnDate})`,
  };
}

// Append a planned annotation to a Due Date value, adding no space when empty.
const withNote = (value: string, note: string): string => (note ? `${value} ${note}` : value);

export async function handleCreateBill(
  client: QuickBooks,
  args: {
    vendor_name?: string;
    vendor_id?: string;
    txn_date: string;
    due_date?: string;
    sales_term_ref?: string;
    department_name?: string;
    department_id?: string;
    ap_account?: string;
    memo?: string;
    doc_number?: string;
    lines: ExpenseLineInput[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    vendor_name, vendor_id, txn_date, due_date, sales_term_ref,
    department_name, department_id, ap_account,
    memo, doc_number, lines, draft = true,
  } = args;

  if (!lines || lines.length === 0) {
    throw new Error("At least one line is required");
  }

  // Get cached lookups
  const [acctCache, deptCache, vendorCacheData, classCacheData] = await Promise.all([
    getAccountCache(client),
    getDepartmentCache(client),
    getVendorCache(client),
    getClassCache(client),
  ]);

  // Resolve vendor
  let vendorRef: { value: string; name: string };
  if (vendor_id) {
    vendorRef = resolveVendorRef(vendorCacheData, vendor_id);
  } else if (vendor_name) {
    vendorRef = resolveVendorRef(vendorCacheData, vendor_name);
  } else {
    throw new Error("Either vendor_name or vendor_id is required");
  }

  // Resolve department (header-level). null (blank input) and undefined both
  // leave DepartmentRef off a create.
  const departmentRef = resolveDepartmentInput(deptCache, { department_id, department_name }) ?? undefined;

  // Resolve AP account if specified
  let apAccountRef: { value: string; name: string } | undefined;
  if (ap_account) {
    // QBO requires APAccountRef to be an A/P account; restricting the match keeps
    // a loose partial hit from silently booking the bill against something else.
    const acct = resolveAccountRef(acctCache, ap_account, {
      label: "A/P account",
      accountType: "Accounts Payable",
    });
    apAccountRef = { value: acct.value, name: acct.name };
  }

  // Resolve terms before the lines, so a bad term fails before any item or
  // customer lookup. An empty string means no terms, as on create_invoice.
  const termRef = sales_term_ref ? resolveTermRef(await getTermCache(client), sales_term_ref) : undefined;
  const due = planDueDate(due_date || undefined, termRef, txn_date);

  const resolvedLines = await resolveExpenseLines(client, lines, { accounts: acctCache, classes: classCacheData });

  // Calculate total
  const totalCents = sumCents(resolvedLines.map(l => l.amount_cents));

  // Build QuickBooks Bill object
  const billObject: Record<string, unknown> = {
    VendorRef: vendorRef,
    TxnDate: txn_date,
    ...(due.date && { DueDate: due.date }),
    ...(termRef && { SalesTermRef: toQboRef(termRef) }),
    ...(memo && { PrivateNote: memo }),
    ...(doc_number && { DocNumber: doc_number }),
    ...(departmentRef && { DepartmentRef: departmentRef }),
    ...(apAccountRef && { APAccountRef: apAccountRef }),
    Line: resolvedLines.map(expenseLinePayload),
  };

  if (draft) {
    const preview = [
      "DRAFT - Bill Preview",
      "",
      `Vendor: ${vendorRef.name}`,
      `Date: ${txn_date}`,
      `Due Date: ${withNote(due.date || "(none)", due.note)}`,
      `Terms: ${termRef?.name || "(none)"}`,
      `Ref no.: ${doc_number || "(auto-assign)"}`,
      `Department: ${departmentRef?.name || "(none)"}`,
      `AP Account: ${apAccountRef?.name || "(default)"}`,
      `Memo: ${memo || "(none)"}`,
      `Total: $${formatDollars(totalCents)}`,
      "",
      "Lines:",
      ...resolvedLines.map(l => formatResolvedExpenseLine(l)),
      "",
      "Set draft=false to create this bill.",
    ].join("\n");

    return {
      content: [{ type: "text", text: preview }],
    };
  }

  // Create the bill
  const result = await promisifyWrite<unknown>((cb) =>
    client.createBill(billObject, cb)
  ) as { Id: string; DocNumber?: string };

  const qboUrl = buildQboUrl("bill", "txnId", result.Id);

  const response = [
    "Bill Created!",
    "",
    `Vendor: ${vendorRef.name}`,
    `Ref no.: ${result.DocNumber || "(auto-assigned)"}`,
    `Date: ${txn_date}`,
    `Due Date: ${due.date || "(none)"}`,
    `Terms: ${termRef?.name || "(none)"}`,
    `Total: $${formatDollars(totalCents)}`,
    "",
    `View in QuickBooks: ${qboUrl}`,
  ].join("\n");

  return {
    content: [{ type: "text", text: response }],
  };
}

export async function handleGetBill(
  client: QuickBooks,
  args: { id: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id } = args;

  const bill = await promisify<unknown>((cb) =>
    client.getBill(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    DueDate?: string;
    SalesTermRef?: { value: string; name?: string };
    DocNumber?: string;
    PrivateNote?: string;
    TotalAmt?: number;
    VendorRef?: { value: string; name?: string };
    APAccountRef?: { value: string; name?: string };
    Line?: QboExpenseLine[];
  };
  const qboUrl = buildQboUrl("bill", "txnId", bill.Id);

  // Format summary
  const lines: string[] = [
    'Bill',
    '====',
    `ID: ${bill.Id}`,
    `SyncToken: ${bill.SyncToken}`,
    `Vendor: ${bill.VendorRef?.name || bill.VendorRef?.value || '(none)'}`,
    `Date: ${bill.TxnDate}`,
    `Due Date: ${bill.DueDate || '(none)'}`,
    `Terms: ${await describeTermRef(client, bill.SalesTermRef)}`,
    `Ref no.: ${bill.DocNumber || '(none)'}`,
    `Memo: ${bill.PrivateNote || '(none)'}`,
    `AP Account: ${bill.APAccountRef?.name || bill.APAccountRef?.value || 'Accounts Payable'}`,
    `Total: $${(bill.TotalAmt || 0).toFixed(2)}`,
    '',
    'Lines:',
  ];

  for (const line of bill.Line || []) {
    const row = formatStoredExpenseLine(line);
    if (row !== undefined) lines.push(row);
  }

  lines.push('', ...(await formatAttachmentLines(client, 'Bill', bill.Id)));
  lines.push('');
  lines.push(`View in QuickBooks: ${qboUrl}`);

  return outputReport(`bill-${bill.Id}`, bill, lines.join('\n'));
}

export async function handleEditBill(
  client: QuickBooks,
  args: {
    id: string;
    vendor_name?: string;
    txn_date?: string;
    due_date?: string;
    sales_term_ref?: string;
    memo?: string;
    department_name?: string;
    doc_number?: string;
    lines?: ExpenseLineChange[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id, vendor_name, txn_date, due_date, sales_term_ref, memo, department_name, doc_number, lines: lineChanges, draft = true } = args;

  // Fetch current Bill
  const current = await promisify<unknown>((cb) =>
    client.getBill(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    DueDate?: string;
    SalesTermRef?: { value: string; name?: string };
    DocNumber?: string;
    PrivateNote?: string;
    DepartmentRef?: { value: string; name?: string };
    VendorRef: { value: string; name?: string };
    Line: QboExpenseLine[];
  };

  // Resolve vendor if changing
  const vendorRef = vendor_name
    ? await resolveVendor(client, vendor_name)
    : current.VendorRef;

  // Always sparse. A full update nulls every writable field absent from the
  // payload (it dropped SalesTermRef here). Sparse also handles line changes,
  // including deletion, provided the complete Line array is sent.
  // See docs/quickbooks-api-limitations.md.
  // Note: VendorRef is required by QB API even for sparse updates
  const updated: Record<string, unknown> = {
    Id: current.Id,
    SyncToken: current.SyncToken,
    VendorRef: vendorRef,
    sparse: true,
  };

  if (txn_date !== undefined) updated.TxnDate = txn_date;
  // Edit resolves any provided value, so "" fails resolution rather than
  // clearing terms, as on edit_invoice. The due date is computed from the date
  // the bill will have after this edit.
  const termRef = sales_term_ref !== undefined ? resolveTermRef(await getTermCache(client), sales_term_ref) : undefined;
  const due = planDueDate(due_date, termRef, txn_date ?? current.TxnDate);
  if (due.date !== undefined) updated.DueDate = due.date;
  if (termRef) updated.SalesTermRef = toQboRef(termRef);
  if (memo !== undefined) updated.PrivateNote = memo;
  if (doc_number !== undefined) updated.DocNumber = doc_number;

  // Resolve department if changing: undefined leaves it, null (blank) clears it.
  let departmentRef: { value: string; name: string } | null | undefined;
  if (department_name !== undefined) {
    departmentRef = resolveDepartmentInput(await getDepartmentCache(client), { department_name });
    if (departmentRef === null) updated.DepartmentRef = CLEARED_REF;
    else if (departmentRef) updated.DepartmentRef = departmentRef;
  }

  // A sparse update replaces Line wholesale, so the complete array is sent:
  // stored lines no change names go back as fetched.
  if (lineChanges && lineChanges.length > 0) {
    updated.Line = await applyExpenseLineChanges(client, current.Line, lineChanges, { entityLabel: "bill" });
  }

  const qboUrl = buildQboUrl("bill", "txnId", id);

  if (draft) {
    const previewLines: string[] = [
      'DRAFT - Bill Edit Preview',
      '',
      `ID: ${id}`,
      `SyncToken: ${current.SyncToken}`,
      '',
      'Changes:',
    ];

    if (vendor_name) previewLines.push(`  Vendor: ${current.VendorRef?.name || current.VendorRef?.value} → ${(vendorRef as { name?: string }).name || vendor_name}`);
    if (txn_date !== undefined) previewLines.push(`  Date: ${current.TxnDate} → ${txn_date}`);
    if (due.date !== undefined) previewLines.push(`  Due Date: ${current.DueDate || '(none)'} → ${withNote(due.date, due.note)}`);
    if (termRef) previewLines.push(`  Terms: ${await describeTermRef(client, current.SalesTermRef)} → ${termRef.name}`);
    if (memo !== undefined) previewLines.push(`  Memo: ${current.PrivateNote || '(none)'} → ${memo}`);
    if (doc_number !== undefined) previewLines.push(`  Ref no.: ${current.DocNumber || '(none)'} → ${doc_number}`);
    if (department_name !== undefined) previewLines.push(`  Department: ${current.DepartmentRef?.name || '(none)'} → ${departmentRef?.name || '(none)'}`);

    // Changing txn_date alone leaves the due date as it is (a call without terms
    // sends today's payload), so say so on a bill whose terms would move it.
    if (txn_date !== undefined && due.date === undefined && current.SalesTermRef?.value) {
      previewLines.push('');
      previewLines.push(
        `Note: this bill's terms are ${await describeTermRef(client, current.SalesTermRef)}, but its due date ` +
        `(${current.DueDate || '(none)'}) is not part of this edit. Pass sales_term_ref with the same term to recompute it from the new date.`
      );
    }

    if (updated.Line) {
      previewLines.push('');
      previewLines.push('Updated Lines:');
      // Rows are read off the built payload (see formatPayloadExpenseLine).
      // Bill's preview has never shown descriptions.
      for (const line of updated.Line as QboExpenseLine[]) {
        const row = formatPayloadExpenseLine(line, { description: false });
        if (row !== undefined) previewLines.push(row);
      }
    }

    previewLines.push('');
    previewLines.push('Set draft=false to apply these changes.');

    return {
      content: [{ type: "text", text: previewLines.join('\n') }],
    };
  }

  const result = await promisifyWrite<unknown>((cb) =>
    client.updateBill(updated, cb)
  ) as { Id: string; SyncToken: string };

  return {
    content: [{ type: "text", text: formatUpdateResult("Bill", id, current.SyncToken, result.SyncToken, qboUrl) }],
  };
}
