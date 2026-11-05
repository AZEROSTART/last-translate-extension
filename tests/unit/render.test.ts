import { it, expect, beforeEach } from "vitest";
import { renderTranslation, updateTranslation, restoreAll, extractSourceText } from "../../src/content/render";

beforeEach(() => { document.body.innerHTML = ""; });

it("appends a block translation as the last child", () => {
  document.body.innerHTML = `<p data-ilmt-p="p_1">Hello</p>`;
  const el = document.querySelector("p")!;
  const node = renderTranslation(el, "p_1", "你好");
  expect(node.classList.contains("ilmt-block")).toBe(true);
  expect(el.lastElementChild).toBe(node);
});

it("inserts an inline translation as a following sibling, not a child", () => {
  document.body.innerHTML = `<p><a href="#" data-ilmt-p="p_2">Hello</a></p>`;
  const el = document.querySelector("a")!;
  const node = renderTranslation(el, "p_2", "你好");
  expect(node.classList.contains("ilmt-inline")).toBe(true);
  expect(el.contains(node)).toBe(false);
  expect(el.nextElementSibling).toBe(node);
});

it("uses the target language passed by the caller", () => {
  document.body.innerHTML = `<p data-ilmt-p="p_3">Hello</p>`;
  const el = document.querySelector("p")!;
  const node = renderTranslation(el, "p_3", "こんにちは", "ja");
  expect(node.getAttribute("lang")).toBe("ja");
});

it("updates in place without creating a second node", () => {
  document.body.innerHTML = `<p data-ilmt-p="p_1">Hello</p>`;
  const el = document.querySelector("p")!;
  renderTranslation(el, "p_1", "你");
  updateTranslation("p_1", "你好");
  expect(el.querySelectorAll(".ilmt-tr")).toHaveLength(1);
  expect(el.querySelector(".ilmt-tr")!.textContent).toBe("你好");
});

it("updates an inline translation in place without duplicating it", () => {
  document.body.innerHTML = `<p><a href="#" data-ilmt-p="p_2">Hello</a></p>`;
  const el = document.querySelector("a")!;
  renderTranslation(el, "p_2", "你");
  renderTranslation(el, "p_2", "你好");
  expect(el.parentElement!.querySelectorAll(".ilmt-tr")).toHaveLength(1);
  expect(el.nextElementSibling!.textContent).toBe("你好");
});

it("restores the DOM exactly", () => {
  document.body.innerHTML = `<p>Hello</p>`;
  const before = document.body.innerHTML;
  const el = document.querySelector("p")!;
  el.setAttribute("data-ilmt-p", "p_1");
  renderTranslation(el, "p_1", "你好");
  restoreAll(document.body);
  expect(document.body.innerHTML).toBe(before);
  expect(document.querySelectorAll("[data-ilmt-p]")).toHaveLength(0);
});

it("extracts source text without the existing translation", () => {
  document.body.innerHTML = `<p data-ilmt-p="p_1">Hello</p>`;
  const el = document.querySelector("p")!;
  renderTranslation(el, "p_1", "你好");
  expect(extractSourceText(el)).toBe("Hello");
});
