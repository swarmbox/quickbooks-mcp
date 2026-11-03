// Invented department fixtures for the department resolver tests and for the
// caller tasks' fake clients (this repository is public — CLAUDE.md).
//
// The first entry has a space in its name on purpose: an untrimmed " " would
// partial-match it, so a resolver that forgets to trim or to reject blank input
// is detectable. `North` is a prefix of `North East`, so an exact-name hit that
// loses to a partial one is detectable too.
//
// This is a fixture module, not a test file.

export interface FixtureDepartment {
  Id: string;
  Name: string;
  FullyQualifiedName: string;
}

export const DEPARTMENTS: FixtureDepartment[] = [
  { Id: "1", Name: "North East", FullyQualifiedName: "North East" },
  { Id: "2", Name: "North", FullyQualifiedName: "North" },
  { Id: "3", Name: "South", FullyQualifiedName: "South" },
];

type Callback<T> = (err: unknown, result: T) => void;

/**
 * A `findDepartments` that answers with `departments`, shaped like the QBO
 * query response. Spread it into a fake client:
 * `{ ...departmentFinders(), findVendors: ... }`.
 */
export function departmentFinders(departments: FixtureDepartment[] = DEPARTMENTS): {
  findDepartments: (criteria: unknown, cb: Callback<unknown>) => void;
} {
  return {
    findDepartments: (_criteria, cb) =>
      cb(null, { QueryResponse: { Department: departments } }),
  };
}
