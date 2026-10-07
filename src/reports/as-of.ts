// The date a point-in-time report was actually computed for.
//
// QBO dates some reports by report_date and others by start_date/end_date, and
// which one wins depends on the company's costing method. A request QBO does not
// honour is not rejected — it silently answers as of today. These helpers read
// the date QBO says it applied from the report header so a caller can refuse
// figures that are not for the date it asked for.

import type { QBReport } from "../types/index.js";

// Start date for reports that QBO dates by a start_date/end_date pair but that
// are point-in-time in meaning: the period must begin before any transaction so
// end_date alone decides the date.
export const BEGINNING_OF_BOOKS = "1970-01-01";

// What QBO stated it applied. Both fields are optional because a header can omit
// either, and an unstated date is not the same as a wrong one.
export interface AppliedAsOf {
  date?: string;
  macro?: string;
}

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

// Read the applied date from a report header. EndPeriod outranks the Option
// entry named report_date: EndPeriod is present on every dated header from both
// kinds of company, whereas what a FIFO company echoes in Option was never
// observed, so it is trusted only when EndPeriod is absent. Never throws — a
// missing or partial header yields an object with nothing set.
export function appliedAsOf(header: QBReport["Header"]): AppliedAsOf {
  const optionDate = header?.Option?.find((o) => o.Name === "report_date")?.Value;
  const applied: AppliedAsOf = {};
  const date = header?.EndPeriod || optionDate;
  if (date) applied.date = date;
  if (header?.DateMacro) applied.macro = header.DateMacro;
  return applied;
}

// Refuse figures QBO computed for a different date than requested. Throws only
// when a date was requested, the header stated one, and they differ: with no
// request there is nothing to contradict, and with no stated date there is no
// evidence of a mismatch, so neither blocks the report.
export function assertAppliedAsOf(
  report: string,
  requested: string | undefined,
  applied: AppliedAsOf
): void {
  if (!requested || !applied.date || applied.date === requested) return;
  const macro = applied.macro ? ` (date_macro "${applied.macro}")` : "";
  throw new Error(
    `${report}: QuickBooks applied ${applied.date}${macro}, not the requested ${requested}. ` +
      `The figures are withheld because they are not as of the requested date.`
  );
}

// One summary line stating the as-of date, so the reader never has to infer it.
// When QBO stated nothing, say so (and what was requested) rather than implying
// the request was honoured.
export function describeAsOf(applied: AppliedAsOf, requested?: string): string {
  if (!applied.date) {
    return requested
      ? `As of: not stated by QuickBooks (requested ${requested})`
      : "As of: not stated by QuickBooks";
  }
  return applied.macro
    ? `As of: ${applied.date} (date_macro "${applied.macro}")`
    : `As of: ${applied.date}`;
}
