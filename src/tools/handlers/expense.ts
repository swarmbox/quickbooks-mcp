// Handlers for expense tools (create, get, edit)

import QuickBooks from "node-quickbooks";
import {
  promisify,
  promisifyWrite,
  getAccountCache,
  getClassCache,
  getDepartmentCache,
  resolveAccountRef,
  resolveEntityRef,
  resolveClassInput,
  resolveItemInput,
  resolveCustomerInput,
  normalizeEntityKind,
  toPurchaseEntityRef,
  toQboRef,
} from "../../client/index.js";
import { buildQboUrl, validateAmount, toDollars, formatDollars, sumCents, outputReport, formatUpdateResult, resolveItemLineAmount } from "../../utils/index.js";

interface CreateExpenseLine {
  account_id?: string;
  account_name?: string;
  item_id?: string;
  item_name?: string;
  qty?: number;
  unit_price?: number;
  class_id?: string;
  class_name?: string;
  amount?: number;
  description?: string;
  customer_name?: string;
  customer_id?: string;
}

interface ExpenseLineChange {
  line_id?: string;
  account_name?: string;
  class_id?: string;
  class_name?: string;
  item_id?: string;
  item_name?: string;
  qty?: number;
  unit_price?: number;
  amount?: number;
  description?: string;
  customer_name?: string;
  customer_id?: string;
  delete?: boolean;
}

// AccountBasedExpenseLineDetail attributes a line to a customer and nothing
// else — there is no Vendor or Employee option at line level, which is why
// these lines take customer_name rather than entity_name/entity_type. The payee
// (vendor, customer, or employee) is the header EntityRef.

export async function handleCreateExpense(
  client: QuickBooks,
  args: {
    payment_type: "Cash" | "Check" | "CreditCard";
    payment_account: string;
    txn_date: string;
    entity_name?: string;
    entity_id?: string;
    entity_type?: string;
    department_name?: string;
    department_id?: string;
    memo?: string;
    doc_number?: string;
    lines: CreateExpenseLine[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    payment_type, payment_account, txn_date,
    entity_name, entity_id, entity_type,
    department_name, department_id,
    memo, doc_number, lines, draft = true,
  } = args;

  if (!lines || lines.length === 0) {
    throw new Error("At least one line is required");
  }

  // Get cached lookups in parallel
  const [acctCache, deptCache, classCacheData] = await Promise.all([
    getAccountCache(client),
    getDepartmentCache(client),
    getClassCache(client),
  ]);

  // Resolve payment account (acctNum is kept for the draft preview)
  const paymentAcct = resolveAccountRef(acctCache, payment_account);
  const paymentAccountRef = toQboRef(paymentAcct);

  // Resolve the payee (optional). QBO lets a Purchase be paid to a vendor,
  // customer, or employee; entity_type picks which name list to search and
  // defaults to Vendor.
  let entityRef: { value: string; name: string; type: string } | undefined;
  const entityInput = entity_id || entity_name;
  if (entityInput) {
    entityRef = toPurchaseEntityRef(
      await resolveEntityRef(client, entityInput, normalizeEntityKind(entity_type))
    );
  }

  // Resolve department (header-level, optional)
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

  // Resolve lines. Item and customer resolution can hit the API, so this is a
  // loop. A line posts against an item or an account, never both.
  const resolvedLines: Array<CreateExpenseLine & {
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

  // Build QuickBooks Purchase object
  const purchaseObject: Record<string, unknown> = {
    PaymentType: payment_type,
    AccountRef: paymentAccountRef,
    TxnDate: txn_date,
    ...(entityRef && { EntityRef: entityRef }),
    ...(departmentRef && { DepartmentRef: departmentRef }),
    ...(memo && { PrivateNote: memo }),
    ...(doc_number && { DocNumber: doc_number }),
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
            ...(line.class_ref && { ClassRef: line.class_ref }),
            // Same coupling as the account branch: BillableStatus travels with
            // CustomerRef, and only with it, on this handler.
            ...(line.customer_ref && {
              CustomerRef: line.customer_ref,
              BillableStatus: "NotBillable",
            }),
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
          ...(line.class_ref && { ClassRef: line.class_ref }),
          // A CustomerRef with no BillableStatus can default to Billable, which
          // would queue the cost for re-invoicing. These tools attribute cost;
          // they do not bill it, so say NotBillable explicitly.
          ...(line.customer_ref && {
            CustomerRef: line.customer_ref,
            BillableStatus: "NotBillable",
          }),
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
      "DRAFT - Expense Preview",
      "",
      `Payment Type: ${payment_type}`,
      `Payment Account: ${paymentAcct.acctNum ? `${paymentAcct.acctNum} ` : ""}${paymentAcct.name}`,
      `Payee: ${entityRef ? `${entityRef.name} (${entityRef.type})` : "(none)"}`,
      `Date: ${txn_date}`,
      `Ref no.: ${doc_number || "(auto-assign)"}`,
      `Department: ${departmentRef?.name || "(none)"}`,
      `Memo: ${memo || "(none)"}`,
      `Total: $${formatDollars(totalCents)}`,
      "",
      "Lines:",
      ...resolvedLines.map(l =>
        `  ${formatAccount(l)}: $${l.amount.toFixed(2)}${l.customer_ref ? ` [Customer: ${l.customer_ref.name}]` : ""}${l.description ? ` "${l.description}"` : ""}`
      ),
      "",
      "Set draft=false to create this expense.",
    ].join("\n");

    return {
      content: [{ type: "text", text: preview }],
    };
  }

  // Create the expense
  const result = await promisifyWrite<unknown>((cb) =>
    client.createPurchase(purchaseObject, cb)
  ) as { Id: string; DocNumber?: string };

  const qboUrl = buildQboUrl("expense", "txnId", result.Id);

  const response = [
    "Expense Created!",
    "",
    `Payment Type: ${payment_type}`,
    `Payment Account: ${paymentAcct.name}`,
    `Payee: ${entityRef?.name || "(none)"}`,
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

export async function handleGetExpense(
  client: QuickBooks,
  args: { id: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id } = args;

  const expense = await promisify<unknown>((cb) =>
    client.getPurchase(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    PaymentType: string;
    DocNumber?: string;
    PrivateNote?: string;
    TotalAmt?: number;
    AccountRef?: { value: string; name?: string };
    EntityRef?: { value: string; name?: string; type?: string };
    DepartmentRef?: { value: string; name?: string };
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
  const qboUrl = buildQboUrl("expense", "txnId", expense.Id);

  // Format summary
  const lines: string[] = [
    'Expense (Purchase)',
    '==================',
    `ID: ${expense.Id}`,
    `SyncToken: ${expense.SyncToken}`,
    `Payment Type: ${expense.PaymentType}`,
    `Payment Account: ${expense.AccountRef?.name || expense.AccountRef?.value || '(none)'}`,
    `Payee: ${expense.EntityRef?.name || expense.EntityRef?.value || '(none)'}${expense.EntityRef?.type ? ` (${expense.EntityRef.type})` : ''}`,
    `Department: ${expense.DepartmentRef?.name || expense.DepartmentRef?.value || '(none)'}`,
    `Date: ${expense.TxnDate}`,
    `Ref no.: ${expense.DocNumber || '(none)'}`,
    `Memo: ${expense.PrivateNote || '(none)'}`,
    `Total: $${(expense.TotalAmt || 0).toFixed(2)}`,
    '',
    'Lines:',
  ];

  for (const line of expense.Line || []) {
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

  return outputReport(`expense-${expense.Id}`, expense, lines.join('\n'));
}

export async function handleEditExpense(
  client: QuickBooks,
  args: {
    id: string;
    txn_date?: string;
    memo?: string;
    payment_account?: string;
    department_name?: string;
    entity_name?: string;
    entity_id?: string;
    entity_type?: string;
    lines?: ExpenseLineChange[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id, txn_date, memo, payment_account, department_name, entity_name, entity_id, entity_type, lines: lineChanges, draft = true } = args;

  // Fetch current Purchase
  const current = await promisify<unknown>((cb) =>
    client.getPurchase(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    PaymentType: string;
    DocNumber?: string;
    PrivateNote?: string;
    AccountRef?: { value: string; name?: string };
    EntityRef?: { value: string; name?: string; type?: string };
    DepartmentRef?: { value: string; name?: string };
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

  // Determine whether the Line array has to be rebuilt for this edit
  const needsLineRebuild = lineChanges && lineChanges.length > 0;

  // Build updated Purchase
  // Note: PaymentType is required by QB API even for sparse updates
  const updated: Record<string, unknown> = {
    Id: current.Id,
    SyncToken: current.SyncToken,
    PaymentType: current.PaymentType,
  };

  // Always sparse. A full update nulls every writable field absent from the
  // payload — it previously stripped DepartmentRef/EntityRef, and it still
  // clears Credit, which flips a card refund into a charge. Sparse also handles
  // line changes, including deletion, provided the complete Line array is sent.
  // See docs/quickbooks-api-limitations.md.
  updated.sparse = true;

  if (needsLineRebuild) {
    // Seed with the existing lines, stripping read-only fields
    updated.Line = current.Line.map(line => {
      const { LineNum, ...rest } = line as Record<string, unknown>;
      return rest;
    });
  }

  if (txn_date !== undefined) updated.TxnDate = txn_date;
  if (memo !== undefined) updated.PrivateNote = memo;

  // Resolve payment account if provided
  if (payment_account !== undefined) {
    const acctCache = await getAccountCache(client);
    updated.AccountRef = toQboRef(
      resolveAccountRef(acctCache, payment_account, { label: "Payment account" })
    );
  }

  // Resolve header-level department if provided
  if (department_name !== undefined) {
    const deptCache = await getDepartmentCache(client);
    let match = deptCache.byName.get(department_name.toLowerCase());
    if (!match) match = deptCache.items.find(d =>
      d.FullyQualifiedName?.toLowerCase().includes(department_name.toLowerCase())
    );
    if (!match) throw new Error(`Department not found: "${department_name}"`);
    updated.DepartmentRef = { value: match.Id, name: match.FullyQualifiedName || match.Name };
  }

  // Resolve the payee if provided. entity_type picks the name list (Vendor,
  // Customer, or Employee) and defaults to Vendor.
  const entityInput = entity_id || entity_name;
  if (entityInput) {
    updated.EntityRef = toPurchaseEntityRef(
      await resolveEntityRef(client, entityInput, normalizeEntityKind(entity_type))
    );
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
          throw new Error(`Line ID ${change.line_id} not found in expense`);
        }

        if (change.delete) {
          finalLines.splice(lineIndex, 1);
        } else {
          const label = `Line ${change.line_id}`;
          const line = { ...finalLines[lineIndex] };

          // Decide which detail this line ends up as BEFORE mutating anything —
          // see the same block in bill.ts. Coercing unconditionally is what used
          // to leave an item line carrying both details.
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

          // ClassRef, CustomerRef and BillableStatus all live on BOTH detail
          // types, so a line that only changes which detail it uses keeps them.
          // Seeding the target detail with them is what makes the conversion
          // symmetric — carrying class one way and dropping the customer the
          // other is the same silent loss this branch exists to prevent.
          const existingDetail = line.ItemBasedExpenseLineDetail ?? line.AccountBasedExpenseLineDetail;
          const carried = {
            ...(existingDetail?.ClassRef && { ClassRef: existingDetail.ClassRef }),
            ...(existingDetail?.CustomerRef && { CustomerRef: existingDetail.CustomerRef }),
            ...(existingDetail?.BillableStatus && { BillableStatus: existingDetail.BillableStatus }),
          };

          if (becomesItem) {
            const detail = {
              ...carried,
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

            // Amount and UnitPrice move together or QBO rejects the pair with
            // fault 6070. Pass the line's own Qty through; never write the
            // helper's default back onto a line that carried none.
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
            ...carried,
            ...(line.AccountBasedExpenseLineDetail || {}),
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
        if (!change.amount || !change.account_name) {
          throw new Error('New lines require an item_name or an account_name');
        }
        if ((change.item_id ?? change.item_name) && change.account_name) {
          throw new Error('A new line names both an item and an account — a line posts against one or the other');
        }

        const newItemInput = change.item_id ?? change.item_name;
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

  const qboUrl = buildQboUrl("expense", "txnId", id);

  if (draft) {
    const previewLines: string[] = [
      'DRAFT - Expense Edit Preview',
      '',
      `ID: ${id}`,
      `SyncToken: ${current.SyncToken}`,
      `Payment Type: ${current.PaymentType} (cannot be changed)`,
      '',
      'Changes:',
    ];

    if (txn_date !== undefined) previewLines.push(`  Date: ${current.TxnDate} → ${txn_date}`);
    if (memo !== undefined) previewLines.push(`  Memo: ${current.PrivateNote || '(none)'} → ${memo}`);
    if (payment_account !== undefined) {
      const newAcct = (updated.AccountRef as { name?: string })?.name || payment_account;
      previewLines.push(`  Payment Account: ${current.AccountRef?.name || '(none)'} → ${newAcct}`);
    }
    if (department_name !== undefined) {
      const newDept = (updated.DepartmentRef as { name?: string })?.name || department_name;
      previewLines.push(`  Department: ${current.DepartmentRef?.name || '(none)'} → ${newDept}`);
    }
    if (entityInput) {
      const ref = updated.EntityRef as { name?: string; type?: string } | undefined;
      const newEntity = ref?.name ? `${ref.name} (${ref.type})` : entityInput;
      previewLines.push(`  Payee: ${current.EntityRef?.name || '(none)'} → ${newEntity}`);
    }

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
    client.updatePurchase(updated, cb)
  ) as { Id: string; SyncToken: string };

  return {
    content: [{ type: "text", text: formatUpdateResult("Expense", id, current.SyncToken, result.SyncToken, qboUrl) }],
  };
}
