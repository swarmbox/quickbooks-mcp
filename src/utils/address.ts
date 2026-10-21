// Address helpers shared by the customer, company and vendor tools.
// Pure functions and schema builders only: no QuickBooks call.

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

/** Renders a QuickBooks address as labelled text lines, or "<label>: (none)" when empty. */
export function formatAddress(addr: QBAddress | undefined, label: string): string[] {
  if (!addr) return [`${label}: (none)`];
  const parts: string[] = [];
  for (const key of ['Line1', 'Line2', 'Line3', 'Line4', 'Line5'] as const) {
    if (addr[key]) parts.push(addr[key]!);
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
