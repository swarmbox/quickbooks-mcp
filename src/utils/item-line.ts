// Item-line Amount/Qty/UnitPrice derivation.
//
// QBO validates `Amount == Qty * UnitPrice` on item lines rather than
// recomputing it, and returns fault 6070 when they disagree. Critically, it
// computes the product at whatever precision `UnitPrice` was sent with and
// rounds to the cent to compare — so rounding `UnitPrice` to two decimals is
// what CAUSES 6070, and keeping precision is what avoids it. Every derivation
// here reconciles or throws; nothing arithmetically inconsistent reaches QBO,
// and `amountCents` is always a whole number of cents so it can enter the
// cents-based money path in `./money.js` unchanged.

import { validateAmount, toDollars } from './money.js';

/** Decimal places retained on a derived `UnitPrice`. */
const UNIT_PRICE_DECIMALS = 6;

/** Above roughly this many units a 6dp unit price can no longer reconcile. */
const MAX_RECONCILABLE_QTY = 10000;

/** Same tolerance `validateAmount` allows for float representation error. */
const CENT_TOLERANCE = 0.001;

export interface ItemLineAmountInput {
  amount?: number;
  qty?: number;
  unit_price?: number;
}

export interface ResolvedItemLineAmount {
  qty: number;
  unitPriceDollars: number;
  amountCents: number;
}

/**
 * Guard the whole-cent invariant on the way out.
 *
 * Neither the tolerance check nor the reconcile-assert can catch a non-finite
 * value: `Math.abs(Infinity - Math.round(Infinity))` is `NaN` and every `NaN`
 * comparison is false, while `Infinity !== Infinity` is also false. So both
 * guards silently pass and `Amount` serializes to JSON `null` — a payload QBO
 * cannot read. `Number.isSafeInteger` rejects `Infinity`, `NaN`, and anything
 * past 2^53 where float addition stops being exact in cents.
 */
function assertWholeCents(amountCents: number, label: string): void {
  if (!Number.isSafeInteger(amountCents)) {
    throw new Error(
      `${label}: derived amount ${amountCents} is not a safe whole number of cents. ` +
      `Amounts must be finite and below ${Number.MAX_SAFE_INTEGER / 100} dollars.`,
    );
  }
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Resolve an item line's `{ qty, unitPriceDollars, amountCents }` triple.
 *
 * Accepts either an `amount` (with an optional `qty`, which may be the `Qty`
 * already on a fetched line) or both `qty` and `unit_price`. Throws locally,
 * naming `label` and the offending values, whenever no consistent whole-cent
 * triple can be derived — rather than forwarding a payload QBO will reject
 * with an opaque fault.
 *
 * @param input - The caller's amount / qty / unit_price.
 * @param label - Caller-supplied line label, interpolated into every error.
 */
export function resolveItemLineAmount(
  input: ItemLineAmountInput,
  label: string,
): ResolvedItemLineAmount {
  const { amount, unit_price: unitPrice } = input;

  if (amount === undefined && (input.qty === undefined || unitPrice === undefined)) {
    throw new Error(`${label} requires amount, or both qty and unit_price`);
  }

  const qty = input.qty ?? 1;
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error(`${label} has qty ${qty}, which must be a finite number greater than 0`);
  }

  if (amount !== undefined) {
    if (!Number.isFinite(amount)) {
      throw new Error(`${label} has amount ${amount}, which must be a finite number`);
    }
    const amountCents = validateAmount(amount, label);
    assertWholeCents(amountCents, label);
    const unitPriceDollars = roundTo(toDollars(amountCents) / qty, UNIT_PRICE_DECIMALS);

    if (Math.round(qty * unitPriceDollars * 100) !== amountCents) {
      throw new Error(
        `${label}: amount ${toDollars(amountCents).toFixed(2)} over qty ${qty} needs a unit ` +
        `price finer than ${UNIT_PRICE_DECIMALS} decimal places (${unitPriceDollars} does not ` +
        `reconcile). Split the line evenly into lines of fewer than ` +
        `${MAX_RECONCILABLE_QTY} units each — the customer will see one line per part, ` +
        `so this is not a free remedy. Do not pass unit_price instead — it only ` +
        `accepts 2 decimal places, so it cannot express this value either. This limit is ` +
        `this server's, not QuickBooks'.`,
      );
    }

    return { qty, unitPriceDollars, amountCents };
  }

  if (!Number.isFinite(unitPrice!)) {
    throw new Error(`${label} has unit_price ${unitPrice}, which must be a finite number`);
  }
  const upCents = validateAmount(unitPrice!, `${label} unit_price`);
  const product = upCents * qty;

  if (Math.abs(product - Math.round(product)) > CENT_TOLERANCE) {
    throw new Error(
      `${label}: unit_price ${toDollars(upCents).toFixed(2)} times qty ${qty} is ` +
      `${toDollars(product)}, which is not a whole number of cents. QuickBooks only ` +
      `supports 2 decimal places (cents).`,
    );
  }

  const amountCents = Math.round(product);
  assertWholeCents(amountCents, label);

  const unitPriceDollars = toDollars(upCents);
  // The same reconcile-assert the amount branch applies. It agrees with
  // `upCents * qty` at every reachable magnitude, but the two evaluation
  // orders diverge past ~2^53 cents, and the invariant is stated without
  // qualification — so enforce it here rather than document an exception.
  if (Math.round(qty * unitPriceDollars * 100) !== amountCents) {
    throw new Error(
      `${label}: unit_price ${unitPriceDollars} times qty ${qty} cannot be represented ` +
      `exactly in cents (${amountCents}). Split the line into smaller amounts.`,
    );
  }

  return { qty, unitPriceDollars, amountCents };
}
