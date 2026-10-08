import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toolDefinitions } from "../../src/tools/definitions.js";
import { executeTool } from "../../src/tools/index.js";

const TOOL = "convert_expense_to_bill_payment";

interface SchemaNode {
  type?: string;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}

describe("convert_expense_to_bill_payment registration", () => {
  it("schema-convert-definition — advertises the tool with its guards and exact arguments", () => {
    const tool = toolDefinitions.find((t) => t.name === TOOL);
    assert.ok(tool, `${TOOL} must be defined`);

    assert.ok(
      tool.description.startsWith(
        "Use only when the user explicitly asks to turn an existing expense into a bill payment."
      )
    );
    assert.ok(tool.description.includes("Do not use it to fix or recode an expense on your own"));
    assert.ok(tool.description.includes("deleted"));
    assert.ok(tool.description.includes("draft"));

    const schema = tool.inputSchema as unknown as SchemaNode;
    assert.deepEqual(schema.required, ["expense_id", "bills"]);
    assert.deepEqual(Object.keys(schema.properties ?? {}), [
      "expense_id",
      "bills",
      "include_line_description",
      "draft",
    ]);

    const bills = schema.properties!.bills;
    assert.equal(bills.type, "array");
    assert.deepEqual(bills.items?.required, ["bill_id"]);
    assert.deepEqual(Object.keys(bills.items?.properties ?? {}), ["bill_id", "amount"]);

    assert.equal(schema.properties!.include_line_description.type, "boolean");
    assert.equal(schema.properties!.draft.type, "boolean");
  });

  it("schema-convert-validated — refuses missing and unknown arguments before reaching QuickBooks", async () => {
    const missing = await executeTool(TOOL, { expense_id: "750" });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Invalid arguments/);
    assert.match(missing.content[0].text, /bills/);

    const unknown = await executeTool(TOOL, {
      expense_id: "750",
      bills: [{ bill_id: "110" }],
      memo: "x",
    });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /Invalid arguments/);
    assert.ok(unknown.content[0].text.includes('Unknown parameter "memo"'));
  });
});
