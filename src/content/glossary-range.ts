/**
 * Locate a glossary surface in the original paragraph text nodes.
 *
 * Version 1 only matches inside a single text node; a phrase split by inline
 * markup is intentionally left unhighlighted. The returned range can be fed to
 * the CSS Custom Highlight API without touching the page's DOM.
 */

const SKIP_ANCESTOR = "code, pre, kbd, samp, .ilmt-tr";
const ASCII_WORD = /^[A-Za-z0-9_]$/;

function isAsciiWordChar(char: string | undefined): boolean {
  return char !== undefined && ASCII_WORD.test(char);
}

export function findSurfaceRange(textNodes: Node[], surface: string): Range | undefined {
  const needle = surface.trim().toLowerCase();
  if (!needle) return undefined;

  for (const node of textNodes) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const text = node as Text;
    const parent = text.parentElement;
    if (!parent || parent.closest(SKIP_ANCESTOR)) continue;

    const haystack = text.data.toLowerCase();
    let from = 0;
    while (from <= haystack.length - needle.length) {
      const index = haystack.indexOf(needle, from);
      if (index < 0) break;

      const before = index > 0 ? haystack[index - 1] : undefined;
      const after =
        index + needle.length < haystack.length ? haystack[index + needle.length] : undefined;
      const startsOnWord = isAsciiWordChar(needle[0]);
      const endsOnWord = isAsciiWordChar(needle[needle.length - 1]);
      const boundaryOk =
        !(startsOnWord && isAsciiWordChar(before)) && !(endsOnWord && isAsciiWordChar(after));

      if (boundaryOk) {
        const doc = text.ownerDocument ?? document;
        const range = doc.createRange();
        range.setStart(text, index);
        range.setEnd(text, index + needle.length);
        return range;
      }
      from = index + 1;
    }
  }

  return undefined;
}
