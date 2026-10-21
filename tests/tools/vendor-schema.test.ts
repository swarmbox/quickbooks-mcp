import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toolDefinitions } from "../../src/tools/definitions.js";
import { executeTool } from "../../src/tools/index.js";
import { addressSchema } from "../../src/utils/address.js";

const TOOL = "create_vendor";

interface SchemaNode {
  type?: string;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  description?: string;
}

describe("create_vendor registration", () => {
  it("schema-create-vendor-definition — advertises the tool with its guards and exact arguments", () => {
    const tool = toolDefinitions.find((t) => t.name === TOOL);
    assert.ok(tool, `${TOOL} must be defined`);

    const schema = tool.inputSchema as unknown as SchemaNode;
    assert.deepEqual(schema.required, ["display_name"]);
    assert.deepEqual(Object.keys(schema.properties ?? {}), [
      "display_name",
      "given_name",
      "middle_name",
      "family_name",
      "suffix",
      "company_name",
      "email",
      "phone",
      "mobile",
      "bill_address",
      "print_on_check_name",
      "acct_num",
      "sales_term_ref",
      "draft",
    ]);

    const billAddress = schema.properties!.bill_address;
    assert.deepEqual(billAddress, addressSchema(billAddress.description!));
    assert.equal(schema.properties!.draft.type, "boolean");

    assert.ok(tool.description.includes("unique across customers, vendors and employees"));
    assert.ok(tool.description.includes("draft"));
    assert.ok(!tool.description.includes("[C]"));
  });

  it("schema-create-vendor-validated — refuses missing and unknown arguments before reaching QuickBooks", async () => {
    const missing = await executeTool(TOOL, {});
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Invalid arguments/);
    assert.match(missing.content[0].text, /display_name/);

    const unknown = await executeTool(TOOL, {
      display_name: "Acme Supply",
      vendor_type: "x",
    });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /Invalid arguments/);
    assert.ok(unknown.content[0].text.includes('Unknown parameter "vendor_type"'));
  });
});
