import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { clearLookupCache } from "../../src/client/cache.js";
import { toolDefinitions } from "../../src/tools/definitions.js";
import { LINKED_TXN_TYPES } from "../../src/tools/handlers/bill-payment-links.js";
import { validateToolArguments, ToolArgumentError, type ToolSchema } from "../../src/tools/validate.js";

beforeEach(() => clearLookupCache());

const definition = toolDefinitions.find((t) => t.name === "create_bill_payment");

function schema(): ToolSchema {
  assert.ok(definition, "no tool definition named create_bill_payment");
  return definition.inputSchema as unknown as ToolSchema;
}

function check(args: Record<string, unknown>): void {
  validateToolArguments("create_bill_payment", schema(), args);
}

const JE_LINK = { txn_type: "JournalEntry", txn_id: "300", amount: 100 };

describe("create_bill_payment schema", () => {
  it("schema-accepts-linked-txns — a linked_txns call with no bills or payment_account validates", () => {
    assert.doesNotThrow(() =>
      check({ vendor_name: "North Produce", txn_date: "2026-07-15", linked_txns: [JE_LINK] })
    );
  });

  it("schema-required-and-enum — only txn_date is required and linked_txns items are typed from LINKED_TXN_TYPES", () => {
    const s = schema() as unknown as {
      required: string[];
      properties: Record<string, { items?: { properties: Record<string, { enum?: string[] }>; required: string[] } }>;
    };
    assert.deepEqual(s.required, ["txn_date"]);
    for (const key of ["bills", "credits", "linked_txns"]) {
      assert.ok(s.properties[key], `${key} must be declared`);
    }
    const item = s.properties.linked_txns.items;
    assert.ok(item, "linked_txns must declare items");
    assert.deepEqual(Object.keys(item.properties).sort(), ["amount", "txn_id", "txn_type"]);
    assert.deepEqual(item.required, ["txn_type", "txn_id"]);
    assert.deepEqual(item.properties.txn_type.enum, [...LINKED_TXN_TYPES]);
  });

  it("schema-rejects-declared-side — a linked_txns item cannot carry a caller-declared side", () => {
    assert.throws(
      () =>
        check({
          vendor_name: "North Produce",
          txn_date: "2026-07-15",
          linked_txns: [{ ...JE_LINK, side: "credit" }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof ToolArgumentError);
        assert.match(error.message, /Unknown parameter "side"/);
        return true;
      }
    );
  });

  it("schema-required-and-enum — declares every top-level parameter", () => {
    const s = schema() as unknown as { properties: Record<string, unknown> };
    assert.deepEqual(Object.keys(s.properties).sort(), [
      "bills",
      "credits",
      "doc_number",
      "draft",
      "linked_txns",
      "memo",
      "payment_account",
      "txn_date",
      "vendor_id",
      "vendor_name",
    ]);
  });
});

describe("bill payment docs", () => {
  const read = (path: string): string => readFileSync(path, "utf8");

  it("schema-required-and-enum — README rows name linked_txns and side signing", () => {
    const readme = read("README.md");
    const row = (tool: string): string => readme.split("\n").find((l) => l.startsWith(`| \`${tool}\` |`)) ?? "";
    assert.match(row("create_bill_payment"), /linked_txns/);
    assert.match(row("get_bill_payment"), /side/i);
  });

  it("schema-required-and-enum — limitations doc has a Bill Payment section stating what is unverified", () => {
    const doc = read("docs/quickbooks-api-limitations.md");
    assert.match(doc, /^## .*Bill Payment/m);
    assert.doesNotMatch(doc, /the bills being paid/);
    const section = doc.split(/^## /m).find((s) => /^.*Bill Payment/.test(s.split("\n")[0])) ?? "";
    assert.match(section, /unverified|not (yet )?verified/i);
    for (const topic of ["JournalEntry", "Deposit", "Purchase", "BankAccountRef"]) {
      assert.ok(section.includes(topic), `section should mention ${topic}`);
    }
  });

  it("schema-required-and-enum — entity-coverage BillPayment row notes the $0 shape", () => {
    const row = read("docs/entity-coverage.md")
      .split("\n")
      .find((l) => l.startsWith("| BillPayment |"));
    assert.ok(row, "BillPayment row missing");
    assert.ok(row.includes("$0"));
  });
});
