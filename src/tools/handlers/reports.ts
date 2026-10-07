// Handlers for report tools (profit_loss, balance_sheet, trial_balance)

import QuickBooks from "node-quickbooks";
import { getAccountCache, promisify, resolveDepartmentId, withRetry } from "../../client/index.js";
import { outputReport } from "../../utils/index.js";
import {
  BEGINNING_OF_BOOKS,
  analyzeTrialBalance,
  appliedAsOf,
  assertAppliedAsOf,
  describeAsOf,
  extractReportSummary,
  isIsoDate,
  parseTrialBalance,
  renderTrialBalanceFlags,
} from "../../reports/index.js";
import { QBReport } from "../../types/index.js";

export async function handleGetProfitLoss(
  client: QuickBooks,
  args: {
    start_date?: string;
    end_date?: string;
    summarize_by?: string;
    department?: string;
    accounting_method?: string;
    detail_level?: string;
    columns?: string;
    include_raw?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    start_date, end_date, summarize_by, department, accounting_method,
    detail_level, columns, include_raw = false,
  } = args;

  const options: Record<string, string> = {};
  if (start_date) options.start_date = start_date;
  if (end_date) options.end_date = end_date;
  if (summarize_by) options.summarize_column_by = summarize_by;
  if (department) options.department = await resolveDepartmentId(client, department);
  if (accounting_method) options.accounting_method = accounting_method;

  const result = await withRetry(() =>
    promisify<unknown>((cb) => client.reportProfitAndLoss(options, cb))
  ) as QBReport;

  const summary = extractReportSummary(result, "Profit and Loss", {
    detail: detail_level === "account",
    allColumns: columns === "all",
  });
  return outputReport("profit-loss", result, summary, { includeRaw: include_raw });
}

export async function handleGetBalanceSheet(
  client: QuickBooks,
  args: {
    as_of_date?: string;
    summarize_by?: string;
    department?: string;
    accounting_method?: string;
    detail_level?: string;
    columns?: string;
    include_raw?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    as_of_date, summarize_by, department, accounting_method,
    detail_level, columns, include_raw = false,
  } = args;

  const options: Record<string, string> = {};
  if (as_of_date) {
    if (!isIsoDate(as_of_date)) {
      throw new Error(`Invalid as_of_date "${as_of_date}" — expected YYYY-MM-DD.`);
    }
    // Balance sheet needs both start_date and end_date
    // Set start_date to beginning of time for point-in-time report
    options.start_date = BEGINNING_OF_BOOKS;
    options.end_date = as_of_date;
  }
  if (summarize_by) options.summarize_column_by = summarize_by;
  if (department) options.department = await resolveDepartmentId(client, department);
  if (accounting_method) options.accounting_method = accounting_method;

  const result = await withRetry(() =>
    promisify<unknown>((cb) => client.reportBalanceSheet(options, cb))
  ) as QBReport;

  // The balance sheet is the dedicated tool's point-in-time report, checked for
  // the same reason as get_report's: QBO answers a request it cannot honour as of
  // today, and those figures would be mistaken for the requested date's.
  let asOfLine: string | undefined;
  if (as_of_date) {
    const applied = appliedAsOf(result.Header);
    assertAppliedAsOf("balance_sheet", as_of_date, applied);
    asOfLine = describeAsOf(applied, as_of_date);
  }

  const summary = extractReportSummary(result, "Balance Sheet", {
    detail: detail_level === "account",
    allColumns: columns === "all",
    asOfLine,
  });
  return outputReport("balance-sheet", result, summary, { includeRaw: include_raw });
}

export async function handleGetTrialBalance(
  client: QuickBooks,
  args: {
    start_date?: string;
    end_date?: string;
    accounting_method?: string;
    flags?: boolean;
    include_raw?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { start_date, end_date, accounting_method, flags, include_raw = false } = args;

  const options: Record<string, string> = {};
  if (start_date) options.start_date = start_date;
  if (end_date) options.end_date = end_date;
  if (accounting_method) options.accounting_method = accounting_method;

  const result = await withRetry(() =>
    promisify<unknown>((cb) => client.reportTrialBalance(options, cb))
  ) as QBReport;

  const lines = [extractReportSummary(result, "Trial Balance")];

  // Opt-in: the flag pass costs an account-cache fetch and a block of output, so
  // the default response stays exactly what it was.
  if (flags) {
    const flagLines: string[] = [];
    try {
      const cache = await getAccountCache(client);
      const { entries } = parseTrialBalance(result.Rows?.Row || []);
      renderTrialBalanceFlags(analyzeTrialBalance(entries, cache.byId, cache.byAcctNum), flagLines);
    } catch (error) {
      // The report is the deliverable; the flags are an extra. A chart-of-accounts
      // fetch that fails must not take down a call that would otherwise succeed.
      const reason = error instanceof Error ? error.message : String(error);
      flagLines.push("", `FLAGS unavailable: ${reason}`);
    }
    lines.push(flagLines.join("\n"));
  }

  return outputReport("trial-balance", result, lines.join("\n"), { includeRaw: include_raw });
}
