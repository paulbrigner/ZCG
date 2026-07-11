import assert from "node:assert/strict";
import test from "node:test";
import {
  linkEvidenceCitationsInMarkdown,
  safeEvidenceAnchorPrefix
} from "../../lib/knowledge/presentation";

function link(markdown: string, evidence: Array<number | { citationNumber: number }> = [1, 2, 3, 4]) {
  return linkEvidenceCitationsInMarkdown(markdown, evidence, "grant-analysis-evidence-report-1");
}

test("links a valid citation to an internal evidence fragment", () => {
  assert.equal(
    link("The application requests $50,000 [1]."),
    "The application requests $50,000 [[1](#grant-analysis-evidence-report-1-1)]."
  );
});

test("preserves grouped and ranged citation display while linking each group", () => {
  assert.equal(
    link("Supported by the application and discussion [1, 3-4]."),
    "Supported by the application and discussion [[1](#grant-analysis-evidence-report-1-1), [3-4](#grant-analysis-evidence-report-1-3)]."
  );
  assert.equal(
    link("Descending source range [4—2]."),
    "Descending source range [[4—2](#grant-analysis-evidence-report-1-4)]."
  );
});

test("leaves an entire citation unchanged when any referenced evidence is unresolved", () => {
  assert.equal(link("Mixed evidence [1, 5]."), "Mixed evidence [1, 5].");
  assert.equal(link("Oversized range [1-500].", Array.from({ length: 500 }, (_, index) => index + 1)), "Oversized range [1-500].");
});

test("accepts evidence records and ignores invalid citation numbers", () => {
  assert.equal(
    linkEvidenceCitationsInMarkdown(
      "Evidence [2], invalid [0].",
      [{ citationNumber: 2 }, { citationNumber: 0 }, -1],
      "evidence"
    ),
    "Evidence [[2](#evidence-2)], invalid [0]."
  );
});

test("does not link citations inside fenced, indented, or inline code", () => {
  const markdown = [
    "Outside [1].",
    "",
    "```text",
    "inside [1]",
    "```",
    "",
    "~~~",
    "also inside [2]",
    "~~~",
    "",
    "    indented [3]",
    "Inline `[4]` and ``code [2]`` but outside [3]."
  ].join("\n");
  const expected = [
    "Outside [[1](#grant-analysis-evidence-report-1-1)].",
    "",
    "```text",
    "inside [1]",
    "```",
    "",
    "~~~",
    "also inside [2]",
    "~~~",
    "",
    "    indented [3]",
    "Inline `[4]` and ``code [2]`` but outside [[3](#grant-analysis-evidence-report-1-3)]."
  ].join("\n");

  assert.equal(link(markdown), expected);
});

test("does not alter existing Markdown links, images, definitions, or escaped citations", () => {
  const markdown = [
    "Existing [1](https://example.test) and reference [2][source].",
    "![3](image.png)",
    "[4]: https://example.test/reference",
    String.raw`Escaped \[1] remains literal.`
  ].join("\n");

  assert.equal(link(markdown), markdown);
});

test("is idempotent", () => {
  const once = link("Evidence [1, 2-3].");
  assert.equal(link(once), once);
});

test("sanitizes anchor prefixes so generated links remain local fragments", () => {
  assert.equal(safeEvidenceAnchorPrefix(" report id](https://evil.test) "), "report-id-https:-evil.test");
  assert.equal(safeEvidenceAnchorPrefix("---"), "evidence");
  assert.equal(
    linkEvidenceCitationsInMarkdown("Evidence [1].", [1], ") https://evil.test ("),
    "Evidence [[1](#https:-evil.test-1)]."
  );
});
