// Handlers for account tools (create, edit). Reads go through list_accounts and `query`.
//
// Every check runs against a full listing (inactive accounts included) taken in
// the same call, not the account cache: the cache holds active accounts only, and
// a draft and a commit each have to see the books as they are now. QuickBooks
// answers several clashes with a bare 2010 that gives no reason, so the checks
// here are the only way to tell the caller what went wrong, and nothing is
// written unless every one has just passed.
//
// Accounts are addressed by an exact Id, AcctNum, name or "Parent:Child" path.
// There is no partial match, and a refusal never proposes a candidate of its own.

import QuickBooks from "node-quickbooks";
import {
  promisify,
  promisifyWrite,
  loadAllAccounts,
  invalidateAccountCache,
} from "../../client/index.js";
import {
  extractQboFault,
  formatQboError,
  formatUpdateResult,
  formatDollars,
  toCents,
} from "../../utils/index.js";
import type { CachedAccount } from "../../types/index.js";

// QBO's code for "the name supplied already exists" (ValidationFault, HTTP 400).
const DUPLICATE_NAME_CODE = "6240";

// A create onto an active account's number is a generic business-validation fault
// (code 6000), identified only by its detail, e.g.:
//   "Business Validation Error: Another account is already using this number.
//    Please use a different number."
// Every other 6000 is left alone: the code is broad.
const BUSINESS_VALIDATION_CODE = "6000";
const NUMBER_IN_USE_DETAIL = /another account is already using this number/i;

// QBO's "Request has invalid or unsupported property": the bare refusal an account
// update gets for a taken name, a cycle, an edit on an inactive account and more.
const UNEXPLAINED_REFUSAL_CODE = "2010";

// What a bare 2010 on an account update has been seen to mean (sandbox,
// 2026-10-23). The edit's checks catch every one of these except the item case.
const KNOWN_2010_CAUSES = [
  "another account at the same level already uses the name",
  "the move would put the account under itself or one of its own sub-accounts",
  "the account is inactive (only a reactivation is accepted)",
  "a type change on an account that has sub-accounts or a balance",
  "deactivating an account that an item uses",
  "reactivating a sub-account whose parent is inactive",
  "an account number that an active account holds",
];

// QBO caps both fields at 100 characters (2050) and refuses a colon or tab in a name (2180).
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 100;

// QBO appends this to an account's name when it is deactivated.
const DELETED_SUFFIX = /\s*\(deleted\)\s*$/i;

// The Account fields the tools read: everything the cache holds, plus the
// SyncToken an update needs.
interface QBAccount extends CachedAccount {
  SyncToken?: string;
}

// A full listing, indexed once per call so each check is a lookup instead of a scan.
interface AccountIndex {
  all: QBAccount[];
  byId: Map<string, QBAccount>;
  // Direct children by parent Id.
  children: Map<string, QBAccount[]>;
}

/**
 * Index a listing by Id and by parent.
 *
 * Built from the listing a handler just loaded, so every later check in that
 * call reads the same snapshot.
 */
function indexAccounts(list: QBAccount[]): AccountIndex {
  const byId = new Map<string, QBAccount>();
  const children = new Map<string, QBAccount[]>();
  for (const account of list) {
    byId.set(account.Id, account);
    const parentId = account.ParentRef?.value;
    if (!parentId) continue;
    const siblings = children.get(parentId);
    if (siblings) siblings.push(account);
    else children.set(parentId, [account]);
  }
  return { all: list, byId, children };
}

// An account's path as the caller sees it, for a listed line. A stored
// FullyQualifiedName is always present on a real account; the name is the fallback.
const pathOf = (account: QBAccount): string => account.FullyQualifiedName ?? account.Name;

// "  - <path> (id <Id>)", the line every refusal lists an account as.
const listLine = (account: QBAccount): string => `  - ${pathOf(account)} (id ${account.Id})`;

// "  - <path>: <balance>", the line a balance refusal lists an account as.
const balanceLine = (account: QBAccount): string =>
  `  - ${pathOf(account)}: ${formatDollars(toCents(account.CurrentBalance ?? 0))}`;

// A name or path with every " (deleted)" suffix removed, segment by segment:
// QBO renames an account "<name> (deleted)" on deactivation and keeps the rest.
function withoutDeleted(text: string): string {
  return text
    .split(":")
    .map((segment) => {
      let stripped = segment;
      while (DELETED_SUFFIX.test(stripped)) stripped = stripped.replace(DELETED_SUFFIX, "");
      return stripped;
    })
    .join(":");
}

// The comparable forms of a name or path: lowercase, and for an inactive account
// also without its " (deleted)" suffixes, so the original name still finds it.
function matchKeys(account: QBAccount, text: string): string[] {
  const lower = text.toLowerCase();
  return account.Active === false ? [lower, withoutDeleted(text).toLowerCase()] : [lower];
}

/**
 * Resolve a caller's reference to exactly one account.
 *
 * Order: Id, AcctNum, full path, leaf name. Matching ignores case, and an
 * inactive account also matches without its " (deleted)" suffix, so a
 * reactivation can name it as it was. The first step with any hit decides. More
 * than one hit at that step is refused with every candidate listed; no hit is
 * refused, and no partial match is tried or proposed. An inactive account keeps a
 * number an active one may now hold, so a shared number is ambiguous like any
 * other and the caller picks by Id or name.
 */
function resolveExact(index: AccountIndex, ref: string, role: "account" | "parent"): QBAccount {
  const wanted = ref.trim();
  const lower = wanted.toLowerCase();

  const byId = index.byId.get(wanted);
  const steps: Array<QBAccount[]> = [
    byId ? [byId] : [],
    index.all.filter((a) => a.AcctNum !== undefined && a.AcctNum.toLowerCase() === lower),
    index.all.filter((a) => matchKeys(a, pathOf(a)).includes(lower)),
    index.all.filter((a) => matchKeys(a, a.Name).includes(lower)),
  ];

  const hits = steps.find((step) => step.length > 0);
  if (!hits) {
    throw new Error(
      `No account matches "${wanted}". Use an exact Id, account number, name or Parent:Child path.`
    );
  }
  if (hits.length > 1) {
    throw new Error(
      [
        `The ${role} "${wanted}" matches more than one account:`,
        ...hits.map(listLine),
        "Use the Id, or the full Parent:Child path, to choose one.",
      ].join("\n")
    );
  }
  return hits[0];
}

/**
 * The account at a level of the tree that already uses a name, if any.
 *
 * Account names are unique per parent, so only siblings count: the same name under
 * another parent never blocks. `parentId` undefined is the top level. Comparison
 * is trimmed and case-insensitive, and an inactive account is compared by its
 * name without " (deleted)" (QBO reserves an inactive account's original name on
 * create). `excludeId` keeps an account from blocking its own rename. An active
 * holder is preferred over an inactive one.
 */
function siblingNameHolder(
  index: AccountIndex,
  parentId: string | undefined,
  name: string,
  options: { excludeId?: string; includeInactive: boolean }
): QBAccount | undefined {
  const wanted = name.trim().toLowerCase();
  const holders = index.all.filter(
    (a) =>
      a.ParentRef?.value === parentId &&
      a.Id !== options.excludeId &&
      (a.Active !== false || options.includeInactive) &&
      matchKeys(a, a.Name.trim()).includes(wanted)
  );
  return holders.find((a) => a.Active !== false) ?? holders[0];
}

/**
 * An account plus every account nested beneath it that `follow` admits, the
 * account first.
 *
 * QBO nests up to 5 deep, so this walks rather than checking one level; a child
 * `follow` rejects is skipped along with everything under it, and a visited set
 * stops a cyclic ParentRef from looping.
 */
function walkSubtree(index: AccountIndex, id: string, follow: (child: QBAccount) => boolean): QBAccount[] {
  const root = index.byId.get(id);
  if (!root) return [];
  const subtree: QBAccount[] = [];
  const visited = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const account = pending.shift()!;
    if (visited.has(account.Id)) continue;
    visited.add(account.Id);
    subtree.push(account);
    for (const child of index.children.get(account.Id) ?? []) {
      if (follow(child)) pending.push(child);
    }
  }
  return subtree;
}

/**
 * An account plus every active account nested beneath it, the account first.
 *
 * A deactivation cascades to the whole subtree, so the edit has to see all of it
 * before it is allowed.
 */
function activeSubtree(index: AccountIndex, id: string): QBAccount[] {
  return walkSubtree(index, id, (child) => child.Active !== false);
}

/**
 * The accounts in a subtree whose balance would leave the books on deactivation.
 *
 * Retiring a balance-sheet account with a balance removes that balance (and
 * Opening Balance Equity falls by the same amount); reactivating does not restore
 * it. A P&L account keeps its history, so only Asset, Liability and Equity count.
 */
function balanceHolders(subtree: QBAccount[]): QBAccount[] {
  return subtree.filter(
    (a) =>
      (a.Classification === "Asset" || a.Classification === "Liability" || a.Classification === "Equity") &&
      (a.CurrentBalance ?? 0) !== 0
  );
}

// QBO's own name rules (2050, 2180), checked locally so a create or a rename is
// refused before any QuickBooks call. Returns the trimmed name.
function validateName(raw: string | undefined): string {
  const name = (raw ?? "").trim();
  if (!name) throw new Error("name must not be blank");
  if (name.length > MAX_NAME_LENGTH) throw new Error(`name must be at most ${MAX_NAME_LENGTH} characters`);
  if (/[:\t]/.test(name)) throw new Error("name cannot contain a colon or a tab");
  return name;
}

// QBO's description limit (2050), checked locally for the same reason.
function validateDescription(description: string | undefined): void {
  if (description !== undefined && description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
}

// Local validation for a create, in the order a caller would fix it. Runs before
// any QuickBooks call and returns the trimmed name. A parent supplies the type
// when neither type nor subtype is given.
function validateCreateInput(args: {
  name: string;
  account_type?: string;
  account_subtype?: string;
  description?: string;
  parent?: string;
}): string {
  const name = validateName(args.name);
  validateDescription(args.description);
  if (!args.account_type && !args.account_subtype && !args.parent) {
    throw new Error("account_type or account_subtype is required");
  }
  return name;
}

// What a create or an edit is refused for, when the name is taken at the target
// level. An inactive holder is named as such, because the caller cannot see it in
// the chart.
function nameTakenMessage(holder: QBAccount): string {
  const inactive = holder.Active === false;
  return [
    `An account at this level already uses this name${inactive ? " (it is inactive, and QuickBooks keeps an inactive account's name reserved)" : ""}:`,
    listLine(holder),
    "Choose a different name, or another parent.",
  ].join("\n");
}

// What a create or a move is refused for, when the parent is inactive: QBO refuses
// an active account under an inactive one.
function inactiveParentMessage(ref: string, parent: QBAccount, action: "created" | "moved"): string {
  return [
    `The parent "${ref.trim()}" is inactive; a sub-account cannot be ${action} under an inactive account:`,
    listLine(parent),
    "Reactivate it first, or choose another parent.",
  ].join("\n");
}

function numberTakenMessage(acctNum: string, holder: QBAccount): string {
  return [
    `Account number ${acctNum} is already used by:`,
    listLine(holder),
    "Choose a different acct_num.",
  ].join("\n");
}

// QBO keeps a parent and its sub-accounts on one account type (6000), on create,
// on a move and on a type change alike.
function parentTypeMessage(parent: QBAccount, accountType: string): string {
  return `A sub-account must have the same account type as its parent: ${pathOf(parent)} (${parent.AccountType}), not ${accountType}.`;
}

// The active account holding a number. Inactive accounts keep their number but
// do not reserve it, so they never count. `excludeId` keeps an account from
// blocking its own number.
function numberHolder(index: AccountIndex, acctNum: string, excludeId?: string): QBAccount | undefined {
  const wanted = acctNum.toLowerCase();
  return index.all.find(
    (a) => a.Active !== false && a.Id !== excludeId && a.AcctNum?.toLowerCase() === wanted
  );
}

// The faults a create rewrites, each of which committed nothing.
function isDuplicateNameFault(err: unknown): boolean {
  return extractQboFault(err)?.errors.some((e) => e.code === DUPLICATE_NAME_CODE) ?? false;
}

function isNumberInUseFault(err: unknown): boolean {
  return (
    extractQboFault(err)?.errors.some(
      (e) => e.code === BUSINESS_VALIDATION_CODE && NUMBER_IN_USE_DETAIL.test(e.detail ?? "")
    ) ?? false
  );
}

/**
 * What a handler throws for a rejected create.
 *
 * The duplicate-name and number-in-use faults are rewritten, because QBO's text
 * does not say who holds the name or number; a fresh listing finds the holder. A
 * failed re-lookup still reports the fault. Anything else comes back as the
 * original object so the auth retry and the write barrier treat this like every
 * other write.
 */
async function createAccountError(
  client: QuickBooks,
  target: { name: string; parentId: string | undefined; acctNum: string | undefined },
  err: unknown
): Promise<unknown> {
  const nameFault = isDuplicateNameFault(err);
  const numberFault = target.acctNum !== undefined && isNumberInUseFault(err);
  if (!nameFault && !numberFault) return err;

  const rejected = `QuickBooks rejected the create: ${formatQboError(err)}`;
  let index: AccountIndex;
  try {
    index = indexAccounts(await loadAllAccounts(client));
  } catch (lookupError) {
    return new Error(
      [`Looking up the account that holds it also failed: ${formatQboError(lookupError)}`, rejected].join("\n")
    );
  }

  if (nameFault) {
    const holder = siblingNameHolder(index, target.parentId, target.name, { includeInactive: true });
    return new Error([...(holder ? [nameTakenMessage(holder)] : []), rejected].join("\n"));
  }
  const holder = numberHolder(index, target.acctNum!);
  return new Error([...(holder ? [numberTakenMessage(target.acctNum!, holder)] : []), rejected].join("\n"));
}

export async function handleCreateAccount(
  client: QuickBooks,
  args: {
    name: string;
    account_type?: string;
    account_subtype?: string;
    acct_num?: string;
    description?: string;
    parent?: string;
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { account_subtype, description, parent, draft = true } = args;
  const name = validateCreateInput(args);
  const acctNum = args.acct_num?.trim() || undefined;

  const index = indexAccounts(await loadAllAccounts(client));

  // A sub-account takes its parent's type; asking for another is refused.
  let parentAccount: QBAccount | undefined;
  let accountType = args.account_type;
  if (parent !== undefined) {
    parentAccount = resolveExact(index, parent, "parent");
    if (parentAccount.Active === false) throw new Error(inactiveParentMessage(parent, parentAccount, "created"));
    if (accountType && accountType !== parentAccount.AccountType) {
      throw new Error(parentTypeMessage(parentAccount, accountType));
    }
    accountType = parentAccount.AccountType;
  }

  // QBO reserves an inactive account's name on create, so inactive siblings count.
  const nameHolder = siblingNameHolder(index, parentAccount?.Id, name, { includeInactive: true });
  if (nameHolder) throw new Error(nameTakenMessage(nameHolder));

  if (acctNum) {
    const holder = numberHolder(index, acctNum);
    if (holder) throw new Error(numberTakenMessage(acctNum, holder));
  }

  const fullName = parentAccount ? `${pathOf(parentAccount)}:${name}` : name;
  const typeText = `${accountType ?? "(inferred from subtype)"} / ${account_subtype ?? "(QuickBooks default)"}`;

  if (draft) {
    const preview = [
      "DRAFT - Account Preview",
      "",
      `Full name: ${fullName}`,
      ...(parentAccount ? [`Parent: ${pathOf(parentAccount)} (id ${parentAccount.Id})`] : []),
      `Type: ${typeText}`,
      `Account Number: ${acctNum ?? "(none)"}`,
      `Description: ${description || "(none)"}`,
      "Name check: no other account at this level uses this name.",
      "",
      "Set draft=false to create this account.",
    ].join("\n");

    return { content: [{ type: "text", text: preview }] };
  }

  // Type and subtype are each sent only when known: a subtype alone infers the
  // type, a type alone gets a default subtype.
  const accountObj: Record<string, unknown> = { Name: name };
  if (accountType) accountObj.AccountType = accountType;
  if (account_subtype) accountObj.AccountSubType = account_subtype;
  if (acctNum) accountObj.AcctNum = acctNum;
  if (description) accountObj.Description = description;
  // ParentRef alone makes a sub-account; SubAccount: true is sent with it.
  if (parentAccount) {
    accountObj.SubAccount = true;
    accountObj.ParentRef = { value: parentAccount.Id };
  }

  let result: QBAccount;
  try {
    result = await promisifyWrite<unknown>((cb) =>
      client.createAccount(accountObj, cb)
    ) as QBAccount;
  } catch (err) {
    throw await createAccountError(client, { name, parentId: parentAccount?.Id, acctNum }, err);
  }

  // A committed create changes the chart, so the cache is dropped, not patched.
  invalidateAccountCache();

  const response = [
    "Account Created!",
    "",
    `ID: ${result.Id}`,
    `Full name: ${result.FullyQualifiedName ?? fullName}`,
    `Type: ${result.AccountType ?? accountType ?? "(unknown)"}${result.AccountSubType ? ` / ${result.AccountSubType}` : ""}`,
  ].join("\n");

  return { content: [{ type: "text", text: response }] };
}

// The edit_account parameters that change something. `account` addresses the
// record and `draft` controls the write; `top_level: false` asks for nothing.
type EditAccountArgs = {
  account: string;
  name?: string;
  acct_num?: string;
  description?: string;
  account_type?: string;
  account_subtype?: string;
  parent?: string;
  top_level?: boolean;
  active?: boolean;
  draft?: boolean;
};
const EDIT_CHANGE_KEYS = [
  "name", "acct_num", "description", "account_type", "account_subtype", "parent", "top_level",
] as const;

// The changes an edit asks for besides `active`, by parameter name.
function requestedChanges(args: EditAccountArgs): string[] {
  return EDIT_CHANGE_KEYS.filter((key) => (key === "top_level" ? args.top_level === true : args[key] !== undefined));
}

/**
 * The combination rules, checked before any QuickBooks call.
 *
 * QBO silently drops a rename sent with a deactivation, and a deactivation
 * cascades, so `active: false` travels alone. A parent and a move to the top
 * level contradict each other.
 */
function validateEditCombination(args: EditAccountArgs): void {
  if (args.top_level === true && args.parent !== undefined) {
    throw new Error("top_level cannot be combined with parent: give parent to move the account under another one, or top_level to move it to the top level.");
  }
  const others = requestedChanges(args);
  if (args.active === false && others.length > 0) {
    throw new Error(
      `active=false must be the only change in its edit (also given: ${others.join(", ")}). ` +
        "QuickBooks drops a rename sent with a deactivation; make the other changes in a separate edit first."
    );
  }
}

/**
 * The checks an inactive account's edit must pass.
 *
 * QBO accepts nothing on an inactive account but a reactivation (a rename sent
 * with it is applied), refuses to reactivate a sub-account under an inactive
 * parent, and refuses to reactivate an account whose number an active account now
 * holds. Each answers with a bare 2010, so each is checked here first.
 */
function checkInactiveEdit(index: AccountIndex, target: QBAccount, args: EditAccountArgs): void {
  const others = requestedChanges(args).filter((key) => key !== "name");
  if (args.active !== true || others.length > 0) {
    throw new Error(
      [
        `The account "${args.account.trim()}" is inactive, and QuickBooks accepts only a reactivation on it: reactivate it first (active=true, optionally with a name), then make other changes in a separate edit:`,
        listLine(target),
      ].join("\n")
    );
  }
  const parent = target.ParentRef ? index.byId.get(target.ParentRef.value) : undefined;
  if (parent && parent.Active === false) {
    throw new Error(
      [
        `"${pathOf(target)}" cannot be reactivated while its parent is inactive:`,
        listLine(parent),
        "Reactivate the parent first.",
      ].join("\n")
    );
  }
  const holder = target.AcctNum ? numberHolder(index, target.AcctNum, target.Id) : undefined;
  if (holder) {
    throw new Error(
      [
        `Account number ${target.AcctNum} is now used by:`,
        listLine(holder),
        "QuickBooks refuses to reactivate an account onto a number an active account holds; change that account's number first.",
      ].join("\n")
    );
  }
}

/**
 * The checks a type change must pass.
 *
 * QBO refuses a type change on a parent with active sub-accounts and on an
 * account carrying a balance, each with a bare 2010 and nothing changed.
 */
function checkTypeChange(index: AccountIndex, target: QBAccount): void {
  const children = (index.children.get(target.Id) ?? []).filter((a) => a.Active !== false);
  if (children.length > 0) {
    throw new Error(
      [
        `"${pathOf(target)}" has active sub-accounts, and QuickBooks refuses a type change on a parent while it has them:`,
        ...children.map(listLine),
        "Move or deactivate them first.",
      ].join("\n")
    );
  }
  if ((target.CurrentBalance ?? 0) !== 0) {
    throw new Error(
      [
        `"${pathOf(target)}" carries a balance, and QuickBooks refuses a type change on an account with one:`,
        balanceLine(target),
        "Move the balance out first with a journal entry or transfer.",
      ].join("\n")
    );
  }
}

/**
 * What a handler throws for a rejected update.
 *
 * QBO answers several distinct problems with the same bare 2010, so it is
 * rewritten to name the known causes, followed by QuickBooks' own text. Anything
 * else comes back as the original object so the auth retry and the write barrier
 * treat this like every other write.
 */
function editAccountError(err: unknown): unknown {
  const unexplained =
    extractQboFault(err)?.errors.some((e) => e.code === UNEXPLAINED_REFUSAL_CODE) ?? false;
  if (!unexplained) return err;
  return new Error(
    [
      "QuickBooks refused the update without giving a reason (2010). Known causes:",
      ...KNOWN_2010_CAUSES.map((cause) => `  - ${cause}`),
      "The checks before the write rule out all of these except the item case, so the books may have changed since they ran; check the account and try again.",
      `QuickBooks said: ${formatQboError(err)}`,
    ].join("\n")
  );
}

export async function handleEditAccount(
  client: QuickBooks,
  args: EditAccountArgs
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { account_type, account_subtype, description, active, draft = true } = args;

  // Everything that needs no chart is refused before any QuickBooks call.
  validateEditCombination(args);
  const name = args.name === undefined ? undefined : validateName(args.name);
  validateDescription(description);
  const acctNum = args.acct_num?.trim();

  const index = indexAccounts(await loadAllAccounts(client));
  const target = resolveExact(index, args.account, "account");

  if (target.Active === false) checkInactiveEdit(index, target, args);

  if (acctNum) {
    const holder = numberHolder(index, acctNum, target.Id);
    if (holder) throw new Error(numberTakenMessage(acctNum, holder));
  }

  // Type and subtype always travel together: an omitted type is the stored one,
  // so a subtype alone never moves the account to another type.
  const typeGiven = account_type !== undefined || account_subtype !== undefined;
  const newType = account_type ?? target.AccountType;
  const typeChanged = typeGiven && newType !== target.AccountType;
  if (typeChanged && account_subtype === undefined) {
    throw new Error(
      `account_subtype is required when account_type changes: the stored subtype (${target.AccountSubType}) belongs to ${target.AccountType}.`
    );
  }
  const newSubtype = account_subtype ?? target.AccountSubType;
  if (typeChanged) checkTypeChange(index, target);

  // Where the account ends up: under the new parent, at the top level, or where it is.
  const moved = args.parent !== undefined || args.top_level === true;
  let newParent = target.ParentRef && !args.top_level ? index.byId.get(target.ParentRef.value) : undefined;
  if (args.parent !== undefined) {
    newParent = resolveExact(index, args.parent, "parent");
    if (newParent.Active === false) throw new Error(inactiveParentMessage(args.parent, newParent, "moved"));
    const destination = newParent;
    if (activeSubtree(index, target.Id).some((a) => a.Id === destination.Id)) {
      throw new Error(`"${pathOf(target)}" cannot be moved under itself or one of its own sub-accounts.`);
    }
  }
  if (newParent && (typeChanged || args.parent !== undefined) && newType !== newParent.AccountType) {
    throw new Error(parentTypeMessage(newParent, newType ?? "(unknown)"));
  }

  // Names are unique per parent among active accounts; a rename onto an inactive
  // account's original name is accepted, and an account never blocks itself.
  const finalName = name ?? target.Name;
  if (name !== undefined || moved) {
    const holder = siblingNameHolder(index, newParent?.Id, finalName, {
      excludeId: target.Id,
      includeInactive: false,
    });
    if (holder) throw new Error(nameTakenMessage(holder));
  }

  // A deactivation cascades to every active descendant, so a balance anywhere in
  // the subtree refuses the whole edit: nothing is half-retired.
  const cascade = active === false ? activeSubtree(index, target.Id).slice(1) : [];
  if (active === false) {
    const holders = balanceHolders([target, ...cascade]);
    if (holders.length > 0) {
      throw new Error(
        [
          `"${pathOf(target)}" cannot be deactivated: deactivating a balance-sheet account takes its balance off the books, and reactivating does not restore it. The deactivation would reach these balances:`,
          ...holders.map(balanceLine),
          "Nothing was changed; move the balance out first with a journal entry or transfer, then deactivate.",
        ].join("\n")
      );
    }
  }

  // A reactivation leaves every descendant inactive.
  const reactivating = target.Active === false && active === true;
  const staysInactive = reactivating
    ? walkSubtree(index, target.Id, (child) => child.Active === false).slice(1)
    : [];

  const changes: Record<string, unknown> = {};
  const changeLines: string[] = [];
  if (name !== undefined) {
    changes.Name = name;
    changeLines.push(`  Name: ${target.Name} → ${name}`);
  }
  if (acctNum !== undefined) {
    changes.AcctNum = acctNum;
    changeLines.push(`  Account Number: ${target.AcctNum || "(none)"} → ${acctNum || "(none)"}`);
  }
  if (description !== undefined) {
    changes.Description = description;
    changeLines.push(`  Description: ${target.Description || "(none)"} → ${description || "(none)"}`);
  }
  if (typeGiven) {
    changes.AccountType = newType;
    changes.AccountSubType = newSubtype;
    changeLines.push(`  Type: ${target.AccountType} / ${target.AccountSubType} → ${newType} / ${newSubtype}`);
  }
  if (args.parent !== undefined && newParent) {
    changes.SubAccount = true;
    changes.ParentRef = { value: newParent.Id };
  }
  if (moved) {
    const fullName = newParent ? `${pathOf(newParent)}:${finalName}` : finalName;
    changeLines.push(`  Full name: ${pathOf(target)} → ${fullName}`);
  }
  if (active !== undefined) {
    changes.Active = active;
    changeLines.push(`  Active: ${target.Active !== false} → ${active}`);
  }

  const cascadeLines = (accounts: QBAccount[]) =>
    accounts.length > 0 ? ["", "Also deactivated (sub-accounts):", ...accounts.map(listLine)] : [];
  const staysInactiveLines =
    staysInactive.length > 0 ? ["", "Sub-accounts stay inactive:", ...staysInactive.map(listLine)] : [];

  if (draft) {
    const preview = [
      "DRAFT - Account Edit Preview",
      "",
      `ID: ${target.Id} (${target.Name})`,
      `SyncToken: ${target.SyncToken}`,
      "",
      "Changes:",
      ...changeLines,
      ...cascadeLines(cascade),
      ...staysInactiveLines,
      ...(reactivating && name === undefined
        ? ["", 'If an active account at this level now uses its name, QuickBooks reactivates it with a "-1" suffix.']
        : []),
      "",
      ...(name !== undefined || moved ? ["Name check: no other active account at this level uses this name."] : []),
      "Fields not listed are left unchanged. Set draft=false to apply these changes.",
    ].join("\n");

    return { content: [{ type: "text", text: preview }] };
  }

  // Fetch fresh so the SyncToken is current.
  const current = await promisify<unknown>((cb) =>
    client.getAccount(target.Id, cb)
  ) as QBAccount;

  // A sparse SubAccount: false is silently ignored, so the move to the top level
  // is a full update of the stored record without its ParentRef. node-quickbooks
  // forces sparse: true unless the body carries sparse, so it is sent as false.
  let body: Record<string, unknown>;
  if (args.top_level === true) {
    const { ParentRef: _parentRef, ...record } = current;
    body = { ...record, ...changes, SubAccount: false, sparse: false };
  } else {
    body = { Id: current.Id, SyncToken: current.SyncToken, sparse: true, ...changes };
  }

  let result: QBAccount;
  try {
    result = await promisifyWrite<unknown>((cb) =>
      client.updateAccount(body, cb)
    ) as QBAccount;
  } catch (err) {
    throw editAccountError(err);
  }

  // A rename rewrites every child's path and a deactivation cascades, so the
  // cache is dropped, not patched.
  invalidateAccountCache();

  // QBO renames on deactivation (" (deleted)") and may on reactivation ("-1"), so
  // the name and status come from the response, not the request.
  const text = [
    formatUpdateResult("Account", target.Id, current.SyncToken, result.SyncToken),
    ...(result.Name !== current.Name ? [`Name: ${current.Name} → ${result.Name}`] : []),
    ...(result.FullyQualifiedName !== undefined && result.FullyQualifiedName !== current.FullyQualifiedName
      ? [`Full name: ${current.FullyQualifiedName} → ${result.FullyQualifiedName}`]
      : []),
    ...(result.Active !== current.Active ? [`Active: ${current.Active !== false} → ${result.Active !== false}`] : []),
    ...(result.Active === false ? cascadeLines(cascade) : []),
    ...(result.Active !== false ? staysInactiveLines : []),
  ].join("\n");

  return { content: [{ type: "text", text }] };
}
