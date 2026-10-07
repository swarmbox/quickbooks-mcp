// Handler for get_preferences tool

import QuickBooks from "node-quickbooks";
import { promisify } from "../../client/index.js";
import { outputReport } from "../../utils/index.js";
import type { QBRef } from "../../types/index.js";

// Only the fields the summary reads. QBO omits a key entirely when it is unset,
// so everything is optional; a present `false` is a real answer. A present
// `null` is not expected from the API but is treated as absent, never rendered.
type Maybe<T> = T | null;
interface Preferences {
  AccountingInfoPrefs?: {
    BookCloseDate?: Maybe<string>;
    TrackDepartments?: Maybe<boolean>;
    DepartmentTerminology?: Maybe<string>;
    ClassTrackingPerTxn?: Maybe<boolean>;
    ClassTrackingPerTxnLine?: Maybe<boolean>;
    FirstMonthOfFiscalYear?: Maybe<string>;
    UseAccountNumbers?: Maybe<boolean>;
  };
  ReportPrefs?: { ReportBasis?: Maybe<string> };
  CurrencyPrefs?: { HomeCurrency?: Maybe<QBRef>; MultiCurrencyEnabled?: Maybe<boolean> };
  SalesFormsPrefs?: { DefaultTerms?: Maybe<QBRef> };
  VendorAndPurchasesPrefs?: {
    DefaultTerms?: Maybe<QBRef>;
    BillableExpenseTracking?: Maybe<boolean>;
    DefaultMarkup?: Maybe<number | string>;
  };
}

const onOff = (flag: boolean) => (flag ? "ON" : "OFF");

/** `<prefix> <value>` when the value is present (neither null nor undefined), else nothing. */
function part<T>(prefix: string, value: T | null | undefined, render: (v: T) => string = String): string | undefined {
  return value == null ? undefined : `${prefix} ${render(value)}`;
}

// A terms ref renders its name, falling back to its id; a ref with neither renders nothing.
const termsText = (ref: Maybe<QBRef> | undefined) => ref?.name || (ref?.value ? `id ${ref.value}` : undefined);

// A currency ref renders its bare ISO code; a ref without one renders nothing.
const currencyText = (ref: Maybe<QBRef> | undefined) => ref?.value || undefined;

/**
 * One digest line: the label plus every part whose source field is present.
 * Returns nothing when every part is absent, so the line is omitted.
 */
function digestLine(label: string, parts: Array<string | undefined>): string | undefined {
  const present = parts.filter((p): p is string => p !== undefined);
  return present.length ? `${label} ${present.join("; ")}` : undefined;
}

function classTracking(acct: NonNullable<Preferences["AccountingInfoPrefs"]>): string | undefined {
  if (acct.ClassTrackingPerTxnLine) return "classes per line";
  if (acct.ClassTrackingPerTxn) return "classes per transaction";
  if (acct.ClassTrackingPerTxnLine === false && acct.ClassTrackingPerTxn === false) return "classes OFF";
  return undefined;
}

function departments(acct: NonNullable<Preferences["AccountingInfoPrefs"]>): string | undefined {
  if (acct.TrackDepartments == null) return undefined;
  const term = acct.DepartmentTerminology ? ` (terminology "${acct.DepartmentTerminology}")` : "";
  return `departments ${onOff(acct.TrackDepartments)}${term}`;
}

/** Render the books closing date, then a short digest. Pure; safe on any shape. */
export function formatPreferencesSummary(prefs: Preferences): string {
  const acct = prefs?.AccountingInfoPrefs ?? {};
  const purchases = prefs?.VendorAndPurchasesPrefs ?? {};
  const currency = prefs?.CurrencyPrefs ?? {};

  const digest = [
    digestLine("Accounting:", [
      departments(acct),
      classTracking(acct),
      part("fiscal year starts", acct.FirstMonthOfFiscalYear),
      part("account numbers", acct.UseAccountNumbers, onOff),
    ]),
    digestLine("Reporting: ", [part("basis", prefs?.ReportPrefs?.ReportBasis)]),
    digestLine("Currency:  ", [
      part("home", currencyText(currency.HomeCurrency)),
      part("multi-currency", currency.MultiCurrencyEnabled, onOff),
    ]),
    digestLine("Sales:     ", [part("default terms", termsText(prefs?.SalesFormsPrefs?.DefaultTerms))]),
    digestLine("Purchases: ", [
      part("default terms", termsText(purchases.DefaultTerms)),
      part("billable expenses", purchases.BillableExpenseTracking, onOff),
      part("markup", purchases.DefaultMarkup, (m) => `${m}%`),
    ]),
  ].filter((l): l is string => l !== undefined);

  return [
    "Company Preferences",
    "===================",
    `Books closing date: ${acct.BookCloseDate ?? "none set"}`,
    ...(digest.length ? ["", ...digest] : []),
  ].join("\n");
}

export async function handleGetPreferences(
  client: QuickBooks
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const prefs = (await promisify<unknown>((cb) => client.getPreferences(cb))) as Preferences;
  return outputReport("preferences", prefs, formatPreferencesSummary(prefs));
}
