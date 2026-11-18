// create_purchase_order: draft preview, payload, the refusals that run before any
// write, and the post-write comparison of what QuickBooks booked.
//
// The fake client records every write and every query. Its default create
// response mirrors QuickBooks as probed against a sandbox: it adds a ShipAddr Id,
// a ShipMethodRef name, an APAccountRef and line Ids, and totals the lines. A case
// that needs a different response overrides only the keys it names.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { clearLookupCache } from "../../src/client/index.js";
import {
  handleCreatePurchaseOrder,
  normalizeShipTo,
  poBookedDifferences,
} from "../../src/tools/handlers/purchase-order.js";
import { toolDefinitions } from "../../src/tools/definitions.js";
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

const TWO_ROW_DESCRIPTION = "Pickup: Dock 4\nDeliver: Stop A";

const FULL_CREATE_ARGS = {
  vendor_name: "North Freight",
  txn_date: "2026-11-02",
  doc_number: "PO1002",
  ship_method: "Truck",
  ship_to: "Stop A\n100 Main St",
  memo: "Load 1",
  vendor_message: "Call before delivery",
  lines: [
    { item_name: "Freight:Shipping", amount: 100, description: TWO_ROW_DESCRIPTION },
    { account_name: "Supplies", amount: 50, class_name: "North" },
  ],
};

// What createPurchaseOrder answers by default: the body echoed back with the
// additions QuickBooks makes, which no comparison may treat as a difference.
function defaultCreateResponse(body: Body): Body {
  const lines = ((body.Line ?? []) as Body[]).map((line, i): Body => ({ ...structuredClone(line), Id: String(i + 1), LineNum: i + 1 }));
  const totalCents = lines.reduce((sum: number, line: Body) => sum + Math.round(line.Amount * 100), 0);
  return {
    ...structuredClone(body),
    Id: "601",
    SyncToken: "0",
    ...(body.ShipMethodRef && { ShipMethodRef: { value: body.ShipMethodRef.value, name: body.ShipMethodRef.value } }),
    ...(body.ShipAddr && { ShipAddr: { Id: "90", ...body.ShipAddr } }),
    APAccountRef: { value: "80", name: "Accounts Payable" },
    TotalAmt: totalCents / 100,
    Line: lines,
  };
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
    createPurchaseOrder: (body: Body, cb: Callback<unknown>) => {
      created.push(structuredClone(body));
      const response = defaultCreateResponse(body);
      cb(null, options.override ? options.override(response) : response);
    },
    updatePurchaseOrder: (body: Body, cb: Callback<unknown>) => {
      updated.push(body);
      cb(null, body);
    },
    deletePurchaseOrder: (body: unknown, cb: Callback<unknown>) => {
      deleted.push(body);
      cb(null, body);
    },
  } as unknown as QuickBooks;

  const wrote = () => created.length + updated.length + deleted.length > 0;
  return { client, created, poQueries, itemQueries, wrote };
}

const create = (client: QuickBooks, args: Record<string, unknown>) =>
  handleCreatePurchaseOrder(client, args as unknown as Parameters<typeof handleCreatePurchaseOrder>[1]) as Promise<Result>;

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

// "in draft and in commit": draft omitted, then draft false, each on a fresh fake
// after clearLookupCache.
async function inDraftAndCommit(run: (draft: { draft?: boolean }, label: string) => Promise<void>) {
  for (const [draft, label] of [[{}, "draft"], [{ draft: false }, "commit"]] as const) {
    clearLookupCache();
    await run(draft, label);
  }
}

beforeEach(() => clearLookupCache());

describe("create_purchase_order draft and payload", () => {
  it("po-create-draft-preview — the draft shows every field and writes nothing", async () => {
    const fake = fakeClient();
    const result = await create(fake.client, FULL_CREATE_ARGS);
    const text = textOf(result);

    assert.ok(text.startsWith("DRAFT - Purchase Order Preview"), text);
    for (const expected of [
      "Vendor: North Freight",
      "Ref no.: PO1002",
      "Status: Open",
      "Ship via: Truck",
      "Stop A",
      "100 Main St",
      "Memo: Load 1",
      "Vendor message: Call before delivery",
      "Total: $150.00",
      "Freight:Shipping",
      "Class: North",
    ]) {
      assert.ok(text.includes(expected), `missing "${expected}" in:\n${text}`);
    }
    const rows = rowsOf(result);
    assert.ok(rows.includes("    Pickup: Dock 4"), text);
    assert.ok(rows.includes("    Deliver: Stop A"), text);
    assert.equal(fake.wrote(), false);
  });

  it("po-create-payload — createPurchaseOrder receives exactly the previewed fields", async () => {
    const fake = fakeClient();
    await create(fake.client, { ...FULL_CREATE_ARGS, draft: false });

    assert.deepEqual(fake.created, [
      {
        VendorRef: { value: "20", name: "North Freight" },
        TxnDate: "2026-11-02",
        POStatus: "Open",
        DocNumber: "PO1002",
        ShipMethodRef: { value: "Truck", name: "Truck" },
        ShipAddr: { Line1: "Stop A", Line2: "100 Main St" },
        PrivateNote: "Load 1",
        Memo: "Call before delivery",
        Line: [
          {
            Amount: 100,
            Description: TWO_ROW_DESCRIPTION,
            DetailType: "ItemBasedExpenseLineDetail",
            ItemBasedExpenseLineDetail: {
              ItemRef: { value: "30", name: "Freight:Shipping" },
              Qty: 1,
              UnitPrice: 100,
              BillableStatus: "NotBillable",
            },
          },
          {
            Amount: 50,
            DetailType: "AccountBasedExpenseLineDetail",
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: "12", name: "Supplies" },
              ClassRef: { value: "50", name: "North" },
              BillableStatus: "NotBillable",
            },
          },
        ],
      },
    ]);
  });

  it("po-create-success — a matching booking returns the created summary with no link line", async () => {
    const fake = fakeClient();
    const result = await create(fake.client, { ...FULL_CREATE_ARGS, draft: false });
    const text = textOf(result);

    assert.equal(result.isError, undefined);
    assert.ok(text.startsWith("Purchase Order Created!"), text);
    assert.ok(text.includes("601"), text);
    assert.ok(text.includes("PO1002"), text);
    assert.ok(!text.includes("View in QuickBooks"), text);
  });

  it("po-create-status — the status defaults to Open and Closed is passed through", async () => {
    const fake = fakeClient();
    await create(fake.client, { ...FULL_CREATE_ARGS, draft: false });
    clearLookupCache();
    await create(fake.client, { ...FULL_CREATE_ARGS, status: "Closed", draft: false });

    assert.deepEqual(fake.created.map((p) => p.POStatus), ["Open", "Closed"]);
  });

  it("an empty doc_number means absent, and no Ref no. lookup runs", async () => {
    const fake = fakeClient();
    await create(fake.client, { ...FULL_CREATE_ARGS, doc_number: "", draft: false });

    assert.equal("DocNumber" in fake.created[0], false);
    assert.equal(fake.poQueries.length, 0);
  });

  it("an empty doc_number gives a draft with an auto-assigned Ref no. and no DocNumber in the payload", async () => {
    const draftFake = fakeClient();
    const draft = await create(draftFake.client, { ...FULL_CREATE_ARGS, doc_number: "" });
    assert.ok(rowsOf(draft).includes("Ref no.: (auto-assign)"), textOf(draft));
    assert.equal(draftFake.wrote(), false);

    clearLookupCache();
    const fake = fakeClient();
    await create(fake.client, { ...FULL_CREATE_ARGS, doc_number: "", draft: false });
    assert.equal("DocNumber" in fake.created[0], false);
  });

  it("surrounding spaces on doc_number and ship_method are trimmed before they are looked up and sent", async () => {
    const fake = fakeClient();
    const result = await create(fake.client, { ...FULL_CREATE_ARGS, doc_number: "  PO1002 ", ship_method: " Truck  ", draft: false });

    assert.equal(fake.created[0].DocNumber, "PO1002");
    assert.deepEqual(fake.created[0].ShipMethodRef, { value: "Truck", name: "Truck" });
    assert.deepEqual(fake.poQueries, [[{ field: "DocNumber", value: "PO1002", operator: "=" }]]);
    assert.equal(result.isError, undefined, textOf(result));
  });

  it("a blank doc_number or ship_method is treated as absent", async () => {
    const fake = fakeClient();
    await create(fake.client, { ...FULL_CREATE_ARGS, doc_number: "   ", ship_method: "  ", draft: false });

    assert.equal("DocNumber" in fake.created[0], false);
    assert.equal("ShipMethodRef" in fake.created[0], false);
    assert.equal(fake.poQueries.length, 0);
  });

  it("a messy ship_to previews as exactly its trimmed, non-blank rows", async () => {
    const fake = fakeClient();
    const draft = await create(fake.client, { ...FULL_CREATE_ARGS, ship_to: ["  Stop A  ", "", "Stop B\n"] });
    const rows = rowsOf(draft);
    const at = rows.indexOf("Ship to:");

    assert.notEqual(at, -1, textOf(draft));
    assert.deepEqual(rows.slice(at, at + 3), ["Ship to:", "  Stop A", "  Stop B"]);
    assert.ok(rows[at + 3].startsWith("Memo:"), textOf(draft));
  });

  it("no ship_to, an empty one and a blank one each leave ShipAddr off the payload", async () => {
    for (const ship_to of [undefined, "", [], ["  ", ""]]) {
      clearLookupCache();
      const fake = fakeClient();
      await create(fake.client, { ...FULL_CREATE_ARGS, ship_to, draft: false });
      assert.equal("ShipAddr" in fake.created[0], false, JSON.stringify(ship_to));
    }
  });

  it("vendor_id books the vendor with that Id", async () => {
    const fake = fakeClient();
    await create(fake.client, { ...FULL_CREATE_ARGS, vendor_name: undefined, vendor_id: "22", draft: false });

    assert.deepEqual(fake.created[0].VendorRef, { value: "22", name: "South Haulage" });
  });
});

describe("create_purchase_order ship_to", () => {
  it("po-create-ship-to-forms — a newline string, an array and a CRLF element give the same lines", async () => {
    for (const ship_to of ["Stop A\nStop B", ["Stop A", "Stop B"], ["Stop A\r\nStop B"]]) {
      clearLookupCache();
      const fake = fakeClient();
      await create(fake.client, { ...FULL_CREATE_ARGS, ship_to, draft: false });
      assert.deepEqual(fake.created[0].ShipAddr, { Line1: "Stop A", Line2: "Stop B" }, JSON.stringify(ship_to));
    }
  });

  it("po-create-ship-to-trim-blank — rows are trimmed and blank rows dropped", async () => {
    const fake = fakeClient();
    await create(fake.client, { ...FULL_CREATE_ARGS, ship_to: ["  Stop A  ", "", "   ", "Stop B\n"], draft: false });

    assert.deepEqual(fake.created[0].ShipAddr, { Line1: "Stop A", Line2: "Stop B" });
  });

  it("po-create-ship-to-six-rows — six rows are refused, listing them, in draft and in commit", async () => {
    await inDraftAndCommit(async (mode, label) => {
      const fake = fakeClient();
      const message = await rejection(() => create(fake.client, { ...FULL_CREATE_ARGS, ship_to: "R1\nR2\nR3\nR4\nR5\nR6", ...mode }));

      for (const row of ["R1", "R2", "R3", "R4", "R5", "R6"]) assert.ok(message.includes(row), `${label}: ${message}`);
      assert.match(message, /QuickBooks keeps 5 address lines/, label);
      assert.equal(fake.wrote(), false, label);
    });
  });

  it("po-create-ship-to-length — 2000 joined characters create, 2001 are refused", async () => {
    const fake = fakeClient();
    await create(fake.client, { ...FULL_CREATE_ARGS, ship_to: ["a".repeat(999), "b".repeat(1000)], draft: false });
    assert.equal(fake.created.length, 1);

    clearLookupCache();
    const over = fakeClient();
    const message = await rejection(() =>
      create(over.client, { ...FULL_CREATE_ARGS, ship_to: ["a".repeat(1000), "b".repeat(1000)], draft: false })
    );
    assert.match(message, /2001/);
    assert.match(message, /2000/);
    assert.equal(over.wrote(), false);
  });

  it("normalizeShipTo returns the rows QuickBooks will keep, and nothing for an empty input", () => {
    assert.deepEqual(normalizeShipTo("  Stop A \r\n\r\n 100 Main St "), { lines: ["Stop A", "100 Main St"] });
    assert.deepEqual(normalizeShipTo(undefined), { lines: [] });
    assert.deepEqual(normalizeShipTo(""), { lines: [] });
    assert.deepEqual(normalizeShipTo([]), { lines: [] });
  });
});

describe("create_purchase_order refusals before any write", () => {
  it("po-create-doc-number-length — 21 characters create, 22 are refused", async () => {
    const fake = fakeClient();
    await create(fake.client, { ...FULL_CREATE_ARGS, doc_number: "N".repeat(21), draft: false });
    assert.equal(fake.created.length, 1);

    clearLookupCache();
    const over = fakeClient();
    const message = await rejection(() => create(over.client, { ...FULL_CREATE_ARGS, doc_number: "N".repeat(22), draft: false }));
    assert.match(message, /21-character/);
    assert.equal(over.wrote(), false);
    assert.equal(over.poQueries.length, 0, "the length is checked before the duplicate lookup");
  });

  it("po-create-duplicate-doc-number — a Ref no. another purchase order holds is refused, in draft and in commit", async () => {
    await inDraftAndCommit(async (mode, label) => {
      const fake = fakeClient();
      const message = await rejection(() => create(fake.client, { ...FULL_CREATE_ARGS, doc_number: "PO1000", ...mode }));

      for (const expected of ["PO1000", "500", "North Freight"]) assert.ok(message.includes(expected), `${label}: ${message}`);
      assert.deepEqual(fake.poQueries, [[{ field: "DocNumber", value: "PO1000", operator: "=" }]], label);
      assert.equal(fake.wrote(), false, label);
    });
  });

  it("po-create-description-length — 4000 characters create, 4001 are refused naming the line", async () => {
    const withDescription = (description: string) => ({
      ...FULL_CREATE_ARGS,
      lines: [{ account_name: "Supplies", amount: 50, description }],
      draft: false,
    });

    const fake = fakeClient();
    await create(fake.client, withDescription("d".repeat(4000)));
    assert.equal(fake.created.length, 1);

    clearLookupCache();
    const over = fakeClient();
    const message = await rejection(() => create(over.client, withDescription("d".repeat(4001))));
    assert.ok(message.startsWith("Line 1"), message);
    assert.match(message, /4000/);
    assert.equal(over.wrote(), false);
  });

  it("po-create-exact-names — a partial vendor or an ambiguous item is refused, with no write", async () => {
    const fake = fakeClient();
    const vendorMessage = await rejection(() => create(fake.client, { ...FULL_CREATE_ARGS, vendor_name: "North" }));
    assert.match(vendorMessage, /no vendor matches .*exactly/i);

    clearLookupCache();
    const itemMessage = await rejection(() =>
      create(fake.client, { ...FULL_CREATE_ARGS, lines: [{ item_name: "Shipping", amount: 100 }, FULL_CREATE_ARGS.lines[1]] })
    );
    assert.ok(itemMessage.includes("id 30") && itemMessage.includes("id 31"), itemMessage);
    assert.equal(fake.wrote(), false);
  });

  it("checks run in order: vendor and items, then ship_to, then the doc_number length, then the duplicate lookup", async () => {
    const everythingWrong = {
      ...FULL_CREATE_ARGS,
      vendor_name: "North",
      ship_to: "R1\nR2\nR3\nR4\nR5\nR6",
      doc_number: "N".repeat(22),
    };

    const fake = fakeClient();
    assert.match(await rejection(() => create(fake.client, everythingWrong)), /no vendor matches/i);
    assert.match(
      await rejection(() => create(fake.client, { ...everythingWrong, vendor_name: "North Freight" })),
      /5 address lines/
    );
    assert.match(
      await rejection(() => create(fake.client, { ...everythingWrong, vendor_name: "North Freight", ship_to: "Stop A" })),
      /21-character/
    );
    assert.equal(fake.poQueries.length, 0);
    assert.equal(fake.wrote(), false);
  });
});

describe("create_purchase_order booked comparison", () => {
  it("po-create-not-as-previewed-address — a re-folded ship-to is returned as an error naming the lines", async () => {
    const fake = fakeClient({
      override: (response) => ({ ...response, ShipAddr: { Id: "90", Line1: "Stop A 100 Main St" } }),
    });
    const result = await create(fake.client, { ...FULL_CREATE_ARGS, draft: false });
    const text = textOf(result);

    assert.equal(result.isError, true);
    assert.equal(rowsOf(result)[0], "Purchase Order Created — NOT AS PREVIEWED");
    assert.match(text, /Ship to line 1: sent Stop A, booked Stop A 100 Main St/);
    assert.match(text, /Ship to line 2: sent 100 Main St, booked \(none\)/);
    for (const expected of ["Nothing was undone", "delete_entity", "purchase_order", "601"]) {
      assert.ok(text.includes(expected), `missing "${expected}" in:\n${text}`);
    }
    assert.match(text, /Do not re-run create_purchase_order/);
    assert.ok(!text.includes("View in QuickBooks"), text);
  });

  it("po-create-not-as-previewed-amount — a changed line amount and total are listed in dollars", async () => {
    const fake = fakeClient({
      override: (response) => ({
        ...response,
        TotalAmt: 140,
        Line: response.Line.map((line: Body, i: number) => (i === 1 ? { ...line, Amount: 40 } : line)),
      }),
    });
    const result = await create(fake.client, { ...FULL_CREATE_ARGS, draft: false });
    const text = textOf(result);

    assert.equal(result.isError, true);
    assert.match(text, /Line 2 amount: sent 50\.00, booked 40\.00/i);
    assert.match(text, /Total: sent 150\.00, booked 140\.00/);
  });
});

// The comparison is field by field over what was sent. Each case starts from a
// booking that matches the payload and changes one field of it.
describe("poBookedDifferences", () => {
  const sentPayload = (): Body => ({
    VendorRef: { value: "20", name: "North Freight" },
    TxnDate: "2026-11-02",
    POStatus: "Open",
    DocNumber: "PO1002",
    ShipMethodRef: { value: "Truck", name: "Truck" },
    ShipAddr: { Line1: "Stop A", Line2: "100 Main St" },
    PrivateNote: "Load 1",
    Memo: "Call before delivery",
    Line: [
      {
        Amount: 100,
        Description: "Pickup",
        DetailType: "ItemBasedExpenseLineDetail",
        ItemBasedExpenseLineDetail: {
          ItemRef: { value: "30", name: "Freight:Shipping" },
          Qty: 2,
          UnitPrice: 50,
          ClassRef: { value: "50", name: "North" },
          CustomerRef: { value: "70", name: "Customer One" },
          BillableStatus: "NotBillable",
        },
      },
      {
        Amount: 50,
        DetailType: "AccountBasedExpenseLineDetail",
        AccountBasedExpenseLineDetail: { AccountRef: { value: "12", name: "Supplies" }, BillableStatus: "NotBillable" },
      },
    ],
  });
  const booked = (): Body => defaultCreateResponse(sentPayload());

  it("finds nothing when the booking only adds what QuickBooks adds", () => {
    assert.deepEqual(poBookedDifferences(sentPayload(), booked()), []);
  });

  const mutations: Array<[string, (b: Body) => void, RegExp]> = [
    ["VendorRef", (b) => { b.VendorRef = { value: "21", name: "North Freight Lines" }; }, /Vendor/],
    ["TxnDate", (b) => { b.TxnDate = "2026-11-03"; }, /Date/],
    ["DocNumber", (b) => { b.DocNumber = "PO9"; }, /Ref no\./],
    ["POStatus", (b) => { b.POStatus = "Closed"; }, /Status/],
    ["ShipMethodRef", (b) => { b.ShipMethodRef = { value: "Rail", name: "Rail" }; }, /Ship via/],
    ["ShipAddr", (b) => { b.ShipAddr = { Id: "90", Line1: "Stop A" }; }, /Ship to line 2/],
    ["PrivateNote", (b) => { b.PrivateNote = "Load 2"; }, /Memo/],
    ["Memo", (b) => { b.Memo = ""; }, /Vendor message/],
    ["TotalAmt", (b) => { b.TotalAmt = 149.99; }, /Total/],
    ["line count", (b) => { b.Line.pop(); }, /Lines/],
    ["DetailType", (b) => { b.Line[1].DetailType = "ItemBasedExpenseLineDetail"; }, /Line 2 type/],
    ["ItemRef", (b) => { b.Line[0].ItemBasedExpenseLineDetail.ItemRef = { value: "31", name: "Supplies:Shipping" }; }, /Line 1 item/],
    ["AccountRef", (b) => { b.Line[1].AccountBasedExpenseLineDetail.AccountRef = { value: "13", name: "Other" }; }, /Line 2 account/],
    ["Description", (b) => { b.Line[0].Description = "Pickup elsewhere"; }, /Line 1 description/],
    ["Amount", (b) => { b.Line[0].Amount = 99.99; }, /Line 1 amount/],
    ["Qty", (b) => { b.Line[0].ItemBasedExpenseLineDetail.Qty = 3; }, /Line 1 qty/],
    ["ClassRef", (b) => { delete b.Line[0].ItemBasedExpenseLineDetail.ClassRef; }, /Line 1 class/],
    ["CustomerRef", (b) => { b.Line[0].ItemBasedExpenseLineDetail.CustomerRef = { value: "71", name: "Customer Two" }; }, /Line 1 customer/],
  ];

  for (const [name, mutate, expected] of mutations) {
    it(`reports a booked ${name} that differs from what was sent`, () => {
      const response = booked();
      mutate(response);
      const differences = poBookedDifferences(sentPayload(), response);
      assert.ok(differences.some((d) => expected.test(d)), `${name}: ${JSON.stringify(differences)}`);
    });
  }

  it("compares money in cents, so a float-shaped total does not raise a false alarm", () => {
    const sent = sentPayload();
    sent.Line = [
      { Amount: 0.1, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: "12" } } },
      { Amount: 0.2, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: "12" } } },
    ];
    const response = defaultCreateResponse(sent);
    response.TotalAmt = 0.3;
    assert.deepEqual(poBookedDifferences(sent, response), []);
  });

  it("never compares keys the payload did not send", () => {
    const response = booked();
    response.ShipAddr = { Id: "90", Line1: "Stop A", Line2: "100 Main St", City: "Northtown", PostalCode: "11111" };
    response.PrivateNote = "Entered in the UI";
    const sent = sentPayload();
    delete sent.PrivateNote;
    assert.deepEqual(poBookedDifferences(sent, response), []);
  });
});

describe("create_purchase_order schema", () => {
  it("po-create-schema — offers no due date, terms, department or AP account, and carries the create annotations", () => {
    const definition = toolDefinitions.find((t) => t.name === "create_purchase_order");
    assert.ok(definition, "create_purchase_order is defined");

    const schema = definition.inputSchema as unknown as ToolSchema;
    const properties = Object.keys(schema.properties ?? {});
    for (const absent of ["due_date", "sales_term_ref", "department_name", "ap_account"]) {
      assert.ok(!properties.includes(absent), `${absent} must not be declared`);
    }

    assert.throws(
      () => validateToolArguments("create_purchase_order", schema, { ...FULL_CREATE_ARGS, due_date: "2026-11-05" }),
      (error: unknown) => error instanceof ToolArgumentError && /due_date/.test(error.message)
    );
    assert.doesNotThrow(() => validateToolArguments("create_purchase_order", schema, FULL_CREATE_ARGS));

    assert.deepEqual(definition.annotations, {
      title: "Create QuickBooks purchase order",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it("the description says there is no due date, the ship_to limits, exact names and the draft default", () => {
    const definition = toolDefinitions.find((t) => t.name === "create_purchase_order");
    assert.ok(definition);
    const text = JSON.stringify(definition);

    assert.match(text, /no due date/i);
    assert.match(text, /memo/);
    assert.match(text, /vendor_message/);
    assert.match(text, /5 lines/);
    assert.match(text, /2000 characters/);
    assert.match(text, /Parent:Child/);
    assert.match(text, /exactly/i);
    assert.match(text, /draft/i);
  });
});
