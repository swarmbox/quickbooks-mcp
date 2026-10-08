// Shared helpers lifted for convert_expense_to_bill_payment. Invented fixtures
// only; nothing here calls QuickBooks.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { billPaymentLines } from "../../src/tools/handlers/bill-payment.js";
import { resolveLinks, type ResolvedLink } from "../../src/tools/handlers/bill-payment-links.js";
import { moveLinkBody, type Attachable } from "../../src/tools/handlers/attachment.js";
import { buildDeleteBody } from "../../src/tools/handlers/delete.js";
import { NORTH, fakeClient } from "./bill-payment-fixtures.js";

describe("convert-expense shared helpers", () => {
  it("shared-bill-payment-lines — one line per link, amounts in dollars, in order", () => {
    const links: ResolvedLink[] = [
      { type: "Bill", id: "110", side: "charge", openCents: 25000, applyCents: 25000 },
      { type: "VendorCredit", id: "401", side: "credit", openCents: 5000, applyCents: 5000 },
    ];

    assert.deepEqual(billPaymentLines(links), [
      { Amount: 250, LinkedTxn: [{ TxnId: "110", TxnType: "Bill" }] },
      { Amount: 50, LinkedTxn: [{ TxnId: "401", TxnType: "VendorCredit" }] },
    ]);
  });

  it("shared-resolved-link-ap-account — apAccountId only when the bill carries APAccountRef", async () => {
    const { client } = fakeClient({
      records: {
        Bill: {
          "110": {
            Id: "110", DocNumber: "B-10", TxnDate: "2026-07-01", TotalAmt: 250, Balance: 250,
            VendorRef: NORTH, APAccountRef: { value: "20", name: "2000 Accounts Payable" },
          },
        },
      },
    });

    const links = await resolveLinks(client, NORTH, [
      { type: "Bill", id: "110" },
      { type: "Bill", id: "101" },
    ]);

    assert.equal(links[0].apAccountId, "20");
    assert.equal("apAccountId" in links[1], false);
  });

  describe("moveLinkBody", () => {
    const attachment = (): Attachable & Record<string, unknown> => ({
      Id: "9001",
      SyncToken: "0",
      FileName: "invoice.pdf",
      ContentType: "application/pdf",
      Size: 2048,
      TempDownloadUri: "https://files.example.test/tmp/9001?sig=abc",
      AttachableRef: [
        { EntityRef: { type: "purchase", value: "750" }, LineInfo: "1", IncludeOnSend: true },
        { EntityRef: { type: "Vendor", value: "5" } },
      ],
    });

    it("shared-move-link-body — replaces the ref in place, drops LineInfo, keeps writable fields only", () => {
      const body = moveLinkBody(
        attachment(),
        { type: "Purchase", value: "750" },
        { type: "BillPayment", value: "950" },
      );
      const sent = JSON.parse(JSON.stringify(body));

      assert.equal(sent.Id, "9001");
      assert.equal(sent.SyncToken, "0");
      assert.equal(sent.FileName, "invoice.pdf");
      assert.equal(sent.ContentType, "application/pdf");
      assert.deepEqual(sent.AttachableRef, [
        { EntityRef: { type: "BillPayment", value: "950" } },
        { EntityRef: { type: "Vendor", value: "5" } },
      ]);
      assert.equal("Size" in sent, false);
      assert.equal("TempDownloadUri" in sent, false);
    });

    it("shared-move-link-body-missing-ref — throws when the attachment is not linked to the old entity", () => {
      assert.throws(
        () => moveLinkBody(attachment(), { type: "Purchase", value: "999" }, { type: "BillPayment", value: "950" }),
        { message: "Attachment 9001 is not linked to Purchase 999" },
      );
    });
  });

  it("shared-delete-body-exported — buildDeleteBody keeps only Id and SyncToken", () => {
    const expense = { Id: "750", SyncToken: "2", PurchaseEx: { any: [] }, TotalAmt: 250 };

    assert.deepEqual(buildDeleteBody(expense, "750", "Expense"), { Id: "750", SyncToken: "2" });
  });
});
