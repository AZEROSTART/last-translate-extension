/**
 * Selection bubble (划词气泡): after the user finishes selecting text, offer
 * two actions — 解释 (explain) and 追问 (follow-up). The module owns only the
 * small floating UI; callbacks decide what the actions mean.
 *
 * A bubble is never shown for selections under two characters or for
 * selections inside an editable control, and it disappears on scroll, an
 * outside mousedown or Escape. No page selection behavior is altered.
 */

export interface SelectionBubbleOptions {
  onExplain(text: string, range: Range): void;
  onFollowUp(text: string, range: Range): void;
}

/** Settle time after `mouseup` so dragging a selection does not flash a bubble. */
const DEBOUNCE_MS = 50;
/** Minimum trimmed selection length worth acting on. */
const MIN_SELECTION_LENGTH = 2;
/** Gap between the bubble and the selection/viewport edge. */
const EDGE_MARGIN_PX = 8;
/** Below this top coordinate a bubble placed above would be cramped. */
const FLIP_ABOVE_TOP_PX = 48;

interface SelectionRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const EMPTY_RECT: SelectionRect = { left: 0, top: 0, width: 0, height: 0 };

let installed = false;
let options: SelectionBubbleOptions | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let bubble: HTMLDivElement | null = null;

/**
 * Install the global listeners (once) and bind the callbacks. Calling it again
 * only refreshes the callbacks; listeners and the current bubble are not
 * duplicated.
 */
export function initSelectionBubble(opts: SelectionBubbleOptions): void {
  options = opts;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  removeBubble();
  if (installed) return;
  installed = true;

  document.addEventListener("mouseup", scheduleSelectionCheck);
  document.addEventListener("mousedown", handleMouseDown);
  document.addEventListener("keydown", handleKeyDown);
  window.addEventListener("scroll", dismiss, { passive: true });
}

/**
 * Check the current selection right now (no debounce). Used by the guard after
 * it lazily loads this bundle on a mouseup: the selection may already be gone
 * by the time the dynamic import settles, but usually it is still present.
 */
export function showSelectionBubble(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  checkSelection();
}

function scheduleSelectionCheck(): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    checkSelection();
  }, DEBOUNCE_MS);
}

function checkSelection(): void {
  const selection = window.getSelection();
  const text = selection?.toString().trim() ?? "";

  if (
    text.length < MIN_SELECTION_LENGTH ||
    !selection ||
    selection.rangeCount === 0 ||
    isEditable(selection.anchorNode)
  ) {
    dismiss();
    return;
  }

  const range = selection.getRangeAt(0).cloneRange();
  showBubble(text, getSelectionRect(range), range);
}

/** Inputs and contenteditable hosts manage their own selection; never cover them. */
function isEditable(node: Node | null): boolean {
  if (!node) return false;
  const el = node instanceof Element ? node : node.parentElement;
  return el ? el.closest("input, textarea, [contenteditable]") !== null : false;
}

function getSelectionRect(range: Range): SelectionRect {
  if (typeof range.getBoundingClientRect !== "function") return EMPTY_RECT;

  const rect = range.getBoundingClientRect();
  if (!rect) return EMPTY_RECT;
  return {
    left: finiteOrZero(rect.left),
    top: finiteOrZero(rect.top),
    width: finiteOrZero(rect.width),
    height: finiteOrZero(rect.height),
  };
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function showBubble(text: string, rect: SelectionRect, range: Range): void {
  removeBubble();

  const el = document.createElement("div");
  el.className = "ilmt-bubble";
  el.setAttribute("data-ilmt-bubble", "");
  el.append(
    createButton("解释", "ilmt-bubble-explain", "explain", () => {
      runAction(options?.onExplain, text, range);
    }),
    createButton("追问", "ilmt-bubble-follow", "follow", () => {
      runAction(options?.onFollowUp, text, range);
    }),
  );

  (document.body ?? document.documentElement).appendChild(el);
  bubble = el;
  positionBubble(el, rect);
}

function createButton(
  label: string,
  className: string,
  action: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.dataset.ilmtAction = action;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function runAction(
  callback: ((selectedText: string, range: Range) => void) | undefined,
  text: string,
  range: Range,
): void {
  try {
    callback?.(text, range);
  } finally {
    // Also cancel the mouseup check that follows the button mousedown, so a
    // still-present selection cannot immediately reopen the bubble.
    dismiss();
  }
}

function positionBubble(el: HTMLDivElement, rect: SelectionRect): void {
  const box = el.getBoundingClientRect();
  const width = finiteOrZero(box.width);
  const height = finiteOrZero(box.height);
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;

  const left = clamp(rect.left, EDGE_MARGIN_PX, viewportWidth - width - EDGE_MARGIN_PX);
  const above = rect.top >= FLIP_ABOVE_TOP_PX;
  const top = above ? rect.top - height - EDGE_MARGIN_PX : rect.top + rect.height + EDGE_MARGIN_PX;

  el.dataset.position = above ? "above" : "below";
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

/** Clamp that also tolerates jsdom's zero viewport/width (max would be < min). */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function handleMouseDown(event: MouseEvent): void {
  if (bubble && event.target instanceof Node && bubble.contains(event.target)) return;
  dismiss();
}

function handleKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  dismiss();
}

/** Clear both a visible bubble and any selection check still waiting to run. */
function dismiss(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  removeBubble();
}

function removeBubble(): void {
  if (!bubble) return;
  bubble.remove();
  bubble = null;
}
