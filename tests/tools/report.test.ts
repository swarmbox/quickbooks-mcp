import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { handleGetReport } from "../../src/tools/handlers/report.js";
import { BEGINNING_OF_BOOKS } from "../../src/reports/index.js";
import { setOutputMode } from "../../src/utils/output.js";

before(() => setOutputMode("http"));

type Callback<T> = (err: unknown, result: T) => void;

const REPORT = {
  Header: { ReportName: "AgedPayables", EndPeriod: "2026-06-30" },
  Columns: { Column: [{ ColTitle: "" }, { ColTitle: "Current" }, { ColTitle: "Total" }] },
  Rows: { Row: [{ ColData: [{ value: "North Supply" }, { value: "100.00" }, { value: "100.00" }] }] },
};

// The date QBO answers as of when it is given none: an invented "today".
const TODAY = "2026-10-07";

// A report whose header is `header`, whatever the request was.
function reportWith(header: Record<string, unknown>) {
  return { ...REPORT, Header: { ReportName: "AgedPayables", ...header } };
}

// Records what criteria the handler passed, so the tests can assert on the
// query QBO would have received. It mimics QBO's dating: a report_date is
// echoed into the header as EndPeriod and as an Option entry, and without one
// the report is answered as of today.
function fakeClient() {
  const seen: Record<string, Record<string, string>> = {};
  const stub = (method: string) => (options: Record<string, string>, cb: Callback<unknown>) => {
    seen[method] = options;
    const date = options.report_date;
    cb(null, date
      ? reportWith({ EndPeriod: date, Option: [{ Name: "report_date", Value: date }] })
      : reportWith({ EndPeriod: TODAY, DateMacro: "today" }));
  };
  const client = {
    reportAgedPayables: stub("reportAgedPayables"),
    reportGeneralLedgerDetail: stub("reportGeneralLedgerDetail"),
    reportInventoryValuationSummary: stub("reportInventoryValuationSummary"),
    reportTransactionList: stub("reportTransactionList"),
  } as unknown as QuickBooks;
  return { client, seen };
}

// A client that answers every report with `header`, whatever it is asked, and
// counts how often it was asked.
function headerClient(header: Record<string, unknown>) {
  const state = { calls: 0 };
  const answer = (_options: Record<string, string>, cb: Callback<unknown>) => {
    state.calls++;
    cb(null, reportWith(header));
  };
  const client = {
    reportAgedPayables: answer,
    reportGeneralLedgerDetail: answer,
    reportInventoryValuationSummary: answer,
    reportVendorBalance: answer,
  } as unknown as QuickBooks;
  return { client, state };
}

async function reject(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail("expected the call to be rejected");
}

describe("handleGetReport — choosing a report", () => {
  it("runs the report named", async () => {
    const { client, seen } = fakeClient();
    const result = await handleGetReport(client, { report: "aged_payables", report_date: "2026-06-30" });
    assert.ok(seen.reportAgedPayables);
    assert.match(result.content[0].text, /Current/);
  });

  it("accepts QuickBooks' own spelling", async () => {
    const { client, seen } = fakeClient();
    await handleGetReport(client, { report: "AgedPayables" });
    assert.ok(seen.reportAgedPayables);
  });

  it("names the closest report when the name is wrong", async () => {
    const { client } = fakeClient();
    const message = await reject(() => handleGetReport(client, { report: "aged_payable" }));
    assert.match(message, /Did you mean "aged_payables"/);
  });

  it("points at the dedicated tool for a report it deliberately omits", async () => {
    const { client } = fakeClient();
    const message = await reject(() => handleGetReport(client, { report: "profit_and_loss" }));
    assert.match(message, /get_profit_loss/);
  });

  it("refuses to run with no report named", async () => {
    const { client } = fakeClient();
    const message = await reject(() => handleGetReport(client, {}));
    assert.match(message, /Missing required parameter "report"/);
  });
});

describe("handleGetReport — dating a report", () => {
  it("dates a point-in-time report with report_date", async () => {
    const { client, seen } = fakeClient();
    await handleGetReport(client, { report: "aged_payables", report_date: "2026-06-30" });
    assert.deepEqual(seen.reportAgedPayables, { report_date: "2026-06-30" });
  });

  it("takes end_date as the as-of date rather than answering as of today", async () => {
    // A caller who reaches for the range parameter on an aging report would
    // otherwise get a silently different report than the one asked for.
    const { client, seen } = fakeClient();
    await handleGetReport(client, { report: "aged_payables", end_date: "2026-06-30" });
    assert.deepEqual(seen.reportAgedPayables, { report_date: "2026-06-30" });
  });

  it("inventory-sends-report-date-and-range", async () => {
    const { client, seen } = fakeClient();
    await handleGetReport(client, { report: "inventory_valuation_summary", report_date: "2026-06-30" });
    assert.deepEqual(seen.reportInventoryValuationSummary, {
      report_date: "2026-06-30", start_date: BEGINNING_OF_BOOKS, end_date: "2026-06-30",
    });
  });

  it("inventory-end-date-alone-sends-all-three", async () => {
    const { client, seen } = fakeClient();
    await handleGetReport(client, { report: "inventory_valuation_summary", end_date: "2026-06-30" });
    assert.deepEqual(seen.reportInventoryValuationSummary, {
      report_date: "2026-06-30", start_date: BEGINNING_OF_BOOKS, end_date: "2026-06-30",
    });
  });

  it("inventory-ignores-caller-start-date", async () => {
    const { client, seen } = fakeClient();
    await handleGetReport(client, {
      report: "inventory_valuation_summary", start_date: "2026-06-01", end_date: "2026-06-30",
    });
    assert.deepEqual(seen.reportInventoryValuationSummary, {
      report_date: "2026-06-30", start_date: BEGINNING_OF_BOOKS, end_date: "2026-06-30",
    });
  });

  it("adds no date criteria to inventory valuation when no date is given", async () => {
    const { client, seen } = fakeClient();
    await handleGetReport(client, { report: "inventory_valuation_summary" });
    assert.deepEqual(seen.reportInventoryValuationSummary, {});
  });

  it("still refuses a lone start_date on inventory valuation", async () => {
    const { client } = fakeClient();
    const message = await reject(() =>
      handleGetReport(client, { report: "inventory_valuation_summary", start_date: "2026-06-01" })
    );
    assert.match(message, /pass report_date, not start_date/);
  });

  it("rejects report_date on a report that covers a range", async () => {
    const { client } = fakeClient();
    const message = await reject(() =>
      handleGetReport(client, { report: "general_ledger", report_date: "2026-06-30" })
    );
    assert.match(message, /covers a date range/);
  });

  it("passes a range through for a range report", async () => {
    const { client, seen } = fakeClient();
    await handleGetReport(client, {
      report: "general_ledger", start_date: "2026-06-01", end_date: "2026-06-30",
      accounting_method: "Cash", summarize_by: "Month",
    });
    assert.deepEqual(seen.reportGeneralLedgerDetail, {
      start_date: "2026-06-01",
      end_date: "2026-06-30",
      accounting_method: "Cash",
      summarize_column_by: "Month",
    });
  });
});

describe("handleGetReport — stating and checking the date QuickBooks applied", () => {
  const textOf = async (client: QuickBooks, args: Parameters<typeof handleGetReport>[1]) =>
    (await handleGetReport(client, args)).content[0].text.split("\n");

  it("report-refuses-misdated", async () => {
    // QBO does not reject a request it cannot honour, it answers as of today.
    const { client } = headerClient({ EndPeriod: TODAY, DateMacro: "today" });
    const message = await reject(() =>
      handleGetReport(client, { report: "aged_payables", report_date: "2026-06-30" })
    );
    assert.match(message, /aged_payables/);
    assert.match(message, /2026-06-30/);
    assert.match(message, /2026-10-07/);
  });

  it("report-refuses-misdated on every point-in-time shape, not just the aging reports", async () => {
    const { client } = headerClient({ EndPeriod: TODAY, DateMacro: "today" });
    for (const report of ["vendor_balance", "inventory_valuation_summary"]) {
      const message = await reject(() =>
        handleGetReport(client, { report, report_date: "2026-06-30" })
      );
      assert.match(message, new RegExp(report));
    }
  });

  it("report-refuses-misdated when the request arrived as end_date", async () => {
    const { client } = headerClient({ EndPeriod: TODAY, DateMacro: "today" });
    const message = await reject(() =>
      handleGetReport(client, { report: "aged_payables", end_date: "2026-06-30" })
    );
    assert.match(message, /2026-06-30/);
    assert.match(message, /2026-10-07/);
  });

  it("report-states-applied-date-on-range-shaped-header", async () => {
    // The FIFO shape: the period starts at the beginning of books and ends at
    // the end_date it was sent, with no report_date Option echoed back.
    const seen: Record<string, string> = {};
    const client = {
      reportInventoryValuationSummary: (options: Record<string, string>, cb: Callback<unknown>) => {
        Object.assign(seen, options);
        cb(null, reportWith({
          ReportName: "InventoryValuationSummary",
          StartPeriod: BEGINNING_OF_BOOKS, EndPeriod: options.end_date,
        }));
      },
    } as unknown as QuickBooks;

    const out = await textOf(client, {
      report: "inventory_valuation_summary", report_date: "2026-06-30",
    });
    assert.equal(seen.end_date, "2026-06-30");
    assert.ok(out.includes("As of: 2026-06-30"));
    assert.ok(!out.some(l => l.startsWith("Period:")));
  });

  it("report-states-chosen-date-when-undated", async () => {
    // A company's "all" macro with an Option naming the date QBO chose, and no
    // EndPeriod: the date is read from the Option and the macro is shown.
    const { client } = headerClient({
      ReportName: "VendorBalance", DateMacro: "all",
      Option: [{ Name: "report_date", Value: "2026-12-31" }],
      EndPeriod: undefined,
    });
    const out = await textOf(client, { report: "vendor_balance" });
    assert.ok(out.includes('As of: 2026-12-31 (date_macro "all")'));
  });

  it("report-states-chosen-date-when-undated also covers a report asked for no date", async () => {
    const { client } = fakeClient();
    const out = await textOf(client, { report: "aged_payables" });
    assert.ok(out.includes(`As of: ${TODAY} (date_macro "today")`));
  });

  it("report-warns-unconfirmed-date", async () => {
    // Nothing in the header says what was applied. That is not evidence of a
    // mismatch, so the report is returned, with the gap stated in the line.
    const { client } = headerClient({ ReportName: "AgedPayables", EndPeriod: undefined });
    const out = await textOf(client, { report: "aged_payables", report_date: "2026-06-30" });
    const line = out.find(l => l.startsWith("As of: not stated by QuickBooks"));
    assert.ok(line, "expected a line saying QuickBooks stated no date");
    assert.match(line!, /2026-06-30/);
  });

  it("states the date QuickBooks applied when it matches the request", async () => {
    const { client } = fakeClient();
    const out = await textOf(client, { report: "aged_payables", report_date: "2026-06-30" });
    assert.ok(out.includes("As of: 2026-06-30"));
  });

  it("report-refuses-non-iso-as-of", async () => {
    const { client, state } = headerClient({ EndPeriod: "2026-06-30" });
    const message = await reject(() =>
      handleGetReport(client, { report: "aged_payables", report_date: "2026-6-30" })
    );
    assert.match(message, /YYYY-MM-DD/);
    assert.equal(state.calls, 0, "the client must not be called with an undated-looking request");
  });

  it("report-refuses-non-iso-as-of whichever parameter carried it", async () => {
    const { client, state } = headerClient({ EndPeriod: "2026-06-30" });
    for (const args of [
      { report: "aged_payables", end_date: "2026-6-30" },
      { report: "aged_payables", report_date: "2026-02-30" },
      { report: "inventory_valuation_summary", report_date: "June 30" },
    ]) {
      const message = await reject(() => handleGetReport(client, args));
      assert.match(message, /YYYY-MM-DD/);
    }
    assert.equal(state.calls, 0);
  });

  it("report-refuses-non-iso-as-of only after unsafe characters are refused by their own message", async () => {
    const { client, state } = headerClient({ EndPeriod: "2026-06-30" });
    const message = await reject(() =>
      handleGetReport(client, { report: "aged_payables", report_date: "2026-06-30&customer=9" })
    );
    assert.match(message, /report criteria may contain only/);
    assert.doesNotMatch(message, /YYYY-MM-DD/);
    assert.equal(state.calls, 0);
  });

  it("leaves a range report unchecked, with its Period line", async () => {
    // A range report states the period it covered, which is not an as-of date
    // and is never compared with the request.
    const { client } = headerClient({
      ReportName: "GeneralLedger", StartPeriod: "2026-06-01", EndPeriod: "2026-06-15",
    });
    const out = await textOf(client, {
      report: "general_ledger", start_date: "2026-06-01", end_date: "2026-06-30",
    });
    assert.ok(out.includes("Period: 2026-06-01 to 2026-06-15"));
    assert.ok(!out.some(l => l.startsWith("As of:")));
  });
});

describe("handleGetReport — criteria that would corrupt the query", () => {
  // node-quickbooks concatenates report criteria into the URL without encoding
  // anything, so an unescaped separator in a value does not arrive as a value —
  // it adds criteria of its own.
  it("rejects a value carrying a query separator", async () => {
    const { client } = fakeClient();
    for (const bad of ["2026-06-30&customer=9", "Cash=x", "a?b", "a#b"]) {
      const message = await reject(() =>
        handleGetReport(client, { report: "aged_payables", report_date: bad })
      );
      assert.match(message, /report criteria may contain only/);
    }
  });

  it("allows the punctuation a legitimate date or macro uses", async () => {
    const { client, seen } = fakeClient();
    await handleGetReport(client, { report: "general_ledger", date_macro: "This Fiscal Year-to-date" });
    assert.equal(seen.reportGeneralLedgerDetail.date_macro, "This Fiscal Year-to-date");
  });
});

describe("handleGetReport — inputs nothing else validates", () => {
  // validateToolArguments checks required and unknown keys, not enums or types.
  it("rejects a detail_level outside the enum rather than quietly summarizing", async () => {
    const { client } = fakeClient();
    for (const bad of ["detailed", "FULL", "all"]) {
      const message = await reject(() =>
        handleGetReport(client, { report: "aged_payables", detail_level: bad })
      );
      assert.match(message, /Invalid detail_level/);
    }
  });

  it("rejects a max_rows that is not a number", async () => {
    // Number("abc") is NaN, and slice(0, NaN) is empty: the table used to come
    // back as headings plus a notice claiming 0 of N rows.
    const { client } = fakeClient();
    for (const bad of ["abc", 0, -3, Infinity]) {
      const message = await reject(() =>
        handleGetReport(client, { report: "aged_payables", max_rows: bad as number })
      );
      assert.match(message, /Invalid max_rows/);
    }
  });

  it("accepts a numeric string, which is what a loose client sends", async () => {
    const { client } = fakeClient();
    await handleGetReport(client, { report: "aged_payables", max_rows: "50" as unknown as number });
  });
});

describe("handleGetReport — a range on a point-in-time report", () => {
  // QBO does not ignore a range on these reports, it answers as of today, so a
  // caller asking for a March aging silently gets one dated now.
  it("refuses start_date on its own", async () => {
    const { client } = fakeClient();
    const message = await reject(() =>
      handleGetReport(client, { report: "aged_payables", start_date: "2026-03-01" })
    );
    assert.match(message, /dated at a single point in time/);
  });

  it("still takes end_date as the as-of date", async () => {
    const { client, seen } = fakeClient();
    await handleGetReport(client, { report: "aged_payables", start_date: "2026-03-01", end_date: "2026-03-31" });
    assert.deepEqual(seen.reportAgedPayables, { report_date: "2026-03-31" });
  });
});

describe("handleGetReport — a department that resolves to nothing", () => {
  // resolveDepartmentId hands back an unmatched name unchanged for QBO to
  // reject, so it can carry arbitrary text into a URL that is never encoded.
  function clientWithNoDepartments() {
    const seen: Record<string, Record<string, string>> = {};
    return {
      client: {
        reportAgedPayables: (options: Record<string, string>, cb: Callback<unknown>) => {
          seen.reportAgedPayables = options;
          cb(null, REPORT);
        },
        findDepartments: (_c: object, cb: Callback<unknown>) =>
          cb(null, { QueryResponse: { Department: [] } }),
      } as unknown as QuickBooks,
      seen,
    };
  }

  it("refuses a department name that would add criteria of its own", async () => {
    const { client } = clientWithNoDepartments();
    const message = await reject(() =>
      handleGetReport(client, { report: "aged_payables", department: "1&start_date=1900-01-01" })
    );
    assert.match(message, /report criteria may contain only/);
  });

  it("refuses one that would truncate the query at a fragment", async () => {
    const { client } = clientWithNoDepartments();
    const message = await reject(() =>
      handleGetReport(client, { report: "aged_payables", department: "North#frag" })
    );
    assert.match(message, /report criteria may contain only/);
  });
});

describe("handleGetReport — response size", () => {
  const wide = {
    Header: { ReportName: "TransactionList" },
    Columns: { Column: [{ ColTitle: "" }, { ColTitle: "Amount" }] },
    Rows: { Row: Array.from({ length: 3000 }, (_, i) => ({ ColData: [{ value: `Row ${i}` }, { value: "1.00" }] })) },
  };

  function bigClient(): QuickBooks {
    return {
      reportTransactionList: (_o: object, cb: Callback<unknown>) => cb(null, wide),
    } as unknown as QuickBooks;
  }

  it("caps the table by default", async () => {
    const result = await handleGetReport(bigClient(), { report: "transaction_list" });
    assert.equal(result.content[0].text.split("\n").filter(l => l.startsWith("Row ")).length, 200);
  });

  it("honours a raised max_rows", async () => {
    const result = await handleGetReport(bigClient(), { report: "transaction_list", max_rows: 500 });
    assert.equal(result.content[0].text.split("\n").filter(l => l.startsWith("Row ")).length, 500);
  });

  it("holds max_rows to a ceiling, so the summary stays a summary", async () => {
    const result = await handleGetReport(bigClient(), { report: "transaction_list", max_rows: 99999 });
    assert.equal(result.content[0].text.split("\n").filter(l => l.startsWith("Row ")).length, 2000);
  });

  it("withholds the raw payload unless asked", async () => {
    const plain = await handleGetReport(bigClient(), { report: "transaction_list" });
    assert.equal(plain.content.length, 1);
    const raw = await handleGetReport(bigClient(), { report: "transaction_list", include_raw: true });
    assert.equal(raw.content.length, 2);
  });
});

describe("handleGetReport — where the withheld rows actually are", () => {
  const wide = {
    Header: { ReportName: "TransactionList" },
    Columns: { Column: [{ ColTitle: "" }, { ColTitle: "Amount" }] },
    Rows: { Row: Array.from({ length: 500 }, (_, i) => ({ ColData: [{ value: `Row ${i}` }, { value: "1.00" }] })) },
  };

  function bigClient(): QuickBooks {
    return {
      reportTransactionList: (_o: object, cb: Callback<unknown>) => cb(null, wide),
    } as unknown as QuickBooks;
  }

  it("sends an HTTP caller to include_raw, not to a file it will never see", async () => {
    setOutputMode("http");
    const text = (await handleGetReport(bigClient(), { report: "transaction_list" })).content[0].text;
    const notice = text.split("\n").find(l => l.startsWith("Showing "))!;
    assert.match(notice, /include_raw/);
    assert.doesNotMatch(notice, /file/);
  });

  it("sends a stdio caller to the file that is already written", async () => {
    setOutputMode("stdio");
    try {
      const text = (await handleGetReport(bigClient(), { report: "transaction_list" })).content[0].text;
      const notice = text.split("\n").find(l => l.startsWith("Showing "))!;
      assert.match(notice, /file below/);
      // And the file it names is really there.
      assert.match(text, /Full data: \//);
    } finally {
      setOutputMode("http");
    }
  });
});
