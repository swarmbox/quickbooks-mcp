import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { handleGetBalanceSheet, handleGetTrialBalance } from "../../src/tools/handlers/reports.js";
import { setOutputMode } from "../../src/utils/output.js";
import { clearLookupCache } from "../../src/client/cache.js";

// Inline output keeps the test off the filesystem; the summary is content[0].
before(() => setOutputMode("http"));

type Callback<T> = (err: unknown, result: T) => void;

const REPORT = {
  Header: { ReportName: "TrialBalance", StartPeriod: "2026-06-01", EndPeriod: "2026-06-30" },
  Columns: { Column: [{ ColTitle: "" }, { ColTitle: "Debit" }, { ColTitle: "Credit" }] },
  Rows: {
    Row: [
      { ColData: [{ value: "1010 Checking", id: "1" }, { value: "" }, { value: "250.00" }] },
      {
        Summary: { ColData: [{ value: "TOTAL" }, { value: "250.00" }, { value: "250.00" }] },
        type: "Section",
        group: "GrandTotal",
      },
    ],
  },
};

const ACCOUNTS = [
  { Id: "1", Name: "Checking", AcctNum: "1010", Classification: "Asset", AccountType: "Bank" },
];

// A stand-in for the QuickBooks client covering only the two calls this handler
// makes, so the handler runs for real without a network or credentials.
function fakeClient(opts: { accountsFail?: string } = {}): QuickBooks {
  return {
    reportTrialBalance: (_options: object, cb: Callback<unknown>) => cb(null, REPORT),
    findAccounts: (_criteria: object, cb: Callback<unknown>) =>
      opts.accountsFail
        ? cb(new Error(opts.accountsFail), null)
        : cb(null, { QueryResponse: { Account: ACCOUNTS } }),
  } as unknown as QuickBooks;
}

describe("handleGetTrialBalance", () => {
  it("leaves the report untouched when flags are not requested", async () => {
    clearLookupCache();
    const result = await handleGetTrialBalance(fakeClient(), {});
    assert.doesNotMatch(result.content[0].text, /FLAGS/);
    assert.match(result.content[0].text, /1010 Checking/);
  });

  it("appends the flag pass when flags is set", async () => {
    clearLookupCache();
    const result = await handleGetTrialBalance(fakeClient(), { flags: true });
    assert.match(result.content[0].text, /FLAGS/);
    assert.match(result.content[0].text, /1010 Checking\s+250\.00 CR\s+Asset, normally debit/);
  });

  it("still returns the report when the chart of accounts cannot be fetched", async () => {
    // The report is the deliverable and the flags are an extra, so a failed
    // account fetch degrades to a note rather than failing the whole call.
    clearLookupCache();
    const result = await handleGetTrialBalance(fakeClient({ accountsFail: "429 throttled" }), {
      flags: true,
    });
    assert.match(result.content[0].text, /1010 Checking/);
    assert.match(result.content[0].text, /FLAGS unavailable: .*429 throttled/);
  });
});

// A balance sheet fake that records the criteria it receives. `header` builds
// the Header from those criteria, so a test can echo the requested end_date or
// ignore it.
function balanceSheetClient(
  header: (options: Record<string, string>) => Record<string, string>
): { client: QuickBooks; calls: Array<Record<string, string>> } {
  const calls: Array<Record<string, string>> = [];
  const client = {
    reportBalanceSheet: (options: Record<string, string>, cb: Callback<unknown>) => {
      calls.push(options);
      cb(null, {
        Header: { ReportName: "BalanceSheet", ...header(options) },
        Columns: { Column: [{ ColTitle: "" }, { ColTitle: "Total" }] },
        Rows: {
          Row: [{ type: "Data", ColData: [{ value: "1010 Checking" }, { value: "100.00" }] }],
        },
      });
    },
  } as unknown as QuickBooks;
  return { client, calls };
}

describe("handleGetBalanceSheet", () => {
  it("balance-sheet-states-as-of — dated call", async () => {
    const { client, calls } = balanceSheetClient(o => ({
      StartPeriod: "1970-01-01",
      EndPeriod: o.end_date,
    }));
    const result = await handleGetBalanceSheet(client, { as_of_date: "2026-06-30" });
    assert.deepEqual(calls, [{ start_date: "1970-01-01", end_date: "2026-06-30" }]);
    const lines = result.content[0].text.split("\n");
    assert.ok(lines.includes("As of: 2026-06-30"));
    assert.equal(lines.filter(l => l.startsWith("Period:")).length, 0);
  });

  it("balance-sheet-states-as-of — undated call", async () => {
    const { client, calls } = balanceSheetClient(() => ({
      StartPeriod: "2026-01-01",
      EndPeriod: "2026-10-07",
    }));
    const result = await handleGetBalanceSheet(client, {});
    assert.deepEqual(calls, [{}]);
    const lines = result.content[0].text.split("\n");
    assert.ok(lines.includes("Period: 2026-01-01 to 2026-10-07"));
    assert.equal(lines.filter(l => l.startsWith("As of:")).length, 0);
  });

  it("balance-sheet-refuses-misdated", async () => {
    const { client } = balanceSheetClient(() => ({ EndPeriod: "2026-10-07" }));
    await assert.rejects(
      handleGetBalanceSheet(client, { as_of_date: "2026-06-30" }),
      (err: Error) => err.message.includes("2026-06-30") && err.message.includes("2026-10-07")
    );
  });

  it("balance-sheet-refuses-non-iso-as-of", async () => {
    const { client, calls } = balanceSheetClient(() => ({ EndPeriod: "2026-06-30" }));
    await assert.rejects(
      handleGetBalanceSheet(client, { as_of_date: "2026-6-30" }),
      (err: Error) => err.message.includes("YYYY-MM-DD")
    );
    assert.equal(calls.length, 0);
  });
});
