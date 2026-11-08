import { beforeEach, it, expect } from "vitest";
import { collectParagraphs, resetPieceCache } from "../../src/content/paragraphs";

const html = (s: string) => {
  document.body.innerHTML = s;
  return document.body;
};

beforeEach(() => {
  document.body.innerHTML = "";
  resetPieceCache();
});

it("skips URLs, emails, paths, handles, hashes, versions, dates and SHAs", async () => {
  html(`
    <p>https://example.com/a/b</p>
    <p>someone@example.com</p>
    <p>/usr/local/bin</p>
    <p>src/content/main.ts</p>
    <p>@octocat</p>
    <p>#12345</p>
    <p>v1.2.3</p>
    <p>2026-11-08</p>
    <p>deadbeef</p>
    <p>This sentence should be translated.</p>`);
  const ps = await collectParagraphs(document.body);
  expect(ps.map((p) => p.text)).toEqual(["This sentence should be translated."]);
});

it("skips bare filenames with common source extensions", async () => {
  html(`<p>main.ts</p><p>styles.css</p><p>README.md</p><p>This filename is prose.</p>`);
  const ps = await collectParagraphs(document.body);
  expect(ps.map((p) => p.text)).toEqual(["This filename is prose."]);
});

it("translates prose that merely contains a URL", async () => {
  html(`<p>Read https://example.com/docs for details.</p>`);
  const ps = await collectParagraphs(document.body);
  expect(ps.map((p) => p.text)).toEqual(["Read https://example.com/docs for details."]);
});

it("skips text with no Unicode letters", async () => {
  html(`<p>12345 !!! ---</p><p>+++</p><p>Words are here.</p>`);
  const ps = await collectParagraphs(document.body);
  expect(ps.map((p) => p.text)).toEqual(["Words are here."]);
});
