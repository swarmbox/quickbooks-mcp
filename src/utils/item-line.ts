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
    const amountCents = validateAmount(amount, label);
    const unitPriceDollars = roundTo(toDollars(amountCents) / qty, UNIT_PRICE_DECIMALS);

    if (Math.round(qty * unitPriceDollars * 100) !== amountCents) {
      throw new Error(
        `${label}: amount ${toDollars(amountCents).toFixed(2)} over qty ${qty} needs a unit ` +
        `price finer than ${UNIT_PRICE_DECIMALS} decimal places (${unitPriceDollars} does not ` +
        `reconcile). Split the line evenly into lines of fewer than ` +
        `${MAX_RECONCILABLE_QTY} units each. Do not pass unit_price instead — it only ` +
        `accepts 2 decimal places, so it cannot express this value either. This limit is ` +
        `this server's, not QuickBooks'.`,
      );
    }

    return { qty, unitPriceDollars, amountCents };
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

  return { qty, unitPriceDollars: toDollars(upCents), amountCents: Math.round(product) };
}
