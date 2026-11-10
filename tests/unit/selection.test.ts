import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initSelectionBubble, showSelectionBubble } from "../../src/content/selection";

/** Debounce documented by the task brief; kept local so the test fails if it drifts. */
const DEBOUNCE_MS = 50;

let onExplain: ReturnType<typeof vi.fn<(text: string, range: Range) => void>>;
let onFollowUp: ReturnType<typeof vi.fn<(text: string, range: Range) => void>>;

const select = (node: Node): void => {
  const r = document.createRange();
  r.selectNodeContents(node);
  const s = getSelection()!;
  s.removeAllRanges();
  s.addRange(r);
};

/** Trigger the debounced mouseup handler and let it run. */
const mouseup = (): void => {
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  vi.advanceTimersByTime(DEBOUNCE_MS);
};

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  onExplain = vi.fn();
  onFollowUp = vi.fn();
  initSelectionBubble({ onExplain, onFollowUp });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

it("shows the bubble for a selection of two or more characters", () => {
  document.body.innerHTML = `<p>Hello world</p>`;
  select(document.querySelector("p")!);
  mouseup();
  expect(document.querySelector(".ilmt-bubble")).not.toBeNull();
});

it("does not show the bubble for a single character", () => {
  document.body.innerHTML = `<p>H</p>`;
  select(document.querySelector("p")!.firstChild!);
  mouseup();
  expect(document.querySelector(".ilmt-bubble")).toBeNull();
});

it("does not show the bubble when the selection is inside an input", () => {
  document.body.innerHTML = `<input value="hello" />`;
  const input = document.querySelector("input")!;
  input.setSelectionRange(0, 5);
  mouseup();
  expect(document.querySelector(".ilmt-bubble")).toBeNull();
});

it("hides on Escape", () => {
  document.body.innerHTML = `<p>Hello world</p>`;
  select(document.querySelector("p")!);
  mouseup();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(document.querySelector(".ilmt-bubble")).toBeNull();
});

describe("selection bubble actions", () => {
  beforeEach(() => {
    document.body.innerHTML = `<p>  Hello world  </p>`;
    select(document.querySelector("p")!);
    mouseup();
  });

  it("calls onExplain with the trimmed selection and removes the bubble", () => {
    document.querySelector<HTMLButtonElement>(".ilmt-bubble-explain")!.click();
    expect(onExplain).toHaveBeenCalledWith("Hello world", expect.any(Range));
    expect(onFollowUp).not.toHaveBeenCalled();
    expect(document.querySelector(".ilmt-bubble")).toBeNull();
  });

  it("passes a range snapshot that still describes the selection", () => {
    document.querySelector<HTMLButtonElement>(".ilmt-bubble-explain")!.click();
    const [, range] = onExplain.mock.calls[0];
    expect(range.toString().trim()).toBe("Hello world");
    expect(range.startContainer).toBe(document.querySelector("p"));
  });

  it("calls onFollowUp with the trimmed selection and removes the bubble", () => {
    document.querySelector<HTMLButtonElement>(".ilmt-bubble-follow")!.click();
    expect(onFollowUp).toHaveBeenCalledWith("Hello world", expect.any(Range));
    expect(onExplain).not.toHaveBeenCalled();
    expect(document.querySelector(".ilmt-bubble")).toBeNull();
  });

  it("stays open on a mousedown inside the bubble and hides on one outside", () => {
    const bubble = document.querySelector<HTMLElement>(".ilmt-bubble")!;
    bubble.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".ilmt-bubble")).not.toBeNull();

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".ilmt-bubble")).toBeNull();
  });

  it("hides on scroll", () => {
    window.dispatchEvent(new Event("scroll"));
    expect(document.querySelector(".ilmt-bubble")).toBeNull();
  });
});

it("does not show the bubble when the selection is inside a contenteditable", () => {
  document.body.innerHTML = `<div contenteditable="true">Hello world</div>`;
  select(document.querySelector("div")!);
  mouseup();
  expect(document.querySelector(".ilmt-bubble")).toBeNull();
});

it("does not stack bubbles when initialized twice", () => {
  initSelectionBubble({ onExplain, onFollowUp });
  document.body.innerHTML = `<p>Hello world</p>`;
  select(document.querySelector("p")!);
  mouseup();
  expect(document.querySelectorAll(".ilmt-bubble")).toHaveLength(1);
});

it("shows the bubble immediately for the guard's post-load hook", () => {
  document.body.innerHTML = `<p>Hello world</p>`;
  select(document.querySelector("p")!);

  showSelectionBubble();

  expect(document.querySelectorAll(".ilmt-bubble")).toHaveLength(1);
  expect(document.querySelector(".ilmt-bubble-explain")).not.toBeNull();
});
