import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toolDefinitions } from "../../src/tools/definitions.js";
import {
  ENABLED_TOOLS_ENV,
  LOCAL_ONLY_TOOLS,
  READ_ONLY_ENV,
  isReadOnlyTool,
  resolveToolAccess,
  type ToolAccess,
} from "../../src/tools/access.js";

// The resolver is pure, so every case hands it a literal env. The expected
// read-only set is computed from the definitions' own annotations rather than
// written out, so adding a tool cannot break these tests.

const READ_HINTS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const CREATE_HINTS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const allNames = toolDefinitions.map((t) => t.name);
const sorted = (names: Iterable<string>): string[] => [...names].sort();

// Every defined tool left out of `names`, mapped to the variable that left it out.
const gatedOf = (access: ToolAccess): ReadonlyMap<string, "read-only" | "allowlist"> => {
  const { gated } = access as ToolAccess & { gated?: ReadonlyMap<string, "read-only" | "allowlist"> };
  assert.ok(gated instanceof Map, "resolveToolAccess returned no gated map");
  return gated;
};

const readOnlyNames = (): string[] =>
  toolDefinitions
    .filter((t) => (t as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint === true)
    .map((t) => t.name)
    .concat("qbo_authenticate");

describe("resolveToolAccess", () => {
  it("access-unset-exposes-all", () => {
    const result = resolveToolAccess({}, toolDefinitions);
    assert.equal(result.mode, "all");
    assert.deepEqual(sorted(result.names), sorted(allNames));
    assert.deepEqual([...result.notices], []);
  });

  it("access-truthy-enables-read-only", () => {
    for (const value of ["1", "true", "YES", "On", " true "]) {
      const result = resolveToolAccess({ [READ_ONLY_ENV]: value }, toolDefinitions);
      assert.equal(result.mode, "read-only", JSON.stringify(value));
      assert.ok(
        !result.notices.some((n) => /recogni[sz]ed/i.test(n)),
        `${JSON.stringify(value)} must not add a not-recognized notice`,
      );
    }
  });

  it("access-falsy-leaves-all", () => {
    for (const value of ["", "0", "false", "no", "OFF"]) {
      const result = resolveToolAccess({ [READ_ONLY_ENV]: value }, toolDefinitions);
      assert.equal(result.mode, "all", JSON.stringify(value));
      assert.deepEqual([...result.notices], [], JSON.stringify(value));
    }
  });

  it("access-unrecognized-fails-closed", () => {
    const result = resolveToolAccess({ [READ_ONLY_ENV]: "ture" }, toolDefinitions);
    assert.equal(result.mode, "read-only");
    const notice = result.notices.find((n) => n.includes('QBO_READ_ONLY="ture"'));
    assert.ok(notice, `no notice echoes the value: ${JSON.stringify(result.notices)}`);
    assert.match(notice, /treated as read-only/);
  });

  it("access-read-only-derived-from-annotations", () => {
    const result = resolveToolAccess({ QBO_READ_ONLY: "true" }, toolDefinitions);
    assert.deepEqual(sorted(result.names), sorted(readOnlyNames()));
    assert.ok(result.names.has("query"));
    const writes = toolDefinitions.filter(
      (t) => (t as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint === false,
    );
    for (const { name } of writes) {
      if (name === "qbo_authenticate") continue;
      assert.ok(!result.names.has(name), `${name} must not be exposed`);
    }
  });

  it("access-new-write-tool-excluded", () => {
    const defs = [
      { name: "get_widget", annotations: { title: "Get a widget", ...READ_HINTS } },
      { name: "create_widget", annotations: { title: "Create a widget", ...CREATE_HINTS } },
      { name: "list_widgets" },
    ];
    const result = resolveToolAccess({ QBO_READ_ONLY: "true" }, defs);
    assert.deepEqual([...result.names], ["get_widget"]);
  });

  it("access-local-only-names-real-tools", () => {
    assert.ok(LOCAL_ONLY_TOOLS.has("qbo_authenticate"));
    assert.equal(LOCAL_ONLY_TOOLS.size, 1);
    for (const name of LOCAL_ONLY_TOOLS) {
      const def = toolDefinitions.find((t) => t.name === name) as
        | { annotations?: { readOnlyHint?: boolean } }
        | undefined;
      assert.ok(def, `${name} is not a real tool`);
      assert.equal(def.annotations?.readOnlyHint, false, name);
      assert.equal(isReadOnlyTool(def as { name: string }), true, name);
    }
  });

  it("access-allowlist-parses-entries", () => {
    const result = resolveToolAccess({ [ENABLED_TOOLS_ENV]: "  Query , ,GET_BILL ,," }, toolDefinitions);
    assert.equal(result.mode, "allowlist");
    assert.deepEqual(sorted(result.names), ["get_bill", "query"]);
  });

  it("access-allowlist-matches-def-case", () => {
    const defs = [
      { name: "Mixed_Case", annotations: { title: "Mixed case", ...READ_HINTS } },
      { name: "get_widget", annotations: { title: "Get a widget", ...READ_HINTS } },
    ];
    const result = resolveToolAccess({ QBO_ENABLED_TOOLS: "mixed_CASE" }, defs);
    assert.deepEqual([...result.names], ["Mixed_Case"]);
  });

  it("access-allowlist-unknown-names-warned", () => {
    const result = resolveToolAccess({ QBO_ENABLED_TOOLS: "query,not_a_tool" }, toolDefinitions);
    assert.deepEqual([...result.names], ["query"]);
    const notice = result.notices.find((n) => n.includes("not_a_tool"));
    assert.ok(notice, `no notice names the unknown entry: ${JSON.stringify(result.notices)}`);
    assert.match(notice, /unknown/i);
    assert.match(notice, /ignored/i);
  });

  it("access-allowlist-all-unknown-exposes-none", () => {
    const result = resolveToolAccess({ QBO_ENABLED_TOOLS: "not_a_tool" }, toolDefinitions);
    assert.equal(result.mode, "allowlist");
    assert.deepEqual([...result.names], []);
    assert.ok(
      result.notices.some((n) => /no tools are exposed/i.test(n)),
      JSON.stringify(result.notices),
    );
  });

  it("access-allowlist-blank-falls-back", () => {
    const result = resolveToolAccess({ QBO_ENABLED_TOOLS: "  ,, ", QBO_READ_ONLY: "true" }, toolDefinitions);
    assert.equal(result.mode, "read-only");
    assert.deepEqual(sorted(result.names), sorted(readOnlyNames()));
  });

  it("access-read-only-narrows-allowlist", () => {
    const result = resolveToolAccess({ QBO_READ_ONLY: "true", QBO_ENABLED_TOOLS: "query,create_bill" }, toolDefinitions);
    assert.equal(result.mode, "read-only-allowlist");
    assert.deepEqual([...result.names], ["query"]);
    assert.ok(
      result.notices.some((n) => n.includes("create_bill") && /disabled by QBO_READ_ONLY/.test(n)),
      JSON.stringify(result.notices),
    );
    assert.ok(
      !result.notices.some((n) => /(QBO_READ_ONLY|QBO_ENABLED_TOOLS) is ignored/.test(n)),
      JSON.stringify(result.notices),
    );
  });

  it("access-allowlist-alone-selects-writes", () => {
    const result = resolveToolAccess({ QBO_ENABLED_TOOLS: "create_bill" }, toolDefinitions);
    assert.equal(result.mode, "allowlist");
    assert.deepEqual([...result.names], ["create_bill"]);
  });

  it("access-unrecognized-narrows-allowlist", () => {
    const result = resolveToolAccess({ QBO_READ_ONLY: "ture", QBO_ENABLED_TOOLS: "query,create_bill" }, toolDefinitions);
    assert.equal(result.mode, "read-only-allowlist");
    assert.deepEqual([...result.names], ["query"]);
    const notice = result.notices.find((n) => n.includes('QBO_READ_ONLY="ture"'));
    assert.ok(notice, `no notice echoes the value: ${JSON.stringify(result.notices)}`);
    assert.match(notice, /treated as read-only/);
  });

  it("access-read-only-allowlist-all-writes-exposes-none", () => {
    const result = resolveToolAccess({ QBO_READ_ONLY: "true", QBO_ENABLED_TOOLS: "create_bill,edit_bill" }, toolDefinitions);
    assert.deepEqual([...result.names], []);
    assert.ok(
      result.notices.some((n) => /no tools are exposed/i.test(n)),
      JSON.stringify(result.notices),
    );
  });

  it("access-local-only-survives-narrowing", () => {
    const result = resolveToolAccess(
      { QBO_READ_ONLY: "true", QBO_ENABLED_TOOLS: "qbo_authenticate,create_bill" },
      toolDefinitions,
    );
    assert.deepEqual([...result.names], ["qbo_authenticate"]);
  });

  it("access-gated-causes", () => {
    const gatedKeysAreTheRest = (result: ToolAccess, gated: ReadonlyMap<string, string>): void => {
      assert.deepEqual(sorted(gated.keys()), sorted(allNames.filter((name) => !result.names.has(name))));
    };

    const both = resolveToolAccess({ QBO_READ_ONLY: "true", QBO_ENABLED_TOOLS: "query,create_bill" }, toolDefinitions);
    const bothGated = gatedOf(both);
    gatedKeysAreTheRest(both, bothGated);
    assert.equal(bothGated.get("create_bill"), "read-only");
    assert.equal(bothGated.get("edit_bill"), "read-only");
    assert.equal(bothGated.get("get_bill"), "allowlist");

    const readOnly = resolveToolAccess({ QBO_READ_ONLY: "true" }, toolDefinitions);
    const readOnlyGated = gatedOf(readOnly);
    gatedKeysAreTheRest(readOnly, readOnlyGated);
    assert.ok(readOnlyGated.size > 0);
    for (const [name, cause] of readOnlyGated) assert.equal(cause, "read-only", name);

    const allowlist = resolveToolAccess({ QBO_ENABLED_TOOLS: "query" }, toolDefinitions);
    const allowlistGated = gatedOf(allowlist);
    gatedKeysAreTheRest(allowlist, allowlistGated);
    assert.ok(allowlistGated.size > 0);
    for (const [name, cause] of allowlistGated) assert.equal(cause, "allowlist", name);
  });

  it("access-summary-notice", () => {
    const total = toolDefinitions.length;

    const readOnly = resolveToolAccess({ QBO_READ_ONLY: "true" }, toolDefinitions);
    assert.ok(
      readOnly.notices.includes(`tool access: read-only, ${readOnly.names.size} of ${total} tools exposed`),
      JSON.stringify(readOnly.notices),
    );

    const allowlist = resolveToolAccess({ QBO_ENABLED_TOOLS: "query" }, toolDefinitions);
    assert.ok(
      allowlist.notices.includes(`tool access: allowlist, ${allowlist.names.size} of ${total} tools exposed`),
      JSON.stringify(allowlist.notices),
    );
  });
});
