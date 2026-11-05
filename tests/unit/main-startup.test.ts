import { it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  const main = (globalThis as any).__ilmtMain;
  if (main && typeof main.restore === "function") main.restore();
  delete (globalThis as any).__ilmtTestPort;
  delete (globalThis as any).__ilmtMain;
  document.body.innerHTML = "";
});

it("initializes the bubble once at startup and adds no inline stylesheet", async () => {
  document.body.innerHTML = `<p>Hello world</p>`;
  const { runContentMain } = await import("../../src/content/main");

  // Repeated startup must neither stack listeners nor duplicate the stylesheet.
  const addListener = vi.spyOn(document, "addEventListener");
  runContentMain();
  runContentMain();
  const mouseupRegistrations = addListener.mock.calls.filter(([type]) => type === "mouseup");
  expect(mouseupRegistrations).toHaveLength(1);
  addListener.mockRestore();

  // Styles arrive through the manifest content_scripts CSS entry, never an
  // inline <style>, so a strict page CSP cannot block them.
  expect(document.querySelectorAll("style[data-ilmt]")).toHaveLength(0);

  // The bubble is usable before the page is translated: selecting text shows it.
  const range = document.createRange();
  range.selectNodeContents(document.querySelector("p")!);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(document.querySelectorAll(".ilmt-bubble")).toHaveLength(1);

  // Activation must not start injecting styles either.
  (globalThis as any).__ilmtTestPort = { send: vi.fn() };
  await (globalThis as any).__ilmtMain.translatePage();
  expect(document.querySelectorAll("style[data-ilmt]")).toHaveLength(0);
});
