// Shared ISO-date helpers: calendar arithmetic and the single isIsoDate source.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addDays, isIsoDate } from "../../src/utils/index.js";
import { isIsoDate as isIsoDateFromAsOf } from "../../src/reports/as-of.js";

describe("addDays", () => {
  it("add-days-crosses-boundaries — carries across month, year, leap day and zero days", () => {
    assert.equal(addDays("2026-01-15", 30), "2026-02-14");
    assert.equal(addDays("2026-12-15", 30), "2027-01-14");
    assert.equal(addDays("2024-02-28", 1), "2024-02-29");
    assert.equal(addDays("2026-03-31", 0), "2026-03-31");
  });

  it("add-days-rejects-bad-input — throws on a non-calendar date, a non-ISO shape and fractional days", () => {
    assert.throws(() => addDays("2026-02-30", 1));
    assert.throws(() => addDays("2026-1-5", 1));
    assert.throws(() => addDays("2026-01-15", 1.5));
  });
});

describe("isIsoDate", () => {
  it("iso-date-single-source — utils and as-of export the same function", () => {
    assert.strictEqual(isIsoDate, isIsoDateFromAsOf);
    assert.equal(isIsoDate("2024-02-29"), true);
    assert.equal(isIsoDate("2026-02-30"), false);
  });
});
