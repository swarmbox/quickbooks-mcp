// edit_purchase_order: a sparse, minimal update; the draft preview; the refusals
// that run before any write; and the post-write comparison, which covers only
// the fields the edit sent.
//
// The fake client records every write and every query. Its default update
// response mirrors QuickBooks as probed against a sandbox: the stored purchase
// order with the body laid over it, the SyncToken advanced, any key whose sent
// value is { value: "" } or {} removed, and TotalAmt recomputed when Line was
// sent. A case that needs a different response overrides only the keys it names.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { clearLookupCache } from "../../src/client/index.js";
import { handleEditPurchaseOrder } from "../../src/tools/handlers/purchase-order.js";
import { toolDefinitions } from "../../src/tools/definitions.js";
import { isReadOnlyTool } from "../../src/tools/access.js";
import { validateToolArguments, ToolArgumentError, type ToolSchema } from "../../src/tools/validate.js";

type Callback<T> = (err: unknown, result: T) => void;
type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Body = Record<string, any>;
interface Criterion {
  field: string;
  value: string | boolean;
  operator: string;
}

// Invented fixtures only — this repository is public (CLAUDE.md).
const VENDORS = [
  { Id: "20", DisplayName: "North Freight" },
  { Id: "21", DisplayName: "North Freight Lines" },
  { Id: "22", DisplayName: "South Haulage" },
];
const ACCOUNTS = [{ Id: "12", Name: "Supplies", FullyQualifiedName: "Supplies", AcctNum: "6000" }];
const CLASSES = [{ Id: "50", Name: "North", FullyQualifiedName: "North" }];
const ITEMS = [
  { Id: "30", Name: "Shipping", FullyQualifiedName: "Freight:Shipping", Active: true },
  { Id: "31", Name: "Shipping", FullyQualifiedName: "Supplies:Shipping", Active: true },
  { Id: "32", Name: "Fuel Surcharge", FullyQualifiedName: "Freight:Fuel Surcharge", Active: true },
  { Id: "33", Name: "Pallets (deleted)", FullyQualifiedName: "Pallets (deleted)", Active: false },
];
const PO_LIST = [
  { Id: "500", DocNumber: "PO1000", VendorRef: { value: "20", name: "North Freight" }, TxnDate: "2026-11-01" },
  { Id: "600", DocNumber: "PO1001", VendorRef: { value: "20", name: "North Freight" }, TxnDate: "2026-11-02" },
];
const PO_600: Body = {
  Id: "600",
  SyncToken: "2",
  TxnDate: "2026-11-02",
  DocNumber: "PO1001",
  POStatus: "Open",
  VendorRef: { value: "20", name: "North Freight" },
  ShipMethodRef: { value: "Truck", name: "Truck" },
  ShipAddr: { Id: "90", Line1: "Stop A", Line2: "100 Main St", City: "Northtown", CountrySubDivisionCode: "CA", PostalCode: "11111" },
  PrivateNote: "Load 1",
  Memo: "Call before delivery",
  TotalAmt: 150,
  APAccountRef: { value: "80", name: "Accounts Payable" },
  LinkedTxn: [{ TxnId: "700", TxnType: "Bill" }],
  Line: [
    {
      Id: "1",
      LineNum: 1,
      Amount: 100,
      Description: "Pickup: Dock 4\nDeliver: Stop A",
      DetailType: "ItemBasedExpenseLineDetail",
      ItemBasedExpenseLineDetail: { ItemRef: { value: "33", name: "Pallets (deleted)" }, Qty: 1, UnitPrice: 100 },
    },
    {
      Id: "2",
      LineNum: 2,
      Amount: 50,
      DetailType: "AccountBasedExpenseLineDetail",
      AccountBasedExpenseLineDetail: { AccountRef: { value: "12", name: "Supplies" } },
    },
  ],
};

const isCleared = (value: unknown): boolean =>
  typeof value === "object" && value !== null && (Object.keys(value).length === 0 || (value as Body).value === "");

// What updatePurchaseOrder answers by default: the stored purchase order with
// the body laid over it.
function defaultUpdateResponse(body: Body): Body {
  const { sparse: _sparse, ...sent } = structuredClone(body);
  const response: Body = { ...structuredClone(PO_600), ...sent, SyncToken: String(Number(PO_600.SyncToken) + 1) };
  for (const [key, value] of Object.entries(sent)) {
    if (isCleared(value)) delete response[key];
  }
  if (sent.Line) {
    const lines = (sent.Line as Body[]).map((line, i): Body => ({ ...line, Id: line.Id ?? String(i + 10), LineNum: i + 1 }));
    response.Line = lines;
    response.TotalAmt = lines.reduce((sum: number, line: Body) => sum + Math.round(line.Amount * 100), 0) / 100;
  }
  return response;
}

interface FakeOptions {
  override?: (response: Body) => Body;
}

function fakeClient(options: FakeOptions = {}) {
  const created: Body[] = [];
  const updated: Body[] = [];
  const deleted: unknown[] = [];
  const poQueries: Criterion[][] = [];
  const itemQueries: Criterion[][] = [];
  const list = <T>(key: string, rows: T[]) => ({ QueryResponse: { [key]: rows } });

  const client = {
    findAccounts: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Account", ACCOUNTS)),
    findClasses: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Class", CLASSES)),
    findVendors: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Vendor", VENDORS)),
    findDepartments: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Department", [])),
    findEmployees: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Employee", [])),
    findItems: (criteria: Criterion[], cb: Callback<unknown>) => {
      itemQueries.push(criteria);
      const active = criteria.find((c) => c.field === "Active");
      let rows = ITEMS.filter((i) => i.Active === (active ? active.value : true));
      for (const c of criteria) {
        const v = String(c.value).toLowerCase();
        if (c.field === "Name" && c.operator === "=") rows = rows.filter((i) => i.Name.toLowerCase() === v);
        if (c.field === "Name" && c.operator === "LIKE") {
          rows = rows.filter((i) => i.Name.toLowerCase().includes(v.replace(/%/g, "")));
        }
        if (c.field === "Id" && c.operator === "=") rows = rows.filter((i) => i.Id === c.value);
      }
      cb(null, list("Item", rows.map((i) => ({ ...i }))));
    },
    findPurchaseOrders: (criteria: Criterion[], cb: Callback<unknown>) => {
      poQueries.push(criteria);
      let rows = PO_LIST;
      for (const c of criteria) {
        if (c.field === "DocNumber" && c.operator === "=") rows = rows.filter((p) => p.DocNumber === c.value);
      }
      cb(null, list("PurchaseOrder", rows.map((p) => structuredClone(p))));
    },
    getPurchaseOrder: (_id: string, cb: Callback<unknown>) => cb(null, structuredClone(PO_600)),
    createPurchaseOrder: (body: Body, cb: Callback<unknown>) => {
      created.push(structuredClone(body));
      cb(null, body);
    },
    updatePurchaseOrder: (body: Body, cb: Callback<unknown>) => {
      updated.push(structuredClone(body));
      const response = defaultUpdateResponse(body);
      cb(null, options.override ? options.override(response) : response);
    },
    deletePurchaseOrder: (body: unknown, cb: Callback<unknown>) => {
      deleted.push(body);
      cb(null, body);
    },
  } as unknown as QuickBooks;

  const wrote = () => created.length + updated.length + deleted.length > 0;
  return { client, updated, poQueries, itemQueries, wrote };
}

const edit = (client: QuickBooks, args: Record<string, unknown>) =>
  handleEditPurchaseOrder(client, args as unknown as Parameters<typeof handleEditPurchaseOrder>[1]) as Promise<Result>;

const textOf = (result: Result): string => result.content.map((c) => c.text).join("\n");
const rowsOf = (result: Result): string[] => textOf(result).split("\n");

async function rejection(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return assert.fail("expected the call to be rejected");
}

beforeEach(() => clearLookupCache());

describe("edit_purchase_order payload", () => {
  it("po-edit-sparse-only-changed — the payload is Id, SyncToken, sparse and exactly the changed field", async () => {
    const fake = fakeClient();
    const result = await edit(fake.client, { id: "600", status: "Closed", draft: false });

    assert.deepEqual(fake.updated, [{ Id: "600", SyncToken: "2", sparse: true, POStatus: "Closed" }]);
    assert.equal(result.isError, undefined);
    const text = textOf(result);
    assert.ok(text.startsWith("Purchase Order 600 updated successfully."), text);
    assert.ok(text.includes("New SyncToken: 3"), text);
    assert.ok(!text.includes("View in QuickBooks"), text);
  });

  it("every header field is sent as itself, and only the ones named", async () => {
    const fake = fakeClient();
    await edit(fake.client, {
      id: "600",
      vendor_id: "22",
      txn_date: "2026-11-05",
      doc_number: "PO2000",
      status: "Closed",
      ship_method: "Rail",
      memo: "Load 2",
      vendor_message: "Leave at dock",
      draft: false,
    });

    assert.deepEqual(fake.updated, [
      {
        Id: "600",
        SyncToken: "2",
        sparse: true,
        VendorRef: { value: "22", name: "South Haulage" },
        TxnDate: "2026-11-05",
        DocNumber: "PO2000",
        POStatus: "Closed",
        ShipMethodRef: { value: "Rail", name: "Rail" },
        PrivateNote: "Load 2",
        Memo: "Leave at dock",
      },
    ]);
  });

  it("po-edit-ship-to-replace — ship_to replaces the whole address and says so in the preview", async () => {
    const draftFake = fakeClient();
    const draft = await edit(draftFake.client, { id: "600", ship_to: ["Stop C"] });
    const rows = rowsOf(draft);

    for (const expected of ["  Stop A", "  100 Main St", "  Stop C"]) {
      assert.ok(rows.includes(expected), `missing row "${expected}" in:\n${textOf(draft)}`);
    }
    assert.match(textOf(draft), /replaces the whole address/);
    assert.equal(draftFake.wrote(), false);

    clearLookupCache();
    const fake = fakeClient();
    const result = await edit(fake.client, { id: "600", ship_to: ["Stop C"], draft: false });

    assert.deepEqual(fake.updated[0].ShipAddr, { Line1: "Stop C" });
    assert.equal(result.isError, undefined, textOf(result));
  });

  it("po-edit-ship-to-seven-rows — seven rows are sent as Line1-Line4 plus rows 5-7 joined in Line5, and a space-joined booking is no difference", async () => {
    const SEVEN_ROWS = ["R1", "R2", "R3", "R4", "R5", "R6", "R7"];

    const draftFake = fakeClient();
    const draft = await edit(draftFake.client, { id: "600", ship_to: SEVEN_ROWS });
    const rows = rowsOf(draft);
    const at = rows.indexOf("Ship to (after):");
    assert.notEqual(at, -1, textOf(draft));
    assert.deepEqual(rows.slice(at, at + 8), ["Ship to (after):", "  R1", "  R2", "  R3", "  R4", "  R5", "  R6", "  R7"]);
    assert.equal(draftFake.wrote(), false);

    clearLookupCache();
    const fake = fakeClient({
      override: (response) => ({
        ...response,
        ShipAddr: { Id: "90", Line1: "R1", Line2: "R2", Line3: "R3", Line4: "R4", Line5: "R5 R6 R7" },
      }),
    });
    const result = await edit(fake.client, { id: "600", ship_to: SEVEN_ROWS, draft: false });

    assert.deepEqual(fake.updated[0].ShipAddr, {
      Line1: "R1",
      Line2: "R2",
      Line3: "R3",
      Line4: "R4",
      Line5: "R5\nR6\nR7",
    });
    assert.equal(result.isError, undefined, textOf(result));
    assert.ok(!textOf(result).includes("NOT AS PREVIEWED"), textOf(result));
  });

  it("po-edit-clears — an empty ship_to and an empty ship_method clear, and the booked absence is not a mismatch", async () => {
    for (const ship_to of ["", []]) {
      clearLookupCache();
      const fake = fakeClient();
      const result = await edit(fake.client, { id: "600", ship_to, ship_method: "", draft: false });

      assert.deepEqual(fake.updated[0].ShipAddr, {}, JSON.stringify(ship_to));
      assert.deepEqual(fake.updated[0].ShipMethodRef, { value: "" }, JSON.stringify(ship_to));
      assert.equal(result.isError, undefined, `${JSON.stringify(ship_to)}: ${textOf(result)}`);
    }
  });

  it("po-edit-untouched-address — an edit that does not send ship_to leaves ShipAddr off the payload and raises no alarm", async () => {
    const fake = fakeClient();
    const result = await edit(fake.client, { id: "600", memo: "Load 2", draft: false });

    assert.equal("ShipAddr" in fake.updated[0], false);
    assert.equal(result.isError, undefined, textOf(result));
  });

  it("surrounding spaces on doc_number and ship_method are trimmed before they are sent", async () => {
    const fake = fakeClient();
    const result = await edit(fake.client, { id: "600", doc_number: "  PO2000 ", ship_method: " Rail  ", draft: false });

    assert.equal(fake.updated[0].DocNumber, "PO2000");
    assert.deepEqual(fake.updated[0].ShipMethodRef, { value: "Rail", name: "Rail" });
    assert.equal(result.isError, undefined, textOf(result));
  });
});

describe("edit_purchase_order draft preview", () => {
  it("po-edit-draft-preview — each changed field is a before → after row, and nothing is written", async () => {
    const fake = fakeClient();
    const result = await edit(fake.client, { id: "600", status: "Closed", memo: "Load 2" });
    const text = textOf(result);

    assert.ok(text.startsWith("DRAFT - Purchase Order Edit Preview"), text);
    assert.ok(text.includes("Open → Closed"), text);
    assert.ok(text.includes("Load 1 → Load 2"), text);
    assert.ok(text.includes("ID: 600"), text);
    assert.ok(text.includes("SyncToken: 2"), text);
    assert.ok(!text.includes("Vendor message"), "an unchanged field is not previewed");
    assert.equal(fake.wrote(), false);
  });

  it("a cleared ship_method previews as → (none)", async () => {
    const fake = fakeClient();
    const text = textOf(await edit(fake.client, { id: "600", ship_method: "" }));

    assert.ok(text.includes("Truck → (none)"), text);
  });
});

describe("edit_purchase_order doc_number", () => {
  it("po-edit-doc-number-self — the purchase order's own Ref no. does not block it; another's does", async () => {
    const fake = fakeClient();
    await edit(fake.client, { id: "600", doc_number: "PO1001", draft: false });
    assert.equal(fake.updated[0].DocNumber, "PO1001");

    clearLookupCache();
    const other = fakeClient();
    const message = await rejection(() => edit(other.client, { id: "600", doc_number: "PO1000", draft: false }));
    assert.ok(message.includes("PO1000"), message);
    assert.ok(message.includes("500"), message);
    assert.equal(other.wrote(), false);
  });

  it("an empty doc_number on edit is refused, with no write", async () => {
    for (const doc_number of ["", "   "]) {
      const fake = fakeClient();
      const message = await rejection(() => edit(fake.client, { id: "600", doc_number, draft: false }));

      assert.match(message, /doc_number/, JSON.stringify(doc_number));
      assert.equal(fake.wrote(), false, JSON.stringify(doc_number));
    }
  });

  it("21 characters are sent and 22 are refused before the duplicate lookup", async () => {
    const fake = fakeClient();
    await edit(fake.client, { id: "600", doc_number: "N".repeat(21), draft: false });
    assert.equal(fake.updated.length, 1);

    clearLookupCache();
    const over = fakeClient();
    const message = await rejection(() => edit(over.client, { id: "600", doc_number: "N".repeat(22), draft: false }));
    assert.match(message, /21-character/);
    assert.equal(over.poQueries.length, 0);
    assert.equal(over.wrote(), false);
  });
});

describe("edit_purchase_order refusals before any write", () => {
  it("po-edit-exact-vendor — a partial vendor name is refused, with no write", async () => {
    const fake = fakeClient();
    const message = await rejection(() => edit(fake.client, { id: "600", vendor_name: "North" }));

    assert.match(message, /no vendor matches .*exactly/i);
    assert.equal(fake.wrote(), false);
  });

  it("a ship_to over 2000 joined characters is refused, naming the field, with no write", async () => {
    const fake = fakeClient();
    const message = await rejection(() =>
      edit(fake.client, { id: "600", ship_to: ["a".repeat(1000), "b".repeat(1000)], draft: false })
    );

    assert.match(message, /ship_to is 2001 characters/);
    assert.match(message, /2000/);
    assert.equal(fake.wrote(), false);
  });

  it("an edit that deletes every line is refused, with no write", async () => {
    const fake = fakeClient();
    const message = await rejection(() =>
      edit(fake.client, { id: "600", lines: [{ line_id: "1", delete: true }, { line_id: "2", delete: true }], draft: false })
    );

    assert.match(message, /At least one line is required/);
    assert.equal(fake.wrote(), false);
  });

  it("a status that is neither Open nor Closed is refused", async () => {
    const fake = fakeClient();
    const message = await rejection(() => edit(fake.client, { id: "600", status: "Pending", draft: false }));

    assert.match(message, /status must be one of Open, Closed/);
    assert.equal(fake.wrote(), false);
  });

  it("an appended line with a 4001-character description is refused, with no write", async () => {
    const withDescription = (description: string) => ({
      id: "600",
      lines: [{ account_name: "Supplies", amount: 10, description }],
      draft: false,
    });

    const fake = fakeClient();
    await edit(fake.client, withDescription("d".repeat(4000)));
    assert.equal(fake.updated.length, 1);

    clearLookupCache();
    const over = fakeClient();
    const message = await rejection(() => edit(over.client, withDescription("d".repeat(4001))));
    assert.match(message, /4000/);
    assert.equal(over.wrote(), false);
  });

  it("a changed line's 4001-character description is refused too", async () => {
    const fake = fakeClient();
    const message = await rejection(() =>
      edit(fake.client, { id: "600", lines: [{ line_id: "2", description: "d".repeat(4001) }], draft: false })
    );

    assert.match(message, /Line 2/);
    assert.match(message, /4000/);
    assert.equal(fake.wrote(), false);
  });

  it("an empty lines array is refused rather than read as no change", async () => {
    const fake = fakeClient();
    const message = await rejection(() => edit(fake.client, { id: "600", lines: [], draft: false }));

    assert.match(message, /lines/);
    assert.equal(fake.wrote(), false);
  });
});

describe("edit_purchase_order lines", () => {
  it("po-edit-inactive-item-passthrough — an untouched line whose item went inactive is sent back as stored", async () => {
    const fake = fakeClient();
    const result = await edit(fake.client, { id: "600", lines: [{ line_id: "2", amount: 60 }], draft: false });

    const { LineNum: _lineNum, ...stored } = PO_600.Line[0];
    assert.deepEqual(fake.updated[0].Line[0], stored);
    assert.equal(fake.updated[0].Line[1].Amount, 60);
    assert.equal(fake.itemQueries.length, 0, "no item is re-resolved");
    assert.equal(result.isError, undefined, textOf(result));
  });

  it("po-edit-lines — a delete and an append send the full Line array, and the draft lists both lines with their descriptions", async () => {
    const lines = [{ line_id: "1", delete: true }, { item_name: "Freight:Fuel Surcharge", amount: 25, description: "Surcharge" }];

    const draftFake = fakeClient();
    const draft = await edit(draftFake.client, { id: "600", lines });
    const draftText = textOf(draft);
    assert.ok(draftText.includes("Updated Lines:"), draftText);
    assert.ok(draftText.includes("Supplies"), draftText);
    assert.ok(draftText.includes("Freight:Fuel Surcharge"), draftText);
    assert.ok(rowsOf(draft).includes("    Surcharge"), `the description is an indented row:\n${draftText}`);
    assert.equal(draftFake.wrote(), false);

    clearLookupCache();
    const fake = fakeClient();
    const result = await edit(fake.client, { id: "600", lines, draft: false });
    const sent = fake.updated[0].Line as Body[];

    assert.equal(sent.length, 2);
    const { LineNum: _lineNum, ...stored } = PO_600.Line[1];
    assert.deepEqual(sent[0], stored);
    assert.equal(sent[1].ItemBasedExpenseLineDetail.ItemRef.value, "32");
    assert.equal(sent[1].Amount, 25);
    assert.equal("Id" in sent[1], false);
    assert.equal(result.isError, undefined, textOf(result));
  });

  it("a mismatch in a sent line is caught, and the total is the sum of the sent lines", async () => {
    const fake = fakeClient({
      override: (response) => ({ ...response, TotalAmt: 999, Line: response.Line.map((l: Body) => ({ ...l, Amount: 1 })) }),
    });
    const result = await edit(fake.client, { id: "600", lines: [{ line_id: "2", amount: 60 }], draft: false });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /Total: sent 160\.00, booked 999\.00/);
    assert.match(textOf(result), /Line 2 amount: sent 60\.00, booked 1\.00/);
  });
});

describe("edit_purchase_order booked comparison", () => {
  it("po-edit-not-as-previewed — a booking that differs is returned as an error naming the difference", async () => {
    const fake = fakeClient({ override: (response) => ({ ...response, POStatus: "Open" }) });
    const result = await edit(fake.client, { id: "600", status: "Closed", draft: false });
    const text = textOf(result);

    assert.equal(result.isError, true);
    assert.equal(rowsOf(result)[0], "Purchase Order Updated — NOT AS PREVIEWED");
    assert.match(text, /Status: sent Closed, booked Open/);
    assert.ok(text.includes("600"), text);
    assert.ok(!text.includes("View in QuickBooks"), text);
  });

  it("a field the edit did not send is never compared", async () => {
    const fake = fakeClient({
      override: (response) => ({ ...response, DocNumber: "PO7777", PrivateNote: "Changed elsewhere", TotalAmt: 1 }),
    });
    const result = await edit(fake.client, { id: "600", status: "Closed", draft: false });

    assert.equal(result.isError, undefined, textOf(result));
  });

  it("a ship_to the booking re-folded is caught on the lines it sent", async () => {
    const fake = fakeClient({
      override: (response) => ({ ...response, ShipAddr: { Id: "90", Line1: "Stop C Dock 4" } }),
    });
    const result = await edit(fake.client, { id: "600", ship_to: ["Stop C", "Dock 4"], draft: false });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /Ship to line 1: sent Stop C, booked Stop C Dock 4/);
  });
});

describe("edit_purchase_order schema", () => {
  const definition = () => {
    const found = toolDefinitions.find((t) => t.name === "edit_purchase_order");
    assert.ok(found, "edit_purchase_order is defined");
    return found;
  };

  it("po-tools-read-only — only get_purchase_order is read-only, and the edit annotations are the edit-with-lines set", () => {
    const flags = Object.fromEntries(
      ["create_purchase_order", "get_purchase_order", "edit_purchase_order"].map((name) => {
        const tool = toolDefinitions.find((t) => t.name === name);
        assert.ok(tool, `${name} is defined`);
        return [name, isReadOnlyTool(tool)];
      })
    );

    assert.deepEqual(flags, { create_purchase_order: false, get_purchase_order: true, edit_purchase_order: false });
    assert.deepEqual(definition().annotations, {
      title: "Edit QuickBooks purchase order",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it("the description says ship_to replaces the whole address, what clears, exact names, no due date and the draft default", () => {
    const text = JSON.stringify(definition());

    assert.match(text, /replaces the whole address/);
    assert.doesNotMatch(text, /5 lines/);
    assert.match(text, /empty string clears|"" clears|pass \\"\\" to clear/i);
    assert.match(text, /exactly/i);
    assert.match(text, /no due date/i);
    assert.match(text, /draft/i);
  });

  it("offers no due date, terms, department or AP account, and refuses an edit with nothing to change", () => {
    const schema = definition().inputSchema as unknown as ToolSchema;
    const properties = Object.keys(schema.properties ?? {});
    for (const absent of ["due_date", "sales_term_ref", "department_name", "ap_account"]) {
      assert.ok(!properties.includes(absent), `${absent} must not be declared`);
    }

    assert.throws(
      () => validateToolArguments("edit_purchase_order", schema, { id: "600", due_date: "2026-11-05" }),
      (error: unknown) => error instanceof ToolArgumentError && /due_date/.test(error.message)
    );
    assert.throws(() => validateToolArguments("edit_purchase_order", schema, { id: "600" }), ToolArgumentError);
    assert.doesNotThrow(() => validateToolArguments("edit_purchase_order", schema, { id: "600", status: "Closed" }));
    assert.deepEqual(schema.required, ["id"]);
  });
});
