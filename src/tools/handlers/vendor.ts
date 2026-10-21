// Handlers for vendor tools (create, edit). Reads go through the `query` tool.
//
// QBO display names are one namespace across Vendor, Customer and Employee, so
// both a create and a rename (an edit that changes the stored name) look the
// trimmed name up in all three lists before the preview and again before
// posting. The vendor being renamed is excluded from that lookup: QBO accepts a
// case-only rename of a vendor to its own name, and the query matches
// case-insensitively, so the vendor would otherwise be reported as the holder
// that blocks its own rename. A holder is reported by list, id and stored display
// name. The handlers apply no naming convention: the name they send is the
// caller's, trimmed, and no message proposes a replacement.

import QuickBooks from "node-quickbooks";
import {
  promisify,
  promisifyWrite,
  findDisplayNameHolders,
  getTermCache,
  resolveTermRef,
  describeTermRef,
  toQboRef,
  rememberVendor,
  type DisplayNameHolder,
} from "../../client/index.js";
import {
  buildQboUrl,
  formatUpdateResult,
  buildQBAddress,
  formatAddress,
  extractQboFault,
  formatQboError,
  type AddressInput,
  type QBAddress,
} from "../../utils/index.js";

// QBO's code for "the name supplied already exists" (ValidationFault, HTTP 400).
// A create answers with it; so does an update onto another vendor's name.
const DUPLICATE_NAME_CODE = "6240";

// An update onto a customer's or employee's name is a generic business-validation
// fault (code 6000), identified only by its detail, e.g.:
//   "Business Validation Error: This name is being used by another customer.
//    Please use a different name. You can merge names only when their type
//    (customer, vendor or employee) matches."
// Every other 6000 is left alone: the code is broad.
const BUSINESS_VALIDATION_CODE = "6000";
const NAME_IN_USE_DETAIL = /name is being used by another (customer|vendor|employee)/i;

// The Vendor fields the create and edit tools send or show.
interface QBVendor {
  Id: string;
  SyncToken: string;
  DisplayName: string;
  Title?: string;
  GivenName?: string;
  MiddleName?: string;
  FamilyName?: string;
  Suffix?: string;
  CompanyName?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  Mobile?: { FreeFormNumber?: string };
  BillAddr?: QBAddress;
  PrintOnCheckName?: string;
  AcctNum?: string;
  TermRef?: { value: string; name?: string };
  Vendor1099?: boolean;
  Active?: boolean;
}

// A vendor write whose display name is checked: the trimmed name it sends,
// whether it creates or updates, and (update) the vendor's own id, which never
// counts as a holder of its own name.
interface NameCheck {
  name: string;
  write: "create" | "update";
  vendorId?: string;
}

function trimDisplayName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new Error("display_name must not be blank");
  return name;
}

// The holders of the name other than the vendor being written, in
// findDisplayNameHolders order.
async function findOtherHolders(client: QuickBooks, check: NameCheck): Promise<DisplayNameHolder[]> {
  const holders = await findDisplayNameHolders(client, check.name);
  return holders.filter((holder) => !(holder.type === "Vendor" && holder.id === check.vendorId));
}

// A name that cannot be written is a validation failure in draft as well as in
// commit, so the preview never looks clean and then fails.
async function assertNameFree(client: QuickBooks, check: NameCheck): Promise<void> {
  const holders = await findOtherHolders(client, check);
  if (holders.length > 0) throw new Error(nameTakenMessage(check, holders));
}

// One line per holder, in findDisplayNameHolders order. Only the stored names
// QBO returned are quoted, so the message never proposes a name of its own. The
// "use it instead" advice is for a create: a rename cannot merge into the holder.
function nameTakenMessage(check: NameCheck, holders: DisplayNameHolder[]): string {
  const vendorHolder = check.write === "create" ? holders.find((holder) => holder.type === "Vendor") : undefined;
  return [
    `Display name "${check.name}" is already used in QuickBooks:`,
    ...holders.map((holder) => `  - ${holder.type} ${holder.id}: "${holder.displayName}"`),
    ...(vendorHolder
      ? [`A vendor with this name already exists (id ${vendorHolder.id}); use it instead of creating one.`]
      : []),
    "QuickBooks display names are unique across customers, vendors and employees.",
    "Choose a different display_name, or rename the record that holds it.",
  ].join("\n");
}

// Whether QBO rejected the write because the display name is taken.
function isDuplicateNameFault(err: unknown): boolean {
  return (
    extractQboFault(err)?.errors.some(
      (e) =>
        e.code === DUPLICATE_NAME_CODE ||
        (e.code === BUSINESS_VALIDATION_CODE && NAME_IN_USE_DETAIL.test(e.detail ?? ""))
    ) ?? false
  );
}

// QBO answered the write with a duplicate-name fault: nothing was committed. A
// create's Detail carries the holder's id but not its list (an update's carries
// neither), so look the holders up again to name them; a failed re-lookup still
// reports the fault and the id when there is one.
async function duplicateNameError(client: QuickBooks, check: NameCheck, err: unknown): Promise<Error> {
  const detail = extractQboFault(err)?.errors.find((e) => e.code === DUPLICATE_NAME_CODE)?.detail;
  const id = detail?.match(/Id=(\d+)/)?.[1];
  const duplicateOf = `as a duplicate${id ? ` of id ${id}` : ""}`;
  const rejected = `QuickBooks rejected the ${check.write}: ${formatQboError(err)}`;

  let holders: DisplayNameHolder[];
  try {
    holders = await findOtherHolders(client, check);
  } catch (lookupError) {
    return new Error(
      [
        `QuickBooks rejected display name "${check.name}" ${duplicateOf}; looking up the record that holds it also failed: ${formatQboError(lookupError)}`,
        rejected,
      ].join("\n")
    );
  }

  if (holders.length > 0) return new Error([nameTakenMessage(check, holders), rejected].join("\n"));
  return new Error(
    [
      `QuickBooks rejected display name "${check.name}" ${duplicateOf}, but no active customer, vendor or employee with that name was found.`,
      rejected,
    ].join("\n")
  );
}

// What a handler throws for a rejected write. The duplicate-name fault is the one
// rejection rewritten (it committed nothing), and only for a write that checked a
// name. Anything else comes back as the original object so the auth retry and the
// write barrier treat this like every other write.
async function vendorWriteError(client: QuickBooks, check: NameCheck | undefined, err: unknown): Promise<unknown> {
  if (check && isDuplicateNameFault(err)) return duplicateNameError(client, check, err);
  return err;
}

export async function handleCreateVendor(
  client: QuickBooks,
  args: {
    display_name: string;
    title?: string;
    given_name?: string;
    middle_name?: string;
    family_name?: string;
    suffix?: string;
    company_name?: string;
    email?: string;
    phone?: string;
    mobile?: string;
    bill_address?: AddressInput;
    print_on_check_name?: string;
    acct_num?: string;
    sales_term_ref?: string;
    vendor_1099?: boolean;
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    title, given_name, middle_name, family_name, suffix,
    company_name, email, phone, mobile,
    bill_address, print_on_check_name, acct_num, sales_term_ref, vendor_1099,
    draft = true,
  } = args;

  const display_name = trimDisplayName(args.display_name);

  // Build QB Vendor object
  const vendorObj: Record<string, unknown> = {
    DisplayName: display_name,
  };
  if (title) vendorObj.Title = title;
  if (given_name) vendorObj.GivenName = given_name;
  if (middle_name) vendorObj.MiddleName = middle_name;
  if (family_name) vendorObj.FamilyName = family_name;
  if (suffix) vendorObj.Suffix = suffix;
  if (company_name) vendorObj.CompanyName = company_name;
  if (email) vendorObj.PrimaryEmailAddr = { Address: email };
  if (phone) vendorObj.PrimaryPhone = { FreeFormNumber: phone };
  if (mobile) vendorObj.Mobile = { FreeFormNumber: mobile };
  if (bill_address) vendorObj.BillAddr = buildQBAddress(bill_address);
  if (print_on_check_name) vendorObj.PrintOnCheckName = print_on_check_name;
  if (acct_num) vendorObj.AcctNum = acct_num;
  if (vendor_1099 !== undefined) vendorObj.Vendor1099 = vendor_1099;

  // Resolve default payment terms
  let termName: string | undefined;
  if (sales_term_ref) {
    const termRef = toQboRef(resolveTermRef(await getTermCache(client), sales_term_ref));
    vendorObj.TermRef = termRef;
    termName = termRef.name;
  }

  const nameCheck: NameCheck = { name: display_name, write: "create" };
  await assertNameFree(client, nameCheck);

  if (draft) {
    const preview = [
      "DRAFT - Vendor Preview",
      "",
      `Display Name: ${display_name}`,
      ...(title || given_name || middle_name || family_name || suffix
        ? [`Name Parts: ${[title, given_name, middle_name, family_name, suffix].filter(Boolean).join(' ')}`]
        : []),
      `Company: ${company_name || "(none)"}`,
      `Email: ${email || "(none)"}`,
      `Phone: ${phone || "(none)"}`,
      `Mobile: ${mobile || "(none)"}`,
      ...formatAddress(bill_address ? buildQBAddress(bill_address) : undefined, "Billing Address"),
      `Print On Check Name: ${print_on_check_name || "(default)"}`,
      `Account Number: ${acct_num || "(none)"}`,
      `Terms: ${termName || "(none)"}`,
      `1099 Vendor: ${vendor_1099 ?? false}`,
      "Name check: no active customer, vendor or employee uses this display name.",
      "",
      "Set draft=false to create this vendor.",
    ].join("\n");

    return { content: [{ type: "text", text: preview }] };
  }

  let result: QBVendor;
  try {
    result = await promisifyWrite<unknown>((cb) =>
      client.createVendor(vendorObj, cb)
    ) as QBVendor;
  } catch (err) {
    throw await vendorWriteError(client, nameCheck, err);
  }

  rememberVendor({ Id: result.Id, DisplayName: result.DisplayName, Active: result.Active });

  const response = [
    "Vendor Created!",
    "",
    `ID: ${result.Id}`,
    `Display Name: ${result.DisplayName}`,
    "",
    `View in QuickBooks: ${buildQboUrl("vendordetail", "nameId", result.Id)}`,
  ].join("\n");

  return { content: [{ type: "text", text: response }] };
}

export async function handleEditVendor(
  client: QuickBooks,
  args: {
    id: string;
    display_name?: string;
    title?: string;
    given_name?: string;
    middle_name?: string;
    family_name?: string;
    suffix?: string;
    company_name?: string;
    email?: string;
    phone?: string;
    mobile?: string;
    bill_address?: AddressInput;
    print_on_check_name?: string;
    acct_num?: string;
    sales_term_ref?: string;
    vendor_1099?: boolean;
    active?: boolean;
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    id, title, given_name, middle_name, family_name, suffix,
    company_name, email, phone, mobile,
    bill_address, print_on_check_name, acct_num, sales_term_ref, vendor_1099, active,
    draft = true,
  } = args;

  // Both refusals come before any QuickBooks call.
  const display_name = args.display_name === undefined ? undefined : trimDisplayName(args.display_name);
  if (display_name !== undefined && active === false) {
    throw new Error(
      "display_name cannot be combined with active=false: QuickBooks drops a rename sent with a deactivation. " +
        "Rename and deactivate in two separate edits."
    );
  }

  // Fetch fresh so the SyncToken is current and the address merge sees the
  // stored value.
  const current = await promisify<unknown>((cb) =>
    client.getVendor(id, cb)
  ) as QBVendor;

  // Sparse: QuickBooks leaves every property not in the payload untouched.
  const updated: Record<string, unknown> = {
    Id: current.Id,
    SyncToken: current.SyncToken,
    sparse: true,
  };

  if (display_name !== undefined) updated.DisplayName = display_name;
  if (title !== undefined) updated.Title = title;
  if (given_name !== undefined) updated.GivenName = given_name;
  if (middle_name !== undefined) updated.MiddleName = middle_name;
  if (family_name !== undefined) updated.FamilyName = family_name;
  if (suffix !== undefined) updated.Suffix = suffix;
  if (company_name !== undefined) updated.CompanyName = company_name;
  if (email !== undefined) updated.PrimaryEmailAddr = { Address: email };
  if (phone !== undefined) updated.PrimaryPhone = { FreeFormNumber: phone };
  if (mobile !== undefined) updated.Mobile = { FreeFormNumber: mobile };
  // A partial address is merged over the stored one, so changing the postal
  // code alone does not blank the street.
  const newBillAddr = bill_address !== undefined
    ? { ...(current.BillAddr ?? {}), ...buildQBAddress(bill_address) }
    : undefined;
  if (newBillAddr) updated.BillAddr = newBillAddr;
  if (print_on_check_name !== undefined) updated.PrintOnCheckName = print_on_check_name;
  if (acct_num !== undefined) updated.AcctNum = acct_num;
  if (vendor_1099 !== undefined) updated.Vendor1099 = vendor_1099;
  if (active !== undefined) updated.Active = active;

  if (sales_term_ref !== undefined) {
    updated.TermRef = toQboRef(resolveTermRef(await getTermCache(client), sales_term_ref));
  }

  // An exact comparison, so a case-only change counts as a rename and is checked.
  // The check runs in draft and in commit, each against the current lists.
  const renamed = display_name !== undefined && display_name !== current.DisplayName;
  const nameCheck: NameCheck | undefined = renamed
    ? { name: display_name, write: "update", vendorId: current.Id }
    : undefined;
  if (nameCheck) await assertNameFree(client, nameCheck);

  const qboUrl = buildQboUrl("vendordetail", "nameId", id);

  if (draft) {
    const previewLines: string[] = [
      "DRAFT - Vendor Edit Preview",
      "",
      `ID: ${id} (${current.DisplayName})`,
      `SyncToken: ${current.SyncToken}`,
      "",
      "Changes:",
    ];

    if (display_name !== undefined) previewLines.push(`  Display Name: ${current.DisplayName} → ${display_name}`);
    if (title !== undefined) previewLines.push(`  Title: ${current.Title || "(none)"} → ${title}`);
    if (given_name !== undefined) previewLines.push(`  Given Name: ${current.GivenName || "(none)"} → ${given_name}`);
    if (middle_name !== undefined) previewLines.push(`  Middle Name: ${current.MiddleName || "(none)"} → ${middle_name}`);
    if (family_name !== undefined) previewLines.push(`  Family Name: ${current.FamilyName || "(none)"} → ${family_name}`);
    if (suffix !== undefined) previewLines.push(`  Suffix: ${current.Suffix || "(none)"} → ${suffix}`);
    if (company_name !== undefined) previewLines.push(`  Company: ${current.CompanyName || "(none)"} → ${company_name}`);
    if (email !== undefined) previewLines.push(`  Email: ${current.PrimaryEmailAddr?.Address || "(none)"} → ${email}`);
    if (phone !== undefined) previewLines.push(`  Phone: ${current.PrimaryPhone?.FreeFormNumber || "(none)"} → ${phone}`);
    if (mobile !== undefined) previewLines.push(`  Mobile: ${current.Mobile?.FreeFormNumber || "(none)"} → ${mobile}`);
    if (newBillAddr) {
      previewLines.push(
        ...formatAddress(current.BillAddr, "Billing Address (before)").map((l) => `  ${l}`),
        ...formatAddress(newBillAddr, "Billing Address (after)").map((l) => `  ${l}`),
      );
    }
    if (print_on_check_name !== undefined) previewLines.push(`  Print On Check Name: ${current.PrintOnCheckName || "(default)"} → ${print_on_check_name}`);
    if (acct_num !== undefined) previewLines.push(`  Account Number: ${current.AcctNum || "(none)"} → ${acct_num}`);
    if (sales_term_ref !== undefined) {
      const newTerm = (updated.TermRef as { name?: string })?.name || sales_term_ref;
      previewLines.push(`  Terms: ${await describeTermRef(client, current.TermRef)} → ${newTerm}`);
    }
    if (vendor_1099 !== undefined) previewLines.push(`  1099 Vendor: ${current.Vendor1099 ?? false} → ${vendor_1099}`);
    if (active !== undefined) previewLines.push(`  Active: ${current.Active !== false} → ${active}`);

    previewLines.push("");
    if (renamed) previewLines.push("Name check: no other active customer, vendor or employee uses this display name.");
    previewLines.push("Fields not listed are left unchanged. Set draft=false to apply these changes.");

    return { content: [{ type: "text", text: previewLines.join("\n") }] };
  }

  let result: QBVendor;
  try {
    result = await promisifyWrite<unknown>((cb) =>
      client.updateVendor(updated, cb)
    ) as QBVendor;
  } catch (err) {
    throw await vendorWriteError(client, nameCheck, err);
  }

  // Deactivation and reactivation can change the display name even when the caller
  // sent none, so the cache and the text take the name and status from the response.
  rememberVendor({ Id: result.Id, DisplayName: result.DisplayName, Active: result.Active });

  const text = [
    formatUpdateResult("Vendor", id, current.SyncToken, result.SyncToken, qboUrl),
    ...(result.DisplayName !== current.DisplayName
      ? [`Display Name: ${current.DisplayName} → ${result.DisplayName}`]
      : []),
  ].join("\n");

  return { content: [{ type: "text", text }] };
}
