// Shared ISO-date helpers: the single isIsoDate source and UTC calendar arithmetic.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Strict calendar check: the shape alone would let 2026-02-30 through, and a
// date that rolls over to March would be sent to QBO as a different day.
export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

// Add whole days to a YYYY-MM-DD date. Computed in UTC so the local time zone
// can never shift the result by a day. Throws rather than return NaN or a
// rolled-over date: a bill's due date is derived from this and sent to QBO.
export function addDays(isoDate: string, days: number): string {
  if (!isIsoDate(isoDate)) {
    throw new Error(`Not a valid YYYY-MM-DD date: "${isoDate}"`);
  }
  if (!Number.isInteger(days)) {
    throw new Error(`Day count must be a whole number: ${days}`);
  }
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
