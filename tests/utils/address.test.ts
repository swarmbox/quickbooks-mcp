// Address helpers lifted out of customer.ts into src/utils/address.ts.
// Pure functions and schema builders only: no QuickBooks call, no fake client.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildQBAddress, formatAddress, addressSchema } from "../../src/utils/address.js";
import { toolDefinitions } from "../../src/tools/definitions.js";

// Invented fixtures only — this repository is public (CLAUDE.md).
const FULL_INPUT = {
  line1: "1 Alpha Way",
  line2: "Suite 2",
  line3: "Floor 3",
  line4: "Door 4",
  line5: "Desk 5",
  city: "Northfield",
  country_sub_division_code: "NF",
  postal_code: "00001",
  country: "Testland",
  lat: "1.5",
  long: "2.5",
};

// Today's address schema properties, written out literally so the test pins the
// shape independently of addressSchema itself.
const TODAY_PROPERTIES = {
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
};

function inputSchemaOf(toolName: string): { properties: Record<string, unknown> } {
  const tool = toolDefinitions.find(t => t.name === toolName);
  assert.ok(tool, `${toolName} is defined`);
  return tool.inputSchema as unknown as { properties: Record<string, unknown> };
}

describe("address helpers", () => {
  it("address-build-maps-fields — buildQBAddress maps every key and skips absent ones", () => {
    assert.deepEqual(buildQBAddress(FULL_INPUT), {
      Line1: "1 Alpha Way",
      Line2: "Suite 2",
      Line3: "Floor 3",
      Line4: "Door 4",
      Line5: "Desk 5",
      City: "Northfield",
      CountrySubDivisionCode: "NF",
      PostalCode: "00001",
      Country: "Testland",
      Lat: "1.5",
      Long: "2.5",
    });

    assert.deepEqual(buildQBAddress({ line1: "1 Alpha Way", city: "Northfield" }), {
      Line1: "1 Alpha Way",
      City: "Northfield",
    });
  });

  it("address-format-unchanged — formatAddress renders a present address and the (none) form", () => {
    const addr = {
      Line1: "100 Main St",
      City: "Springfield",
      CountrySubDivisionCode: "IL",
      PostalCode: "62701",
    };

    assert.deepEqual(formatAddress(addr, "Billing Address"), [
      "Billing Address:",
      "  100 Main St",
      "  Springfield, IL 62701",
    ]);
    assert.deepEqual(formatAddress(undefined, "Billing Address"), ["Billing Address: (none)"]);
  });

  it("address-schema-unchanged — the four address schemas and addressSchema keep today's shape", () => {
    const create = inputSchemaOf("create_customer");
    const edit = inputSchemaOf("edit_customer");

    assert.deepEqual(create.properties.bill_address, {
      type: "object",
      description: "Billing address (optional)",
      properties: TODAY_PROPERTIES,
    });
    assert.deepEqual(create.properties.ship_address, {
      type: "object",
      description: "Shipping address (optional, same shape as bill_address)",
      properties: TODAY_PROPERTIES,
    });
    assert.deepEqual(edit.properties.bill_address, {
      type: "object",
      description: "New billing address",
      properties: TODAY_PROPERTIES,
    });
    assert.deepEqual(edit.properties.ship_address, {
      type: "object",
      description: "New shipping address",
      properties: TODAY_PROPERTIES,
    });

    const first = addressSchema("Any text");
    const second = addressSchema("Any text");
    assert.deepEqual(first, { type: "object", description: "Any text", properties: TODAY_PROPERTIES });
    assert.deepEqual(second, first);
    assert.notEqual(first, second, "addressSchema returns a fresh object on every call");
  });
});
