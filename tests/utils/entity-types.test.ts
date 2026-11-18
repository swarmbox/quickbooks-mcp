// Shared entity-type table: PDF-capable types and the attachment link types.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LINK_TYPES, resolvePdfType } from "../../src/utils/entity-types.js";
import { ATTACHMENT_LINK_TYPES, resolveLinkType } from "../../src/tools/handlers/attachment.js";

const SIX = ["purchase_order", "invoice", "estimate", "sales_receipt", "credit_memo", "refund_receipt"];

// Literal snapshot of the pre-change attachment table.
const SNAPSHOT: Array<[string, string, string]> = [
  ["bill", "Bill", "Bill"],
  ["invoice", "Invoice", "Invoice"],
  ["expense", "Purchase", "Expense"],
  ["journal_entry", "JournalEntry", "Journal Entry"],
  ["deposit", "Deposit", "Deposit"],
  ["vendor_credit", "VendorCredit", "Vendor Credit"],
  ["sales_receipt", "SalesReceipt", "Sales Receipt"],
  ["bill_payment", "BillPayment", "Bill Payment"],
  ["estimate", "Estimate", "Estimate"],
  ["credit_memo", "CreditMemo", "Credit Memo"],
  ["payment", "Payment", "Payment"],
  ["refund_receipt", "RefundReceipt", "Refund Receipt"],
  ["purchase_order", "PurchaseOrder", "Purchase Order"],
  ["transfer", "Transfer", "Transfer"],
  ["vendor", "Vendor", "Vendor"],
  ["customer", "Customer", "Customer"],
  ["employee", "Employee", "Employee"],
  ["item", "Item", "Item"],
];

describe("entity-types", () => {
  it("pdf-types-exact-six: exactly the six PDF-capable types are flagged", () => {
    const flagged = Object.entries(LINK_TYPES)
      .filter(([, c]) => (c as { pdf?: boolean }).pdf === true)
      .map(([k]) => k);
    assert.deepEqual([...flagged].sort(), [...SIX].sort());
  });

  it("pdf-type-resolves-both-spellings: snake_case and QBO type resolve alike", () => {
    for (const input of ["purchase_order", "PurchaseOrder", "PURCHASEORDER"]) {
      assert.deepEqual(resolvePdfType(input), {
        key: "purchase_order",
        qboType: "PurchaseOrder",
        label: "Purchase Order",
        pathSegment: "purchaseorder",
      });
    }
  });

  it("pdf-type-refuses-unsupported: bill, expense and nonsense throw naming input and the six", () => {
    for (const input of ["bill", "expense", "nonsense"]) {
      assert.throws(
        () => resolvePdfType(input),
        (err: Error) => {
          assert.ok(err.message.includes(`"${input}"`), err.message);
          for (const key of SIX) assert.ok(err.message.includes(key), err.message);
          return true;
        }
      );
    }
  });

  it("attachment-link-types-unchanged: attachment link types match the pre-change snapshot", () => {
    assert.deepEqual(ATTACHMENT_LINK_TYPES, SNAPSHOT.map(([k]) => k));
    for (const [key, qboType, label] of SNAPSHOT) {
      assert.deepEqual(resolveLinkType(key), { qboType, label });
      assert.deepEqual(resolveLinkType(qboType), { qboType, label });
    }
    assert.equal(resolveLinkType("Purchase").label, "Expense");
    assert.throws(() => resolveLinkType("nonsense"), /Invalid entity_type "nonsense"/);
  });
});
