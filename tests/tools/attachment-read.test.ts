import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type QuickBooks from "node-quickbooks";

import {
  fetchAttachments,
  handleGetAttachment,
  handleListAttachments,
} from "../../src/tools/handlers/attachment.js";
import { setOutputMode } from "../../src/utils/output.js";
import { newAttemptRecord, withWriteTracking } from "../../src/client/write-barrier.js";

type Callback<T> = (err: unknown, result: T) => void;

const FILE_ATTACHABLE = {
  Id: "11",
  SyncToken: "0",
  FileName: "statement.pdf",
  ContentType: "application/pdf",
  Size: 2048,
  Note: "March statement",
  Category: "Receipt",
  TempDownloadUri: "https://files.example.test/tmp/statement.pdf?sig=abc",
  AttachableRef: [
    { EntityRef: { type: "Bill", value: "42" } },
    { EntityRef: { type: "VendorCredit", value: "9" } },
  ],
};

const NOTE_ATTACHABLE = {
  Id: "12",
  SyncToken: "1",
  Note: "Called the supplier",
  AttachableRef: [{ EntityRef: { type: "Bill", value: "42" } }],
};

// Records every method the handlers touch, so write methods can be proven
// untouched. Only the read methods exist on the object; a write call would
// throw, and `calls` lists what was reached.
function fakeClient(opts: {
  found?: unknown[];
  attachable?: Record<string, unknown>;
}) {
  const calls = { criteria: [] as unknown[], reads: [] as string[], writes: [] as string[] };
  const client = {
    findAttachables: (criteria: unknown, cb: Callback<unknown>) => {
      calls.criteria.push(criteria);
      cb(null, { QueryResponse: { Attachable: opts.found ?? [] } });
    },
    getAttachable: (id: string, cb: Callback<unknown>) => {
      calls.reads.push(id);
      cb(null, opts.attachable);
    },
    createAttachable: () => calls.writes.push("createAttachable"),
    updateAttachable: () => calls.writes.push("updateAttachable"),
    deleteAttachable: () => calls.writes.push("deleteAttachable"),
    upload: () => calls.writes.push("upload"),
  } as unknown as QuickBooks;
  return { client, calls };
}

const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join("\n");

const realFetch = globalThis.fetch;

function stubFetch(body: Buffer) {
  const requested: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    requested.push(String(url));
    return new Response(new Uint8Array(body), { status: 200 });
  }) as typeof fetch;
  return requested;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  setOutputMode("stdio");
});

describe("attachment reads", () => {
  it("list-attachments-documented-query", async () => {
    const { client, calls } = fakeClient({});
    await handleListAttachments(client, { entity_type: "bill", entity_id: "42" });

    assert.equal(calls.criteria.length, 1);
    const criteria = String(calls.criteria[0]);
    assert.match(criteria, /AttachableRef\.EntityRef\.Type = 'bill'/);
    assert.match(criteria, /AttachableRef\.EntityRef\.value = '42'/);
    // The capitalised forms are not the documented query.
    assert.doesNotMatch(criteria, /\.Value\b/);
  });

  it("list-attachments-expense-is-purchase", async () => {
    const { client, calls } = fakeClient({});
    await handleListAttachments(client, { entity_type: "expense", entity_id: "7" });

    const criteria = String(calls.criteria[0]);
    assert.match(criteria, /AttachableRef\.EntityRef\.Type = 'purchase'/);
    assert.match(criteria, /AttachableRef\.EntityRef\.value = '7'/);
  });

  it("list-attachments accepts the QBO type name case-insensitively", async () => {
    const { client, calls } = fakeClient({});
    await handleListAttachments(client, { entity_type: "JournalEntry", entity_id: "3" });
    assert.match(String(calls.criteria[0]), /EntityRef\.Type = 'journalentry'/);
  });

  it("fetchAttachments lowercases the type and returns the Attachable rows", async () => {
    const { client, calls } = fakeClient({ found: [NOTE_ATTACHABLE] });
    const rows = await fetchAttachments(client, "VendorCredit", "9");
    assert.deepEqual(rows, [NOTE_ATTACHABLE]);
    assert.match(String(calls.criteria[0]), /EntityRef\.Type = 'vendorcredit'/);
  });

  it("attachment-query-rejects-non-numeric-id", async () => {
    const { client, calls } = fakeClient({});
    await assert.rejects(
      handleListAttachments(client, { entity_type: "bill", entity_id: "42' or Id != '0" }),
      /invalid entity id/i
    );
    await assert.rejects(fetchAttachments(client, "Bill", "4x2"), /invalid entity id/i);
    assert.equal(calls.criteria.length, 0);
  });

  it("list-attachments-rejects-unknown-type", async () => {
    const { client, calls } = fakeClient({});
    await assert.rejects(
      handleListAttachments(client, { entity_type: "widget", entity_id: "42" }),
      (err: Error) => {
        assert.match(err.message, /widget/);
        // Names the valid types, both a transaction and a name entity.
        assert.match(err.message, /bill/);
        assert.match(err.message, /journal_entry/);
        assert.match(err.message, /vendor_credit/);
        assert.match(err.message, /item/);
        return true;
      }
    );
    assert.equal(calls.criteria.length, 0);
  });

  it("list-attachments-describes-each", async () => {
    const { client } = fakeClient({ found: [FILE_ATTACHABLE, NOTE_ATTACHABLE] });
    const out = text(await handleListAttachments(client, { entity_type: "bill", entity_id: "42" }));

    // The count is asserted on the header: a bare \b2\b would also match "2.0 KB".
    assert.match(out, /Bill 42: 2 attachments/);
    assert.match(out, /\b11\b/);
    assert.match(out, /statement\.pdf/);
    assert.match(out, /application\/pdf/);
    assert.match(out, /2\.0 KB|2048/);
    assert.match(out, /March statement/);
    assert.match(out, /\b12\b/);
    assert.match(out, /Note/);
    assert.match(out, /Called the supplier/);
  });

  it("list_attachments reports zero when nothing is linked", async () => {
    const { client } = fakeClient({ found: [] });
    const out = text(await handleListAttachments(client, { entity_type: "bill", entity_id: "42" }));
    assert.match(out, /\b0\b/);
  });

  it("get-attachment-shows-details", async () => {
    const { client, calls } = fakeClient({ attachable: FILE_ATTACHABLE });
    const out = text(await handleGetAttachment(client, { id: "11" }));

    assert.deepEqual(calls.reads, ["11"]);
    assert.match(out, /statement\.pdf/);
    assert.match(out, /application\/pdf/);
    assert.match(out, /2\.0 KB|2048/);
    assert.match(out, /March statement/);
    assert.match(out, /Receipt/);
    // Both links are listed...
    assert.match(out, /Bill 42/);
    assert.match(out, /Vendor Credit 9/);
    // ...a deep link only for the bill: vendorcredit is unmapped, never guessed.
    assert.match(out, /\/app\/bill\?txnId=42/);
    assert.doesNotMatch(out, /txnId=9\b/);
    assert.doesNotMatch(out, /https?:\S*vendorcredit/i);
    // The download URL is shown and labelled temporary (about 15 minutes).
    assert.ok(out.includes(FILE_ATTACHABLE.TempDownloadUri));
    assert.match(out, /temporary/i);
    assert.match(out, /15 minutes/);
  });

  it("get-attachment-downloads-in-stdio", async () => {
    setOutputMode("stdio");
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]);
    const requested = stubFetch(bytes);
    const dir = mkdtempSync(join(tmpdir(), "attachment-read-test-"));
    try {
      const target = join(dir, "saved.pdf");
      const { client } = fakeClient({ attachable: FILE_ATTACHABLE });
      const out = text(await handleGetAttachment(client, { id: "11", save_to: target }));

      assert.deepEqual(requested, [FILE_ATTACHABLE.TempDownloadUri]);
      assert.deepEqual(readFileSync(target), bytes);
      assert.ok(out.includes(target));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("get-attachment-downloads-in-stdio without save_to uses a fresh temp dir and the base name", async () => {
    setOutputMode("stdio");
    const bytes = Buffer.from("known bytes");
    stubFetch(bytes);
    // A path-bearing file name must not escape the fresh directory.
    const attachable = { ...FILE_ATTACHABLE, FileName: "../../nested/statement.pdf" };
    const { client } = fakeClient({ attachable });
    const out = text(await handleGetAttachment(client, { id: "11", download: true }));

    const match = out.match(/(\/\S*statement\.pdf)/);
    assert.ok(match, `no saved path in output: ${out}`);
    const saved = match[1];
    try {
      assert.equal(basename(saved), "statement.pdf");
      // A fresh directory of its own, never the OS temp dir itself.
      assert.notEqual(dirname(saved), tmpdir());
      assert.equal(dirname(dirname(saved)), tmpdir());
      assert.match(basename(dirname(saved)), /^qbo-attachment-/);
      assert.ok(saved.startsWith(tmpdir()) || saved.includes("/tmp") || saved.includes("/var/"));
      assert.doesNotMatch(saved, /nested/);
      assert.deepEqual(readFileSync(saved), bytes);
    } finally {
      rmSync(join(saved, ".."), { recursive: true, force: true });
    }
  });

  it("get-attachment-download-http-url-only", async () => {
    setOutputMode("http");
    const requested = stubFetch(Buffer.from("never fetched"));
    const { client } = fakeClient({ attachable: FILE_ATTACHABLE });
    const out = text(await handleGetAttachment(client, { id: "11", download: true }));

    assert.equal(requested.length, 0);
    assert.match(out, /unavailable|not available/i);
    assert.match(out, /HTTP/);
    assert.ok(out.includes(FILE_ATTACHABLE.TempDownloadUri));
  });

  it("get-attachment-note-has-no-download", async () => {
    setOutputMode("stdio");
    const requested = stubFetch(Buffer.from("never fetched"));
    const { client } = fakeClient({ attachable: NOTE_ATTACHABLE });

    await assert.rejects(
      handleGetAttachment(client, { id: "12", download: true }),
      /no file to download/i
    );
    assert.equal(requested.length, 0);
  });

  it("carries the Attachable JSON in HTTP mode (includeRaw stays default)", async () => {
    setOutputMode("http");
    const { client } = fakeClient({ attachable: FILE_ATTACHABLE });
    const result = await handleGetAttachment(client, { id: "11" });
    assert.equal(result.content.length, 2);
    assert.equal(JSON.parse(result.content[1].text).Id, "11");
  });

  it("read tools never call a write method or arm the write barrier", async () => {
    const record = newAttemptRecord();
    const { client, calls } = fakeClient({ found: [FILE_ATTACHABLE], attachable: FILE_ATTACHABLE });
    await withWriteTracking(record, async () => {
      await handleListAttachments(client, { entity_type: "bill", entity_id: "42" });
      await handleGetAttachment(client, { id: "11" });
    });

    assert.deepEqual(calls.writes, []);
    assert.equal(record.writeIssued, false);
  });
});
