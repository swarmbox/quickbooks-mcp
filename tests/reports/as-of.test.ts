import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  BEGINNING_OF_BOOKS,
  appliedAsOf,
  assertAppliedAsOf,
  describeAsOf,
  isIsoDate,
} from "../../src/reports/as-of.js";
import type { QBReport } from "../../src/types/index.js";

// Invented headers only: the repository is public.

describe("appliedAsOf", () => {
  it("applied-as-of-prefers-end-period — EndPeriod wins over a disagreeing Option", () => {
    const header: QBReport["Header"] = {
      EndPeriod: "2026-06-30",
      Option: [{ Name: "report_date", Value: "2026-10-07" }],
    };
    assert.equal(appliedAsOf(header).date, "2026-06-30");
  });

  it("applied-as-of-falls-back-to-option — reads report_date and DateMacro when EndPeriod is absent", () => {
    const header: QBReport["Header"] = {
      DateMacro: "all",
      Option: [
        { Name: "report_date", Value: "2026-12-31" },
        { Name: "NoReportData", Value: "false" },
      ],
    };
    assert.deepEqual(appliedAsOf(header), { date: "2026-12-31", macro: "all" });
  });

  it("applied-as-of-unstated — an empty or missing header states neither date nor macro", () => {
    for (const header of [{}, undefined]) {
      const applied = appliedAsOf(header);
      assert.equal(applied.date, undefined);
      assert.equal(applied.macro, undefined);
    }
  });
});

describe("assertAppliedAsOf", () => {
  it("assert-as-of-refuses-mismatch — names the report, both dates and the macro", () => {
    assert.throws(
      () => assertAppliedAsOf("aged_payables", "2026-06-30", { date: "2026-10-07", macro: "today" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        for (const part of ["aged_payables", "2026-06-30", "2026-10-07", "today"]) {
          assert.ok(err.message.includes(part), `message lacks ${part}: ${err.message}`);
        }
        assert.match(err.message, /not as of the requested date/);
        return true;
      },
    );
  });

  it("assert-as-of-allows-match-unrequested-or-unstated — throws only on a stated, differing date", () => {
    assert.doesNotThrow(() => assertAppliedAsOf("aged_payables", "2026-06-30", { date: "2026-06-30" }));
    assert.doesNotThrow(() => assertAppliedAsOf("aged_payables", undefined, { date: "2026-10-07" }));
    assert.doesNotThrow(() => assertAppliedAsOf("aged_payables", "2026-06-30", {}));
  });
});

describe("describeAsOf", () => {
  it("describe-as-of-forms — the four one-line forms", () => {
    assert.equal(describeAsOf({ date: "2026-06-30" }), "As of: 2026-06-30");
    assert.equal(
      describeAsOf({ date: "2026-12-31", macro: "all" }),
      'As of: 2026-12-31 (date_macro "all")',
    );
    const withRequest = describeAsOf({}, "2026-06-30");
    assert.ok(withRequest.startsWith("As of: not stated by QuickBooks"));
    assert.ok(withRequest.includes("2026-06-30"));
    assert.ok(!withRequest.includes("\n"));
    assert.equal(describeAsOf({}), "As of: not stated by QuickBooks");
  });
});

describe("isIsoDate", () => {
  it("iso-date-strict — only real YYYY-MM-DD calendar dates pass", () => {
    const accepted = ["2026-06-30", "2024-02-29"];
    const rejected = ["2026-6-30", "2026-02-30", "2025-02-29", "2026-06-30x", "06/30/2026", ""];
    for (const s of accepted) assert.equal(isIsoDate(s), true, s);
    for (const s of rejected) assert.equal(isIsoDate(s), false, JSON.stringify(s));
  });
});

describe("BEGINNING_OF_BOOKS", () => {
  it("is the start-of-books date the balance sheet has always sent", () => {
    assert.equal(BEGINNING_OF_BOOKS, "1970-01-01");
  });

  it("appears as a literal only in src/reports/as-of.ts", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts") && readFileSync(path, "utf8").includes("1970-01-01")) hits.push(path);
      }
    };
    walk("src");
    assert.deepEqual(hits, [join("src", "reports", "as-of.ts")]);
  });
});
