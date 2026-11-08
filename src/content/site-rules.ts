/**
 * Static site rules for the content script.
 *
 * A rule describes where page text lives (`scopeSelectors`), which subtrees
 * must never be translated (`excludeSelectors`), and which extra selectors may
 * contribute content (for example GitHub's About summary). It is pure data:
 * nothing here reads the DOM, so rules can be unit-tested from a URL alone.
 *
 * Selector strings come from the design spec §6.2–§6.4 verbatim.
 */

export interface SiteRule {
  id: "generic" | "github";
  disabled?: boolean;
  scopeSelectors: string[];
  extraTextSelectors: string[];
  excludeSelectors: string[];
  /**
   * Skipped while walking the scope only, not during the ancestor check for
   * `extraTextSelectors`. Lets a whole sidebar UI be skipped while a precise
   * selector pulls a single paragraph back in.
   */
  scopeExcludeSelectors?: string[];
  /** Optional display overrides, kept for site rules that need them. Empty this round. */
  extraInlineSelectors?: string[];
  extraBlockSelectors?: string[];
}

/** Non-content, form, media, hidden and accessibility selectors (spec §6.2). */
const BASE: string[] = [
  // Non-content tags.
  "script",
  "style",
  "noscript",
  "template",
  "pre",
  "code",
  "kbd",
  "samp",
  // Form controls and interactive elements.
  "textarea",
  "input",
  "select",
  "option",
  "optgroup",
  "datalist",
  "button",
  "[role='button']",
  "label",
  "legend",
  "summary",
  "dialog",
  "menu",
  // Media and graphics.
  "svg",
  "canvas",
  "video",
  "audio",
  "iframe",
  "object",
  "embed",
  "math",
  // Time and code references.
  "time",
  "relative-time",
  "[datetime]",
  // Hidden or assistive-only content.
  "[contenteditable]",
  "[aria-hidden='true']",
  "[hidden]",
  ".sr-only",
  ".visually-hidden",
  // Opt-out markers.
  "[translate='no']",
  ".notranslate",
  // Emoji wrappers.
  "g-emoji",
  "img.emoji",
  // Our own injected UI.
  ".ilmt-tr",
  ".ilmt-active-banner",
  ".ilmt-error-banner",
  ".ilmt-bubble",
  // ARIA widgets.
  "[role='tab']",
  "[role='menuitem']",
  "[role='option']",
  "[role='switch']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='combobox']",
  "[role='searchbox']",
  "[role='textbox']",
  // Ruby annotations; the base characters stay.
  "rt",
  "rp",
];

/** Navigation/landmark UI shared by the generic and GitHub rules (spec §6.3). */
const GENERIC_COMMON: string[] = [
  "nav",
  "footer",
  "[role='navigation']",
  "[role='menu']",
  "[role='menubar']",
  "[role='toolbar']",
  "[role='tablist']",
];

/** GitHub-only exclusions on top of `BASE` and `GENERIC_COMMON` (spec §6.4). */
const GITHUB_EXCLUDES: string[] = [
  "a[data-hovercard-type]",
  ".blob-code",
  ".timeline-comment-header",
  ".review-thread-reply",
  ".author",
  ".assignee",
  "[data-testid^='breadcrumbs']",
  ".vcard-names-container",
  ".BorderGrid-cell a[role='link']",
  ".BorderGrid-cell .topic-tag-link",
  "[data-testid=list-row-repo-name-and-number]",
  "[title='Label: Private']",
  "a.anchor",
  "[data-test-selector='commit-tease-commit-message']",
  "[data-test-selector='create-branch.developmentForm']",
  ".js-repos-container .markdown-title",
  ".State",
  ".Label",
  ".Counter",
  ".branch-name",
  ".commit-ref",
  ".issue-number",
];

/** GitHub-only content selectors on top of the scope (spec §6.4). */
const GITHUB_EXTRA_TEXT: string[] = [
  "h1",
  ".Layout-sidebar .BorderGrid-row:first-child .BorderGrid-cell > p",
  ".p-note",
  "li.repo-list-item p",
  "div.repo-description p",
  "#responsive-meta-container p",
  ".pinned-item-desc",
  ".topic-box > a > p:nth-of-type(2)",
  "main a[href^='/topics/'] > p",
  "article section[aria-label='card content'] p",
  ".js-notice h2",
  ".js-notice p",
];

const GENERIC_RULE: SiteRule = {
  id: "generic",
  scopeSelectors: ["main", "article", "[role='main']"],
  extraTextSelectors: [],
  excludeSelectors: [
    ...BASE,
    ...GENERIC_COMMON,
    "[role='dialog']",
    "[aria-modal='true']",
  ],
};

const GITHUB_RULE: SiteRule = {
  id: "github",
  scopeSelectors: ["main", "#repo-content-turbo-frame", "article", "feed-container"],
  // The sidebar is skipped as a whole while walking the scope; the About
  // summary is pulled back in through `extraTextSelectors` below.
  scopeExcludeSelectors: [".Layout-sidebar"],
  extraTextSelectors: GITHUB_EXTRA_TEXT,
  excludeSelectors: [...BASE, ...GENERIC_COMMON, ...GITHUB_EXCLUDES],
};

/** GitHub paths that are account/settings/admin UI, never content (spec §6.4). */
const DISABLED_PREFIXES = [
  "/settings",
  "/login",
  "/signup",
  "/join",
  "/marketplace",
  "/pricing",
  "/features",
  "/sponsors",
  "/codespaces",
  "/collections",
  "/readme",
  "/site",
  "/about",
  "/contact",
  "/security",
];

export function getSiteRule(url: string): SiteRule {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return GENERIC_RULE;
    if (isDisabledGithubPath(parsed.pathname)) {
      return { ...GITHUB_RULE, disabled: true };
    }
    return GITHUB_RULE;
  } catch {
    return GENERIC_RULE;
  }
}

function isDisabledGithubPath(pathname: string): boolean {
  if (DISABLED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return true;
  }
  // Repo settings live at /owner/repo/settings, not /settings.
  return pathname.split("/").includes("settings");
}
