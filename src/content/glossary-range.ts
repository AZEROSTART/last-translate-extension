/**
 * Locate a glossary surface in the original paragraph text nodes.
 *
 * Matching runs in two passes: first inside a single text node (the common
 * case, cheapest), then across adjacent inline elements ("look <em>up</em>").
 * Cross-node matches never bridge skipped tags (`code`, `pre`, `kbd`, `samp`,
 * and translations) because those contribute a NUL sentinel instead of text.
 * The returned range can be fed to the CSS Custom Highlight API without
 * touching the page's DOM.
 */

const SKIP_ANCESTOR = "code, pre, kbd, samp, .ilmt-tr";
/** Source matching never reaches into translations; pair lookup must. */
const SKIP_ANCESTOR_ALLOW_TRANSLATION = "code, pre, kbd, samp";
const ASCII_WORD = /^[A-Za-z0-9_]$/;
const BRIDGE_SENTINEL = "\u0000";

function isAsciiWordChar(char: string | undefined): boolean {
  return char !== undefined && ASCII_WORD.test(char);
}

/**
 * First index of `needle` in `haystack` that does not cut through an ASCII
 * word. Both arguments are expected lowercased.
 */
export function findMatchIndex(haystack: string, needle: string): number {
  if (!needle) return -1;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return -1;

    const before = index > 0 ? haystack[index - 1] : undefined;
    const after =
      index + needle.length < haystack.length ? haystack[index + needle.length] : undefined;
    const startsOnWord = isAsciiWordChar(needle[0]);
    const endsOnWord = isAsciiWordChar(needle[needle.length - 1]);
    const boundaryOk =
      !(startsOnWord && isAsciiWordChar(before)) && !(endsOnWord && isAsciiWordChar(after));

    if (boundaryOk) return index;
    from = index + 1;
  }
  return -1;
}

export interface FindSurfaceOptions {
  /** Allow matching inside `.ilmt-tr` (used to light a term in the translation). */
  allowTranslation?: boolean;
}

interface TextSegment {
  node: Text;
  start: number;
  end: number;
}

export function findSurfaceRange(
  textNodes: Node[],
  surface: string,
  options: FindSurfaceOptions = {},
): Range | undefined {
  const needle = surface.trim().toLowerCase();
  if (!needle) return undefined;
  const skipSelector = options.allowTranslation ? SKIP_ANCESTOR_ALLOW_TRANSLATION : SKIP_ANCESTOR;

  // Pass 1: a match wholly inside one text node. A match touching either edge
  // may continue in a neighbouring inline element, so its word boundary is only
  // authoritative once Pass 2 sees the combined text.
  for (const node of textNodes) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const text = node as Text;
    const parent = text.parentElement;
    if (!parent || parent.closest(skipSelector)) continue;

    const index = findMatchIndex(text.data.toLowerCase(), needle);
    if (index < 0) continue;
    const end = index + needle.length;
    if (index === 0 || end === text.data.length) break;

    const doc = text.ownerDocument ?? document;
    const range = doc.createRange();
    range.setStart(text, index);
    range.setEnd(text, end);
    return range;
  }

  // Pass 2: a match spanning inline elements. Skipped nodes become sentinels
  // so a term can never be reassembled across <code>, <pre>, a translation, …
  let combined = "";
  const segments: TextSegment[] = [];
  for (const node of textNodes) {
    if (node.nodeType !== Node.TEXT_NODE) {
      combined += BRIDGE_SENTINEL;
      continue;
    }
    const text = node as Text;
    const parent = text.parentElement;
    if (!parent || parent.closest(skipSelector)) {
      combined += BRIDGE_SENTINEL;
      continue;
    }
    const lowered = text.data.toLowerCase();
    segments.push({ node: text, start: combined.length, end: combined.length + lowered.length });
    combined += lowered;
  }

  const matchStart = findMatchIndex(combined, needle);
  if (matchStart < 0) return undefined;
  const matchEnd = matchStart + needle.length;

  const startSegment = segments.find(
    (segment) => matchStart >= segment.start && matchStart < segment.end,
  );
  const endSegment = segments.find(
    (segment) => matchEnd > segment.start && matchEnd <= segment.end,
  );
  if (!startSegment || !endSegment) return undefined;

  const doc = startSegment.node.ownerDocument ?? document;
  const range = doc.createRange();
  range.setStart(startSegment.node, matchStart - startSegment.start);
  range.setEnd(endSegment.node, matchEnd - endSegment.start);
  return range;
}
