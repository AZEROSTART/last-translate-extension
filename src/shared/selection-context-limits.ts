/**
 * Length caps shared by the content-script extractor and the panel's
 * defensive parser. The extractor includes the ellipsis inside these limits.
 */
export const SELECTION_CONTEXT_LIMITS = {
  paragraph: 1000,
  preceding: 500,
  heading: 120,
  precedingBlocks: 2,
} as const;
