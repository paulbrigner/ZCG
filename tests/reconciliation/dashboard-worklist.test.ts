import assert from "node:assert/strict";
import test from "node:test";
import { normalizeApplicationSort, normalizeWorklistSortDirection } from "../../lib/admin/dashboard";

test("committee worklist defaults to least-to-most application age", () => {
  assert.equal(normalizeWorklistSortDirection(undefined), "asc");
  assert.equal(normalizeWorklistSortDirection("unexpected"), "asc");
});

test("application registry sort is allowlisted and defaults to oldest", () => {
  assert.equal(normalizeApplicationSort(undefined), "oldest");
  assert.equal(normalizeApplicationSort("funding_desc"), "funding_desc");
  assert.equal(normalizeApplicationSort(["title", "newest"]), "title");
  assert.equal(normalizeApplicationSort("ga.updated_at desc; drop table grant_applications"), "oldest");
});

test("committee worklist accepts either supported sort direction", () => {
  assert.equal(normalizeWorklistSortDirection("asc"), "asc");
  assert.equal(normalizeWorklistSortDirection("desc"), "desc");
  assert.equal(normalizeWorklistSortDirection(["desc", "asc"]), "desc");
});
