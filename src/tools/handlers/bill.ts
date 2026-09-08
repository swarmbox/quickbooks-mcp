// Handlers for bill tools (create, get, edit)

import QuickBooks from "node-quickbooks";
import {
  promisify,
  promisifyWrite,
  getAccountCache,
  getClassCache,
  getDepartmentCache,
  getVendorCache,
  resolveVendor,
  resolveAccountRef,
  resolveVendorRef,
  resolveClassRef,
  resolveClassInput,
  resolveItemInput,
  resolveCustomerInput,
  toQboRef,
} from "../../client/index.js";
import { buildQboUrl, validateAmount, toDollars, formatDollars, sumCents, outputReport, formatUpdateResult, resolveItemLineAmount } from "../../utils/index.js";

// A bill's payee is its header VendorRef — by definition a vendor, so there is
// no entity_type to pick. Line-level attribution is
// AccountBasedExpenseLineDetail.CustomerRef, which only accepts a customer;
// hence customer_name rather than entity_name here.
interface CreateBillLine {
  account_id?: string;
  account_name?: string;
  item_id?: string;
  item_name?: string;
  qty?: number;
  unit_price?: number;
  amount?: number;
  description?: string;
  class_id?: string;
  class_name?: string;
  customer_name?: string;
  customer_id?: string;
}

interface BillLineChange {
  line_id?: string;
  account_name?: string;
  item_id?: string;
  item_name?: string;
  qty?: number;
  unit_price?: number;
  amount?: number;
  description?: string;
  class_id?: string;
  class_name?: string;
  customer_name?: string;
  customer_id?: string;
  delete?: boolean;
}

export async function handleCreateBill(
  client: QuickBooks,
  args: {
    vendor_name?: string;
    vendor_id?: string;
    txn_date: string;
    due_date?: string;
    department_name?: string;
    department_id?: string;
    ap_account?: string;
    memo?: string;
    doc_number?: string;
    lines: CreateBillLine[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    vendor_name, vendor_id, txn_date, due_date,
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

  // Resolve department (header-level)
  let departmentRef: { value: string; name: string } | undefined;
  const deptInput = department_id || department_name;
  if (deptInput) {
    const byId = deptCache.byId.get(deptInput);
    if (byId) {
      departmentRef = { value: byId.Id, name: byId.FullyQualifiedName || byId.Name };
    } else {
      const byName = deptCache.byName.get(deptInput.toLowerCase());
      if (byName) {
        departmentRef = { value: byName.Id, name: byName.FullyQualifiedName || byName.Name };
      } else {
        const byPartial = deptCache.items.find(d =>
          d.FullyQualifiedName?.toLowerCase().includes(deptInput.toLowerCase())
        );
        if (byPartial) {
          departmentRef = { value: byPartial.Id, name: byPartial.FullyQualifiedName || byPartial.Name };
        } else {
          throw new Error(`Department not found: "${deptInput}"`);
        }
      }
    }
  }

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

  // Resolve lines. Item and customer resolution can hit the API, so this is a
  // loop. A line posts against an item or an account, never both.
  const resolvedLines: Array<CreateBillLine & {
    account_id?: string;
    account_num?: string;
    amount_cents: number;
    amount: number;
    item_ref?: { value: string; name: string };
    class_ref?: { value: string; name: string };
    customer_ref?: { value: string; name: string };
  }> = [];
  for (const [index, line] of lines.entries()) {
    const label = `Line ${index + 1}`;
    const itemInput = line.item_id || line.item_name;
    const accountInput = line.account_id || line.account_name;

    if (itemInput && accountInput) {
      throw new Error(
        `${label} names both an item ("${itemInput}") and an account ("${accountInput}"). ` +
        `A line posts against one or the other — drop whichever does not apply.`
      );
    }
    if (!itemInput && !accountInput) {
      throw new Error(`${label} must have an item (item_name/item_id) or an account (account_name/account_id)`);
    }

    const classRef = resolveClassInput(classCacheData, line, label);
    const customerRef = await resolveCustomerInput(client, line, label);

    if (itemInput) {
      const itemRef = await resolveItemInput(client, line, label);
      // resolveItemLineAmount owns the whole triple: the precondition, the
      // qty > 0 and non-finite guards, and the reconcile-assert that keeps
      // Qty x UnitPrice rounding back to Amount. Do not re-guard any of it.
      const { qty, unitPriceDollars, amountCents } = resolveItemLineAmount(line, label);
      resolvedLines.push({
        ...line,
        amount_cents: amountCents,
        amount: toDollars(amountCents),
        item_ref: itemRef ?? undefined,
        class_ref: classRef ?? undefined,
        customer_ref: customerRef ?? undefined,
        qty,
        unit_price: unitPriceDollars,
      });
      continue;
    }

    let accountId = line.account_id;
    let accountName = line.account_name;
    let accountNum: string | undefined;
    if (!accountId && accountName) {
      const account = resolveAccountRef(acctCache, accountName);
      accountId = account.value;
      accountName = account.name;
      accountNum = account.acctNum;
    }

    if (line.amount === undefined) {
      throw new Error(`${label} requires an amount`);
    }
    const amountCents = validateAmount(line.amount, label);

    resolvedLines.push({
      ...line,
      account_id: accountId!,
      account_name: accountName,
      account_num: accountNum,
      amount_cents: amountCents,
      class_ref: classRef ?? undefined,
      customer_ref: customerRef ?? undefined,
      amount: toDollars(amountCents),
    });
  }

  // Calculate total
  const totalCents = sumCents(resolvedLines.map(l => l.amount_cents));

  // Build QuickBooks Bill object
  const billObject: Record<string, unknown> = {
    VendorRef: vendorRef,
    TxnDate: txn_date,
    ...(due_date && { DueDate: due_date }),
    ...(memo && { PrivateNote: memo }),
    ...(doc_number && { DocNumber: doc_number }),
    ...(departmentRef && { DepartmentRef: departmentRef }),
    ...(apAccountRef && { APAccountRef: apAccountRef }),
    Line: resolvedLines.map((line) => {
      const base = {
        Amount: line.amount,
        ...(line.description && { Description: line.description }),
      };
      if (line.item_ref) {
        return {
          ...base,
          DetailType: "ItemBasedExpenseLineDetail",
          ItemBasedExpenseLineDetail: {
            ItemRef: line.item_ref,
            Qty: line.qty,
            UnitPrice: line.unit_price,
            // Same NotBillable reasoning as the account branch below.
            BillableStatus: "NotBillable",
            ...(line.class_ref && { ClassRef: line.class_ref }),
            ...(line.customer_ref && { CustomerRef: line.customer_ref }),
          },
        };
      }
      return {
        ...base,
        DetailType: "AccountBasedExpenseLineDetail",
        AccountBasedExpenseLineDetail: {
          AccountRef: {
            value: line.account_id,
            name: line.account_name,
          },
          // NotBillable is deliberate even with a CustomerRef: the line
          // attributes cost to a customer without queuing it for re-invoicing.
          BillableStatus: "NotBillable",
          ...(line.class_ref && { ClassRef: line.class_ref }),
          ...(line.customer_ref && { CustomerRef: line.customer_ref }),
        },
      };
    }),
  };

  if (draft) {
    const formatAccount = (l: typeof resolvedLines[0]) => {
      const num = l.account_num ? `${l.account_num} ` : "";
      return `${num}${l.account_name || l.account_id}`;
    };

    const preview = [
      "DRAFT - Bill Preview",
      "",
      `Vendor: ${vendorRef.name}`,
      `Date: ${txn_date}`,
      `Due Date: ${due_date || "(none)"}`,
      `Ref no.: ${doc_number || "(auto-assign)"}`,
      `Department: ${departmentRef?.name || "(none)"}`,
      `AP Account: ${apAccountRef?.name || "(default)"}`,
      `Memo: ${memo || "(none)"}`,
      `Total: $${formatDollars(totalCents)}`,
      "",
      "Lines:",
      ...resolvedLines.map(l =>
        `  ${formatAccount(l)}: $${l.amount.toFixed(2)}${l.customer_ref ? ` [Customer: ${l.customer_ref.name}]` : ""}${l.description ? ` "${l.description}"` : ""}`
      ),
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
    DocNumber?: string;
    PrivateNote?: string;
    TotalAmt?: number;
    VendorRef?: { value: string; name?: string };
    APAccountRef?: { value: string; name?: string };
    Line?: Array<{
      Id: string;
      Amount: number;
      Description?: string;
      DetailType: string;
      AccountBasedExpenseLineDetail?: {
        AccountRef: { value: string; name?: string };
        DepartmentRef?: { value: string; name?: string };
        ClassRef?: { value: string; name?: string };
        CustomerRef?: { value: string; name?: string };
        BillableStatus?: string;
      };
      ItemBasedExpenseLineDetail?: {
        ItemRef: { value: string; name?: string };
        ClassRef?: { value: string; name?: string };
        Qty?: number;
        UnitPrice?: number;
        CustomerRef?: { value: string; name?: string };
      };
    }>;
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
    `Ref no.: ${bill.DocNumber || '(none)'}`,
    `Memo: ${bill.PrivateNote || '(none)'}`,
    `AP Account: ${bill.APAccountRef?.name || bill.APAccountRef?.value || 'Accounts Payable'}`,
    `Total: $${(bill.TotalAmt || 0).toFixed(2)}`,
    '',
    'Lines:',
  ];

  for (const line of bill.Line || []) {
    if (line.AccountBasedExpenseLineDetail) {
      const detail = line.AccountBasedExpenseLineDetail;
      const acctName = detail.AccountRef.name || detail.AccountRef.value;
      const deptStr = detail.DepartmentRef?.name ? ` [${detail.DepartmentRef.name}]` : '';
      const custStr = detail.CustomerRef?.name ? ` [Customer: ${detail.CustomerRef.name}]` : '';
      const descStr = line.Description ? ` "${line.Description}"` : '';
      lines.push(`  Line ${line.Id}: ${acctName}${deptStr}${custStr} $${line.Amount.toFixed(2)}${descStr}`);
    } else if (line.ItemBasedExpenseLineDetail) {
      const detail = line.ItemBasedExpenseLineDetail;
      const itemName = detail.ItemRef.name || detail.ItemRef.value;
      const descStr = line.Description ? ` "${line.Description}"` : '';
      lines.push(`  Line ${line.Id}: Item: ${itemName} (Qty: ${detail.Qty || 1}) $${line.Amount.toFixed(2)}${descStr}`);
    }
  }

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
    memo?: string;
    department_name?: string;
    doc_number?: string;
    lines?: BillLineChange[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id, vendor_name, txn_date, due_date, memo, department_name, doc_number, lines: lineChanges, draft = true } = args;

  // Fetch current Bill
  const current = await promisify<unknown>((cb) =>
    client.getBill(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    DueDate?: string;
    DocNumber?: string;
    PrivateNote?: string;
    DepartmentRef?: { value: string; name?: string };
    VendorRef: { value: string; name?: string };
    Line: Array<{
      Id: string;
      Amount: number;
      Description?: string;
      DetailType: string;
      AccountBasedExpenseLineDetail?: {
        AccountRef: { value: string; name?: string };
        DepartmentRef?: { value: string; name?: string };
        ClassRef?: { value: string; name?: string };
        CustomerRef?: { value: string; name?: string };
        BillableStatus?: string;
      };
      // A fetched line may be item-based. The runtime spread preserved that all
      // along; the compiler could not see it, which is how this path came to
      // coerce every line to account-based and ship a dual-detail payload.
      ItemBasedExpenseLineDetail?: {
        ItemRef: { value: string; name?: string };
        ClassRef?: { value: string; name?: string };
        CustomerRef?: { value: string; name?: string };
        BillableStatus?: string;
        Qty?: number;
        UnitPrice?: number;
      };
    }>;
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

  if (lineChanges && lineChanges.length > 0) {
    // Seed with the existing lines, stripping read-only fields
    updated.Line = current.Line.map(line => {
      const { LineNum, ...rest } = line as Record<string, unknown>;
      return rest;
    });
  }

  if (txn_date !== undefined) updated.TxnDate = txn_date;
  if (due_date !== undefined) updated.DueDate = due_date;
  if (memo !== undefined) updated.PrivateNote = memo;
  if (doc_number !== undefined) updated.DocNumber = doc_number;

  // Resolve department if changing
  if (department_name !== undefined) {
    const deptCache = await getDepartmentCache(client);
    let match = deptCache.byName.get(department_name.toLowerCase());
    if (!match) match = deptCache.items.find(d =>
      d.FullyQualifiedName?.toLowerCase().includes(department_name.toLowerCase())
    );
    if (!match) throw new Error(`Department not found: "${department_name}"`);
    updated.DepartmentRef = { value: match.Id, name: match.FullyQualifiedName || match.Name };
  }

  // Process line changes if provided
  // Use updated.Line if available (for full updates with stripped read-only fields), else current.Line
  let finalLines = [...((updated.Line as typeof current.Line) || current.Line)];

  if (lineChanges && lineChanges.length > 0) {
    const [acctCache, classCacheData] = await Promise.all([
      getAccountCache(client),
      getClassCache(client),
    ]);

    const resolveAcct = (name: string) => toQboRef(resolveAccountRef(acctCache, name));

    for (const change of lineChanges) {
      if (change.line_id) {
        const lineIndex = finalLines.findIndex(l => l.Id === change.line_id);
        if (lineIndex === -1) {
          throw new Error(`Line ID ${change.line_id} not found in bill`);
        }

        if (change.delete) {
          finalLines.splice(lineIndex, 1);
        } else {
          const label = `Line ${change.line_id}`;
          const line = { ...finalLines[lineIndex] };

          // Decide which detail this line ends up as BEFORE mutating anything.
          // Naming an item makes it item-based, naming an account makes it
          // account-based, and naming neither keeps whatever it already was.
          // Coercing unconditionally is what used to bolt an empty account
          // detail onto an item line and leave both on the payload.
          const itemInput = change.item_id ?? change.item_name;
          const clearingItem = itemInput !== undefined && itemInput.trim() === "";
          if (itemInput !== undefined && !clearingItem && change.account_name !== undefined) {
            throw new Error(`${label} names both an item and an account — a line posts against one or the other`);
          }
          if (clearingItem && change.account_name === undefined) {
            throw new Error(
              `${label}: clearing the item needs an account_name in the same change — ` +
              `a line cannot have neither.`
            );
          }
          const becomesItem = clearingItem
            ? false
            : itemInput !== undefined
              ? true
              : change.account_name !== undefined
                ? false
                : Boolean(line.ItemBasedExpenseLineDetail);

          if (change.description !== undefined) line.Description = change.description;

          const classRef = resolveClassInput(classCacheData, change, label);
          const customerRef = await resolveCustomerInput(client, change, label);

          if (becomesItem) {
            const detail = {
              ...(line.ItemBasedExpenseLineDetail || {}),
            } as NonNullable<typeof line.ItemBasedExpenseLineDetail>;

            if (itemInput !== undefined) {
              const itemRef = await resolveItemInput(client, change, label);
              if (itemRef) detail.ItemRef = itemRef;
            }
            if (!detail.ItemRef) {
              throw new Error(`${label} needs an item_name to become an item-based line`);
            }
            if (change.qty !== undefined) detail.Qty = change.qty;

            // Amount and UnitPrice have to move together: QBO validates
            // Qty x UnitPrice against Amount, so a repriced line with a stale
            // UnitPrice is rejected with fault 6070. Pass the line's existing
            // Qty through rather than the helper's default, and never write a
            // Qty back onto a line that carried none.
            if (change.amount !== undefined || change.qty !== undefined) {
              const { unitPriceDollars, amountCents } = resolveItemLineAmount(
                {
                  amount: change.amount ?? line.Amount,
                  qty: detail.Qty,
                  unit_price: change.unit_price,
                },
                label
              );
              line.Amount = toDollars(amountCents);
              detail.UnitPrice = unitPriceDollars;
            }

            if (classRef === null) delete detail.ClassRef;
            else if (classRef) detail.ClassRef = classRef;

            if (customerRef === null) {
              delete detail.CustomerRef;
            } else if (customerRef) {
              detail.CustomerRef = customerRef;
              detail.BillableStatus = detail.BillableStatus ?? "NotBillable";
            }

            line.ItemBasedExpenseLineDetail = detail;
            delete line.AccountBasedExpenseLineDetail;
            line.DetailType = 'ItemBasedExpenseLineDetail';
            finalLines[lineIndex] = line;
            continue;
          }

          const detail = {
            ...(line.AccountBasedExpenseLineDetail || {}),
            // A converted item line keeps its class; it lives on both details.
            ...(line.ItemBasedExpenseLineDetail?.ClassRef && !line.AccountBasedExpenseLineDetail
              ? { ClassRef: line.ItemBasedExpenseLineDetail.ClassRef }
              : {}),
          } as NonNullable<typeof line.AccountBasedExpenseLineDetail>;

          if (change.amount !== undefined) {
            const amountCents = validateAmount(change.amount, label);
            line.Amount = toDollars(amountCents);
          }
          if (change.account_name !== undefined) detail.AccountRef = resolveAcct(change.account_name);
          if (!detail.AccountRef) {
            throw new Error(`${label} needs an account_name to become an account-based line`);
          }

          if (classRef === null) delete detail.ClassRef;
          else if (classRef) detail.ClassRef = classRef;

          // Spreading the existing detail already preserves CustomerRef; only an
          // explicit customer input changes it, and an empty one clears it.
          if (customerRef === null) {
            delete detail.CustomerRef;
          } else if (customerRef) {
            detail.CustomerRef = customerRef;
            detail.BillableStatus = detail.BillableStatus ?? "NotBillable";
          }

          line.AccountBasedExpenseLineDetail = detail;
          delete line.ItemBasedExpenseLineDetail;
          line.DetailType = 'AccountBasedExpenseLineDetail';
          finalLines[lineIndex] = line;
        }
      } else {
        const newItemInput = change.item_id ?? change.item_name;
        if (!newItemInput && !change.account_name) {
          throw new Error('New lines require an item_name or an account_name');
        }
        if (newItemInput && change.account_name) {
          throw new Error('A new line names both an item and an account — a line posts against one or the other');
        }

        const label = `New line for ${newItemInput || change.account_name}`;
        const newClassRef = resolveClassInput(classCacheData, change, label);
        const newCustomer = await resolveCustomerInput(client, change, label);

        // Id omitted for new lines - QB will assign
        if (newItemInput) {
          const itemRef = await resolveItemInput(client, change, label);
          const { qty, unitPriceDollars, amountCents } = resolveItemLineAmount(change, label);
          finalLines.push({
            Amount: toDollars(amountCents),
            Description: change.description,
            DetailType: 'ItemBasedExpenseLineDetail',
            ItemBasedExpenseLineDetail: {
              ItemRef: itemRef!,
              Qty: qty,
              UnitPrice: unitPriceDollars,
              ...(newClassRef && { ClassRef: newClassRef }),
              ...(newCustomer && {
                CustomerRef: newCustomer,
                BillableStatus: "NotBillable",
              }),
            },
          } as unknown as typeof finalLines[0]);
          continue;
        }

        if (!change.amount) {
          throw new Error(`${label} requires an amount`);
        }
        const amountCents = validateAmount(change.amount, label);
        const newLine = {
          Amount: toDollars(amountCents),
          Description: change.description,
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: {
            AccountRef: resolveAcct(change.account_name!),
            ...(newClassRef && { ClassRef: newClassRef }),
            ...(newCustomer && {
              CustomerRef: newCustomer,
              BillableStatus: "NotBillable",
            }),
          }
        } as typeof finalLines[0];
        finalLines.push(newLine);
      }
    }

    updated.Line = finalLines;
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
    if (due_date !== undefined) previewLines.push(`  Due Date: ${current.DueDate || '(none)'} → ${due_date}`);
    if (memo !== undefined) previewLines.push(`  Memo: ${current.PrivateNote || '(none)'} → ${memo}`);
    if (doc_number !== undefined) previewLines.push(`  Ref no.: ${current.DocNumber || '(none)'} → ${doc_number}`);
    if (department_name !== undefined) previewLines.push(`  Department: ${current.DepartmentRef?.name || '(none)'} → ${(updated.DepartmentRef as { name?: string })?.name || department_name}`);

    if (updated.Line) {
      previewLines.push('');
      previewLines.push('Updated Lines:');
      for (const line of updated.Line as typeof finalLines) {
        const detail = line.AccountBasedExpenseLineDetail;
        if (detail) {
          const acctName = detail.AccountRef.name || detail.AccountRef.value;
          const deptStr = detail.DepartmentRef?.name ? ` [${detail.DepartmentRef.name}]` : '';
          const custStr = detail.CustomerRef?.name ? ` [Customer: ${detail.CustomerRef.name}]` : '';
          previewLines.push(`  ${acctName}${deptStr}${custStr}: $${line.Amount.toFixed(2)}`);
        }
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
