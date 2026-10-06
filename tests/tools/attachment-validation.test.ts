import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { executeTool } from "../../src/tools/index.js";
import { toolDefinitions } from "../../src/tools/definitions.js";
import { validateToolArguments, type ToolSchema } from "../../src/tools/validate.js";

// Validation runs before the dispatcher asks for a QuickBooks client, so none
// of the executeTool calls here need credentials. A valid call is never made
// through executeTool: it would request a client, which is a live call on a
// machine with credentials.

const ATTACHMENT_TOOLS = [
  "upload_attachment",
  "create_attachment_note",
  "get_attachment",
  "list_attachments",
  "edit_attachment",
] as const;

const link = { entity_type: "expense", entity_id: "42" };

// Otherwise-valid argument sets, one per tool
const validArgs: Record<(typeof ATTACHMENT_TOOLS)[number], Record<string, unknown>> = {
  upload_attachment: { file_path: "/tmp/statement.pdf", links: [link] },
  create_attachment_note: { note: "Checked", links: [link] },
  get_attachment: { id: "7" },
  list_attachments: { entity_type: "bill", entity_id: "9" },
  edit_attachment: { id: "7", note: "Updated" },
};

// Every parameter each handler reads, with every links item field
const fullArgs: Record<(typeof ATTACHMENT_TOOLS)[number], Record<string, unknown>> = {
  upload_attachment: {
    file_path: "/tmp/statement.pdf",
    file_content_base64: "aGVsbG8=",
    file_name: "statement.pdf",
    content_type: "application/pdf",
    links: [{ entity_type: "bill", entity_id: "42", include_on_send: true }],
    note: "Statement",
    category: "Receipt",
    allow_duplicate: true,
    draft: false,
  },
  create_attachment_note: {
    note: "Checked",
    links: [{ entity_type: "bill", entity_id: "42", include_on_send: false }],
    category: "Other",
    draft: false,
  },
  get_attachment: { id: "7", download: true, save_to: "/tmp/out" },
  list_attachments: { entity_type: "bill", entity_id: "9" },
  edit_attachment: {
    id: "7",
    note: "Updated",
    category: "Receipt",
    file_name: "renamed.pdf",
    add_links: [{ entity_type: "bill", entity_id: "42", include_on_send: true }],
    remove_links: [{ entity_type: "expense", entity_id: "3" }],
    set_include_on_send: [{ entity_type: "bill", entity_id: "42", include_on_send: false }],
    draft: false,
  },
};

const schemaOf = (name: string) => toolDefinitions.find((t) => t.name === name);

describe("attachment tool validation", () => {
  it("attachment-tools-reject-unknown-arguments", async () => {
    for (const name of ATTACHMENT_TOOLS) {
      const result = await executeTool(name, { ...validArgs[name], bogus_param: "x" });
      assert.equal(result.isError, true, `${name} should be an error`);
      assert.match(result.content[0].text, /Invalid arguments/, name);
      assert.match(result.content[0].text, /Unknown parameter "bogus_param"/, name);
    }
  });

  it("attachment-tools-enforce-required", async () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["get_attachment", {}, /Missing required parameter "id"/],
      ["list_attachments", { entity_type: "bill" }, /Missing required parameter "entity_id"/],
      ["create_attachment_note", { note: "Checked" }, /Missing required parameter "links"/],
      ["edit_attachment", { note: "Updated" }, /Missing required parameter "id"/],
    ];
    for (const [name, args, pattern] of cases) {
      const result = await executeTool(name, args);
      assert.equal(result.isError, true, `${name} should be an error`);
      assert.match(result.content[0].text, pattern, name);
    }
  });

  it("attachment-link-items-enforce-entity-id", async () => {
    const result = await executeTool("upload_attachment", {
      file_path: "/tmp/statement.pdf",
      links: [{ entity_type: "expense" }],
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Missing required parameter "links\[0\]\.entity_id"/);
  });

  it("attachment-link-items-enforce-entity-id: every link array declares entity_type and entity_id as required", () => {
    const arrays: Array<[string, string]> = [
      ["upload_attachment", "links"],
      ["create_attachment_note", "links"],
      ["edit_attachment", "add_links"],
      ["edit_attachment", "set_include_on_send"],
      ["edit_attachment", "remove_links"],
    ];
    for (const [tool, prop] of arrays) {
      const schema = schemaOf(tool)?.inputSchema as any;
      const items = schema?.properties?.[prop]?.items;
      assert.ok(items, `${tool}.${prop} should declare items`);
      assert.ok(items.required?.includes("entity_type"), `${tool}.${prop} requires entity_type`);
      assert.ok(items.required?.includes("entity_id"), `${tool}.${prop} requires entity_id`);
    }
  });

  it("attachment-schemas-accept-full-arguments", () => {
    for (const name of ATTACHMENT_TOOLS) {
      const def = schemaOf(name);
      assert.ok(def, `${name} should be in toolDefinitions`);
      assert.ok(def.inputSchema, `${name} should have a schema`);
      assert.doesNotThrow(
        () => validateToolArguments(name, def.inputSchema as unknown as ToolSchema, fullArgs[name]),
        name
      );
    }
  });

  it("edit-attachment-needs-a-change", async () => {
    const result = await executeTool("edit_attachment", { id: "7" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no fields to change/);
  });

  it("write tool descriptions start with WRITE: and state the draft default", () => {
    for (const name of ["upload_attachment", "create_attachment_note", "edit_attachment"]) {
      const description = schemaOf(name)?.description ?? "";
      assert.match(description, /^WRITE:/, name);
      assert.match(description, /draft/i, name);
    }
  });

  it("upload_attachment states the HTTP base64 bound and the context cost", () => {
    const description = schemaOf("upload_attachment")?.description ?? "";
    assert.ok(description.includes("4.4 MB"));
    assert.match(description, /context/i);
  });

  it("read tools do not claim to write, and list_attachments points to query", () => {
    for (const name of ["get_attachment", "list_attachments"]) {
      assert.doesNotMatch(schemaOf(name)?.description ?? "", /^WRITE:/, name);
    }
    assert.match(schemaOf("list_attachments")?.description ?? "", /\bquery\b/);
  });
});
