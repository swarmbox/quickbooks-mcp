// Handlers for vendor tools (create, edit). Reads go through the `query` tool.
//
// QBO display names are one namespace across Vendor, Customer and Employee, so
// create_vendor looks the trimmed name up in all three lists before the preview
// and again before posting. A holder is reported by list, id and stored display
// name. The handler applies no naming convention: the name it sends is the
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
const DUPLICATE_NAME_CODE = "6240";

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

// One line per holder, in findDisplayNameHolders order. Only the stored names
// QBO returned are quoted, so the message never proposes a name of its own.
function nameTakenMessage(name: string, holders: DisplayNameHolder[]): string {
  const vendorHolder = holders.find((holder) => holder.type === "Vendor");
  return [
    `Display name "${name}" is already used in QuickBooks:`,
    ...holders.map((holder) => `  - ${holder.type} ${holder.id}: "${holder.displayName}"`),
    ...(vendorHolder
      ? [`A vendor with this name already exists (id ${vendorHolder.id}); use it instead of creating one.`]
      : []),
    "QuickBooks display names are unique across customers, vendors and employees.",
    "Choose a different display_name, or rename the record that holds it.",
  ].join("\n");
}

// QBO answered the create with a duplicate-name fault: nothing was committed. The
// Detail carries the holder's id but not its list, so look the holders up again
// to name them; a failed re-lookup still reports the fault and the id.
async function duplicateNameError(client: QuickBooks, name: string, err: unknown): Promise<Error> {
  const detail = extractQboFault(err)?.errors.find((e) => e.code === DUPLICATE_NAME_CODE)?.detail;
  const id = detail?.match(/Id=(\d+)/)?.[1];
  const duplicateOf = `as a duplicate${id ? ` of id ${id}` : ""}`;
  const rejected = `QuickBooks rejected the create: ${formatQboError(err)}`;

  let holders: DisplayNameHolder[];
  try {
    holders = await findDisplayNameHolders(client, name);
  } catch (lookupError) {
    return new Error(
      [
        `QuickBooks rejected display name "${name}" ${duplicateOf}; looking up the record that holds it also failed: ${formatQboError(lookupError)}`,
        rejected,
      ].join("\n")
    );
  }

  if (holders.length > 0) return new Error([nameTakenMessage(name, holders), rejected].join("\n"));
  return new Error(
    [
      `QuickBooks rejected display name "${name}" ${duplicateOf}, but no active customer, vendor or employee with that name was found.`,
      rejected,
    ].join("\n")
  );
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

  const display_name = args.display_name.trim();
  if (!display_name) throw new Error("display_name must not be blank");

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

  // A name that cannot be created is a validation failure in draft as well as in
  // commit, so the preview never looks clean and then fails.
  const holders = await findDisplayNameHolders(client, display_name);
  if (holders.length > 0) throw new Error(nameTakenMessage(display_name, holders));

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
    // The duplicate-name fault is the one rejection rewritten here; it committed
    // nothing. Anything else propagates as the original object so the auth retry
    // and the write barrier treat this like every other write.
    if (extractQboFault(err)?.errors.some((e) => e.code === DUPLICATE_NAME_CODE)) {
      throw await duplicateNameError(client, display_name, err);
    }
    throw err;
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
    id, display_name, title, given_name, middle_name, family_name, suffix,
    company_name, email, phone, mobile,
    bill_address, print_on_check_name, acct_num, sales_term_ref, vendor_1099, active,
    draft = true,
  } = args;

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
    previewLines.push("Fields not listed are left unchanged. Set draft=false to apply these changes.");

    return { content: [{ type: "text", text: previewLines.join("\n") }] };
  }

  const result = await promisifyWrite<unknown>((cb) =>
    client.updateVendor(updated, cb)
  ) as QBVendor;

  return {
    content: [{
      type: "text",
      text: formatUpdateResult("Vendor", id, current.SyncToken, result.SyncToken, qboUrl),
    }],
  };
}
