// Item-line Amount/Qty/UnitPrice derivation.
//
// QBO validates `Amount == Qty * UnitPrice` on item lines rather than
// recomputing it, and it does so at whatever precision `UnitPrice` was sent
// with, rounding the product to the cent to compare. So the hazard is the
// opposite of the intuitive one: rounding `UnitPrice` to cents is what causes
// fault 6070, and full-precision division reconciles. These tests pin that
// direction, the whole-cent guarantee on `Amount`, and every local throw — so
// the handlers never hand QBO a triple it will reject, and never emit a
// sub-cent `Amount` into the cents-based money path.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveItemLineAmount } from "../../src/utils/item-line.js";

describe("resolveItemLineAmount", () => {
  it("derives a reconciling UnitPrice from amount 10.00 at qty 3", () => {
    const r = resolveItemLineAmount({ amount: 10.00, qty: 3 }, "L");
    assert.equal(r.qty, 3);
    assert.equal(r.amountCents, 1000);
    assert.equal(Math.round(3 * r.unitPriceDollars * 100), 1000);
  });

  it("accepts amount 100.00 at qty 3 without rounding UnitPrice to cents", () => {
    // Regression guard: a round-to-cents derivation gives 33.33, whose product
    // is 99.99 against an Amount of 100.00 — the actual cause of fault 6070.
    const r = resolveItemLineAmount({ amount: 100.00, qty: 3 }, "L");
    assert.equal(r.amountCents, 10000);
    assert.notEqual(r.unitPriceDollars, 33.33);
    assert.equal(Math.round(3 * r.unitPriceDollars * 100), 10000);
  });

  it("accepts fractional qty 2.5 when the product lands on a cent", () => {
    const r = resolveItemLineAmount({ unit_price: 10.00, qty: 2.5 }, "L");
    assert.equal(r.amountCents, 2500);
    assert.equal(r.unitPriceDollars, 10.00);
  });

  it("rounds the product to whole cents after the tolerance check", () => {
    // 3 cents x 0.3333333 = 0.9999998999999999 — inside validateAmount's 0.001
    // tolerance but not an integer. Tolerance-checking alone would return it.
    const r = resolveItemLineAmount({ unit_price: 0.03, qty: 0.3333333 }, "L");
    assert.ok(Number.isInteger(r.amountCents));
    assert.equal(r.amountCents, 1);
  });

  it("rejects a sub-cent Amount from unit_price 10.01 at qty 2.5", () => {
    assert.throws(
      () => resolveItemLineAmount({ unit_price: 10.01, qty: 2.5 }, "L"),
      (e: Error) => {
        assert.match(e.message, /L/);
        assert.match(e.message, /10\.01/);
        assert.match(e.message, /2\.5/);
        return true;
      },
    );
  });

  it("rejects a unit price too fine for the 6dp bound at qty 30000", () => {
    // Rule 3's reconcile-assert: 350/30000 needs more than 6dp, so the bounded
    // unit price gives 350.01 against a requested 350.00. The message must
    // point at the split remedy — NOT at supplying unit_price, which
    // validateAmount rejects for every input that can reach here.
    assert.throws(
      () => resolveItemLineAmount({ amount: 350.00, qty: 30000 }, "L"),
      (e: Error) => {
        assert.match(e.message, /L/);
        assert.match(e.message, /30000/);
        assert.match(e.message, /0\.011667/);
        assert.match(e.message, /6 decimal places/);
        assert.match(e.message, /split/i);
        return true;
      },
    );
  });

  it("rejects qty 0", () => {
    // The unit_price shape is what actually pins the guard: without it,
    // 1000 * 0 returns amountCents 0 silently. The amount shape throws either
    // way (10/0 is Infinity, which the reconcile-assert also rejects), so it
    // cannot tell the guard's presence from its absence.
    assert.throws(
      () => resolveItemLineAmount({ unit_price: 10.00, qty: 0 }, "L"),
      /must be a finite number greater than 0/,
    );
    assert.throws(
      () => resolveItemLineAmount({ amount: 10.00, qty: 0 }, "L"),
      /must be a finite number greater than 0/,
    );
  });

  it("defaults qty to 1 when omitted", () => {
    // The most common production shape: lines: [{ item_name, amount }].
    assert.deepEqual(resolveItemLineAmount({ amount: 10.00 }, "L"), {
      qty: 1,
      unitPriceDollars: 10,
      amountCents: 1000,
    });
  });

  it("rejects a non-finite or negative qty", () => {
    // Rule 2 requires finite and > 0; qty 0 alone does not cover either half.
    assert.throws(() => resolveItemLineAmount({ amount: 10.00, qty: NaN }, "L"), /L/);
    assert.throws(() => resolveItemLineAmount({ amount: 10.00, qty: Infinity }, "L"), /L/);
    assert.throws(() => resolveItemLineAmount({ amount: 10.00, qty: -1 }, "L"), /L/);
  });

  it("rejects a non-finite or unsafe amount", () => {
    // Infinity and NaN slip past BOTH the tolerance check and the
    // reconcile-assert — Math.abs(Infinity - Infinity) is NaN and every NaN
    // comparison is false, and Infinity === Infinity. The resulting Amount
    // serializes to JSON null and ships to QBO.
    assert.throws(() => resolveItemLineAmount({ amount: 1e307, qty: 2 }, "L"), /L/);
    assert.throws(() => resolveItemLineAmount({ amount: Infinity, qty: 2 }, "L"), /L/);
    assert.throws(() => resolveItemLineAmount({ unit_price: 1e308, qty: 100 }, "L"), /L/);
    assert.throws(() => resolveItemLineAmount({ unit_price: NaN, qty: 1 }, "L"), /L/);
  });

  it("rejects input with neither amount nor unit_price", () => {
    assert.throws(() => resolveItemLineAmount({}, "L"), /L/);
    assert.throws(() => resolveItemLineAmount({ qty: 2 }, "L"), /L/);
  });
});
