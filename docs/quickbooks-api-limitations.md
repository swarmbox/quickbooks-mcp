# QuickBooks Online API Limitations

## Query Filtering Limitations

Only fields marked as **"filterable"** in the [Intuit API reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/account) are queryable in WHERE clauses.

### Accounts That Are Not In The Payload

Some postings carry no account reference at all, so they cannot be found by
matching `*AccountRef` fields in entity JSON:

| Entity | Missing reference |
|--------|-------------------|
| `Invoice` | No `ARAccountRef` — the A/R side is implicit |
| `CreditMemo` | No `ARAccountRef` |
| `Payment` | No `ARAccountRef` (only `DepositToAccountRef`) |
| any sales txn | Sales tax posts via `TxnTaxDetail`, which has `TaxRateRef`, not `AccountRef` |

Use the General Ledger report (via `account_period_summary`) when a complete
account figure is required. See `docs/entity-coverage.md`.

### Entity Names Differ Between URL, Query, and JSON

`CreditCardPayment` uses three spellings: the REST path is `/creditcardpayment`,
the query is `select * from creditcardpayment`, but the JSON wrapper key in both
requests and responses is **`CreditCardPaymentTxn`**. Do not assume the queried
name is the response key — read the key from the response.

### Non-Filterable Reference Fields

The following reference fields are **NOT queryable** on transaction entities:

| Field | Entities Tested | Result |
|-------|-----------------|--------|
| `DepartmentRef` | SalesReceipt, JournalEntry, Purchase, Invoice | `QueryValidationError: property 'DepartmentRef' is not queryable` |
| `AccountRef` | JournalEntry, Invoice, Deposit | `QueryValidationError: Property AccountRef not found for Entity` |

### Commonly Filterable Fields

Based on API documentation, these fields are typically filterable:

- `TxnDate` - Transaction date
- `CreateTime` / `LastUpdatedTime` - Metadata timestamps
- `DocNumber` - Document/reference number
- `CustomerRef` - Customer reference (on some entities)
- `Active` - Active status (on master data entities)

### Workarounds

Since DepartmentRef and AccountRef cannot be filtered server-side:

1. **For Reports**: Use the `department` parameter on P&L and Balance Sheet reports (these use a different API endpoint that supports department filtering)

2. **For Queries**: Fetch all records and filter client-side using tools like `jq`:
   ```bash
   # Filter SalesReceipts by department
   cat results.json | jq '.QueryResponse.SalesReceipt[] | select(.DepartmentRef.value == "5")'

   # Filter JournalEntry lines by account
   cat results.json | jq '.QueryResponse.JournalEntry[].Line[] | select(.JournalEntryLineDetail.AccountRef.value == "123")'
   ```

## Other Query Limitations

From [Intuit's Data Queries documentation](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/data-queries):

- **No projections**: Response returns all properties for each object
- **No OR operator**: WHERE clauses don't support OR
- **No GROUP BY**: Aggregation not supported
- **No JOIN**: Cannot join entities
- **Single quotes required**: Comparison values must use single quotes (`'value'`), not double quotes
- **Max 1000 results**: Use `STARTPOSITION` for pagination
- **Wildcard limited to %**: Only `LIKE '%pattern%'` supported, no other wildcards

## Full Update Nulls Omitted Fields — Always Prefer Sparse

This is the single most dangerous QBO update behaviour, and the root cause of a
recurring class of silent data loss in this server. Intuit's own wording, from
the "Full update" section of every transaction entity page:

> The request body must include all writable fields of the existing object as
> returned in a read response. **Writable fields omitted from the request body are
> set to NULL.**

Versus sparse update:

> Sparse updating provides the ability to update a subset of properties for a
> given object; only elements specified in the request are updated. **Missing
> elements are left untouched.**

`node-quickbooks` defaults to `sparse = true` (`index.js`, `module.update`), so a
full update only happens when the caller *explicitly* sets `sparse: false`.

### Sparse update handles line changes — including deletion

Earlier handlers assumed line modifications required a full update. **That is
false.** `Line` is an accepted attribute of the sparse update request body, and
supplying a complete `Line` array replaces the entire array.

Verified against the production company (2026-08-04) with a temporary
SalesReceipt, since deleted:

| Operation | `sparse: true` + full `Line` array | Result |
|-----------|------------------------------------|--------|
| Change line amounts | 2 lines, amounts `1/2` → `5/7` | applied; all header fields intact |
| Delete a line | shortened array, 2 lines → 1 | line deleted; all header fields intact |

So sparse update is strictly better: it does everything a full update does for
lines, and cannot null a field you forgot to copy.

### Which fields actually get nulled

Not every omitted field is lost — QuickBooks re-derives some from company or
vendor defaults. Verified in production by round-tripping temporary records
through a full update built from the old whitelists:

| Field | Full update result |
|-------|--------------------|
| `SalesReceipt.CustomerRef` | **LOST** — silently cleared |
| `Purchase.Credit` | **LOST** — `true` → `false`, so a card refund becomes a charge |
| `Bill.SalesTermRef` | **LOST** |
| `Bill.APAccountRef` | survives (re-defaulted) |
| `CurrencyRef`, `PrintStatus`, `EmailStatus`, `ApplyTaxAfterDiscount`, `CustomField` | survive (re-defaulted) |

`Purchase.Credit` is the one with a dollar impact: dropping it flips the sign of
a credit-card refund. Note `Credit` is only settable when
`PaymentType` is `CreditCard`; QBO silently ignores it for `Cash`/`Check`.

`SalesReceipt.CustomerRef` is nominally **required** per Intuit's docs, yet a
full update omitting it is accepted and clears the field rather than erroring —
which is why this failed silently for so long.

### Real-world damage

This was found in the wild, not in review. Sales receipts created correctly by
an automated importer lost their customer after a single later line edit —
identifiable by `SyncToken 1` on a record whose customer is now empty while its
siblings still have theirs.

Only the customer link was lost; GL lines were untouched, so the P&L and balance
sheet were unaffected. That is what made it survive so long: nothing failed to
balance, and no report errored — the link was simply gone.

### Rule for handlers

Do **not** hand-maintain a list of header fields to copy on update. A whitelist
can never be proven complete, and each omission is silent. Use `sparse: true`
and send only what is changing, plus the entity's required-for-sparse fields
below and a complete `Line` array when lines change.

## Deposited Transactions Cannot Be Edited At All

A sales receipt or payment that has been swept into a Deposit is frozen. Every
update is rejected, sparse or full, even one touching a single header field:

```json
{
  "Fault": {
    "Error": [{
      "Message": "Deposited Transaction cannot be changed",
      "Detail": "This transaction has been deposited. If you want to change or delete it, you must edit the deposit it appears on and remove it first",
      "code": "6540"
    }],
    "type": "ValidationFault"
  }
}
```

The transaction still reads back with `DepositToAccountRef` pointing at
Undeposited Funds; the giveaway is a `LinkedTxn` entry of type `Deposit`:

```json
"LinkedTxn": [{ "TxnId": "123", "TxnType": "Deposit" }]
```

Check for that before attempting an edit, so the failure can be reported as a
business-rule conflict rather than a generic HTTP 400.

### Consequence for repairs

Damage done to a transaction *before* it was deposited cannot be undone through
the API afterwards. Undoing it means removing the transaction from its deposit,
editing it, then putting it back — which changes a deposit that may already be
reconciled against a bank statement. Weigh that against the size of the defect;
a cosmetic field is rarely worth re-opening a completed reconciliation.

## Sparse Update Required Fields

When performing sparse updates (`sparse: true`), certain fields are **required** beyond just `Id` and `SyncToken`, even though you're only updating a subset of the entity.

| Entity | Required Fields | Notes |
|--------|-----------------|-------|
| **JournalEntry** | `Id`, `SyncToken` | Minimal requirements |
| **Bill** | `Id`, `SyncToken`, `VendorRef` | Must include vendor reference |
| **Purchase** (Expense) | `Id`, `SyncToken`, `PaymentType` | PaymentType cannot be changed, but must be included |

### Example Error

If you omit a required field like `PaymentType` on a Purchase update:

```json
{
  "Fault": {
    "Error": [{
      "Message": "Required param missing, need to supply the required value for the API",
      "Detail": "Required parameter PaymentType is missing in the request",
      "code": "2020",
      "element": "PaymentType"
    }],
    "type": "ValidationFault"
  }
}
```

### Implementation Notes

The MCP edit tools (`edit_journal_entry`, `edit_bill`, `edit_expense`) automatically include these required fields by:
1. Fetching the current entity state
2. Copying the required fields to the update payload
3. Applying only the requested changes

## Expense (Purchase) Department Limitations

### Single Department Per Expense

QBO expenses (Purchases) support only **one department at the header level**. While the API schema includes `DepartmentRef` on line-level `AccountBasedExpenseLineDetail`, the API rejects attempts to set line-level departments when lines are added or modified (error: "failed to parse json object; a property specified is unsupported or invalid").

This means an expense transaction **cannot be split across multiple departments**. If a single vendor charge covers multiple locations (e.g., a $59.98 SimpliSafe charge for two stores), it cannot be represented as one expense with two department-tagged lines.

### Workarounds

1. **Split Bills (preferred for recurring)**: Use the bill-splitting workflow in the frontend to create separate bills per department from a single vendor invoice. Each bill gets its own header-level department.

2. **Reclassification Journal Entry (for corrections)**: When expenses are already recorded under the wrong department, create a JE to move the amounts:
   - Debit the expense account in the correct department
   - Credit the expense account in the incorrect department

3. **Separate Expenses**: Manually create individual expense records per department (loses the connection to the single bank/card transaction).

### edit_expense Full Update Bug (Historical)

`edit_expense` used to strip `DepartmentRef` and `EntityRef` on any line edit,
because its full update did not copy them. Those two fields were added to the
copy list in 190ea93, and the handler now uses a sparse update, so line edits no
longer clear them.

Kept here as the first known instance of the whitelist problem described in
[Full Update Nulls Omitted Fields](#full-update-nulls-omitted-fields--always-prefer-sparse).
It was patched by adding the two missing fields rather than by removing the
whitelist, so the same bug resurfaced later on `SalesReceipt.CustomerRef`. Prefer
sparse updates over extending a copy list.

## Delete Takes Id + SyncToken Only — Never Echo A Read

The `?operation=delete` endpoints accept a minimal body:

```json
{ "Id": "123", "SyncToken": "3" }
```

Posting back the entity exactly as it was read is **not** equivalent. A read
returns read-only extension blocks that QBO emits but refuses to accept as
input — `Purchase` carries a `PurchaseEx` whose entries name `javax.xml.bind`
JAXB scopes, and other entities have their own — so the round trip fails
validation with an HTTP 400 that never mentions the block by name.

This matters because of how `node-quickbooks` branches on its argument:

```js
module.delete = function (context, entityName, idOrEntity, callback) {
  if (_.isObject(idOrEntity)) {
    // posted as-is
  } else {
    // re-reads the entity by id and posts the WHOLE entity back
  }
}
```

Passing the bare id string takes the second branch and reproduces the failure.
`delete_entity` therefore reads the entity itself (it needs the `SyncToken`, and
the preview needs the summary) and hands the delete method a fresh
`{ Id, SyncToken }` object, for every entity type — the extension blocks differ
per entity, the hazard does not.

## Entity Attribution Is Four Different Fields

"Which vendor/customer/employee is this for" is one column in the QBO UI and
four unrelated field shapes in the API. There is no uniform `EntityRef`, and a
payload built for one entity type is silently wrong on another — the transaction
saves and the name column comes back blank.

| Where | Field | Shape | Accepts |
|-------|-------|-------|---------|
| Deposit line | `DepositLineDetail.Entity` | `{ value, name, type: "VENDOR" }` | Vendor, Customer, Employee |
| Journal entry line | `JournalEntryLineDetail.Entity` | `{ Type: "Vendor", EntityRef: { value, name } }` | Vendor, Customer, Employee |
| Expense header | `Purchase.EntityRef` | `{ value, name, type: "Vendor" }` | Vendor, Customer, Employee |
| Bill / vendor credit / expense line | `AccountBasedExpenseLineDetail.CustomerRef` | `{ value, name }` | **Customer only** |
| Bill / vendor credit header | `VendorRef` | `{ value, name }` | Vendor only |
| Invoice / sales receipt header | `CustomerRef` | `{ value, name }` | Customer only |

Three things to note:

- **The `type` casing differs by entity.** Deposit lines round-trip an uppercase
  `VENDOR`/`CUSTOMER`/`EMPLOYEE`; `Purchase.EntityRef` uses PascalCase
  `Vendor`. Journal entries do not use a `type` attribute at all — the kind goes
  in a sibling `Type` field beside a nested `EntityRef`.
- **Expense-style lines take a customer and nothing else.** There is no
  vendor-on-a-bill-line. This is why those tools expose `customer_name` while
  deposits and journal entries expose `entity_name` + `entity_type`: the
  parameter names follow what the field can actually hold.
- **A journal entry line posting to A/R or A/P must carry an entity.** QBO
  rejects a receivable line with no customer and a payable line with no vendor.

`src/client/entity-refs.ts` holds the resolution and one shape adapter per
target, so a handler never has to remember which of the four it is writing.

### Setting a CustomerRef can make a line billable

`AccountBasedExpenseLineDetail.CustomerRef` and `BillableStatus` travel
together. A line given a customer with no explicit `BillableStatus` can default
to `Billable`, which queues the cost to be re-invoiced to that customer — a real
accounting change, not a labelling one. These tools write `NotBillable`
alongside any customer they set (and leave an existing `Billable` alone on
edit), because they attribute cost rather than bill it.

## An Expense Line Posts Against An Account Or An Item, Never Both

`Bill.Line` and `Purchase.Line` accept two line shapes, and a line is exactly
one of them:

| Detail type | Carries |
|-------------|---------|
| `AccountBasedExpenseLineDetail` | `AccountRef`, `ClassRef`, `CustomerRef`, `BillableStatus`, `DepartmentRef` (rejected on write — see above) |
| `ItemBasedExpenseLineDetail` | `ItemRef`, `Qty`, `UnitPrice`, `ClassRef`, `CustomerRef`, `BillableStatus` |

`ClassRef` sits **inside the line detail**, on both shapes — it is not a header
field, and it is unrelated to the header-level `DepartmentRef`. A property-management
book tagging each line with a class for per-property P&L is the common case.

A name that looks like an account may be an item: `Utilities:Water & Sewer` can
be an item's `FullyQualifiedName` whose own `ExpenseAccountRef` points at a plain
`Utilities` account. Resolving it as an account "works" and silently loses the
item tracking, which is why `item_name` and `account_name` are separate
parameters here and a line naming both is rejected rather than resolved by
precedence.

### `Amount` is validated against `Qty` × `UnitPrice`, not derived from it

QBO computes `Qty × UnitPrice` at the precision sent, rounds that product to the
cent, and compares it to `Amount`. A mismatch is fault **6070** ("Amount is not
equal to UnitPrice*Qty").

The counter-intuitive consequence: **rounding `UnitPrice` to cents is what causes
6070**, not what avoids it.

```
amount 100.00 / qty 3 -> UnitPrice 33.333333  x 3 = 99.999999 -> 100.00  accepted
                         UnitPrice 33.33      x 3 =     99.99 ->  99.99  REJECTED 6070
```

So a derived unit price keeps its extra precision. `resolveItemLineAmount`
(`src/utils/item-line.ts`) owns this for every item-line path in this server —
invoice, sales receipt, bill and expense — and asserts the product reconciles
before returning rather than letting QBO discover it. Handlers must not
re-derive or re-guard the arithmetic.

Two consequences worth knowing:

- **Editing an item line must move `Amount` and `UnitPrice` together.** Changing
  only the amount leaves a stale `UnitPrice` whose product no longer matches, and
  the edit is rejected.
- **A very large `Qty` can be refused locally.** The helper bounds derived unit
  prices to 6 decimal places, and past roughly 10,000 units the per-unit rounding
  error accumulates beyond half a cent. Supplying `unit_price` directly does not
  help — it accepts only 2 decimals. The remedy is to split the line.

Caveat on provenance: the rounding behaviour above is established for
`SalesItemLineDetail` and assumed to hold for `ItemBasedExpenseLineDetail`. No
source found distinguishes them, and it has not yet been probed against a
sandbox for the expense-line case.

## Sales Receipt And Invoice Lines Have No Entity

`SalesItemLineDetail` carries `ItemRef`, `ClassRef`, and tax fields — there is
no per-line customer or entity. The customer is the header `CustomerRef` and
applies to the whole transaction. `create_sales_receipt`, `edit_sales_receipt`,
`create_invoice`, and `edit_invoice` therefore expose `customer_name` at header
level only; the absence of a line-level parameter is the API's shape, not a gap
in the tools.

`create_bill_payment` is the same story: its lines are `LinkedTxn` references to
the Accounts Payable transactions being applied (bills, vendor credits and the
other types under "Bill Payment Lines" below), and the payee is the header
`VendorRef`.

## Report Payloads Do Not Describe Themselves

Everything below was found by running all 29 `report*` methods against a live US
company and comparing the payload to what the report actually means. None of it
is stated in Intuit's docs.

### The General Ledger `Amount` column is signed by balance movement, not by side

A positive `Amount` means the account's running balance went **up**; a negative
one means it went down. This held for every account tested, in every
classification — the sign says nothing about debit or credit on its own.

Which side that is depends on the account's normal balance:

| Classification | Balance up | Balance down |
|---|---|---|
| Asset, Expense | **debit** | credit |
| Liability, Equity, Revenue | **credit** | debit |

So a single fixed mapping from sign to side is right for half the chart of
accounts and backwards for the other half. `parseGLReport` in
`src/tools/handlers/account-period-summary.ts` treated negative as debit
unconditionally, which is correct for liability, equity and revenue accounts and
inverted for asset and expense ones — every bank account included. An expense
account with a month of spending was reported as carrying that spending in
*credits*.

Note that only the **labels** were affected. `netActivity` is the signed sum
either way, and closing balance is opening plus that sum, so both were correct
throughout; it is the split into debits and credits that swapped.

The running `Balance` column is the way to check this without trusting `Amount`:
compare consecutive balances and see which direction a positive amount moves
them. A balance sheet as of each end of the window confirms it independently.

### A report may fill more cells than it declares columns for

`Columns.Column` is not a reliable description of the rows. Sales by item
declares **two** columns and returns **eight** cells per row. Anything that
renders a report by walking the declared column list will silently drop every
value past the last declared column — a wrong answer, not a formatting problem.
Size a table by the widest row as well as by the header list.

### Free-text cells contain the newlines the user typed

Memo and description columns come back with embedded newlines — one cell in a
single month's transaction list spanned 32 lines. Any layout that assumes one
line per row breaks: values land under the wrong heading, and a row-count cap
stops bounding the output. Collapse whitespace before laying a report out.

### A date range on a point-in-time report answers as of *today*

The aging and balance reports (`AgedPayables`, `AgedReceivables`,
`CustomerBalance`, `VendorBalance`) are dated by `report_date`. Given
`start_date`/`end_date` instead, QBO does not error and does not ignore the
request — it returns the report as of today, with `EndPeriod` set to today's
date rather than the range's end. A caller asking for a March aging silently
gets one dated now. `AccountList` is undated entirely and ignores both.

`InventoryValuationSummary` is different: which parameter dates it depends on
the company's costing method. On an **average-cost** company it is dated by
`report_date`; on a **FIFO** company it is dated only by `start_date`/`end_date`.
A lone `report_date` on a FIFO company, or a lone range on an average-cost one,
answers as of today with no error. Sending all three — `report_date`, a
`start_date` at the beginning of the books and an `end_date` — dates it on both
kinds of company, and that is what `get_report` sends.

**Reading the applied date.** The date QBO applied is in `Header.EndPeriod`, or,
when `EndPeriod` is absent, in the `Header.Option` entry named `report_date`. An
undated balance report carries `DateMacro: "all"` in its header.

**Refusal.** `get_report`'s point-in-time reports and `get_balance_sheet` (when
given `as_of_date`) state the applied date on an `As of` line and refuse a report
whose stated date differs from the request, instead of returning today's figures
under the requested date. A header that states no date is not refused; the
`As of` line says it was not stated.

**Tolerance.** A FIFO valuation total differs from the Balance Sheet inventory
asset by cents, so any comparison between the two needs a tolerance rather than
exact equality.

### Two report methods do not work on a US company

`reportTrialBalanceFR` and `reportTaxSummary` both answer HTTP 400 —
region-specific reports with no US equivalent. The other 27 return data.

### Report criteria are concatenated into the URL unencoded

`module.reportCriteria` in node-quickbooks builds the query string with
`s += p + '=' + criteria[p] + '&'` and no escaping whatsoever. A criterion value
containing `&` or `=` does not arrive as a value — it adds criteria of its own,
and a `#` truncates the query string at the fragment. Resolve names to ids where
possible, and validate any free-text value before passing it. Note that
`resolveDepartmentId` returns an unmatched name *unchanged* for QBO to reject,
so it is not a safe source of ids on its own; `resolveCustomer` and
`resolveVendor` throw instead.

## Attachable (Attachments) Quirks

Attachments are the `Attachable` entity. A file upload and a text note are the
same entity; a note simply has no file. These items come from Intuit's
[Attachable reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/attachable)
and [attach images and notes workflow](https://developer.intuit.com/app/developer/qbo/docs/workflows/attach-images-and-notes).
Intuit's own pages could not be read in full while this was written, so the
`TempDownloadUri` lifetime and the upload part layout also rely on secondary
mirrors ([CData Attachables table](https://cdn.cdata.com/help/RNM/odbc/pg_table-attachables.htm),
[CData UploadAttachment](https://cdn.cdata.com/help/RNN/cis/pg_sp-uploadattachment.htm)).

### Documented

- **Find attachments by linked entity** with a query on the nested reference.
  The type is the lowercase QBO type and the value is the numeric id:

  ```
  select * from Attachable where AttachableRef.EntityRef.Type = 'bill' and AttachableRef.EntityRef.value = '42'
  ```

  (Intuit Attachable reference.)
- **Delete takes `Id` + `SyncToken` only**, the same minimal body described in
  the delete section above. `delete_entity` accepts `entity_type: attachable`.
  (Intuit Attachable reference.)
- **`Category` is one of seven values**: Contact Photo, Document, Image,
  Receipt, Signature, Sound, Other. (Intuit Attachable reference.)
- **`TempDownloadUri` expires after roughly 15 minutes.** It is a signed,
  short-lived link to the file, so fetch it right before downloading and never
  store it. (CData Attachables table, secondary mirror.)
- **An upload is a multipart request** with a `file_metadata_01` JSON part
  carrying `FileName`, `ContentType` and `AttachableRef`, plus a
  `file_content_01` part. (Intuit workflow; CData UploadAttachment.)

### Updates are full updates

Intuit documents Attachable updates as full updates: a writable field left out
of the body is nulled. The read-only fields (`Size`, `TempDownloadUri`,
`FileAccessUri`, `ThumbnailTempDownloadUri`, `MetaData`, any extension block)
are rejected if echoed back.

The writable fields are `FileName`, `Note`, `Category`, `ContentType`, `Tag`,
`Lat`, `Long`, `PlaceName` and `AttachableRef` (each ref: `EntityRef`
`{type, value}`, optional `IncludeOnSend`, optional `LineInfo`).

### Rule for handlers

Fetch the current attachment, merge the requested changes onto it, then send
only `Id`, `SyncToken` and the writable fields. Never send a partial body (it
nulls the rest) and never echo the read.

### Confirmed in a sandbox company

Each of these was checked against a sandbox company through the tools
themselves, then cross-checked by reading the Attachable back:

- **The type filter is case-insensitive.** `AttachableRef.EntityRef.Type = 'bill'`
  and `= 'Bill'` return the same attachment. The handlers send the lowercase
  form Intuit documents.
- **An update replaces `AttachableRef`; it does not merge.** Sending the list
  without one link removes that link, so `edit_attachment` always sends the
  complete merged list.
- **The upload's linking update keeps everything it sends.** After
  `upload_attachment`, the follow-up update (`Id`, `SyncToken`, `FileName`,
  `ContentType`, `AttachableRef`, `Note`, `Category`) leaves the file name and
  content type intact and sets the note and category.
- **An edit that sends every writable field preserves the unchanged ones.**
  Changing only the note left `FileName`, `ContentType` and `Category` as
  they were.

### Unconfirmed — verify in the sandbox

Not established by the sources above or the sandbox check. Tick each off after
testing against a sandbox company, and move the result into a section above:

- [ ] Does a `file_metadata_01` part honor `Note` and `Category` on upload? The
      handlers do not use one: they set both in the linking update instead.
- [ ] What is the official maximum file size?
- [ ] What is the official list of accepted file types?

## Preferences (Closing Date)

`get_preferences` reads the company's `Preferences` object. `getPreferences()`
returns it bare: ten `*Prefs` sections plus `Id`, `SyncToken` and `MetaData`.

- **Is this period closed?** `AccountingInfoPrefs.BookCloseDate` is a
  `YYYY-MM-DD` string. The key is **omitted** when no closing date is set, so
  absence means "none set", not an empty value.
- **The API cannot write it.** Intuit's schema, as mirrored by third-party
  references, lists the closing date as read-only. This was not confirmed
  against Intuit's own page.
- **The closing-date password is not in the payload.** Confirmed in a sandbox
  company with a closing date and password set, at `minorversion=75` (the
  node-quickbooks default the client sends). The check was a value-level search
  over every key and value of both `getPreferences()` and
  `select * from Preferences` (also with `STARTPOSITION`/`MAXRESULTS`), with the
  closing date as a positive control that the search did find. Because of this,
  `get_preferences` has no redaction step and passes the object through
  unmodified.

## Bill Payment Lines Link Any A/P Transaction

A `BillPayment` line carries one `LinkedTxn` (`TxnId`, `TxnType`) and a positive
`Amount`. The line type is not limited to bills: `create_bill_payment` accepts
`Bill`, `VendorCredit`, `JournalEntry` and `Deposit`, and `get_bill_payment`
signs those and `Purchase` with the same rules. The header `TotalAmt` is
charge-side lines minus credit-side lines, so it is never the sum of the
`Amount`s once a credit is applied.

The side is never supplied by the caller. It follows from how the linked
transaction posts to Accounts Payable for the vendor (positive credits A/P,
negative debits A/P):

| `TxnType` | Side | Open amount |
|-----------|------|-------------|
| `Bill` | charge | `Balance` |
| `VendorCredit` | credit | `Balance`, else `TotalAmt` |
| `JournalEntry` | A/P lines for the vendor net to a Credit: charge. Net to a Debit: credit | \|net\| minus amount already applied |
| `Deposit` | an A/P line naming the vendor (e.g. a vendor refund): charge | \|sum\| minus amount already applied |
| `Purchase` (reads only) | A/P expense line: credit. `Credit: true` (credit-card credit): charge | \|sum\| minus amount already applied |

### $0 payment shape

A bill payment whose credits fully offset its charges has `TotalAmt` 0 and needs
no bank account. QBO stores one as `PayType: "Check"` with
`CheckPayment: { PrintStatus: "NotSet" }` and no `BankAccountRef`. The tool sends
that shape when `payment_account` is omitted and the total is $0, and requires
`payment_account` for any total above $0.

### How open amounts are derived

`Bill` and `VendorCredit` carry their own `Balance`. `JournalEntry`, `Deposit`
and `Purchase` carry none, and only a JournalEntry lists its applying
bill payments. So the tool queries the vendor's bill payments
(`select * from BillPayment where VendorRef = '<id>'`), sums each line's
`Amount` per `(TxnType, TxnId)`, and subtracts that from the transaction's A/P
magnitude for the vendor. On create the query runs only when a `JournalEntry` or
`Deposit` is requested, because `Purchase` is refused before any read. A scan
that hits the safety limit is an error, never a partial total.

### Documented

- Intuit's minor-version-38 linked-transaction notes list `Bill`,
  `VendorCredit`, `JournalEntry` and `Deposit` as `BillPayment` line links
  supported through the API.
- Read-only observation of existing company data showed all five types above on
  `BillPayment` lines (`Purchase` only on UI-created payments), every line
  `Amount` positive, and $0 `Check` payments whose `CheckPayment` has only
  `PrintStatus`.

### Verified

Proven through the API on the production company (2026-10-07, owner-approved):
`create_bill_payment` with `draft: false` created a BillPayment, a $0
`Check` payment with no `BankAccountRef` whose lines link four `Bill`s (charges)
and one `JournalEntry` (credit, from that JE's single A/P debit for the vendor).
`get_bill_payment` read it back unchanged and every bill's `Balance` went to 0.
So these are accepted on create:

- A `BillPayment` line with `LinkedTxn` `TxnType: "JournalEntry"`.
- A $0 `BillPayment` with `CheckPayment: { PrintStatus: "NotSet" }` and no
  `BankAccountRef`.

### Verified: Purchase links are not applied through the API

Checked in a sandbox company (2026-10-07) with a bill and an equal `Purchase`
holding an Accounts Payable expense line for the same vendor, both linked from
one `BillPayment`:

- With `CheckPayment.BankAccountRef`: HTTP 200, with a response `TotalAmt` equal
  to the bill and one line linking the bill. The `Purchase` line is dropped, the
  bill's balance goes to 0 and the `Purchase` is untouched, so a real payment of
  the bill amount is booked.
- Without `BankAccountRef`: rejected with ValidationFault 6000.
- `TxnType` `Check` or `Expense`: the same result, for `Purchase`s of every
  `PaymentType`.
- Linking from the `Purchase` side (header or line `LinkedTxn`, on create or
  sparse update): accepted and ignored.

`create_bill_payment` therefore refuses `Purchase` before any read or write.
`get_bill_payment` still classifies the `Purchase` lines that UI-created payments
carry.

### Verified: unallocated credit-card BillPayment create variants rejected

**REJECTED IN TESTED SANDBOX** (2026-10-09). Checked in Test Advanced Company
(realm `4620816365341983180`) through direct HTTPS Accounting API v3 requests
using Bun `fetch`, on `sandbox-quickbooks.api.intuit.com`, `minorversion=75`.
A successful CompanyInfo read established sandbox identity before writes.
The requests bypassed connector/MCP payload validation: all four rejections
came from QBO, not a local restriction.

The positive control used a disposable vendor (`59`), a $10 Bill (`258`) on
A/P account `488`, and a $10 `CreditCard` BillPayment (`259`) on card account
`410`. Create returned HTTP 200. Reading the payment back confirmed its pay
type, total, card account and single `LinkedTxn` to that Bill; the Bill's
balance changed from $10 to $0.

The main test used a separate, newly created vendor (`60`) with balance zero.
Queries confirmed no Bills, VendorCredits or BillPayments before the attempts,
preventing automatic application to existing vendor transactions.

All variants were POSTed to `/v3/company/4620816365341983180/billpayment?minorversion=75`.
This is the actual serialized body for variant A; B–D sent the same fields
with only the `Line` member added as shown below (`10` is JSON's numeric
representation of $10.00):

```json
{"VendorRef":{"value":"60"},"APAccountRef":{"value":"488"},"PayType":"CreditCard","CreditCardPayment":{"CCAccountRef":{"value":"410"}},"TotalAmt":10,"TxnDate":"2026-10-09","PrivateNote":"SBX-UNALLOC-14e2ad13-20261009T1846"}
```

Every response was HTTP 400, QBO error code `2020`, with the exact message:
`Required param missing, need to supply the required value for the API`.

| Variant | Actual `Line` member | Exact error `Detail` |
|---------|----------------------|----------------------|
| A | omitted | `Required parameter Line is missing in the request` |
| B | `"Line":[{"Amount":10}]` | `Required parameter LinkedTxn is missing in the request` |
| C | `"Line":[{"Amount":10,"LinkedTxn":[]}]` | `Required parameter LinkedTxn is missing in the request` |
| D | `"Line":[]` | `Required parameter Line is missing in the request` |

No variant returned a created ID. Subsequent queries still found no Bills,
VendorCredits or BillPayments for vendor `60`, whose balance remained zero.
There were no apparent successes to read back, ambiguous create outcomes or
blind retries.

Cleanup used fresh reads and SyncTokens, deleting payment `259` before Bill
`258` (both HTTP 200, subsequent reads fault `610`, `Object Not Found`), then
deactivating vendors `59` and `60`. Readback confirmed both vendors inactive
with zero balances; those two inactive master records remain. No session-created
transactions or cleanup failures remained, and the A/P, card and control expense
account balances matched their pre-test values. No production Accounting API
calls or real payment processing were performed.

**Scope of the finding:** these tested shapes cannot create a positive,
unallocated credit-card BillPayment before an applied transaction exists.
Do not rely on them for that export path. This is evidence for these payloads
and this sandbox/minor version, not a universal guarantee about every possible
payload; it does not establish that an applied transaction must specifically
be a Bill rather than another supported A/P transaction type.

### Unverified

Not yet proven through the API:

- Acceptance of `Deposit` links on a `BillPayment` created through the API. A
  dropped `Deposit` line would be caught by create's response check.
- Whether a JournalEntry with several A/P lines for the vendor is one netted link
  keyed by `(TxnType, TxnId)` rather than one link per line (`TxnLineId`).

### When QBO accepts a link but does not apply it

QBO can return 200 and drop a link, as it does for `Purchase`. After every create,
`create_bill_payment` compares the response's `TotalAmt` and each line's
`(TxnType, TxnId, Amount)` with what it sent, and reports any difference as an
error naming the payment and what was booked. It never deletes the payment.

A type shown not to apply gets a `createRefusal` in `LINK_KINDS` and stays in
`LINKED_TXN_TYPES`, because reads still classify it.

## Converting an Expense to a Bill Payment

In the QBO UI an existing expense or check (a `Purchase`) can be turned into a
bill payment by adding one of the vendor's open bills to it and saving. The UI
does this in place: the same transaction id is re-typed as a bill payment, its
account lines are dropped, and a link to the bill is added. That save goes
through the UI's internal endpoint, authorised by the browser session, not
through the public Accounting API.

### The public API cannot convert in place

Neither UI route works through the API (see "Verified: Purchase links are not
applied through the API" above):

- **Re-typing the Purchase.** A header or line `LinkedTxn` to a bill on a
  `Purchase` is accepted with HTTP 200 and ignored, on create and on sparse
  update, for every `PaymentType`.
- **Applying the expense on a bill payment.** A `BillPayment` line linking the
  `Purchase` is dropped, and QBO books only the bill line at the bill's amount.

The only API route to the same books is to create a `BillPayment` against the
bill and delete the `Purchase`. The result has a new transaction id, a new create
time and its own audit trail, and it takes writes that are not atomic.

### What `convert_expense_to_bill_payment` does

The tool is for explicit requests only. It accepts a single-line expense whose
line is coded to an Accounts Payable account, paid to a vendor, in home
currency, outside a closed period, and not already applied by another bill
payment. Every bill it applies must sit on that same A/P account, and the bill
amounts must add up to the expense total exactly. A Check or Cash expense becomes
a `PayType: "Check"` bill payment on the same bank account; a CreditCard expense
becomes `PayType: "CreditCard"` on the same card account.

On `draft: false` it re-reads and re-checks everything, then runs:

1. **Create** the bill payment.
2. **Verify** the response against what was sent: the booked total and lines,
   and the header fields (vendor, date, pay type, payment account, memo, and
   location and print status when sent).
3. **Move attachments** from the expense to the bill payment.
4. **Delete** the expense, with the SyncToken from this commit's own read.
5. **Set the ref no.** on the bill payment, when the expense had one.

Create comes first because its worst failure mode is visible and cheap: the
payment is counted twice in A/P and the payment account until one
`delete_entity` call resolves it. Deleting first would risk losing the expense
with no payment recorded in its place.

The tool stops at the first failure and undoes nothing. A failed create has
changed nothing and surfaces as an ordinary error. Every later stop returns an
error report headed `Expense Conversion Stopped`, naming the ids, what was and
was not done, where the payment is counted twice, and the call that finishes or
undoes it:

- **Bill payment not as previewed** (step 2): the expense is not deleted.
- **Attachments not moved** (step 3): the expense is not deleted.
- **Expense not deleted** (step 4).
- **Ref no. not set** (step 5): there is no edit tool for bill payments, so the
  report says to set it in QuickBooks.

Each report ends with "Do not re-run this conversion": once a bill is only
partly paid, a rerun would not be refused.

### Ref no. is set after the delete

A Check expense's `DocNumber` cannot be reused while the expense exists. Creating
a bill payment with the same number fails with fault 6140 (duplicate document
number), and the number space is shared between checks and bill payments.
Setting it on the bill payment with a sparse update after the delete works.

Whether Cash and CreditCard expenses collide the same way was not tested. The
tool sets the ref no. after the delete for every pay type, so the answer does not
matter.

### Verified in a sandbox company (2026-10-07)

- **A/P account is derived from the bill.** A bill payment created without
  `APAccountRef`, against a bill on a second A/P account, cleared that account
  and left the other A/P account untouched. `APAccountRef` is not echoed in the
  create response even when it is sent, so the tool does not send it and instead
  refuses a bill on a different A/P account from the expense line.
- **Print status carries over.** `CheckPayment.PrintStatus` is kept on create
  and survives the sparse update that sets the ref no.
- **Attachments outlive the delete.** Deleting a `Purchase` does not delete its
  Attachables; each keeps an `AttachableRef` to the deleted Purchase id. That is
  why the tool moves them to the bill payment before the delete. An Attachable
  re-linked by a full update that keeps its writable fields is listed on the bill
  payment.
- **Balances net out.** Converting a Check, Cash or CreditCard expense left the
  bill's `Balance` at 0 and the A/P and payment-account balances where they
  started.
- **A deleted Purchase reads back as fault 610.** So does a `Purchase` id the UI
  has re-typed into a bill payment. The tool reports a 610 on the expense as "not
  found — it may already have been converted or deleted".

### Unverified: location

`DepartmentRef` on a created bill payment is unverified: the sandbox has
location tracking off, and it could not be turned on through the Preferences
API. The tool sends the expense's `DepartmentRef` and its header check compares
the booked value with the one sent. A dropped or changed location stops the run
before the expense is deleted.

## References

- [Data Queries - Intuit Developer](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/data-queries)
- [Deep Dive into QuickBooks Online Data Queries](https://blogs.intuit.com/2017/02/08/deep-dive-sql-queries/)
- [Purchase API Reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/Purchase)
- [JournalEntry API Reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/journalentry)
- [Deposit API Reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/deposit)
- [Reports API Reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/generalledger)
- [Attachable API Reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/attachable)
