// Expense lines: the ItemBasedExpenseLineDetail / AccountBasedExpenseLineDetail
// line shape shared by bills and purchase orders.
//
// Callers: bill.ts (create_bill, get_bill, edit_bill) and, as they land, the
// purchase-order tools. Expense (Purchase) and vendor-credit lines are the same
// shape and can adopt this module later; they still carry their own copies.
//
// One module owns the whole line lifecycle so the callers cannot drift apart:
// resolving create inputs (resolveExpenseLines), building the payload line
// (expenseLinePayload), applying edit changes to stored lines
// (applyExpenseLineChanges), and the three preview renderings — a resolved
// input line, a stored line, and a built payload line.
//
// Every option defaults to bill's behaviour, which tests/tools/bill-output-pin
// holds byte for byte:
//   - itemMatch "loose" (the default) resolves items through resolveItemInput's
//     partial-match path; "exact" routes through resolveItemExact and refuses a
//     partial or ambiguous name instead of guessing.
//   - descriptionLayout "inline" (the default) appends the description quoted
//     on the line row; "indented" puts each description row on its own row,
//     indented four spaces, under the line row.

import QuickBooks from "node-quickbooks";
import {
  resolveAccountRef,
  resolveClassInput,
  resolveItemInput,
  resolveCustomerInput,
  getAccountCache,
  getClassCache,
  toQboRef,
} from "../../client/index.js";
import type { AccountCache, ClassCache } from "../../types/cache.js";
import { validateAmount, toDollars, resolveItemLineAmount } from "../../utils/index.js";

type Ref = { value: string; name: string };
type QboRef = { value: string; name?: string };

// "loose" is bill's partial-match item resolution; "exact" never guesses.
export type ItemMatch = "loose" | "exact";

// "inline" is bill's quoted form; "indented" gives each description row its own row.
export type DescriptionLayout = "inline" | "indented";

// A line as a create call gives it. The payee is the transaction's header
// VendorRef — by definition a vendor, so there is no entity_type to pick.
// Line-level attribution is the detail's CustomerRef, which only accepts a
// customer; hence customer_name rather than entity_name here.
export interface ExpenseLineInput {
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

// One entry of an edit call's lines: line_id names a stored line to change or
// delete; without it the entry appends a new line.
export interface ExpenseLineChange {
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

// A create input after resolution: refs looked up, amount validated to cents.
// An item line carries item_ref, qty and unit_price; an account line carries
// account_id, account_name and account_num.
export type ResolvedExpenseLine = ExpenseLineInput & {
  account_id?: string;
  account_num?: string;
  amount_cents: number;
  amount: number;
  item_ref?: Ref;
  class_ref?: Ref;
  customer_ref?: Ref;
};

// A line as QBO stores and accepts it. Id is absent on a line being appended;
// LineNum is read-only and is stripped before a line is sent back.
export interface QboExpenseLine {
  Id?: string;
  LineNum?: number;
  Amount: number;
  Description?: string;
  DetailType: string;
  AccountBasedExpenseLineDetail?: {
    AccountRef: QboRef;
    DepartmentRef?: QboRef;
    ClassRef?: QboRef;
    CustomerRef?: QboRef;
    BillableStatus?: string;
  };
  // A fetched line may be item-based. Bill's edit path once typed every stored
  // line as account-based; the runtime spread preserved the item detail all
  // along, but the compiler could not see it, which is how that path came to
  // coerce every line to account-based and ship a dual-detail payload.
  ItemBasedExpenseLineDetail?: {
    ItemRef: QboRef;
    ClassRef?: QboRef;
    CustomerRef?: QboRef;
    BillableStatus?: string;
    Qty?: number;
    UnitPrice?: number;
  };
}

const itemOptions = (itemMatch: ItemMatch | undefined) => ({ exact: itemMatch === "exact" });

// The description suffix for a line row, in either layout. Inline appends it
// quoted; indented puts each of its rows on a row of its own. Indented splits on
// CRLF as well as LF, so a description pasted from a Windows source does not
// leave a stray "\r" at the end of each preview row.
function descriptionSuffix(description: string | undefined, layout: DescriptionLayout = "inline"): string {
  if (!description) return "";
  if (layout === "inline") return ` "${description}"`;
  return description.split(/\r?\n/).map(row => `\n    ${row}`).join("");
}

// Resolve create inputs. Item and customer resolution can hit the API, so this
// is a loop. A line posts against an item or an account, never both. Errors
// name the line as "Line N" (1-based).
export async function resolveExpenseLines(
  client: QuickBooks,
  lines: ExpenseLineInput[],
  options: { accounts: AccountCache; classes: ClassCache; itemMatch?: ItemMatch }
): Promise<ResolvedExpenseLine[]> {
  const { accounts, classes, itemMatch } = options;
  const resolvedLines: ResolvedExpenseLine[] = [];
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

    const classRef = resolveClassInput(classes, line, label);
    const customerRef = await resolveCustomerInput(client, line, label);

    if (itemInput) {
      const itemRef = await resolveItemInput(client, line, label, itemOptions(itemMatch));
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
      const account = resolveAccountRef(accounts, accountName);
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
  return resolvedLines;
}

// The payload line for a resolved create input.
export function expenseLinePayload(line: ResolvedExpenseLine): QboExpenseLine {
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
        value: line.account_id!,
        name: line.account_name,
      },
      // NotBillable is deliberate even with a CustomerRef: the line
      // attributes cost to a customer without queuing it for re-invoicing.
      BillableStatus: "NotBillable",
      ...(line.class_ref && { ClassRef: line.class_ref }),
      ...(line.customer_ref && { CustomerRef: line.customer_ref }),
    },
  };
}

// A create preview row. Every field a caller can set on a line has to be
// visible here: draft mode is the safety gate, and a field you can set but
// cannot see undercuts it.
export function formatResolvedExpenseLine(
  l: ResolvedExpenseLine,
  options: { descriptionLayout?: DescriptionLayout } = {}
): string {
  const account = `${l.account_num ? `${l.account_num} ` : ""}${l.account_name || l.account_id}`;
  const label = l.item_ref
    ? `Item: ${l.item_ref.name}${l.qty && l.qty !== 1 ? ` (Qty: ${l.qty} x $${(l.unit_price ?? 0).toFixed(2)})` : ""}`
    : account;
  const classStr = l.class_ref ? ` [Class: ${l.class_ref.name}]` : "";
  const custStr = l.customer_ref ? ` [Customer: ${l.customer_ref.name}]` : "";
  return `  ${label}${classStr}${custStr}: $${l.amount.toFixed(2)}${descriptionSuffix(l.description, options.descriptionLayout)}`;
}

// A get summary row for a stored line, naming its line Id. Undefined for a line
// with neither expense detail (QBO's subtotal and similar lines), which the
// summary skips.
export function formatStoredExpenseLine(
  line: QboExpenseLine,
  options: { descriptionLayout?: DescriptionLayout } = {}
): string | undefined {
  const descStr = descriptionSuffix(line.Description, options.descriptionLayout);
  if (line.AccountBasedExpenseLineDetail) {
    const detail = line.AccountBasedExpenseLineDetail;
    const acctName = detail.AccountRef.name || detail.AccountRef.value;
    const deptStr = detail.DepartmentRef?.name ? ` [${detail.DepartmentRef.name}]` : '';
    const custStr = detail.CustomerRef?.name ? ` [Customer: ${detail.CustomerRef.name}]` : '';
    const classStr = detail.ClassRef?.name ? ` [Class: ${detail.ClassRef.name}]` : '';
    return `  Line ${line.Id}: ${acctName}${deptStr}${classStr}${custStr} $${line.Amount.toFixed(2)}${descStr}`;
  }
  if (line.ItemBasedExpenseLineDetail) {
    const detail = line.ItemBasedExpenseLineDetail;
    const itemName = detail.ItemRef.name || detail.ItemRef.value;
    const classStr = detail.ClassRef?.name ? ` [Class: ${detail.ClassRef.name}]` : '';
    const custStr = detail.CustomerRef?.name ? ` [Customer: ${detail.CustomerRef.name}]` : '';
    const priceStr = detail.UnitPrice !== undefined ? ` x $${detail.UnitPrice.toFixed(2)}` : '';
    return `  Line ${line.Id}: Item: ${itemName} (Qty: ${detail.Qty ?? 1}${priceStr})${classStr}${custStr} $${line.Amount.toFixed(2)}${descStr}`;
  }
  return undefined;
}

// An edit preview row, read off the built payload rather than the inputs — that
// is what makes preserve-on-omit visible before the caller sets draft=false.
// Undefined for a line with neither expense detail, which the preview skips.
//
// Bill's preview shows no descriptions (description: false). With
// description: true each description row follows on its own indented row, the
// layout the purchase-order tools use throughout.
export function formatPayloadExpenseLine(
  line: QboExpenseLine,
  options: { description: boolean }
): string | undefined {
  const item = line.ItemBasedExpenseLineDetail;
  const acct = line.AccountBasedExpenseLineDetail;
  const detail = item ?? acct;
  if (!detail) return undefined;
  const label = item
    ? `Item: ${item.ItemRef.name || item.ItemRef.value}${item.Qty && item.Qty !== 1 ? ` (Qty: ${item.Qty} x $${(item.UnitPrice ?? 0).toFixed(2)})` : ''}`
    : `${acct!.AccountRef.name || acct!.AccountRef.value}`;
  const deptStr = acct?.DepartmentRef?.name ? ` [${acct.DepartmentRef.name}]` : '';
  const classStr = detail.ClassRef?.name ? ` [Class: ${detail.ClassRef.name}]` : '';
  const custStr = detail.CustomerRef?.name ? ` [Customer: ${detail.CustomerRef.name}]` : '';
  const descStr = options.description ? descriptionSuffix(line.Description, "indented") : '';
  return `  ${label}${deptStr}${classStr}${custStr}: $${line.Amount.toFixed(2)}${descStr}`;
}

// Apply an edit call's line changes to the stored lines and return the complete
// Line array to send (a sparse update replaces Line wholesale, so deletion is
// an omission). A stored line no change names is returned as fetched, minus the
// read-only LineNum, and is never re-resolved. entityLabel names the
// transaction in a missing-line error ("Line ID 9 not found in bill").
export async function applyExpenseLineChanges(
  client: QuickBooks,
  storedLines: QboExpenseLine[],
  changes: ExpenseLineChange[],
  options: { entityLabel: string; itemMatch?: ItemMatch }
): Promise<QboExpenseLine[]> {
  const { entityLabel, itemMatch } = options;

  // Seed with the existing lines, stripping read-only fields
  const finalLines: QboExpenseLine[] = storedLines.map(line => {
    const { LineNum: _lineNum, ...rest } = line;
    return rest;
  });

  const [acctCache, classCacheData] = await Promise.all([
    getAccountCache(client),
    getClassCache(client),
  ]);

  const resolveAcct = (name: string) => toQboRef(resolveAccountRef(acctCache, name));

  for (const change of changes) {
    if (change.line_id) {
      const lineIndex = finalLines.findIndex(l => l.Id === change.line_id);
      if (lineIndex === -1) {
        throw new Error(`Line ID ${change.line_id} not found in ${entityLabel}`);
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
          } as NonNullable<QboExpenseLine["ItemBasedExpenseLineDetail"]>;

          if (itemInput !== undefined) {
            const itemRef = await resolveItemInput(client, change, label, itemOptions(itemMatch));
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
          ...carried,
          ...(line.AccountBasedExpenseLineDetail || {}),
        } as NonNullable<QboExpenseLine["AccountBasedExpenseLineDetail"]>;

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
        const itemRef = await resolveItemInput(client, change, label, itemOptions(itemMatch));
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
        });
        continue;
      }

      if (!change.amount) {
        throw new Error(`${label} requires an amount`);
      }
      const amountCents = validateAmount(change.amount, label);
      finalLines.push({
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
        },
      });
    }
  }

  return finalLines;
}
