// The get_preferences tool: the books closing date leads the summary, followed by
// a short curated digest; the full Preferences object goes to outputReport as-is.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type QuickBooks from "node-quickbooks";

import { setOutputMode } from "../../src/utils/output.js";
import { handleGetPreferences, formatPreferencesSummary } from "../../src/tools/handlers/preferences.js";
import { toolDefinitions, executeTool } from "../../src/tools/index.js";
import { validateToolArguments, type ToolSchema } from "../../src/tools/validate.js";
import { newAttemptRecord, withWriteTracking } from "../../src/client/write-barrier.js";

type Callback<T> = (err: unknown, result: T) => void;
type ToolResult = { content: Array<{ type: string; text: string }> };

// Invented fixtures only — this repository is public (CLAUDE.md).
const FULL_PREFS = {
  AccountingInfoPrefs: {
    BookCloseDate: "2025-12-31",
    TrackDepartments: true,
    DepartmentTerminology: "Location",
    ClassTrackingPerTxn: false,
    ClassTrackingPerTxnLine: true,
    FirstMonthOfFiscalYear: "January",
    UseAccountNumbers: true,
  },
  ReportPrefs: { ReportBasis: "Accrual" },
  CurrencyPrefs: { HomeCurrency: { value: "USD" }, MultiCurrencyEnabled: true },
  SalesFormsPrefs: { DefaultTerms: { value: "3", name: "Net 30" } },
  VendorAndPurchasesPrefs: {
    DefaultTerms: { value: "4", name: "Net 15" },
    BillableExpenseTracking: true,
    DefaultMarkup: 10,
  },
};

function fakeClient(prefs: unknown) {
  let calls = 0;
  const client = {
    getPreferences: (cb: Callback<unknown>) => {
      calls++;
      cb(null, prefs);
    },
  } as unknown as QuickBooks;
  return { client, calls: () => calls };
}

const textOf = (result: ToolResult) => result.content[0].text;
const lines = (text: string) => text.split("\n");
const lineStarting = (text: string, label: string) => lines(text).find((l) => l.startsWith(label));

afterEach(() => setOutputMode("stdio"));

describe("get_preferences summary", () => {
  it("preferences-close-date-leads", async () => {
    const { client } = fakeClient(FULL_PREFS);
    const text = textOf(await handleGetPreferences(client));

    assert.ok(lines(text).includes("Books closing date: 2025-12-31"));
    const closeAt = text.indexOf("Books closing date: 2025-12-31");
    for (const label of ["Accounting:", "Reporting:", "Currency:", "Sales:", "Purchases:"]) {
      const at = text.indexOf(label);
      assert.ok(at > closeAt, `${label} line comes after the close-date line`);
    }
  });

  it("preferences-summary-has-title-and-underline", async () => {
    const { client } = fakeClient(FULL_PREFS);
    const out = lines(textOf(await handleGetPreferences(client)));

    assert.equal(out[0], "Company Preferences");
    assert.match(out[1], /^=+$/);
  });

  it("preferences-close-date-none-set", async () => {
    const { client } = fakeClient({ AccountingInfoPrefs: { TrackDepartments: true } });
    const text = textOf(await handleGetPreferences(client));

    assert.ok(lines(text).includes("Books closing date: none set"));
  });

  it("preferences-digest-shows-settings", async () => {
    const { client } = fakeClient(FULL_PREFS);
    const text = textOf(await handleGetPreferences(client));

    const accounting = lineStarting(text, "Accounting:");
    const reporting = lineStarting(text, "Reporting:");
    const currency = lineStarting(text, "Currency:");
    const sales = lineStarting(text, "Sales:");
    const purchases = lineStarting(text, "Purchases:");
    for (const line of [accounting, reporting, currency, sales, purchases]) assert.ok(line);

    const joined = [accounting, reporting, currency, sales, purchases].join("\n");
    for (const expected of [
      "departments ON",
      "Location",
      "classes per line",
      "fiscal year starts January",
      "account numbers ON",
      "basis Accrual",
      "home USD",
      "multi-currency ON",
      "Net 30",
      "Net 15",
      "billable expenses ON",
      "markup 10",
    ]) {
      assert.ok(joined.includes(expected), `digest contains "${expected}"`);
    }
  });

  it("preferences-digest-classes-per-transaction-and-off", () => {
    const perTxn = formatPreferencesSummary({
      AccountingInfoPrefs: { ClassTrackingPerTxn: true, ClassTrackingPerTxnLine: false },
    });
    assert.match(lineStarting(perTxn, "Accounting:") ?? "", /classes per transaction/);

    const off = formatPreferencesSummary({
      AccountingInfoPrefs: { ClassTrackingPerTxn: false, ClassTrackingPerTxnLine: false },
    });
    assert.match(lineStarting(off, "Accounting:") ?? "", /classes OFF/);
  });

  it("preferences-false-renders-off", async () => {
    const { client } = fakeClient({
      CurrencyPrefs: { HomeCurrency: { value: "USD" }, MultiCurrencyEnabled: false },
    });
    const text = textOf(await handleGetPreferences(client));

    const currency = lineStarting(text, "Currency:");
    assert.ok(currency);
    assert.ok(currency.includes("home USD"));
    assert.ok(currency.includes("multi-currency OFF"));
    assert.ok(!currency.includes("id USD"));
    for (const label of ["Accounting:", "Reporting:", "Sales:", "Purchases:"]) {
      assert.equal(lineStarting(text, label), undefined, `${label} line is omitted`);
    }
  });

  it("preferences-empty-object-is-safe", async () => {
    const { client } = fakeClient({});
    const text = textOf(await handleGetPreferences(client));

    assert.ok(text.includes("Books closing date: none set"));
    for (const label of ["Accounting:", "Reporting:", "Currency:", "Sales:", "Purchases:"]) {
      assert.equal(lineStarting(text, label), undefined, `${label} line is omitted`);
    }
    assert.ok(!text.includes("undefined"));
    assert.ok(!text.includes("null"));
  });

  it("preferences-empty-object-is-safe: the formatter never throws on partial sections", () => {
    assert.doesNotThrow(() => formatPreferencesSummary({}));
    assert.doesNotThrow(() =>
      formatPreferencesSummary({
        AccountingInfoPrefs: {},
        ReportPrefs: {},
        CurrencyPrefs: {},
        SalesFormsPrefs: {},
        VendorAndPurchasesPrefs: {},
      })
    );
    const text = formatPreferencesSummary({ VendorAndPurchasesPrefs: {}, SalesFormsPrefs: {} });
    assert.ok(!text.includes("undefined"));
  });

  it("preferences-terms-name-fallback", async () => {
    const { client } = fakeClient({ SalesFormsPrefs: { DefaultTerms: { value: "3" } } });
    const text = textOf(await handleGetPreferences(client));

    const sales = lineStarting(text, "Sales:");
    assert.ok(sales);
    assert.ok(sales.includes("id 3"));
  });
});

describe("get_preferences output", () => {
  it("preferences-http-inline-json", async () => {
    setOutputMode("http");
    const { client } = fakeClient(FULL_PREFS);
    const result = (await handleGetPreferences(client)) as ToolResult;

    assert.equal(result.content.length, 2);
    assert.deepEqual(JSON.parse(result.content[1].text), FULL_PREFS);
  });

  it("preferences-stdio-full-data-file", async () => {
    setOutputMode("stdio");
    const { client } = fakeClient(FULL_PREFS);
    const result = (await handleGetPreferences(client)) as ToolResult;

    assert.equal(result.content.length, 1);
    const match = /Full data: (.+)$/.exec(result.content[0].text);
    assert.ok(match, "text ends with 'Full data: <path>'");
    assert.deepEqual(JSON.parse(readFileSync(match[1], "utf8")), FULL_PREFS);
  });

  it("preferences-read-calls-client-once-and-passes-object-unmodified", async () => {
    setOutputMode("http");
    const prefs = structuredClone(FULL_PREFS);
    const { client, calls } = fakeClient(prefs);
    await handleGetPreferences(client);

    assert.equal(calls(), 1);
    assert.deepEqual(prefs, FULL_PREFS, "the object is not modified");
  });
});

describe("get_preferences faults and retry", () => {
  it("preferences-fault-propagates", async () => {
    const fault = Object.assign(new Error("Request failed with status code 400"), {
      response: { status: 400, data: { Fault: { Error: [{ Message: "Bad", code: "2500" }] } } },
    });
    const client = {
      getPreferences: (cb: Callback<unknown>) => cb(fault, undefined),
    } as unknown as QuickBooks;

    await assert.rejects(
      () => handleGetPreferences(client),
      (err) => err === fault
    );
  });

  it("preferences-read-leaves-retry-open", async () => {
    const { client } = fakeClient(FULL_PREFS);
    const record = newAttemptRecord();

    await withWriteTracking(record, () => handleGetPreferences(client));

    assert.equal(record.writeIssued, false);
  });
});

describe("get_preferences schema", () => {
  const definition = toolDefinitions.find((d) => d.name === "get_preferences");

  it("preferences-schema-accepts-no-arguments", () => {
    assert.ok(definition, "get_preferences is defined");
    const schema = definition.inputSchema as unknown as ToolSchema;

    assert.deepEqual(definition.inputSchema, { type: "object", properties: {}, required: [] });
    assert.doesNotThrow(() => validateToolArguments("get_preferences", schema, {}));
    assert.doesNotThrow(() => validateToolArguments("get_preferences", schema, undefined));
  });

  it("preferences-description-names-the-closing-date", () => {
    assert.ok(definition);
    assert.match(definition.description, /closing date/);
  });

  it("preferences-rejects-unknown-argument", async () => {
    // No credentials needed: validation runs before the client lookup.
    const result = await executeTool("get_preferences", { bogus: 1 });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Invalid arguments/);
    assert.match(result.content[0].text, /Unknown parameter "bogus"/);
  });
});

describe("get_preferences summary on null and empty refs", () => {
  // QBO omits unset keys, so these shapes are defensive: the formatter must never
  // throw, and must render a null or empty field as absent, never as text.
  type Prefs = Parameters<typeof formatPreferencesSummary>[0];
  const summarize = (prefs: unknown) => formatPreferencesSummary(prefs as Prefs);
  const DIGEST_LABELS = ["Accounting:", "Reporting:", "Currency:", "Sales:", "Purchases:"];

  it("preferences-null-terms-skipped", () => {
    const text = summarize({
      SalesFormsPrefs: { DefaultTerms: null },
      VendorAndPurchasesPrefs: { DefaultTerms: null },
    });

    assert.equal(lineStarting(text, "Sales:"), undefined);
    assert.equal(lineStarting(text, "Purchases:"), undefined);
  });

  it("preferences-null-home-currency-skipped", () => {
    const text = summarize({ CurrencyPrefs: { HomeCurrency: null } });

    assert.equal(lineStarting(text, "Currency:"), undefined);
  });

  it("preferences-empty-home-currency-skipped", () => {
    const text = summarize({ CurrencyPrefs: { HomeCurrency: {}, MultiCurrencyEnabled: true } });

    const currency = lineStarting(text, "Currency:");
    assert.ok(currency);
    assert.ok(currency.includes("multi-currency ON"));
    assert.ok(!currency.includes("home"));
    assert.ok(!text.includes("undefined"));
  });

  it("preferences-empty-terms-skipped", () => {
    const text = summarize({ SalesFormsPrefs: { DefaultTerms: {} } });

    assert.equal(lineStarting(text, "Sales:"), undefined);
    assert.ok(!text.includes("undefined"));
  });

  it("preferences-null-scalars-skipped", () => {
    const text = summarize({
      AccountingInfoPrefs: {
        BookCloseDate: null,
        TrackDepartments: null,
        DepartmentTerminology: null,
        ClassTrackingPerTxn: null,
        ClassTrackingPerTxnLine: null,
        FirstMonthOfFiscalYear: null,
        UseAccountNumbers: null,
      },
      ReportPrefs: { ReportBasis: null },
      CurrencyPrefs: { HomeCurrency: null, MultiCurrencyEnabled: null },
      SalesFormsPrefs: { DefaultTerms: null },
      VendorAndPurchasesPrefs: { DefaultTerms: null, BillableExpenseTracking: null, DefaultMarkup: null },
    });

    assert.ok(text.includes("Books closing date: none set"));
    for (const label of DIGEST_LABELS) {
      assert.equal(lineStarting(text, label), undefined, `${label} line is omitted`);
    }
    assert.ok(!text.includes("null"));
    assert.ok(!text.includes("undefined"));
  });
});
