// Read-side department filters resolve through the shared finder. Blank input
// applies no filter (a lone space used to partial-match the first department
// with a space in its name); a miss still reaches QBO unchanged on the report
// tools and still rejects on query_account_transactions.
//
// Invented fixtures only — this repository is public (CLAUDE.md).

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { clearLookupCache } from "../../src/client/index.js";
import { handleGetProfitLoss } from "../../src/tools/handlers/reports.js";
import { handleGetReport } from "../../src/tools/handlers/report.js";
import { handleAccountPeriodSummary } from "../../src/tools/handlers/account-period-summary.js";
import { handleQueryAccountTransactions } from "../../src/tools/handlers/account-transactions.js";
import { setOutputMode } from "../../src/utils/output.js";
import { departmentFinders } from "./department-fixtures.js";

before(() => setOutputMode("http"));
beforeEach(() => clearLookupCache());

type Callback<T> = (err: unknown, result: T) => void;
type Options = Record<string, string>;

const ACCOUNTS = [
  {
    Id: "100", Name: "Sales", FullyQualifiedName: "Sales", AcctNum: "4000",
    AccountType: "Income", Classification: "Revenue", SubAccount: false, Active: true,
  },
];

const accountFinders = {
  findAccounts: (_criteria: unknown, cb: Callback<unknown>) =>
    cb(null, { QueryResponse: { Account: ACCOUNTS } }),
};

const EMPTY_REPORT = {
  Header: { ReportName: "Report" },
  Columns: { Column: [{ ColTitle: "" }, { ColTitle: "Total" }] },
  Rows: { Row: [] },
};

// Records the options each report method received.
function recordingClient() {
  const seen: Record<string, Options> = {};
  const stub = (method: string) => (options: Options, cb: Callback<unknown>) => {
    seen[method] = options;
    cb(null, EMPTY_REPORT);
  };
  const client = {
    ...departmentFinders(),
    ...accountFinders,
    reportProfitAndLoss: stub("reportProfitAndLoss"),
    reportAgedPayables: stub("reportAgedPayables"),
    reportGeneralLedgerDetail: stub("reportGeneralLedgerDetail"),
  } as unknown as QuickBooks;
  return { client, seen };
}

// Two purchases posting to account 100, one per department (ids 2 and 3).
function purchase(id: string, deptId: string, deptName: string) {
  return {
    Id: id,
    TxnDate: "2026-03-10",
    TotalAmt: 100,
    AccountRef: { value: "900", name: "Checking" },
    Line: [{
      Id: "1",
      Amount: 100,
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: "100", name: "Sales" },
        DepartmentRef: { value: deptId, name: deptName },
      },
    }],
  };
}

function purchaseClient() {
  return {
    ...departmentFinders(),
    ...accountFinders,
    findPurchases: (_criteria: unknown, cb: Callback<unknown>) =>
      cb(null, {
        QueryResponse: {
          Purchase: [purchase("p1", "2", "North"), purchase("p2", "3", "South")],
        },
      }),
  } as unknown as QuickBooks;
}

const BLANK = " ";
const UNKNOWN = "Nowhere";

describe("read-side department filters", () => {
  it("account-transactions-whitespace-department-no-filter: blank department applies no filter", async () => {
    const result = await handleQueryAccountTransactions(purchaseClient(), {
      account: "100",
      start_date: "2026-01-01",
      end_date: "2026-12-31",
      department: BLANK,
    });
    const text = result.content[0].text;
    assert.doesNotMatch(text, /^Department:/m);
    // Both purchases survive: one posts to each department.
    assert.match(text, /Summary: 2 transactions/);
  });

  it("account-transactions-unknown-department-rejects: a miss rejects with Department not found", async () => {
    await assert.rejects(
      handleQueryAccountTransactions(purchaseClient(), {
        account: "100",
        start_date: "2026-01-01",
        end_date: "2026-12-31",
        department: UNKNOWN,
      }),
      /Department not found: "Nowhere"/
    );
  });

  it("pl-whitespace-department-no-filter: blank department sets no option", async () => {
    const { client, seen } = recordingClient();
    await handleGetProfitLoss(client, { department: BLANK });
    assert.ok(seen.reportProfitAndLoss, "report was requested");
    assert.equal("department" in seen.reportProfitAndLoss, false);
  });

  it("pl-department-miss-passes-through: a miss reaches QBO unchanged", async () => {
    const { client, seen } = recordingClient();
    await handleGetProfitLoss(client, { department: UNKNOWN });
    assert.equal(seen.reportProfitAndLoss.department, UNKNOWN);
  });

  it("report-whitespace-department-no-filter: blank department sets no option", async () => {
    const { client, seen } = recordingClient();
    await handleGetReport(client, { report: "aged_payables", department: BLANK });
    assert.ok(seen.reportAgedPayables, "report was requested");
    assert.equal("department" in seen.reportAgedPayables, false);
  });

  it("aps-whitespace-department-no-filter: blank department sets no option and prints no line", async () => {
    const { client, seen } = recordingClient();
    const result = await handleAccountPeriodSummary(client, {
      account: "100",
      start_date: "2026-01-01",
      end_date: "2026-12-31",
      department: BLANK,
    });
    assert.ok(seen.reportGeneralLedgerDetail, "report was requested");
    assert.equal("department" in seen.reportGeneralLedgerDetail, false);
    assert.doesNotMatch(result.content[0].text, /^Department:/m);
  });
});
