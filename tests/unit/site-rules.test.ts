import { describe, it, expect } from "vitest";
import { getSiteRule } from "../../src/content/site-rules";

describe("getSiteRule", () => {
  it("uses the GitHub rule for repository pages", () => {
    const rule = getSiteRule("https://github.com/owner/repo");
    expect(rule.id).toBe("github");
    expect(rule.disabled).not.toBe(true);
    expect(rule.scopeSelectors).toContain("main");
    expect(rule.scopeExcludeSelectors).toContain(".Layout-sidebar");
    expect(rule.extraTextSelectors).toContain(
      ".Layout-sidebar .BorderGrid-row:first-child .BorderGrid-cell > p",
    );
  });

  it("falls back to the generic rule for other sites", () => {
    const rule = getSiteRule("https://example.com/article");
    expect(rule.id).toBe("generic");
    expect(rule.scopeSelectors).toEqual(["main", "article", "[role='main']"]);
    expect(rule.scopeExcludeSelectors ?? []).toHaveLength(0);
  });

  it("disables GitHub settings pages", () => {
    expect(getSiteRule("https://github.com/settings/profile").disabled).toBe(true);
    expect(getSiteRule("https://github.com/owner/repo/settings").disabled).toBe(true);
  });

  it("does not apply the GitHub rule to gists or enterprise hosts", () => {
    expect(getSiteRule("https://gist.github.com/owner/abc").id).toBe("generic");
    expect(getSiteRule("https://github.example.com/owner/repo").id).toBe("generic");
  });

  it("falls back to generic for an unparseable URL", () => {
    expect(getSiteRule("not a url").id).toBe("generic");
  });
});
