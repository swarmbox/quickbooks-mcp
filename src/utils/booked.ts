// Rendering for the sent-versus-booked comparison a create tool runs after a write.
//
// QuickBooks can answer HTTP 200 and store something other than what was sent
// (it drops fields, re-folds address lines, recomputes totals), so a create tool
// compares its payload with the response and reports any difference.
//
// This helper is generic on purpose. create_bill_payment's `bookedDifferences`
// is specific to payment links (it keys lines by linked transaction and sums
// split links), so it cannot serve a tool whose comparison is field by field.
// Each tool builds its own rows, normalizing both sides to display strings, and
// hands them here to be rendered the same way.

export interface FieldRow {
  label: string;
  /** What the payload carried; undefined when it carried nothing. */
  sent: string | undefined;
  /** What QuickBooks booked; undefined when it booked nothing. */
  booked: string | undefined;
}

/**
 * "<label>: sent <x>, booked <y>" for every row whose two sides differ, in row
 * order; a side that is absent renders as "(none)". Equal rows produce nothing.
 */
export function fieldDifferences(rows: FieldRow[]): string[] {
  return rows
    .filter(row => row.sent !== row.booked)
    .map(row => `${row.label}: sent ${row.sent ?? "(none)"}, booked ${row.booked ?? "(none)"}`);
}
