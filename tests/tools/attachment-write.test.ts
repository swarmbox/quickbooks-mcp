import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type QuickBooks from "node-quickbooks";

import {
  handleCreateAttachmentNote,
  handleEditAttachment,
  handleUploadAttachment,
} from "../../src/tools/handlers/attachment.js";
import { setOutputMode } from "../../src/utils/output.js";
import { newAttemptRecord, withWriteTracking, type AttemptRecord } from "../../src/client/write-barrier.js";

type Callback<T> = (err: unknown, result: T) => void;
type ToolResult = { content: Array<{ text: string }> };

// ---------------------------------------------------------------------------
// Fixtures (invented data only)
// ---------------------------------------------------------------------------

const BILL_42 = {
  Id: "42",
  SyncToken: "2",
  DocNumber: "1001",
  VendorRef: { value: "9", name: "Example Supply" },
  TxnDate: "2026-03-01",
  TotalAmt: 100.0,
};

const INVOICE_7 = {
  Id: "7",
  SyncToken: "0",
  DocNumber: "1002",
  CustomerRef: { value: "3", name: "North Customer" },
  TxnDate: "2026-03-02",
  TotalAmt: 200.0,
};

const CUSTOMER_3 = { Id: "3", SyncToken: "0", DisplayName: "North Customer" };

// The fields QBO lets a caller write on an Attachable, besides Id/SyncToken.
const WRITABLE = new Set([
  "Id",
  "SyncToken",
  "FileName",
  "Note",
  "Category",
  "ContentType",
  "Tag",
  "Lat",
  "Long",
  "PlaceName",
  "AttachableRef",
]);

const READ_ONLY = [
  "Size",
  "TempDownloadUri",
  "FileAccessUri",
  "ThumbnailTempDownloadUri",
  "MetaData",
  "AttachableEx",
  "domain",
  "sparse",
];

// An upload response as QBO returns it: the new, unlinked Attachable with its
// read-only fields filled in. None of those may be echoed into the link update.
function uploadResponse(id: string) {
  return {
    Id: id,
    SyncToken: "0",
    FileName: "statement.pdf",
    ContentType: "application/pdf",
    Size: 2048,
    FileAccessUri: `/v3/company/1/download/${id}`,
    TempDownloadUri: `https://files.example.test/tmp/${id}?sig=abc`,
    MetaData: { CreateTime: "2026-03-03T10:00:00-08:00", LastUpdatedTime: "2026-03-03T10:00:00-08:00" },
    domain: "QBO",
    sparse: false,
  };
}

// ---------------------------------------------------------------------------
// Fake client
// ---------------------------------------------------------------------------

interface UploadCall {
  fileName: string;
  contentType: string;
  data: unknown;
  barrierArmed: boolean | undefined;
}

interface FakeOpts {
  // Attachables found by findAttachables, keyed by "<lowercase type>:<id>"
  existing?: Record<string, unknown[]>;
  // What getAttachable returns
  attachable?: Record<string, unknown>;
  uploaded?: Record<string, unknown>;
  updateError?: unknown;
  // Observed at the moment upload is called
  record?: AttemptRecord;
}

// node-quickbooks-style callback methods that record their arguments. Reads
// return fixtures; writes are recorded so a draft can be proven to make none.
function fakeClient(opts: FakeOpts = {}) {
  const calls = {
    uploads: [] as UploadCall[],
    creates: [] as Record<string, unknown>[],
    updates: [] as Record<string, unknown>[],
    criteria: [] as string[],
  };
  const getById =
    (fixtures: Record<string, unknown>) => (id: string, cb: Callback<unknown>) => {
      const found = fixtures[String(id)];
      if (found) cb(null, found);
      else cb(new Error(`Object Not Found: ${id}`), undefined);
    };

  const client = {
    getBill: getById({ "42": BILL_42 }),
    getInvoice: getById({ "7": INVOICE_7 }),
    getCustomer: getById({ "3": CUSTOMER_3 }),
    getAttachable: (id: string, cb: Callback<unknown>) => cb(null, opts.attachable ?? { Id: id }),
    findAttachables: (criteria: string, cb: Callback<unknown>) => {
      calls.criteria.push(String(criteria));
      const type = /EntityRef\.Type = '([^']+)'/.exec(String(criteria))?.[1];
      const value = /EntityRef\.value = '([^']+)'/.exec(String(criteria))?.[1];
      const rows = opts.existing?.[`${type}:${value}`] ?? [];
      cb(null, { QueryResponse: { Attachable: rows } });
    },
    upload: (fileName: string, contentType: string, data: unknown, cb: Callback<unknown>) => {
      calls.uploads.push({ fileName, contentType, data, barrierArmed: opts.record?.writeIssued });
      cb(null, opts.uploaded ?? uploadResponse("77"));
    },
    createAttachable: (body: Record<string, unknown>, cb: Callback<unknown>) => {
      calls.creates.push(body);
      cb(null, { Id: "88", SyncToken: "0", ...body });
    },
    updateAttachable: (body: Record<string, unknown>, cb: Callback<unknown>) => {
      calls.updates.push(body);
      if (opts.updateError) cb(opts.updateError, undefined);
      else cb(null, { ...body, SyncToken: String(Number(body.SyncToken ?? 0) + 1) });
    },
  } as unknown as QuickBooks;
  return { client, calls };
}

const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

// The body as it goes on the wire: undefined-valued keys are not sent.
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const refKey = (r: { EntityRef: { type: string; value: string } }) =>
  `${r.EntityRef.type} ${r.EntityRef.value}`;

function writeCount(calls: ReturnType<typeof fakeClient>["calls"]): number {
  return calls.uploads.length + calls.creates.length + calls.updates.length;
}

function assertWritableOnly(body: Record<string, unknown>) {
  const sent = Object.keys(wire(body));
  for (const key of sent) assert.ok(WRITABLE.has(key), `non-writable field sent: ${key}`);
  for (const key of READ_ONLY) assert.ok(!(key in body), `read-only field sent: ${key}`);
}

// Runs a handler inside an attempt so the write barrier can be observed.
async function tracked(
  fn: (record: AttemptRecord) => Promise<ToolResult>
): Promise<{ result: ToolResult; record: AttemptRecord }> {
  const record = newAttemptRecord();
  const result = await withWriteTracking(record, () => fn(record));
  return { result, record };
}

// ---------------------------------------------------------------------------
// File fixtures
// ---------------------------------------------------------------------------

let dir: string;
let pdfPath: string;
let binPath: string;
const PDF_BYTES = Buffer.alloc(2048, 0x41);

before(() => {
  dir = mkdtempSync(join(tmpdir(), "attachment-write-test-"));
  pdfPath = join(dir, "statement.pdf");
  binPath = join(dir, "data.bin");
  PDF_BYTES.write("%PDF-1.4", 0);
  writeFileSync(pdfPath, PDF_BYTES);
  writeFileSync(binPath, Buffer.from([0x00, 0x01, 0x02]));
});

after(() => rmSync(dir, { recursive: true, force: true }));

afterEach(() => setOutputMode("stdio"));

// ---------------------------------------------------------------------------
// upload_attachment
// ---------------------------------------------------------------------------

describe("upload_attachment", () => {
  it("upload-draft-writes-nothing", async () => {
    const { client, calls } = fakeClient();
    const { result, record } = await tracked(() =>
      handleUploadAttachment(client, {
        file_path: pdfPath,
        links: [{ entity_type: "bill", entity_id: "42" }],
      })
    );
    const out = text(result);

    assert.match(out, /statement\.pdf/);
    assert.match(out, /application\/pdf/);
    assert.match(out, /2\.0 KB|2048/);
    // The target is described: type label, id, doc number, party and date.
    assert.match(out, /Bill 42/);
    assert.match(out, /1001/);
    assert.match(out, /Example Supply/);
    assert.match(out, /2026-03-01/);

    assert.equal(writeCount(calls), 0);
    assert.equal(record.writeIssued, false);
  });

  it("upload-commit-uploads-then-links", async () => {
    const record = newAttemptRecord();
    const { client, calls } = fakeClient({ record, uploaded: uploadResponse("77") });
    const result: ToolResult = await withWriteTracking(record, () =>
      handleUploadAttachment(client, {
        file_path: pdfPath,
        links: [{ entity_type: "bill", entity_id: "42" }],
        note: "March statement",
        category: "receipt",
        draft: false,
      })
    );

    assert.equal(calls.uploads.length, 1);
    const upload = calls.uploads[0];
    assert.equal(upload.fileName, "statement.pdf");
    assert.equal(upload.contentType, "application/pdf");
    // A Buffer with the file's bytes, not a stream.
    assert.ok(Buffer.isBuffer(upload.data), "upload must receive a Buffer");
    assert.deepEqual(upload.data, PDF_BYTES);
    // The barrier is armed before the upload leaves, not after it returns.
    assert.equal(upload.barrierArmed, true);

    assert.equal(calls.creates.length, 0);
    assert.equal(calls.updates.length, 1);
    const body = calls.updates[0];
    // Id and SyncToken come from the upload response, never a hard-coded "0".
    assert.equal(body.Id, "77");
    assert.equal(body.SyncToken, "0");
    assert.equal(body.FileName, "statement.pdf");
    assert.equal(body.ContentType, "application/pdf");
    assert.equal(body.Note, "March statement");
    // Category is matched case-insensitively and sent in QBO's casing.
    assert.equal(body.Category, "Receipt");
    const refs = wire(body.AttachableRef) as Array<{ EntityRef: { type: string; value: string } }>;
    assert.deepEqual(refs.map(refKey), ["Bill 42"]);
    assertWritableOnly(body);

    assert.match(text(result), /\b77\b/);
    assert.equal(record.writeIssued, true);
  });

  it("upload-commit takes Id and SyncToken from the upload response", async () => {
    const { client, calls } = fakeClient({ uploaded: { ...uploadResponse("78"), SyncToken: "3" } });
    await handleUploadAttachment(client, {
      file_path: pdfPath,
      links: [{ entity_type: "bill", entity_id: "42" }],
      draft: false,
    });
    assert.equal(calls.updates[0].Id, "78");
    assert.equal(calls.updates[0].SyncToken, "3");
  });

  it("upload-refuses-duplicate-name", async () => {
    // A file already on bill 42 whose name differs only in case.
    const existing = {
      "bill:42": [{ Id: "60", SyncToken: "0", FileName: "STATEMENT.PDF", ContentType: "application/pdf" }],
    };
    const args = { file_path: pdfPath, links: [{ entity_type: "bill", entity_id: "42" }] };

    const draft = fakeClient({ existing });
    const out = text(await handleUploadAttachment(draft.client, args));
    assert.match(out, /duplicate/i);
    assert.match(out, /\b60\b/);
    assert.equal(writeCount(draft.calls), 0);

    const refused = fakeClient({ existing });
    await assert.rejects(
      handleUploadAttachment(refused.client, { ...args, draft: false }),
      (err: Error) => {
        assert.match(err.message, /duplicate/i);
        assert.match(err.message, /allow_duplicate/);
        return true;
      }
    );
    assert.equal(refused.calls.uploads.length, 0);

    const allowed = fakeClient({ existing });
    await handleUploadAttachment(allowed.client, { ...args, draft: false, allow_duplicate: true });
    assert.equal(allowed.calls.uploads.length, 1);
  });

  it("upload-refuses-duplicate-name compares only file attachables", async () => {
    // A note whose text happens to equal the file name is not a duplicate file.
    const existing = { "bill:42": [{ Id: "61", SyncToken: "0", Note: "statement.pdf" }] };
    const { client, calls } = fakeClient({ existing });
    await handleUploadAttachment(client, {
      file_path: pdfPath,
      links: [{ entity_type: "bill", entity_id: "42" }],
      draft: false,
    });
    assert.equal(calls.uploads.length, 1);
  });

  it("upload-orphan-error-is-safe", async () => {
    const token = "Bearer eyJexample-secret-access-token";
    const updateError = Object.assign(new Error("Request failed with status code 400"), {
      config: { headers: { Authorization: token }, url: "https://quickbooks.example.test/v3/company/1/attachable" },
      response: {
        status: 400,
        data: {
          Fault: {
            Error: [{ Message: "Invalid Reference Id", Detail: "Invalid Reference Id : Bill 42", code: "2500" }],
            type: "ValidationFault",
          },
        },
      },
    });
    const { client, calls } = fakeClient({ uploaded: uploadResponse("501"), updateError });

    await assert.rejects(
      handleUploadAttachment(client, {
        file_path: pdfPath,
        links: [{ entity_type: "bill", entity_id: "42" }],
        draft: false,
      }),
      (err: Error) => {
        assert.match(err.message, /\b501\b/);
        assert.match(err.message, /edit_attachment/);
        assert.match(err.message, /delete_entity/);
        assert.match(err.message, /attachable/);
        assert.match(err.message, /Invalid Reference Id/);
        assert.ok(!err.message.includes("eyJexample-secret-access-token"), "token leaked into the error");
        assert.doesNotMatch(err.message, /Authorization/i);
        return true;
      }
    );
    assert.equal(calls.uploads.length, 1);
  });

  it("upload-base64-commits-decoded-bytes", async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0x10]);
    const { client, calls } = fakeClient();
    await handleUploadAttachment(client, {
      file_content_base64: bytes.toString("base64"),
      file_name: "statement.pdf",
      links: [{ entity_type: "bill", entity_id: "42" }],
      draft: false,
    });

    assert.equal(calls.uploads.length, 1);
    assert.ok(Buffer.isBuffer(calls.uploads[0].data), "upload must receive a Buffer");
    assert.deepEqual(calls.uploads[0].data, bytes);
    assert.equal(calls.uploads[0].contentType, "application/pdf");
  });

  it("upload-file-path-refused-over-http", async () => {
    setOutputMode("http");
    const { client, calls } = fakeClient();
    // A path that does not exist: the refusal must come before any file access.
    await assert.rejects(
      handleUploadAttachment(client, {
        file_path: join(dir, "missing.pdf"),
        links: [{ entity_type: "bill", entity_id: "42" }],
        draft: false,
      }),
      (err: Error) => {
        assert.match(err.message, /file_content_base64/);
        assert.match(err.message, /file_name/);
        return true;
      }
    );
    assert.equal(writeCount(calls), 0);
  });

  it("upload-base64-needs-file-name", async () => {
    const { client, calls } = fakeClient();
    await assert.rejects(
      handleUploadAttachment(client, {
        file_content_base64: Buffer.from("hello").toString("base64"),
        links: [{ entity_type: "bill", entity_id: "42" }],
        draft: false,
      }),
      /file_name.*required|required.*file_name/i
    );
    assert.equal(writeCount(calls), 0);
  });

  it("upload-unknown-extension-needs-content-type", async () => {
    const { client, calls } = fakeClient();
    await assert.rejects(
      handleUploadAttachment(client, {
        file_path: binPath,
        links: [{ entity_type: "bill", entity_id: "42" }],
      }),
      (err: Error) => {
        for (const ext of [".ai", ".csv", ".docx", ".pdf", ".png", ".tiff", ".xlsx", ".xml"]) {
          assert.ok(err.message.includes(ext), `accepted extension ${ext} not listed`);
        }
        assert.match(err.message, /content_type/);
        return true;
      }
    );

    const out = text(
      await handleUploadAttachment(client, {
        file_path: binPath,
        content_type: "application/octet-stream",
        links: [{ entity_type: "bill", entity_id: "42" }],
      })
    );
    assert.match(out, /data\.bin/);
    assert.match(out, /application\/octet-stream/);
    assert.equal(writeCount(calls), 0);
  });

  it("upload uses content_type over the extension table when given", async () => {
    const { client, calls } = fakeClient();
    await handleUploadAttachment(client, {
      file_path: pdfPath,
      content_type: "application/x-example",
      links: [{ entity_type: "bill", entity_id: "42" }],
      draft: false,
    });
    assert.equal(calls.uploads[0].contentType, "application/x-example");
  });

  it("upload rejects a file over 100 MB before uploading", async () => {
    const big = join(dir, "big.pdf");
    writeFileSync(big, "");
    truncateSync(big, 100 * 1024 * 1024 + 1); // sparse: no 100 MB written
    try {
      const { client, calls } = fakeClient();
      await assert.rejects(
        handleUploadAttachment(client, {
          file_path: big,
          links: [{ entity_type: "bill", entity_id: "42" }],
          draft: false,
        }),
        /100 MB/
      );
      assert.equal(writeCount(calls), 0);
    } finally {
      rmSync(big, { force: true });
    }
  });

  it("upload rejects an unknown category, naming the accepted values", async () => {
    const { client, calls } = fakeClient();
    await assert.rejects(
      handleUploadAttachment(client, {
        file_path: pdfPath,
        category: "invoice scan",
        links: [{ entity_type: "bill", entity_id: "42" }],
        draft: false,
      }),
      (err: Error) => {
        for (const c of ["Contact Photo", "Document", "Image", "Receipt", "Signature", "Sound", "Other"]) {
          assert.ok(err.message.includes(c), `category ${c} not listed`);
        }
        return true;
      }
    );
    assert.equal(writeCount(calls), 0);
  });

  it("upload with no links creates an unlinked attachment", async () => {
    const { client, calls } = fakeClient({ uploaded: uploadResponse("79") });
    const out = text(await handleUploadAttachment(client, { file_path: pdfPath, draft: false }));

    assert.equal(calls.uploads.length, 1);
    for (const body of calls.updates) {
      assert.equal(body.Id, "79");
      assert.deepEqual(wire(body.AttachableRef ?? []), []);
      assertWritableOnly(body);
    }
    assert.match(out, /\b79\b/);
  });
});

// ---------------------------------------------------------------------------
// create_attachment_note
// ---------------------------------------------------------------------------

describe("create_attachment_note", () => {
  it("note-commit-creates-linked-note", async () => {
    const args = {
      note: "Called the supplier",
      links: [{ entity_type: "invoice", entity_id: "7" }],
    };

    const draft = fakeClient();
    const { result: preview, record: draftRecord } = await tracked(() =>
      handleCreateAttachmentNote(draft.client, args)
    );
    assert.equal(writeCount(draft.calls), 0);
    assert.equal(draftRecord.writeIssued, false);
    const out = text(preview);
    assert.match(out, /Called the supplier/);
    assert.match(out, /Invoice 7/);
    assert.match(out, /1002/);
    assert.match(out, /North Customer/);
    assert.match(out, /2026-03-02/);

    const commit = fakeClient();
    const { result, record } = await tracked(() =>
      handleCreateAttachmentNote(commit.client, { ...args, category: "other", draft: false })
    );
    assert.equal(commit.calls.creates.length, 1);
    assert.equal(commit.calls.uploads.length, 0);
    assert.equal(commit.calls.updates.length, 0);
    const body = commit.calls.creates[0];
    assert.equal(body.Note, "Called the supplier");
    assert.equal(body.Category, "Other");
    const refs = wire(body.AttachableRef) as Array<{ EntityRef: { type: string; value: string } }>;
    assert.deepEqual(refs.map(refKey), ["Invoice 7"]);
    assert.equal(record.writeIssued, true);
    assert.match(text(result), /\b88\b/);
  });

  it("note-requires-a-link", async () => {
    const { client, calls } = fakeClient();
    await assert.rejects(
      handleCreateAttachmentNote(client, { note: "Called the supplier", links: [], draft: false }),
      /at least one link/i
    );
    assert.equal(calls.creates.length, 0);
  });
});

// ---------------------------------------------------------------------------
// edit_attachment
// ---------------------------------------------------------------------------

// A read carrying every writable field plus the read-only ones QBO returns.
const FULL_READ = {
  Id: "11",
  SyncToken: "4",
  FileName: "statement.pdf",
  Note: "March statement",
  Category: "Receipt",
  ContentType: "application/pdf",
  Tag: "march",
  Lat: "40.0",
  Long: "-75.0",
  PlaceName: "North office",
  AttachableRef: [{ EntityRef: { type: "Bill", value: "42" }, IncludeOnSend: false }],
  Size: 2048,
  TempDownloadUri: "https://files.example.test/tmp/11?sig=abc",
  FileAccessUri: "/v3/company/1/download/11",
  ThumbnailTempDownloadUri: "https://files.example.test/tmp/11-thumb?sig=abc",
  MetaData: { CreateTime: "2026-03-03T10:00:00-08:00", LastUpdatedTime: "2026-03-03T10:00:00-08:00" },
  AttachableEx: {
    any: [
      {
        name: "{http://schema.intuit.com/finance/v3}NameValue",
        declaredType: "com.intuit.schema.finance.v3.NameValue",
        scope: "javax.xml.bind.JAXBElement$GlobalScope",
        value: { Name: "Example", Value: "1" },
        nil: false,
        globalScope: true,
        typeSubstituted: false,
      },
    ],
  },
  domain: "QBO",
  sparse: false,
};

describe("edit_attachment", () => {
  it("edit-body-writable-fields-only", async () => {
    const { client, calls } = fakeClient({ attachable: FULL_READ });
    const { record } = await tracked(() =>
      handleEditAttachment(client, { id: "11", note: "Revised note", draft: false })
    );

    assert.equal(calls.updates.length, 1);
    const body = wire(calls.updates[0]);
    assert.deepEqual(Object.keys(body).sort(), [...WRITABLE].sort());
    assert.deepEqual(body, {
      Id: "11",
      SyncToken: "4",
      FileName: "statement.pdf",
      Note: "Revised note",
      Category: "Receipt",
      ContentType: "application/pdf",
      Tag: "march",
      Lat: "40.0",
      Long: "-75.0",
      PlaceName: "North office",
      AttachableRef: [{ EntityRef: { type: "Bill", value: "42" }, IncludeOnSend: false }],
    });
    assert.doesNotMatch(JSON.stringify(calls.updates[0]), /AttachableEx|javax\.xml\.bind|TempDownloadUri/);
    assert.equal(record.writeIssued, true);
  });

  it("edit-merges-links", async () => {
    const attachable = {
      Id: "11",
      SyncToken: "4",
      FileName: "statement.pdf",
      ContentType: "application/pdf",
      AttachableRef: [
        { EntityRef: { type: "Bill", value: "42" }, IncludeOnSend: false, LineInfo: "1" },
        { EntityRef: { type: "Invoice", value: "7" } },
      ],
    };
    const { client, calls } = fakeClient({ attachable });
    await handleEditAttachment(client, {
      id: "11",
      add_links: [{ entity_type: "customer", entity_id: "3" }],
      remove_links: [{ entity_type: "invoice", entity_id: "7" }],
      set_include_on_send: [{ entity_type: "bill", entity_id: "42", include_on_send: true }],
      draft: false,
    });

    assert.equal(calls.updates.length, 1);
    const refs = wire(calls.updates[0].AttachableRef) as Array<{
      EntityRef: { type: string; value: string };
      IncludeOnSend?: boolean;
      LineInfo?: string;
    }>;
    assert.deepEqual(refs.map(refKey), ["Bill 42", "Customer 3"]);
    assert.equal(refs[0].IncludeOnSend, true);
    assert.equal(refs[0].LineInfo, "1");
    assertWritableOnly(calls.updates[0]);
  });

  it("edit-refuses-zero-links", async () => {
    const { client, calls } = fakeClient({ attachable: FULL_READ });
    await assert.rejects(
      handleEditAttachment(client, {
        id: "11",
        remove_links: [{ entity_type: "bill", entity_id: "42" }],
        draft: false,
      }),
      (err: Error) => {
        assert.match(err.message, /delete_entity/);
        assert.match(err.message, /attachable/);
        return true;
      }
    );
    assert.equal(calls.updates.length, 0);
  });

  it("edit-refuses-missing-link-removal", async () => {
    const { client, calls } = fakeClient({ attachable: FULL_READ });
    await assert.rejects(
      handleEditAttachment(client, {
        id: "11",
        remove_links: [{ entity_type: "invoice", entity_id: "7" }],
        draft: false,
      }),
      /not linked to invoice 7/i
    );
    assert.equal(calls.updates.length, 0);
  });

  it("edit-draft-shows-before-after", async () => {
    const { client, calls } = fakeClient({ attachable: FULL_READ });
    const { result, record } = await tracked(() =>
      handleEditAttachment(client, { id: "11", note: "Revised note" })
    );
    const out = text(result);

    assert.match(out, /current/i);
    assert.match(out, /after/i);
    assert.match(out, /March statement/);
    assert.match(out, /Revised note/);
    // The current note is shown before the proposed one.
    assert.ok(out.indexOf("March statement") < out.indexOf("Revised note"));
    assert.equal(writeCount(calls), 0);
    assert.equal(record.writeIssued, false);
  });

  it("edit refuses file_name on a note-only attachable", async () => {
    const note = {
      Id: "12",
      SyncToken: "1",
      Note: "Called the supplier",
      AttachableRef: [{ EntityRef: { type: "Bill", value: "42" } }],
    };
    const { client, calls } = fakeClient({ attachable: note });
    await assert.rejects(
      handleEditAttachment(client, { id: "12", file_name: "renamed.pdf" }),
      /note/i
    );
    await assert.rejects(
      handleEditAttachment(client, { id: "12", file_name: "renamed.pdf", draft: false }),
      /note/i
    );
    assert.equal(calls.updates.length, 0);
  });

  it("edit accepts category case-insensitively and sends QBO's casing", async () => {
    const { client, calls } = fakeClient({ attachable: FULL_READ });
    await handleEditAttachment(client, { id: "11", category: "contact photo", draft: false });
    assert.equal(calls.updates[0].Category, "Contact Photo");
  });
});
