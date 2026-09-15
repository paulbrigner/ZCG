import { htmlToPlainText } from "@/lib/source-mirroring/forum";

type Node = { tag: string; start: number; openEnd: number; end: number; parent: Node | null; children: Node[] };
type Link = { url: string; title: string; htmlOffset: number | null };
export type AgendaSection = { title: string; sections: Array<{ title: string; text: string }> };

// Discourse cooked HTML is balanced, sanitized HTML. Retain its block ancestry
// instead of guessing boundaries after conversion has erased list nesting.
function blocks(html: string) {
  const root: Node = { tag: "root", start: 0, openEnd: 0, end: html.length, parent: null, children: [] };
  const stack = [root];
  const nodes: Node[] = [];
  for (const match of html.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi)) {
    const tag = match[2].toLowerCase();
    if (match[1]) {
      const index = stack.findLastIndex(node => node.tag === tag);
      if (index > 0) {
        for (const node of stack.splice(index)) node.end = match.index + match[0].length;
      }
    } else if (!/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(tag)) {
      const parent = stack.at(-1)!;
      const node: Node = { tag, start: match.index, openEnd: match.index + match[0].length, end: html.length, parent, children: [] };
      parent.children.push(node); nodes.push(node); stack.push(node);
    }
  }
  return nodes;
}

function ancestors(node: Node) {
  const result: Node[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) result.push(parent);
  return result;
}

function legacyProposal(url: string) {
  try {
    const parsed = new URL(url);
    return ["grants.zfnd.org", "grants-admin.zfnd.org", "zcashgrants.org"].includes(parsed.hostname) &&
      /^\/(?:proposals|gallery)\//.test(parsed.pathname);
  } catch { return false; }
}

function sectionHeading(text: string) {
  return /^(?:(?:open|new|current|202\d community funding programs) grants?(?: proposals?| applications?)?|brainstorm(?: session)?(?: follow[ -]?ups?)?|follow[ -]?ups?|key takeaways|notes|applications|grant proposals|other business)\s*:?$/i.test(text.trim());
}

export function structuredAgendaSections(html: string, links: Link[], plainText: string, regions: string[]) {
  const sections = new Map<string, AgendaSection>();
  const excludedOffsets = new Set<number>();
  if (!html) return { sections, excludedOffsets };
  const normalized = (value: string) => value.replace(/\s+/g, " ").trim();
  const fullText = normalized(plainText);
  const ranges = regions.filter(Boolean).map(region => {
    const text = normalized(region);
    const start = fullText.indexOf(text);
    return { start, end: start + text.length };
  }).filter(range => range.start >= 0);
  const nodes = blocks(html);
  const anchors = new Map(nodes.filter(n => n.tag === "a").map(n => [n.start, n]));
  const text = (start: number, end: number) => htmlToPlainText(html.slice(start, end));
  const headingText = (node: Node) => text(node.openEnd, node.children.find(n => /^(?:ul|ol)$/.test(n.tag))?.start ?? node.end);
  const standalone = nodes.filter(n => /^(?:p|h[1-6])$/.test(n.tag) && !ancestors(n).some(a => /^(?:li|aside|blockquote)$/.test(a.tag)));
  const isHeading = (node: Node) => {
    const value = text(node.start, node.end);
    return /^h/.test(node.tag) || (value.length < 180 && value.split(/\s+/).length <= 16 && !/[.;!?]/.test(value));
  };
  const legacyHeadings = standalone.flatMap(node => {
    const anchor = node.children.find(n => n.tag === "a") ?? nodes.find(n => n.tag === "a" && n.start > node.start && n.end < node.end);
    const href = anchor && html.slice(anchor.start, anchor.openEnd).match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (!anchor || !href || !legacyProposal(href)) return [];
    const next = standalone.find(n => n.start > node.end && isHeading(n));
    return [{ node, title: text(anchor.openEnd, anchor.end).trim(), end: next?.start ?? html.length }];
  });
  for (const link of links) {
    if (link.htmlOffset === null) continue;
    const anchor = anchors.get(link.htmlOffset);
    if (!anchor) continue;
    const parents = ancestors(anchor);
    // Locate this occurrence in the actual detailed/follow-up region. A link
    // in the summary must not replace an unlinked or differently linked detail.
    const before = normalized(htmlToPlainText(html.slice(0, anchor.start)));
    if (!fullText.startsWith(before) || !ranges.some(range => before.length >= range.start - 1 && before.length < range.end)) continue;
    if (parents.some(n => n.tag === "aside")) continue;
    const legacy = /^(?:forum discussion|forum post|discussion)$/i.test(link.title.trim())
      ? legacyHeadings.find(h => anchor.start > h.node.end && anchor.start < h.end) : null;
    let title = link.title;
    let section: string | null = null;
    if (legacy) {
      title = legacy.title;
      section = text(legacy.node.start, legacy.end);
    } else {
      const item = parents.find(n => n.tag === "li");
      if (item) {
        const prefix = text(item.openEnd, anchor.start);
        const tail = text(anchor.end, item.end);
        const parentItems = ancestors(item).filter(n => n.tag === "li");
        // A link in the commentary of an organizational or application heading
        // is evidence within that item, not a second application.
        if (!item.children.some(n => /^(?:ul|ol)$/.test(n.tag)) && /^to\b/i.test(tail) && parentItems.some(n => !sectionHeading(headingText(n)))) {
          excludedOffsets.add(anchor.start); continue;
        }
        // Inline references within discussion are supporting evidence, even
        // when they link back to this proposal's own topic.
        if (!/^[\s\d.)-]*$/.test(prefix)) continue;
        section = text(item.start, item.end);
      } else {
        const heading = standalone.find(n => n.start <= anchor.start && n.end >= anchor.end);
        if (heading && !text(heading.openEnd, anchor.start)) {
          const next = standalone.find(n => n.start > heading.end && isHeading(n));
          section = text(heading.start, next?.start ?? html.length);
        }
      }
    }
    if (section) {
      const existing = sections.get(link.url) ?? { title, sections: [] };
      if (/^(?:forum discussion|forum post|discussion)$/i.test(existing.title)) existing.title = title;
      existing.sections.push({ title, text: section });
      sections.set(link.url, existing);
    }
  }
  return { sections, excludedOffsets };
}
