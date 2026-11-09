import { it, expect, beforeEach } from "vitest";
import {
  renderTranslation,
  renderLoading,
  discardLoading,
  setInlineLoader,
  updateTranslation,
  restoreAll,
  extractSourceText,
} from "../../src/content/render";

beforeEach(() => {
  document.body.innerHTML = "";
});

it("inserts a block translation after the source text inside a paragraph", () => {
  document.body.innerHTML = `<p>Hello</p>`;
  const p = document.querySelector("p")!;
  const node = renderTranslation({ root: p, anchor: p.firstChild! }, "p_1", "你好");
  expect(node.classList.contains("ilmt-block")).toBe(true);
  expect(node.classList.contains("ilmt-inline")).toBe(false);
  expect(p.lastElementChild).toBe(node);
});

it("inserts after an inline link, not inside it", () => {
  document.body.innerHTML = `<p><a href="#">Hello</a></p>`;
  const p = document.querySelector("p")!;
  const a = document.querySelector("a")!;
  const node = renderTranslation({ root: p, anchor: a.firstChild! }, "p_2", "你好");
  expect(a.contains(node)).toBe(false);
  expect(a.nextSibling).toBe(node);
});

it("never inserts inside a trailing button", () => {
  document.body.innerHTML = `<p>prefix <button>action</button></p>`;
  const p = document.querySelector("p")!;
  const button = document.querySelector("button")!;
  const node = renderTranslation({ root: p, anchor: p.firstChild! }, "p_3", "前缀");
  expect(button.contains(node)).toBe(false);
  expect(p.lastElementChild).toBe(node);
});

it("appends after a trailing inline code node instead of splitting the prose", () => {
  document.body.innerHTML = `<p>Use the command <code>npm test</code></p>`;
  const p = document.querySelector("p")!;
  const node = renderTranslation({ root: p, anchor: p.firstChild! }, "p_18", "使用命令");
  expect(p.lastElementChild).toBe(node);
  expect(node.previousElementSibling?.tagName).toBe("CODE");
});

it("uses the target language passed by the caller", () => {
  document.body.innerHTML = `<p>Hello</p>`;
  const p = document.querySelector("p")!;
  const node = renderTranslation({ root: p, anchor: p.firstChild! }, "p_4", "Hello", "ja");
  expect(node.getAttribute("lang")).toBe("ja");
});

it("updates in place, including a translation outside the root", () => {
  document.body.innerHTML = `<div id="row" style="display:flex"><span>Hello</span><button>Action</button></div>`;
  const row = document.querySelector("#row")!;
  renderTranslation({ root: row, anchor: row.querySelector("span")!.firstChild! }, "p_5", "你");
  updateTranslation("p_5", "你好");
  expect(document.querySelectorAll(".ilmt-tr")).toHaveLength(1);
  expect(document.querySelector(".ilmt-tr")!.textContent).toBe("你好");
});

it("places a row-flex translation after the row", () => {
  document.body.innerHTML = `<div id="row" style="display:flex"><span>Hello</span><button>Action</button></div>`;
  const row = document.querySelector("#row")!;
  const node = renderTranslation(
    { root: row, anchor: row.querySelector("span")!.firstChild! },
    "p_6",
    "你好",
  );
  expect(row.querySelectorAll(".ilmt-tr")).toHaveLength(0);
  expect(row.nextElementSibling).toBe(node);
  expect(node.classList.contains("ilmt-flex-break")).toBe(false);
});

it("adds a flex break when the row is a child of a row flex", () => {
  document.body.innerHTML = `<div id="parent" style="display:flex"><div id="row" style="display:flex"><span>Hello</span></div></div>`;
  const row = document.querySelector("#row")!;
  const node = renderTranslation(
    { root: row, anchor: row.querySelector("span")!.firstChild! },
    "p_7",
    "你好",
  );
  expect(node.classList.contains("ilmt-flex-break")).toBe(true);
});

it("does not add a flex break inside a column-flex parent", () => {
  document.body.innerHTML = `<div id="parent" style="display:flex;flex-direction:column"><div id="row" style="display:flex"><span>Hello</span></div></div>`;
  const row = document.querySelector("#row")!;
  const node = renderTranslation(
    { root: row, anchor: row.querySelector("span")!.firstChild! },
    "p_8",
    "你好",
  );
  expect(node.classList.contains("ilmt-flex-break")).toBe(false);
});

it("adds a grid break when the row is a child of a grid", () => {
  document.body.innerHTML = `<div id="parent" style="display:grid"><div id="row" style="display:flex"><span>Hello</span></div></div>`;
  const row = document.querySelector("#row")!;
  const node = renderTranslation(
    { root: row, anchor: row.querySelector("span")!.firstChild! },
    "p_9",
    "你好",
  );
  expect(node.classList.contains("ilmt-grid-break")).toBe(true);
});

it("inserts inside a column-flex root without a flex break", () => {
  document.body.innerHTML = `<div id="col" style="display:flex;flex-direction:column">Hello</div>`;
  const col = document.querySelector("#col")!;
  const node = renderTranslation({ root: col, anchor: col.firstChild! }, "p_10", "你好");
  expect(col.contains(node)).toBe(true);
  expect(node.classList.contains("ilmt-flex-break")).toBe(false);
});

it("inserts inside a grid root with a grid break", () => {
  document.body.innerHTML = `<div id="grid" style="display:grid">Hello</div>`;
  const grid = document.querySelector("#grid")!;
  const node = renderTranslation({ root: grid, anchor: grid.firstChild! }, "p_11", "你好");
  expect(grid.contains(node)).toBe(true);
  expect(node.classList.contains("ilmt-grid-break")).toBe(true);
});

it("inserts a heading translation inside the heading", () => {
  document.body.innerHTML = `<h1>Repository title</h1>`;
  const h1 = document.querySelector("h1")!;
  const node = renderTranslation(
    { root: h1, anchor: h1.firstChild!, heading: true },
    "p_12",
    "仓库标题",
  );
  expect(h1.contains(node)).toBe(true);
  expect(node.getAttribute("data-ilmt-heading")).toBe("1");
});

it("keeps a heading inside its own flex row and adds a flex break", () => {
  document.body.innerHTML = `<h1 id="title" style="display:flex"><span>Title</span></h1>`;
  const h1 = document.querySelector("#title")!;
  const node = renderTranslation(
    { root: h1, anchor: h1.querySelector("span")!.firstChild!, heading: true },
    "p_13",
    "标题",
  );
  expect(h1.contains(node)).toBe(true);
  expect(node.getAttribute("data-ilmt-heading")).toBe("1");
  expect(node.classList.contains("ilmt-flex-break")).toBe(true);
});

it("inserts a table-cell translation inside the cell, not between rows", () => {
  document.body.innerHTML = `<table><tbody><tr><td style="display:flex"><span>Cell text</span></td></tr></tbody></table>`;
  const td = document.querySelector("td")!;
  const node = renderTranslation(
    { root: td, anchor: td.querySelector("span")!.firstChild! },
    "p_14",
    "单元格",
  );
  expect(td.contains(node)).toBe(true);
  expect(td.parentElement!.tagName).toBe("TR");
});

it("appends to the root when the anchor has been detached", () => {
  document.body.innerHTML = `<p id="root">Hello</p>`;
  const root = document.querySelector("#root")!;
  const anchor = root.firstChild!;
  anchor.parentNode!.removeChild(anchor);
  const node = renderTranslation({ root, anchor }, "p_15", "你好");
  expect(root.lastElementChild).toBe(node);
});

it("restores the DOM exactly", () => {
  document.body.innerHTML = `<p>Hello</p>`;
  const before = document.body.innerHTML;
  const p = document.querySelector("p")!;
  p.setAttribute("data-ilmt-p", "p_16");
  renderTranslation({ root: p, anchor: p.firstChild! }, "p_16", "你好");
  restoreAll(document.body);
  expect(document.body.innerHTML).toBe(before);
  expect(document.querySelectorAll("[data-ilmt-p]")).toHaveLength(0);
});

it("extracts source text without the existing translation", () => {
  document.body.innerHTML = `<p>Hello <span class="ilmt-tr" data-ilmt-for="p_17">你好</span></p>`;
  expect(extractSourceText(document.querySelector("p")!)).toBe("Hello");
});

it("renders a loading skeleton at the translation anchor", () => {
  document.body.innerHTML = `<p>Hello</p>`;
  const p = document.querySelector("p")!;
  const node = renderLoading({ root: p, anchor: p.firstChild! }, "p_load_1");
  expect(node.classList.contains("ilmt-block")).toBe(true);
  expect(node.getAttribute("data-loading")).toBe("1");
  expect(node.getAttribute("aria-busy")).toBe("true");
  expect(node.getAttribute("aria-label")).toBe("翻译中");
  expect(p.lastElementChild).toBe(node);
});

it("never renders a loading skeleton inside a trailing button", () => {
  document.body.innerHTML = `<p>prefix <button>action</button></p>`;
  const p = document.querySelector("p")!;
  const button = document.querySelector("button")!;
  const node = renderLoading({ root: p, anchor: p.firstChild! }, "p_load_2");
  expect(button.contains(node)).toBe(false);
  expect(p.lastElementChild).toBe(node);
});

it("marks a heading loading skeleton as a heading", () => {
  document.body.innerHTML = `<h1>Repository title</h1>`;
  const h1 = document.querySelector("h1")!;
  const node = renderLoading({ root: h1, anchor: h1.firstChild!, heading: true }, "p_load_3");
  expect(node.getAttribute("data-ilmt-heading")).toBe("1");
});

it("reuses the loading node and clears the skeleton when the translation arrives", () => {
  document.body.innerHTML = `<p>Hello</p>`;
  const p = document.querySelector("p")!;
  const loader = renderLoading({ root: p, anchor: p.firstChild! }, "p_load_4");
  const node = renderTranslation({ root: p, anchor: p.firstChild! }, "p_load_4", "你好");
  expect(node).toBe(loader);
  expect(node.textContent).toBe("你好");
  expect(node.hasAttribute("data-loading")).toBe(false);
  expect(node.hasAttribute("aria-busy")).toBe(false);
  expect(node.hasAttribute("aria-label")).toBe(false);
});

it("does not insert a loading node when the root is detached", () => {
  document.body.innerHTML = `<p id="root">Hello</p>`;
  const root = document.querySelector("#root")!;
  const anchor = root.firstChild!;
  root.remove();
  const node = renderLoading({ root, anchor }, "p_load_5");
  expect(document.querySelector(".ilmt-tr")).toBeNull();
  expect(node.isConnected).toBe(false);
});

it("discards an empty loading node but keeps a partial translation", () => {
  document.body.innerHTML = `<p>Hello</p>`;
  const p = document.querySelector("p")!;
  renderLoading({ root: p, anchor: p.firstChild! }, "p_load_6");
  discardLoading("p_load_6");
  expect(document.querySelector('[data-ilmt-for="p_load_6"]')).toBeNull();

  renderLoading({ root: p, anchor: p.firstChild! }, "p_load_7");
  renderTranslation({ root: p, anchor: p.firstChild! }, "p_load_7", "你");
  setInlineLoader("p_load_7");
  discardLoading("p_load_7");
  const node = document.querySelector('[data-ilmt-for="p_load_7"]') as HTMLElement;
  expect(node.textContent).toBe("你");
  expect(node.hasAttribute("data-loading")).toBe(false);
});

it("removes loading placeholders on restore", () => {
  document.body.innerHTML = `<p>Hello</p>`;
  const before = document.body.innerHTML;
  const p = document.querySelector("p")!;
  p.setAttribute("data-ilmt-p", "p_load_8");
  renderLoading({ root: p, anchor: p.firstChild! }, "p_load_8");
  restoreAll(document.body);
  expect(document.body.innerHTML).toBe(before);
});
