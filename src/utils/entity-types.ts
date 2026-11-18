// Shared QBO entity-type table: the one spelling of snake_case key -> QBO type
// and label, used by the attachment tools and the transaction PDF tool.

export interface EntityTypeConfig {
  qboType: string; // EntityRef.type as QBO names it
  label: string;
  // True when QBO renders a PDF for this type (GET /{lowercase type}/{id}/pdf).
  // Verified against the sandbox on 2026-11-18: exactly PurchaseOrder, Invoice,
  // Estimate, SalesReceipt, CreditMemo and RefundReceipt return a PDF. Bill,
  // Purchase and Deposit return HTTP 400 with an empty body.
  pdf?: true;
}

export const LINK_TYPES: Record<string, EntityTypeConfig> = {
  bill: { qboType: "Bill", label: "Bill" },
  invoice: { qboType: "Invoice", label: "Invoice", pdf: true },
  expense: { qboType: "Purchase", label: "Expense" },
  journal_entry: { qboType: "JournalEntry", label: "Journal Entry" },
  deposit: { qboType: "Deposit", label: "Deposit" },
  vendor_credit: { qboType: "VendorCredit", label: "Vendor Credit" },
  sales_receipt: { qboType: "SalesReceipt", label: "Sales Receipt", pdf: true },
  bill_payment: { qboType: "BillPayment", label: "Bill Payment" },
  estimate: { qboType: "Estimate", label: "Estimate", pdf: true },
  credit_memo: { qboType: "CreditMemo", label: "Credit Memo", pdf: true },
  payment: { qboType: "Payment", label: "Payment" },
  refund_receipt: { qboType: "RefundReceipt", label: "Refund Receipt", pdf: true },
  purchase_order: { qboType: "PurchaseOrder", label: "Purchase Order", pdf: true },
  transfer: { qboType: "Transfer", label: "Transfer" },
  vendor: { qboType: "Vendor", label: "Vendor" },
  customer: { qboType: "Customer", label: "Customer" },
  employee: { qboType: "Employee", label: "Employee" },
  item: { qboType: "Item", label: "Item" },
};

export const BY_QBO_TYPE = new Map(
  Object.values(LINK_TYPES).map((c) => [c.qboType.toLowerCase(), c])
);

export interface PdfType {
  key: string;
  qboType: string;
  label: string;
  pathSegment: string; // QBO's PDF path is lowercase; mixed case returns 400
}

const PDF_KEYS = Object.keys(LINK_TYPES).filter((k) => LINK_TYPES[k].pdf);

// Accepts the snake_case key ("purchase_order") or the QBO type in any case ("PurchaseOrder")
export function resolvePdfType(input: string): PdfType {
  const lower = input.toLowerCase();
  const key = PDF_KEYS.find(
    (k) => k === lower || LINK_TYPES[k].qboType.toLowerCase() === lower
  );
  if (!key) {
    throw new Error(
      `Unsupported entity_type "${input}" for PDF. Must be one of: ${PDF_KEYS.join(", ")}`
    );
  }
  const { qboType, label } = LINK_TYPES[key];
  return { key, qboType, label, pathSegment: qboType.toLowerCase() };
}
