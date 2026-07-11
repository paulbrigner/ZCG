const citationRangeLimit = 100;
const citationTokenPattern = /^\d+(?:\s*[–—-]\s*\d+)?(?:\s*,\s*\d+(?:\s*[–—-]\s*\d+)?)*$/;
const citationGroupPattern = /\d+(?:\s*[–—-]\s*\d+)?/g;

export type EvidenceCitationReference = number | { citationNumber: number };

function normalizedCitationNumber(reference: EvidenceCitationReference) {
  const value = typeof reference === "number" ? reference : reference.citationNumber;
  return Number.isInteger(value) && value > 0 ? value : null;
}

function citationSet(evidence: Iterable<EvidenceCitationReference>) {
  const citations = new Set<number>();

  for (const reference of evidence) {
    const citationNumber = normalizedCitationNumber(reference);

    if (citationNumber !== null) {
      citations.add(citationNumber);
    }
  }

  return citations;
}

export function safeEvidenceAnchorPrefix(value: string) {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.:]+|[-.:]+$/g, "");

  return normalized || "evidence";
}

function citationNumbers(tokenContent: string) {
  const numbers: number[] = [];

  for (const match of tokenContent.matchAll(citationGroupPattern)) {
    const range = match[0].match(/^(\d+)\s*[–—-]\s*(\d+)$/);

    if (!range) {
      numbers.push(Number(match[0]));
      continue;
    }

    const start = Number(range[1]);
    const end = Number(range[2]);
    const rangeLength = Math.abs(end - start) + 1;

    if (rangeLength > citationRangeLimit) {
      return null;
    }

    const first = Math.min(start, end);

    for (let offset = 0; offset < rangeLength; offset += 1) {
      numbers.push(first + offset);
    }
  }

  return numbers;
}

function linkedCitationToken(tokenContent: string, validCitations: Set<number>, anchorPrefix: string) {
  if (!citationTokenPattern.test(tokenContent)) {
    return null;
  }

  const citations = citationNumbers(tokenContent);

  if (!citations?.length || citations.some((citation) => !validCitations.has(citation))) {
    return null;
  }

  const linkedContent = tokenContent.replace(citationGroupPattern, (group) => {
    const firstNumber = Number(group.match(/^\d+/)?.[0]);
    return `[${group}](#${anchorPrefix}-${firstNumber})`;
  });

  return `[${linkedContent}]`;
}

function followsMarkdownLinkSyntax(value: string, closingBracketIndex: number) {
  const remainder = value.slice(closingBracketIndex + 1);
  return /^\s*(?:\(|\[|:)/.test(remainder);
}

function linkCitationTokens(value: string, validCitations: Set<number>, anchorPrefix: string) {
  let output = "";
  let cursor = 0;

  while (cursor < value.length) {
    const openingBracketIndex = value.indexOf("[", cursor);

    if (openingBracketIndex < 0) {
      output += value.slice(cursor);
      break;
    }

    output += value.slice(cursor, openingBracketIndex);
    const closingBracketIndex = value.indexOf("]", openingBracketIndex + 1);

    if (closingBracketIndex < 0) {
      output += value.slice(openingBracketIndex);
      break;
    }

    const token = value.slice(openingBracketIndex, closingBracketIndex + 1);
    const tokenContent = value.slice(openingBracketIndex + 1, closingBracketIndex);
    const previousCharacter = openingBracketIndex > 0 ? value[openingBracketIndex - 1] : "";
    const shouldLeaveUnchanged =
      previousCharacter === "\\" ||
      previousCharacter === "!" ||
      previousCharacter === "[" ||
      followsMarkdownLinkSyntax(value, closingBracketIndex);
    const linked = shouldLeaveUnchanged
      ? null
      : linkedCitationToken(tokenContent, validCitations, anchorPrefix);

    output += linked ?? token;
    cursor = closingBracketIndex + 1;
  }

  return output;
}

function exactBacktickRun(value: string, startIndex: number, runLength: number) {
  const delimiter = "`".repeat(runLength);
  let index = value.indexOf(delimiter, startIndex);

  while (index >= 0) {
    const before = index > 0 ? value[index - 1] : "";
    const after = value[index + runLength] ?? "";

    if (before !== "`" && after !== "`") {
      return index;
    }

    index = value.indexOf(delimiter, index + runLength);
  }

  return -1;
}

function linkOutsideInlineCode(value: string, validCitations: Set<number>, anchorPrefix: string) {
  let output = "";
  let cursor = 0;

  while (cursor < value.length) {
    const opening = value.slice(cursor).match(/`+/);

    if (!opening || opening.index === undefined) {
      output += linkCitationTokens(value.slice(cursor), validCitations, anchorPrefix);
      break;
    }

    const openingIndex = cursor + opening.index;
    const delimiterLength = opening[0].length;
    const closingIndex = exactBacktickRun(value, openingIndex + delimiterLength, delimiterLength);

    if (closingIndex < 0) {
      output += linkCitationTokens(value.slice(cursor), validCitations, anchorPrefix);
      break;
    }

    output += linkCitationTokens(value.slice(cursor, openingIndex), validCitations, anchorPrefix);
    output += value.slice(openingIndex, closingIndex + delimiterLength);
    cursor = closingIndex + delimiterLength;
  }

  return output;
}

type Fence = {
  marker: "`" | "~";
  length: number;
};

function openingFence(value: string): Fence | null {
  const match = value.match(/^ {0,3}(`{3,}|~{3,})/);

  if (!match) {
    return null;
  }

  return {
    marker: match[1][0] as Fence["marker"],
    length: match[1].length
  };
}

function closesFence(value: string, fence: Fence) {
  const match = value.match(/^ {0,3}(`+|~+)[ \t]*$/);
  return Boolean(
    match &&
    match[1][0] === fence.marker &&
    match[1].length >= fence.length
  );
}

/**
 * Converts valid numbered evidence references into fragment-only Markdown links.
 *
 * A grouped citation such as `[1, 3-4]` becomes
 * `[[1](#report-evidence-1), [3-4](#report-evidence-3)]`, preserving its rendered
 * grouping and range notation. If any referenced evidence number is unavailable,
 * the original citation is returned unchanged.
 */
export function linkEvidenceCitationsInMarkdown(
  markdown: string,
  validCitationNumbers: Iterable<EvidenceCitationReference>,
  anchorPrefix: string
) {
  if (!markdown) {
    return markdown;
  }

  const validCitations = citationSet(validCitationNumbers);

  if (!validCitations.size) {
    return markdown;
  }

  const safeAnchorPrefix = safeEvidenceAnchorPrefix(anchorPrefix);
  const lines = markdown.match(/.*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [markdown];
  let fence: Fence | null = null;

  return lines.map((line) => {
    const body = line.replace(/(?:\r\n|\n|\r)$/, "");
    const lineEnding = line.slice(body.length);

    if (fence) {
      if (closesFence(body, fence)) {
        fence = null;
      }

      return line;
    }

    const nextFence = openingFence(body);

    if (nextFence) {
      fence = nextFence;
      return line;
    }

    if (/^(?: {4}|\t)/.test(body)) {
      return line;
    }

    return `${linkOutsideInlineCode(body, validCitations, safeAnchorPrefix)}${lineEnding}`;
  }).join("");
}
