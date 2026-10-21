// Display-name holder lookup: QBO display names are one namespace across the
// Vendor, Customer and Employee lists, so a name is "held" if any of the three
// answers an exact query for it. Read-only; it never touches the lookup caches.

import type QuickBooks from "node-quickbooks";
import { promisify } from "./promisify.js";
import { withRetry } from "./throttle.js";
import { extractQueryResults } from "./cache.js";
import { ENTITY_KINDS } from "./refs.js";
import type { EntityKind } from "./refs.js";
import { mapWithConcurrency } from "../utils/index.js";

// One query per list; Intuit throttles per realm, so keep the fan-out bounded.
const HOLDER_QUERY_CONCURRENCY = 3;

/** A record that holds a display name: which list, its QBO Id, and the stored name. */
export interface DisplayNameHolder {
  type: EntityKind;
  id: string;
  displayName: string;
}

type HolderRow = { Id: string; DisplayName: string };

/**
 * Find the Vendor, Customer and Employee records that hold `displayName`.
 *
 * Facts verified against the QBO sandbox, which the queries rely on:
 * - `=` on DisplayName matches case-insensitively, so a holder's stored name may
 *   differ in case from the one asked for (the returned `displayName` is the
 *   stored one).
 * - Queries do not trim, so the name is trimmed here before it is sent.
 * - Inactive vendors are renamed "(deleted)" / "(deleted-1)" and release the
 *   name, so the default active-only query scope is the uniqueness scope and no
 *   `Active` criterion is sent. (Only vendors were probed; whether inactive
 *   customers and employees release theirs is unverified.)
 *
 * Results are ordered by `ENTITY_KINDS`, then in the order QBO returned them. A
 * failed lookup rejects with the original error rather than resolving to a list
 * that silently omits a name list it could not read.
 */
export async function findDisplayNameHolders(
  client: QuickBooks,
  displayName: string
): Promise<DisplayNameHolder[]> {
  // Known gap: node-quickbooks escapes `'` but not `\`, so a name containing a
  // backslash may not match. The handler's 6240 (duplicate name) fallback covers it.
  const criteria = [{ field: "DisplayName", value: displayName.trim(), operator: "=" }];

  const find = (kind: EntityKind, cb: (err: Error | null, result: unknown) => void): void => {
    switch (kind) {
      case "Vendor":
        return void client.findVendors(criteria, cb);
      case "Customer":
        return void client.findCustomers(criteria, cb);
      case "Employee":
        return void client.findEmployees(criteria, cb);
    }
  };

  const perKind = await mapWithConcurrency(ENTITY_KINDS, HOLDER_QUERY_CONCURRENCY, async (kind) => {
    const result = await withRetry(() => promisify<unknown>((cb) => find(kind, cb)));
    return extractQueryResults<HolderRow>(result, kind).map(
      (row): DisplayNameHolder => ({ type: kind, id: row.Id, displayName: row.DisplayName })
    );
  });

  return perKind.flat();
}
