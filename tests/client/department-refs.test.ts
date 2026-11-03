// Shared department resolver: findDepartment, resolveDepartmentRef and the
// tri-state resolveDepartmentInput.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";
import {
  clearLookupCache,
  getDepartmentCache,
  findDepartment,
  resolveDepartmentRef,
  resolveDepartmentInput,
  CLEARED_REF,
} from "../../src/client/index.js";
import {
  DEPARTMENTS,
  departmentFinders,
  type FixtureDepartment,
} from "../tools/department-fixtures.js";

async function cacheFor(departments: FixtureDepartment[] = DEPARTMENTS) {
  return getDepartmentCache(departmentFinders(departments) as unknown as QuickBooks);
}

const NORTH = { value: "2", name: "North" };
const SOUTH = { value: "3", name: "South" };

describe("findDepartment", () => {
  beforeEach(() => clearLookupCache());

  it("dept-find-precedence: Id, then exact name, then partial", async () => {
    const cache = await cacheFor();
    assert.equal(findDepartment(cache, "3")?.Name, "South");
    assert.equal(findDepartment(cache, "sOuTh")?.Id, "3");
    assert.equal(findDepartment(cache, "east")?.Name, "North East");
    // Exact name beats the earlier partial hit on "North East".
    assert.equal(findDepartment(cache, "North")?.Id, "2");
  });

  it("dept-find-blank-matches-nothing: blank input returns undefined", async () => {
    const cache = await cacheFor();
    assert.equal(DEPARTMENTS[0].Name.includes(" "), true);
    assert.equal(findDepartment(cache, ""), undefined);
    assert.equal(findDepartment(cache, " "), undefined);
    assert.equal(findDepartment(cache, "   "), undefined);
  });

  it("dept-find-trims-padded-name: surrounding spaces are ignored", async () => {
    const cache = await cacheFor();
    assert.equal(findDepartment(cache, " North ")?.Id, "2");
  });

  it("dept-find-id-beats-name: an Id match wins over another department's name", async () => {
    const cache = await cacheFor([
      { Id: "7", Name: "Alpha", FullyQualifiedName: "Alpha" },
      { Id: "8", Name: "7", FullyQualifiedName: "7" },
    ]);
    assert.equal(findDepartment(cache, "7")?.Id, "7");
  });
});

describe("resolveDepartmentRef", () => {
  beforeEach(() => clearLookupCache());

  it("dept-ref-miss-throws: a miss quotes the input, a hit returns value and name", async () => {
    const cache = await cacheFor();
    assert.deepEqual(resolveDepartmentRef(cache, "South"), SOUTH);
    assert.throws(
      () => resolveDepartmentRef(cache, "Nowhere"),
      { message: 'Department not found: "Nowhere"' }
    );
  });
});

describe("resolveDepartmentInput", () => {
  beforeEach(() => clearLookupCache());

  it("dept-input-three-way: absent is undefined, blank is null, a name is a ref", async () => {
    const cache = await cacheFor();
    assert.equal(resolveDepartmentInput(cache, {}), undefined);
    assert.equal(resolveDepartmentInput(cache, { department_name: "" }), null);
    assert.equal(resolveDepartmentInput(cache, { department_name: " " }), null);
    assert.deepEqual(resolveDepartmentInput(cache, { department_name: "North" }), NORTH);
  });

  it("dept-input-id-precedence: department_id wins over department_name, even when blank", async () => {
    const cache = await cacheFor();
    assert.deepEqual(
      resolveDepartmentInput(cache, { department_id: "South", department_name: "North" }),
      SOUTH
    );
    assert.equal(
      resolveDepartmentInput(cache, { department_id: "", department_name: "North" }),
      null
    );
  });

  it("dept-input-label-prefix: a labelled miss is prefixed, an unlabelled one is bare", async () => {
    const cache = await cacheFor();
    assert.throws(
      () => resolveDepartmentInput(cache, { department_name: "Nowhere" }, "Line 1"),
      { message: 'Line 1: Department not found: "Nowhere"' }
    );
    assert.throws(
      () => resolveDepartmentInput(cache, { department_name: "Nowhere" }),
      { message: 'Department not found: "Nowhere"' }
    );
  });
});

describe("CLEARED_REF", () => {
  it("is a frozen { value: \"\" }", () => {
    assert.deepEqual(CLEARED_REF, { value: "" });
    assert.equal(Object.isFrozen(CLEARED_REF), true);
  });
});
