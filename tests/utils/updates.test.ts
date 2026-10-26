import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatUpdateResult } from "../../src/utils/updates.js";

const URL = "https://example.invalid/txn/1";

describe("formatUpdateResult", () => {
  it("reports success when the SyncToken advances", () => {
    const text = formatUpdateResult("Journal Entry", "1", "3", "4", URL);
    assert.match(text, /updated successfully/);
    assert.match(text, /New SyncToken: 4/);
  });

  // QuickBooks accepts a payload identical to the stored record and returns the
  // same token. Calling that "updated successfully" is how a no-op edit gets
  // mistaken for a correction that landed.
  it("says nothing changed when the SyncToken stands still", () => {
    const text = formatUpdateResult("Journal Entry", "1", "3", "3", URL);
    assert.doesNotMatch(text, /updated successfully/);
    assert.match(text, /no change/);
    assert.match(text, /still 3/);
  });

  it("falls back to the success wording when a token is unavailable", () => {
    assert.match(formatUpdateResult("Bill", "1", undefined, "4", URL), /updated successfully/);
    assert.match(formatUpdateResult("Bill", "1", "3", undefined, URL), /updated successfully/);
  });

  // Account updates have no confirmed QuickBooks route, so they pass no URL and
  // the link line is left out rather than pointing somewhere wrong.
  it("update-result-without-url — without a URL the result has no link line", () => {
    const changed = formatUpdateResult("Account", "10", "3", "4");
    const unchanged = formatUpdateResult("Account", "10", "4", "4");

    assert.equal(changed, "Account 10 updated successfully.\nNew SyncToken: 4");
    assert.ok(unchanged.includes("Account 10: no change."), unchanged);
    assert.ok(!changed.includes("View in QuickBooks"), changed);
    assert.ok(!unchanged.includes("View in QuickBooks"), unchanged);
  });
});
