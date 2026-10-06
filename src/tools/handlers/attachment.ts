// Handlers for attachment tools (QBO Attachable entity)
//
// An Attachable is either an uploaded file or a text-only note. It links to
// zero or more entities (transactions, names, items) through AttachableRef.
// This file holds the link-type table, the lookup and description helpers
// shared by every attachment tool, and the read and write handlers.

import QuickBooks from "node-quickbooks";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, extname, join } from "path";
import { tmpdir } from "os";
import { promisify, promisifyWrite } from "../../client/index.js";
import {
  formatQboError,
  getQboUrl,
  isHttpMode,
  mapWithConcurrency,
  outputReport,
} from "../../utils/index.js";

// ---------------------------------------------------------------------------
// Entity types an attachment can link to
// ---------------------------------------------------------------------------

interface LinkTypeConfig {
  qboType: string; // EntityRef.type as QBO names it
  label: string;
}

const LINK_TYPES: Record<string, LinkTypeConfig> = {
  bill: { qboType: "Bill", label: "Bill" },
  invoice: { qboType: "Invoice", label: "Invoice" },
  expense: { qboType: "Purchase", label: "Expense" },
  journal_entry: { qboType: "JournalEntry", label: "Journal Entry" },
  deposit: { qboType: "Deposit", label: "Deposit" },
  vendor_credit: { qboType: "VendorCredit", label: "Vendor Credit" },
  sales_receipt: { qboType: "SalesReceipt", label: "Sales Receipt" },
  bill_payment: { qboType: "BillPayment", label: "Bill Payment" },
  estimate: { qboType: "Estimate", label: "Estimate" },
  credit_memo: { qboType: "CreditMemo", label: "Credit Memo" },
  payment: { qboType: "Payment", label: "Payment" },
  refund_receipt: { qboType: "RefundReceipt", label: "Refund Receipt" },
  purchase_order: { qboType: "PurchaseOrder", label: "Purchase Order" },
  transfer: { qboType: "Transfer", label: "Transfer" },
  vendor: { qboType: "Vendor", label: "Vendor" },
  customer: { qboType: "Customer", label: "Customer" },
  employee: { qboType: "Employee", label: "Employee" },
  item: { qboType: "Item", label: "Item" },
};

export const ATTACHMENT_LINK_TYPES = Object.keys(LINK_TYPES);

const BY_QBO_TYPE = new Map(
  Object.values(LINK_TYPES).map((c) => [c.qboType.toLowerCase(), c])
);

// Accepts the tool's snake_case name ("expense") or the QBO type, in any case ("Purchase")
export function resolveLinkType(entityType: string): LinkTypeConfig {
  const config = LINK_TYPES[entityType] || BY_QBO_TYPE.get(entityType.toLowerCase());
  if (!config) {
    throw new Error(
      `Invalid entity_type "${entityType}". Must be one of: ${ATTACHMENT_LINK_TYPES.join(", ")}`
    );
  }
  return config;
}

function labelForQboType(qboType: string): string {
  return BY_QBO_TYPE.get(qboType.toLowerCase())?.label || qboType;
}

// ---------------------------------------------------------------------------
// Types and description helpers (shared by every attachment tool)
// ---------------------------------------------------------------------------

export interface AttachableRef {
  EntityRef: { type: string; value: string; name?: string };
  IncludeOnSend?: boolean;
  LineInfo?: string;
}

export interface Attachable {
  Id: string;
  SyncToken: string;
  FileName?: string;
  Note?: string;
  Category?: string;
  ContentType?: string;
  Size?: number;
  Tag?: string;
  Lat?: string;
  Long?: string;
  PlaceName?: string;
  FileAccessUri?: string;
  TempDownloadUri?: string;
  ThumbnailTempDownloadUri?: string;
  AttachableRef?: AttachableRef[];
}

type ToolResult = { content: Array<{ type: string; text: string }> };

export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "(unknown size)";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// FileName is caller-supplied text; only its base name is ever shown or used as a path.
function safeFileName(a: Attachable): string | undefined {
  return a.FileName ? basename(a.FileName.replace(/\\/g, "/")) : undefined;
}

export function describeFile(a: Attachable): string {
  const name = safeFileName(a);
  return name ? `${name} (${a.ContentType || "unknown type"}, ${formatSize(a.Size)})` : "Note";
}

export function describeRef(ref: AttachableRef): string {
  const { type, value, name } = ref.EntityRef;
  const nameStr = name ? ` — ${name}` : "";
  const sendStr = ref.IncludeOnSend ? " (included on send)" : "";
  return `${labelForQboType(type)} ${value}${nameStr}${sendStr}`;
}

export function describeAttachable(a: Attachable): string {
  const noteStr = a.Note ? ` — "${a.Note}"` : "";
  return `Attachment ${a.Id}: ${describeFile(a)}${noteStr}`;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * List the attachables linked to an entity, using the documented query form
 * (lowercase type, `.value`). Exported so get_* tools can show attachments next
 * to the entity they describe.
 */
export async function fetchAttachments(
  client: QuickBooks,
  qboType: string,
  entityId: string
): Promise<Attachable[]> {
  // The id is interpolated into the query, so only a plain integer may pass.
  if (!/^\d+$/.test(entityId)) throw new Error(`Invalid entity id "${entityId}"`);
  const criteria =
    `where AttachableRef.EntityRef.Type = '${qboType.toLowerCase()}' ` +
    `and AttachableRef.EntityRef.value = '${entityId}' MAXRESULTS 1000`;
  const result = (await promisify<unknown>((cb) => client.findAttachables(criteria, cb))) as {
    QueryResponse?: { Attachable?: Attachable[] };
  };
  return result.QueryResponse?.Attachable || [];
}

/**
 * The "Attachments" section the get_* tools show before their View in QuickBooks
 * line. Never throws or rejects: the section is context, so a failed lookup
 * (including a client with no query method) renders a placeholder instead of
 * breaking the read.
 */
export async function formatAttachmentLines(
  client: QuickBooks,
  qboType: string,
  entityId: string
): Promise<string[]> {
  try {
    const attachments = await fetchAttachments(client, qboType, String(entityId));
    if (attachments.length === 0) return ["Attachments: (none)"];
    return ["Attachments:", ...attachments.map((a) => `  ${describeAttachable(a)}`)];
  } catch {
    return ["Attachments: (could not be loaded)"];
  }
}

// ---------------------------------------------------------------------------
// list_attachments
// ---------------------------------------------------------------------------

export async function handleListAttachments(
  client: QuickBooks,
  args: { entity_type: string; entity_id: string }
): Promise<ToolResult> {
  const config = resolveLinkType(args.entity_type);
  const entityId = String(args.entity_id).trim();
  const attachments = await fetchAttachments(client, config.qboType, entityId);

  const header = `${config.label} ${entityId}: ${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`;
  const summary = [header, ...attachments.map((a) => `  ${describeAttachable(a)}`)].join("\n");
  return outputReport("attachments", attachments, summary);
}

// ---------------------------------------------------------------------------
// get_attachment
// ---------------------------------------------------------------------------

export async function handleGetAttachment(
  client: QuickBooks,
  args: { id: string; download?: boolean; save_to?: string }
): Promise<ToolResult> {
  const { id, save_to } = args;
  const wantsDownload = args.download === true || save_to !== undefined;

  const attachable = (await promisify<unknown>((cb) => client.getAttachable(id, cb))) as Attachable;
  const fileName = safeFileName(attachable);

  if (wantsDownload && (!fileName || !attachable.TempDownloadUri)) {
    throw new Error(`Attachment ${attachable.Id} has no file to download (it is a note).`);
  }

  const lines = [
    `Attachment ${attachable.Id}`,
    `SyncToken: ${attachable.SyncToken}`,
    `File: ${describeFile(attachable)}`,
    `Note: ${attachable.Note || "(none)"}`,
    `Category: ${attachable.Category || "(none)"}`,
  ];
  if (attachable.Tag) lines.push(`Tag: ${attachable.Tag}`);
  lines.push("Linked to:");
  const refs = attachable.AttachableRef || [];
  if (refs.length === 0) lines.push("  (nothing — unlinked attachment)");
  for (const ref of refs) {
    // getQboUrl returns null for unmapped types; no link is printed rather than a guessed one
    const url = getQboUrl(ref.EntityRef.type, ref.EntityRef.value);
    lines.push(`  ${describeRef(ref)}${url ? ` ${url}` : ""}`);
  }

  if (wantsDownload && !isHttpMode()) {
    const target = save_to ?? join(mkdtempSync(join(tmpdir(), "qbo-attachment-")), fileName!);
    const response = await fetch(attachable.TempDownloadUri!);
    if (!response.ok) {
      throw new Error(`Download failed with HTTP ${response.status}`);
    }
    writeFileSync(target, Buffer.from(await response.arrayBuffer()));
    lines.push("", `Downloaded to: ${target}`);
  } else if (attachable.TempDownloadUri) {
    if (wantsDownload) {
      lines.push("", "Downloading is unavailable over HTTP — fetch the temporary URL below instead.");
    }
    lines.push(
      "",
      `Download URL (temporary, valid about 15 minutes): ${attachable.TempDownloadUri}`
    );
  }

  return outputReport("attachment", attachable, lines.join("\n"));
}

// ===========================================================================
// Write tools: upload_attachment, create_attachment_note, edit_attachment
// ===========================================================================

// ---------------------------------------------------------------------------
// Input tables
// ---------------------------------------------------------------------------

// Category values QBO accepts on an Attachable, in QBO's casing
const CATEGORIES = ["Contact Photo", "Document", "Image", "Receipt", "Signature", "Sound", "Other"];

// Matches case-insensitively and returns QBO's exact casing
function resolveCategory(category: string | undefined): string | undefined {
  if (category === undefined) return undefined;
  const match = CATEGORIES.find((c) => c.toLowerCase() === category.trim().toLowerCase());
  if (!match) {
    throw new Error(`Invalid category "${category}". Must be one of: ${CATEGORIES.join(", ")}`);
  }
  return match;
}

// File types QBO accepts for upload, with the MIME type sent for each
const CONTENT_TYPES: Record<string, string> = {
  ".ai": "application/postscript",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".eps": "application/postscript",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".rtf": "application/rtf",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".txt": "text/plain",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "text/xml",
};

// QBO rejects files over 100 MB; checked locally so nothing that large is read or sent
const MAX_FILE_BYTES = 100 * 1024 * 1024;

// Link-target reads fanned out at once; QBO throttles per realm
const TARGET_READ_CONCURRENCY = 4;

export interface LinkInput {
  entity_type: string;
  entity_id: string;
  include_on_send?: boolean;
}

// ---------------------------------------------------------------------------
// The writable-field builder
// ---------------------------------------------------------------------------

// The fields QBO lets a caller write on an Attachable, besides Id and SyncToken.
type WritableAttachable = Pick<
  Attachable,
  "FileName" | "Note" | "Category" | "ContentType" | "Tag" | "Lat" | "Long" | "PlaceName" | "AttachableRef"
>;

function writableRef(ref: AttachableRef): AttachableRef {
  return {
    EntityRef: { type: ref.EntityRef.type, value: ref.EntityRef.value },
    IncludeOnSend: ref.IncludeOnSend,
    LineInfo: ref.LineInfo,
  };
}

/**
 * Picks the writable fields, one by one. Every Attachable body this file sends
 * is built here, so a read-only field (Size, TempDownloadUri, MetaData, an
 * extension block…) can never be echoed back — QBO rejects those.
 */
function writableFields(a: WritableAttachable): WritableAttachable {
  return {
    FileName: a.FileName,
    Note: a.Note,
    Category: a.Category,
    ContentType: a.ContentType,
    Tag: a.Tag,
    Lat: a.Lat,
    Long: a.Long,
    PlaceName: a.PlaceName,
    AttachableRef: a.AttachableRef?.map(writableRef),
  };
}

/**
 * The body of an Attachable update. QBO treats it as a full update that nulls
 * any writable field left out, so every current writable value is carried over
 * and `changes` is applied on top.
 */
function buildUpdateBody(current: Attachable, changes: WritableAttachable): Record<string, unknown> {
  return {
    Id: current.Id,
    SyncToken: current.SyncToken,
    ...writableFields({ ...writableFields(current), ...changes }),
  };
}

// ---------------------------------------------------------------------------
// Link targets
// ---------------------------------------------------------------------------

type EntityGetter = (id: string, cb: (err: Error | null, result: unknown) => void) => void;

const refKey = (type: string, value: string) => `${type.toLowerCase()}:${value}`;

interface LinkTarget {
  ref: AttachableRef;
  display: string;
}

/**
 * Reads the entity a link points at, which confirms it exists, and describes it
 * by type label, id, and doc number, party and date where the record has them.
 */
async function readLinkTarget(client: QuickBooks, config: LinkTypeConfig, id: string): Promise<string> {
  if (!/^\d+$/.test(id)) throw new Error(`Invalid entity id "${id}"`);
  // node-quickbooks names each read get<QBO type>; not all are in its typings.
  const getter = (client as unknown as Record<string, EntityGetter>)[`get${config.qboType}`];
  const entity = (await promisify<unknown>((cb) => getter.call(client, id, cb))) as Record<string, unknown>;

  const partyRef = (entity.VendorRef || entity.CustomerRef || entity.EntityRef) as { name?: string } | undefined;
  const party = partyRef?.name || entity.DisplayName || entity.Name;
  const parts = [`${config.label} ${id}`];
  if (entity.DocNumber) parts.push(`#${entity.DocNumber}`);
  if (party) parts.push(String(party));
  if (entity.TxnDate) parts.push(String(entity.TxnDate));
  return parts.join(" — ");
}

// Validates the caller's links and turns them into AttachableRefs with descriptions
async function resolveLinks(client: QuickBooks, links: LinkInput[]): Promise<LinkTarget[]> {
  return mapWithConcurrency(links, TARGET_READ_CONCURRENCY, async (link) => {
    const config = resolveLinkType(link.entity_type);
    const id = String(link.entity_id).trim();
    const display = await readLinkTarget(client, config, id);
    const ref: AttachableRef = {
      EntityRef: { type: config.qboType, value: id },
      ...(link.include_on_send !== undefined && { IncludeOnSend: link.include_on_send }),
    };
    return { ref, display };
  });
}

// Describes refs already on an attachable; a type this tool has no reader for keeps its plain label
async function describeExistingRefs(client: QuickBooks, refs: AttachableRef[]): Promise<Map<string, string>> {
  const described = await mapWithConcurrency(refs, TARGET_READ_CONCURRENCY, async (ref) => {
    const config = BY_QBO_TYPE.get(ref.EntityRef.type.toLowerCase());
    const display = config ? await readLinkTarget(client, config, ref.EntityRef.value) : describeRef(ref);
    return [refKey(ref.EntityRef.type, ref.EntityRef.value), display] as const;
  });
  return new Map(described);
}

function targetLines(refs: AttachableRef[], displays: Map<string, string>, indent = "  "): string[] {
  if (refs.length === 0) return [`${indent}(nothing — unlinked attachment)`];
  return refs.map((ref) => {
    const display = displays.get(refKey(ref.EntityRef.type, ref.EntityRef.value)) ?? describeRef(ref);
    return `${indent}${display}${ref.IncludeOnSend ? " (included on send)" : ""}`;
  });
}

// Fields and links of an attachable, as shown in drafts and results
function attachableLines(a: Attachable, displays: Map<string, string>, indent = ""): string[] {
  const lines = [
    `File: ${describeFile(a)}`,
    `Note: ${a.Note || "(none)"}`,
    `Category: ${a.Category || "(none)"}`,
  ];
  if (a.Tag) lines.push(`Tag: ${a.Tag}`);
  lines.push("Linked to:");
  return [...lines, ...targetLines(a.AttachableRef || [], displays, "  ")].map((l) => `${indent}${l}`);
}

const displaysOf = (targets: LinkTarget[]) =>
  new Map(targets.map((t) => [refKey(t.ref.EntityRef.type, t.ref.EntityRef.value), t.display]));

// ---------------------------------------------------------------------------
// File input
// ---------------------------------------------------------------------------

interface FileInput {
  file_path?: string;
  file_content_base64?: string;
  file_name?: string;
  content_type?: string;
}

interface LoadedFile {
  fileName: string;
  contentType: string;
  data: Buffer;
}

const tooLarge = (bytes: number) =>
  new Error(`File is ${formatSize(bytes)}; QuickBooks accepts at most 100 MB.`);

// A file name is sent to QBO and shown back, so only its base name is kept
const baseFileName = (name: string) => basename(name.replace(/\\/g, "/"));

/**
 * Loads the file to upload as a Buffer (not a stream, so the multipart body has
 * a known length). A local path is read only in stdio mode — over HTTP the path
 * would name a file on the server, not the caller's machine.
 */
function loadFile(args: FileInput): LoadedFile {
  const { file_path, file_content_base64, file_name, content_type } = args;
  if (file_path && file_content_base64) {
    throw new Error("Provide either file_path or file_content_base64, not both.");
  }

  let data: Buffer;
  let fileName: string;
  if (file_path) {
    if (isHttpMode()) {
      throw new Error(
        "file_path is not available over HTTP — send the file as file_content_base64 together with file_name."
      );
    }
    const stat = statSync(file_path);
    if (!stat.isFile()) throw new Error(`Not a file: ${file_path}`);
    if (stat.size > MAX_FILE_BYTES) throw tooLarge(stat.size);
    fileName = baseFileName(file_name || file_path);
    data = readFileSync(file_path);
  } else if (file_content_base64) {
    if (!file_name) throw new Error("file_name is required with file_content_base64.");
    fileName = baseFileName(file_name);
    data = Buffer.from(file_content_base64, "base64");
    if (data.length > MAX_FILE_BYTES) throw tooLarge(data.length);
  } else {
    throw new Error("Either file_path or file_content_base64 is required.");
  }
  if (data.length === 0) throw new Error("File is empty.");

  const contentType = content_type || CONTENT_TYPES[extname(fileName).toLowerCase()];
  if (!contentType) {
    throw new Error(
      `Cannot infer a content type for "${fileName}". QuickBooks accepts: ` +
        `${Object.keys(CONTENT_TYPES).join(", ")} — or pass content_type explicitly.`
    );
  }
  return { fileName, contentType, data };
}

// ---------------------------------------------------------------------------
// upload_attachment
// ---------------------------------------------------------------------------

export async function handleUploadAttachment(
  client: QuickBooks,
  args: FileInput & {
    links?: LinkInput[];
    note?: string;
    category?: string;
    allow_duplicate?: boolean;
    draft?: boolean;
  }
): Promise<ToolResult> {
  const { links = [], note, allow_duplicate = false, draft = true } = args;
  const category = resolveCategory(args.category);
  const file = loadFile(args);
  const targets = await resolveLinks(client, links);

  // A same-named file already on a target is usually a re-run, not a new document.
  const existing = await mapWithConcurrency(targets, TARGET_READ_CONCURRENCY, (t) =>
    fetchAttachments(client, t.ref.EntityRef.type, t.ref.EntityRef.value)
  );
  const duplicates = targets.flatMap((t, i) =>
    existing[i]
      .filter((a) => a.FileName && safeFileName(a)!.toLowerCase() === file.fileName.toLowerCase())
      .map((a) => `${t.display} already has ${describeAttachable(a)}`)
  );

  const preview: Attachable = {
    Id: "(new)",
    SyncToken: "0",
    FileName: file.fileName,
    ContentType: file.contentType,
    Size: file.data.length,
    Note: note,
    Category: category,
    AttachableRef: targets.map((t) => t.ref),
  };

  if (draft) {
    const lines = ["DRAFT - Upload Attachment Preview", "", ...attachableLines(preview, displaysOf(targets))];
    if (duplicates.length > 0) {
      lines.push(
        "",
        "*** POSSIBLE DUPLICATE:",
        ...duplicates.map((d) => `  ${d}`),
        allow_duplicate
          ? "  allow_duplicate=true — will upload anyway."
          : "  Committing will fail unless allow_duplicate=true."
      );
    }
    lines.push("", "Set draft=false to upload this attachment.");
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (duplicates.length > 0 && !allow_duplicate) {
    throw new Error(
      `Possible duplicate attachment:\n${duplicates.join("\n")}\nSet allow_duplicate=true to upload anyway.`
    );
  }

  // Step 1: upload. With four arguments node-quickbooks returns the new, unlinked Attachable.
  const uploaded = await promisifyWrite<Attachable>((cb) =>
    client.upload(file.fileName, file.contentType, file.data, cb as (err: unknown, result: unknown) => void)
  );

  // Step 2: links and metadata, as a separate update so a failure here can name the id it orphaned.
  let attachable = uploaded;
  if (targets.length > 0 || note !== undefined || category !== undefined) {
    const body = buildUpdateBody(uploaded, {
      FileName: uploaded.FileName ?? file.fileName,
      ContentType: uploaded.ContentType ?? file.contentType,
      Note: note,
      Category: category,
      AttachableRef: targets.map((t) => t.ref),
    });
    try {
      attachable = await promisifyWrite<Attachable>((cb) =>
        client.updateAttachable(body, cb as (err: unknown, result: unknown) => void)
      );
    } catch (error) {
      throw new Error(
        `The file was uploaded as attachment ${uploaded.Id}, but linking it failed: ${formatQboError(error)}\n` +
          `Attachment ${uploaded.Id} now exists unlinked. Repair it with edit_attachment (id ${uploaded.Id}), ` +
          `or remove it with delete_entity (entity_type attachable, id ${uploaded.Id}).`
      );
    }
  }

  const lines = [
    `Attachment ${attachable.Id} uploaded.`,
    "",
    `SyncToken: ${attachable.SyncToken}`,
    ...attachableLines(attachable, displaysOf(targets)),
  ];
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ---------------------------------------------------------------------------
// create_attachment_note
// ---------------------------------------------------------------------------

export async function handleCreateAttachmentNote(
  client: QuickBooks,
  args: { note: string; links: LinkInput[]; category?: string; draft?: boolean }
): Promise<ToolResult> {
  const { note, links = [], draft = true } = args;
  const category = resolveCategory(args.category);
  if (!note || !note.trim()) throw new Error("note is required.");
  if (links.length === 0) {
    throw new Error("At least one link is required — a note must be attached to something.");
  }
  const targets = await resolveLinks(client, links);
  const fields = writableFields({ Note: note, Category: category, AttachableRef: targets.map((t) => t.ref) });

  if (draft) {
    const lines = [
      "DRAFT - Attachment Note Preview",
      "",
      ...attachableLines({ Id: "(new)", SyncToken: "0", ...fields }, displaysOf(targets)),
      "",
      "Set draft=false to create this note.",
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  const created = await promisifyWrite<Attachable>((cb) =>
    client.createAttachable(fields, cb as (err: unknown, result: unknown) => void)
  );
  const lines = [
    `Attachment ${created.Id} created (note).`,
    "",
    `SyncToken: ${created.SyncToken}`,
    ...attachableLines(created, displaysOf(targets)),
  ];
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ---------------------------------------------------------------------------
// edit_attachment
// ---------------------------------------------------------------------------

export async function handleEditAttachment(
  client: QuickBooks,
  args: {
    id: string;
    note?: string;
    category?: string;
    file_name?: string;
    add_links?: LinkInput[];
    remove_links?: Array<{ entity_type: string; entity_id: string }>;
    set_include_on_send?: LinkInput[];
    draft?: boolean;
  }
): Promise<ToolResult> {
  const { id, note, add_links = [], remove_links = [], set_include_on_send = [], draft = true } = args;
  const category = resolveCategory(args.category);
  const fileName = args.file_name === undefined ? undefined : baseFileName(args.file_name);

  const current = (await promisify<unknown>((cb) => client.getAttachable(id, cb))) as Attachable;
  if (fileName !== undefined && !current.FileName) {
    throw new Error(`Attachment ${current.Id} is a note — it has no file name to change.`);
  }

  const isRef = (ref: AttachableRef, qboType: string, value: string) =>
    refKey(ref.EntityRef.type, ref.EntityRef.value) === refKey(qboType, String(value).trim());
  const notLinked = (link: { entity_type: string; entity_id: string }) =>
    new Error(`Attachment ${current.Id} is not linked to ${link.entity_type} ${link.entity_id}.`);

  // Links: removals, then additions, then IncludeOnSend changes (which may name a new link)
  let refs = (current.AttachableRef || []).map(writableRef);
  for (const link of remove_links) {
    const { qboType } = resolveLinkType(link.entity_type);
    if (!refs.some((r) => isRef(r, qboType, link.entity_id))) throw notLinked(link);
    refs = refs.filter((r) => !isRef(r, qboType, link.entity_id));
  }
  const added = await resolveLinks(client, add_links);
  for (const t of added) {
    if (refs.some((r) => isRef(r, t.ref.EntityRef.type, t.ref.EntityRef.value))) {
      throw new Error(`Attachment ${current.Id} is already linked to ${t.display}.`);
    }
    refs.push(t.ref);
  }
  for (const link of set_include_on_send) {
    const { qboType } = resolveLinkType(link.entity_type);
    const ref = refs.find((r) => isRef(r, qboType, link.entity_id));
    if (!ref) throw notLinked(link);
    ref.IncludeOnSend = link.include_on_send ?? true;
  }

  const linksChanged = remove_links.length + add_links.length + set_include_on_send.length > 0;
  if (!linksChanged && note === undefined && category === undefined && fileName === undefined) {
    throw new Error(
      "Nothing to change — provide note, category, file_name, add_links, remove_links or set_include_on_send."
    );
  }
  if (refs.length === 0) {
    throw new Error(
      `This edit would leave attachment ${current.Id} linked to nothing. Add a link with add_links, ` +
        `or remove the attachment with delete_entity (entity_type attachable, id ${current.Id}).`
    );
  }

  const changes: WritableAttachable = {
    ...(note !== undefined && { Note: note }),
    ...(category !== undefined && { Category: category }),
    ...(fileName !== undefined && { FileName: fileName }),
    AttachableRef: refs,
  };
  const body = buildUpdateBody(current, changes);

  if (draft) {
    const after: Attachable = { Id: current.Id, SyncToken: current.SyncToken, Size: current.Size, ...body };
    const displays = await describeExistingRefs(client, current.AttachableRef || []);
    for (const [key, display] of displaysOf(added)) displays.set(key, display);
    const lines = [
      `DRAFT - Edit Attachment ${current.Id} Preview`,
      "",
      "Current:",
      ...attachableLines(current, displays, "  "),
      "",
      "After edit:",
      ...attachableLines(after, displays, "  "),
      "",
      "Set draft=false to apply these changes.",
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  const updated = await promisifyWrite<Attachable>((cb) =>
    client.updateAttachable(body, cb as (err: unknown, result: unknown) => void)
  );
  const lines = [
    `Attachment ${updated.Id} updated (SyncToken ${current.SyncToken} → ${updated.SyncToken}).`,
    "",
    ...attachableLines(updated, displaysOf(added)),
  ];
  return { content: [{ type: "text", text: lines.join("\n") }] };
}
