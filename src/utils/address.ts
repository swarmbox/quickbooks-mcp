// Address helpers shared by the customer, company, vendor and purchase-order tools.
// Pure functions and schema builders only: no QuickBooks call.
//
// Which builder to use: where the QuickBooks screen has a structured address
// (street plus City, State, ZIP, Country, as on customers and vendors) send
// structured fields through `buildQBAddress`. Use the free-form helpers
// (`normalizeAddressRows`, `freeFormAddress`, `addressLinesMatch`) only for a
// free-form text box, such as a purchase order's Shipping address.

/** Address as the tool input takes it (snake_case keys). */
export interface AddressInput {
  line1?: string;
  line2?: string;
  line3?: string;
  line4?: string;
  line5?: string;
  city?: string;
  country_sub_division_code?: string;
  postal_code?: string;
  country?: string;
  lat?: string;
  long?: string;
}

/** Address as QuickBooks stores it on BillAddr, ShipAddr and CompanyAddr. */
export interface QBAddress {
  Line1?: string;
  Line2?: string;
  Line3?: string;
  Line4?: string;
  Line5?: string;
  City?: string;
  CountrySubDivisionCode?: string;
  PostalCode?: string;
  Country?: string;
  Lat?: string;
  Long?: string;
}

/** Maps a tool address input to the QuickBooks shape, skipping falsy fields. */
export function buildQBAddress(input: AddressInput): QBAddress {
  const addr: QBAddress = {};
  if (input.line1) addr.Line1 = input.line1;
  if (input.line2) addr.Line2 = input.line2;
  if (input.line3) addr.Line3 = input.line3;
  if (input.line4) addr.Line4 = input.line4;
  if (input.line5) addr.Line5 = input.line5;
  if (input.city) addr.City = input.city;
  if (input.country_sub_division_code) addr.CountrySubDivisionCode = input.country_sub_division_code;
  if (input.postal_code) addr.PostalCode = input.postal_code;
  if (input.country) addr.Country = input.country;
  if (input.lat) addr.Lat = input.lat;
  if (input.long) addr.Long = input.long;
  return addr;
}

/** Renders a QuickBooks address as labelled text lines (a "\n" inside a line starts a new row), or "<label>: (none)" when empty. */
export function formatAddress(addr: QBAddress | undefined, label: string): string[] {
  if (!addr) return [`${label}: (none)`];
  const parts: string[] = [];
  for (const key of ['Line1', 'Line2', 'Line3', 'Line4', 'Line5'] as const) {
    // A free-form address keeps its rows as "\n" inside Line5: show one row per line.
    if (addr[key]) parts.push(...addr[key]!.split(/\r?\n/));
  }
  if (addr.City || addr.CountrySubDivisionCode || addr.PostalCode) {
    const cityState = [addr.City, addr.CountrySubDivisionCode].filter(Boolean).join(', ');
    parts.push([cityState, addr.PostalCode].filter(Boolean).join(' '));
  }
  if (addr.Country) parts.push(addr.Country);
  if (parts.length === 0) return [`${label}: (none)`];
  return [`${label}:`, ...parts.map(p => `  ${p}`)];
}

/**
 * JSON Schema for an address input object. Returns a fresh object on every call,
 * so no schema object is shared between tools.
 */
export function addressSchema(description: string) {
  return {
    type: "object" as const,
    description,
    properties: {
      line1: { type: "string" },
      line2: { type: "string" },
      line3: { type: "string" },
      line4: { type: "string" },
      line5: { type: "string" },
      city: { type: "string" },
      country_sub_division_code: { type: "string", description: "State/province code" },
      postal_code: { type: "string" },
      country: { type: "string" },
      lat: { type: "string" },
      long: { type: "string" },
    },
  };
}

const LINE_KEYS = ["Line1", "Line2", "Line3", "Line4", "Line5"] as const;
const MAX_FREE_FORM_CHARS = 2000;

/**
 * Splits free-form address input (a newline string, or an array of rows or
 * multi-row strings) into trimmed, non-blank rows. Pure row hygiene: no cap on
 * the row count and no length check (see `freeFormAddress`).
 *
 * Sandbox fact: QBO stores a "\n" inside Line5 and its screen shows each row on
 * its own line, so rows are meaningful and blank ones are noise.
 */
export function normalizeAddressRows(input: string | string[] | undefined): string[] {
  const elements = input === undefined ? [] : Array.isArray(input) ? input : [input];
  return elements
    .flatMap(element => String(element).split(/\r?\n/))
    .map(row => row.trim())
    .filter(row => row !== "");
}

/**
 * Builds a free-form address (a ship-to text box) from rows: Line1-Line4 take
 * rows 1-4 and Line5 takes row 5 onward joined with "\n". Sets no other key, never Line6.
 *
 * Sandbox facts: a purchase order's ShipAddr has only Line1-Line5 (Line6 is
 * fault 2010); QBO stores "\n" inside Line5 and shows each row on its own line
 * on screen, while every API read returns those rows joined with spaces. The
 * rows joined with one "\n" each over 2000 characters are refused by QBO with
 * fault 6000, so that limit is checked here, naming `field`.
 */
export function freeFormAddress(rows: string[], field: string): QBAddress {
  const joinedLength = rows.join("\n").length;
  if (joinedLength > MAX_FREE_FORM_CHARS) {
    throw new Error(
      `${field} is ${joinedLength} characters with one separator between rows, ` +
      `over QuickBooks' ${MAX_FREE_FORM_CHARS}-character limit. Shorten it.`
    );
  }
  const addr: QBAddress = {};
  rows.slice(0, LINE_KEYS.length - 1).forEach((row, i) => { addr[LINE_KEYS[i]] = row; });
  if (rows.length >= LINE_KEYS.length) addr.Line5 = rows.slice(LINE_KEYS.length - 1).join("\n");
  return addr;
}

const collapseWhitespace = (line: string | undefined): string => (line ?? "").replace(/\s+/g, " ").trim();

/**
 * True when Line1-Line5 of two addresses agree once every whitespace run is one
 * space and each line is trimmed; a missing line equals an empty one. Other keys
 * (Id, City) are ignored.
 *
 * Sandbox fact: QBO stores "\n" inside Line5, but every API read returns the
 * rows joined with spaces, so a sent address and its read-back differ only in
 * whitespace and cannot be compared byte for byte.
 */
export function addressLinesMatch(sent: QBAddress, booked: QBAddress): boolean {
  return LINE_KEYS.every(key => collapseWhitespace(sent[key]) === collapseWhitespace(booked[key]));
}
