// Handler for get_preferences tool

import QuickBooks from "node-quickbooks";
import { promisify } from "../../client/index.js";
import { outputReport } from "../../utils/index.js";
import type { QBRef } from "../../types/index.js";

// Only the fields the summary reads. QBO omits a key entirely when it is unset,
// so everything is optional; a present `false` is a real answer.
interface Preferences {
  AccountingInfoPrefs?: {
    BookCloseDate?: string;
    TrackDepartments?: boolean;
    DepartmentTerminology?: string;
    ClassTrackingPerTxn?: boolean;
    ClassTrackingPerTxnLine?: boolean;
    FirstMonthOfFiscalYear?: string;
    UseAccountNumbers?: boolean;
  };
  ReportPrefs?: { ReportBasis?: string };
  CurrencyPrefs?: { HomeCurrency?: QBRef; MultiCurrencyEnabled?: boolean };
  SalesFormsPrefs?: { DefaultTerms?: QBRef };
  VendorAndPurchasesPrefs?: {
    DefaultTerms?: QBRef;
    BillableExpenseTracking?: boolean;
    DefaultMarkup?: number | string;
  };
}

const onOff = (flag: boolean) => (flag ? "ON" : "OFF");

// A terms ref renders its name, falling back to its id.
const termsText = (ref: QBRef) => ref.name || `id ${ref.value}`;

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
  if (acct.TrackDepartments === undefined) return undefined;
  const term = acct.DepartmentTerminology ? ` (terminology "${acct.DepartmentTerminology}")` : "";
  return `departments ${onOff(acct.TrackDepartments)}${term}`;
}

/** Render the books closing date, then a short digest. Pure; safe on any shape. */
export function formatPreferencesSummary(prefs: Preferences): string {
  const acct = prefs?.AccountingInfoPrefs ?? {};
  const purchases = prefs?.VendorAndPurchasesPrefs ?? {};
  const currency = prefs?.CurrencyPrefs ?? {};
  const salesTerms = prefs?.SalesFormsPrefs?.DefaultTerms;
  const purchaseTerms = purchases.DefaultTerms;

  const digest = [
    digestLine("Accounting:", [
      departments(acct),
      classTracking(acct),
      acct.FirstMonthOfFiscalYear !== undefined ? `fiscal year starts ${acct.FirstMonthOfFiscalYear}` : undefined,
      acct.UseAccountNumbers !== undefined ? `account numbers ${onOff(acct.UseAccountNumbers)}` : undefined,
    ]),
    digestLine("Reporting: ", [
      prefs?.ReportPrefs?.ReportBasis !== undefined ? `basis ${prefs.ReportPrefs.ReportBasis}` : undefined,
    ]),
    digestLine("Currency:  ", [
      currency.HomeCurrency !== undefined ? `home ${currency.HomeCurrency.value}` : undefined,
      currency.MultiCurrencyEnabled !== undefined ? `multi-currency ${onOff(currency.MultiCurrencyEnabled)}` : undefined,
    ]),
    digestLine("Sales:     ", [
      salesTerms !== undefined ? `default terms ${termsText(salesTerms)}` : undefined,
    ]),
    digestLine("Purchases: ", [
      purchaseTerms !== undefined ? `default terms ${termsText(purchaseTerms)}` : undefined,
      purchases.BillableExpenseTracking !== undefined
        ? `billable expenses ${onOff(purchases.BillableExpenseTracking)}`
        : undefined,
      purchases.DefaultMarkup !== undefined ? `markup ${purchases.DefaultMarkup}%` : undefined,
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
