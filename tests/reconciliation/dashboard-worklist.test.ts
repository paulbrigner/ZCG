import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorklistSortDirection } from "../../lib/admin/dashboard";

test("committee worklist defaults to least-to-most days outstanding", () => {
  assert.equal(normalizeWorklistSortDirection(undefined), "asc");
  assert.equal(normalizeWorklistSortDirection("unexpected"), "asc");
});

test("committee worklist accepts either supported sort direction", () => {
  assert.equal(normalizeWorklistSortDirection("asc"), "asc");
  assert.equal(normalizeWorklistSortDirection("desc"), "desc");
  assert.equal(normalizeWorklistSortDirection(["desc", "asc"]), "desc");
});
