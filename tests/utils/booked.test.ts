// fieldDifferences renders the rows of a sent-versus-booked comparison, for the
// create tools that check what QuickBooks stored against what they sent.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fieldDifferences } from "../../src/utils/index.js";

describe("fieldDifferences", () => {
  it("booked-field-differences — renders only the rows whose sides differ, with (none) for an absent side", () => {
    assert.deepEqual(
      fieldDifferences([
        { label: "Status", sent: "Open", booked: "Open" },
        { label: "Ship via", sent: "Truck", booked: undefined },
        { label: "Total", sent: "150.00", booked: "140.00" },
      ]),
      ["Ship via: sent Truck, booked (none)", "Total: sent 150.00, booked 140.00"]
    );
  });

  it("renders an absent sent side as (none) too", () => {
    assert.deepEqual(fieldDifferences([{ label: "Memo", sent: undefined, booked: "Load 1" }]), [
      "Memo: sent (none), booked Load 1",
    ]);
  });

  it("returns nothing when every row matches", () => {
    assert.deepEqual(
      fieldDifferences([
        { label: "Memo", sent: undefined, booked: undefined },
        { label: "Status", sent: "Open", booked: "Open" },
      ]),
      []
    );
  });
});
