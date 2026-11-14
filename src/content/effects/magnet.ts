import { registerEffect } from "./index";
import type { ClaimEffect, ClaimHandle, ClaimPhase } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";
const EFFECT_ID = "magnet";
/** Pull animation length; the settled still is the same pose. */
const PULL_MS = 560;

type LocalPhase = ClaimPhase | "hit";

function node<K extends keyof SVGElementTagNameMap>(
  doc: Document,
  name: K,
  attrs: Record<string, string> = {},
): SVGElementTagNameMap[K] {
  const element = doc.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}

/** Small iron filings that get sucked into the poles while the magnet pulls. */
const FILINGS: Array<{ x: number; y: number; dx: number; dy: number; delay: number }> = [
  { x: 10, y: 3, dx: 3, dy: 9, delay: 0 },
  { x: 18.5, y: 0.5, dx: 4.5, dy: 15, delay: 40 },
  { x: 27, y: 1.5, dx: -1.5, dy: 14, delay: 80 },
  { x: 38, y: 3, dx: -1, dy: 9, delay: 30 },
  { x: 22, y: 8, dx: 2, dy: 9, delay: 110 },
  { x: 31.5, y: 9, dx: -2.5, dy: 8, delay: 70 },
];

/**
 * A magnet under the word: the field arcs breathe while idle, the poles flash
 * on click and iron filings fall into them. The word is then held between the
 * poles as a small teal pellet, which is what "captured" looks like.
 */
function magnetSvg(doc: Document): SVGElement {
  const svg = node(doc, "svg", {
    viewBox: "0 0 50 44",
    width: "50",
    height: "44",
    "aria-hidden": "true",
    focusable: "false",
  });

  const field = node(doc, "g");
  field.setAttribute("class", "ilmt-gloss-fx-field");
  field.append(
    node(doc, "path", {
      d: "M11 6 q14 -7 28 0",
      fill: "none",
      stroke: "var(--ilmt-field)",
      "stroke-width": "1.4",
      "stroke-linecap": "round",
    }),
    node(doc, "path", {
      d: "M15 7.5 q10 -4.5 20 0",
      fill: "none",
      stroke: "var(--ilmt-field)",
      "stroke-width": "1",
      "stroke-linecap": "round",
      "stroke-dasharray": "2.6 3.4",
    }),
  );

  const body = node(doc, "g");
  body.setAttribute("class", "ilmt-gloss-fx-body");
  body.append(
    // the horseshoe, opening up: legs at x 8-18 and 32-42, bottom arc at y 38-43
    node(doc, "path", {
      d: "M13 12 V27 A11 11 0 0 0 37 27 V12",
      fill: "none",
      stroke: "var(--ilmt-magnet)",
      "stroke-width": "10",
    }),
    // specular down the left leg, so the red does not read as a flat blob
    node(doc, "path", {
      d: "M15.4 13 V26",
      fill: "none",
      stroke: "var(--ilmt-magnet-light)",
      "stroke-width": "2",
      "stroke-linecap": "round",
      opacity: ".5",
    }),
    node(doc, "rect", {
      x: "8",
      y: "8",
      width: "10",
      height: "9",
      rx: "1.8",
      fill: "var(--ilmt-pole)",
      stroke: "var(--ilmt-pole-edge)",
      "stroke-width": ".9",
    }),
    node(doc, "rect", {
      x: "32",
      y: "8",
      width: "10",
      height: "9",
      rx: "1.8",
      fill: "var(--ilmt-pole)",
      stroke: "var(--ilmt-pole-edge)",
      "stroke-width": ".9",
    }),
  );

  const caught = node(doc, "g");
  caught.setAttribute("class", "ilmt-gloss-fx-caught");
  caught.append(
    node(doc, "circle", { cx: "25", cy: "24", r: "6.4", fill: "var(--ilmt-catch)", opacity: ".18" }),
    node(doc, "circle", { cx: "25", cy: "24", r: "3.2", fill: "var(--ilmt-catch)", opacity: ".95" }),
    node(doc, "circle", { cx: "23.9", cy: "22.9", r: "1", fill: "#fff", opacity: ".75" }),
  );
  body.append(caught);

  const filings = node(doc, "g");
  filings.setAttribute("class", "ilmt-gloss-fx-filings");
  for (const filing of FILINGS) {
    const square = node(doc, "rect", {
      x: String(filing.x),
      y: String(filing.y),
      width: "2.6",
      height: "2.6",
      rx: ".7",
      fill: "var(--ilmt-field)",
      class: "ilmt-gloss-fx-filing",
    });
    square.style.setProperty("--dx", `${filing.dx}px`);
    square.style.setProperty("--dy", `${filing.dy}px`);
    square.style.setProperty("--d", `${filing.delay}ms`);
    filings.appendChild(square);
  }

  svg.append(field, body, filings);
  return svg;
}

const CSS = `
[data-ilmt-effect="${EFFECT_ID}"] {
  --ilmt-magnet: #d9544e;
  --ilmt-magnet-light: #f6ada7;
  --ilmt-pole: #cfd7de;
  --ilmt-pole-edge: #7b8794;
  --ilmt-field: #7ea6c4;
  --ilmt-catch: #2dd4bf;
  display: block;
  width: 50px;
  height: 44px;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-theme="dark"] {
  --ilmt-magnet: #cf5f58;
  --ilmt-magnet-light: #ec9d97;
  --ilmt-pole: #a9b4c0;
  --ilmt-pole-edge: #59636e;
  --ilmt-field: #6f9dbb;
  --ilmt-catch: #5eead4;
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-hit {
  position: relative;
  display: block;
  width: 50px;
  height: 44px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  line-height: 0;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-hit:focus-visible {
  outline: 2px solid #2dd4bf;
  outline-offset: 3px;
  border-radius: 10px;
}

[data-ilmt-effect="${EFFECT_ID}"] svg {
  display: block;
  overflow: visible;
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-body {
  animation: ilmt-magnet-idle 3.2s ease-in-out infinite;
  transform-origin: 25px 38px;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="hit"] .ilmt-gloss-fx-body {
  animation: ilmt-magnet-pull 560ms cubic-bezier(.3, .7, .25, 1) both;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="settled"] .ilmt-gloss-fx-body,
[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="known"] .ilmt-gloss-fx-body {
  animation: none;
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-field {
  animation: ilmt-magnet-breathe 2.8s ease-in-out infinite;
  transform-origin: 25px 6px;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="hit"] .ilmt-gloss-fx-field {
  animation: ilmt-magnet-flare 560ms ease-out both;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="settled"] .ilmt-gloss-fx-field,
[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="known"] .ilmt-gloss-fx-field {
  animation: none;
  opacity: .22;
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-caught {
  opacity: 0;
  transition: opacity .18s ease;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="settled"] .ilmt-gloss-fx-caught,
[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="known"] .ilmt-gloss-fx-caught {
  opacity: 1;
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-filing {
  opacity: 0;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="hit"] .ilmt-gloss-fx-filing {
  animation: ilmt-magnet-filing 420ms cubic-bezier(.45, 0, .9, .6) both;
  animation-delay: var(--d, 0ms);
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-plus {
  position: absolute;
  left: 100%;
  top: 26px;
  transform: translate(6px, -50%);
  color: #0f766e;
  font-size: 11.5px;
  line-height: 1;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-theme="dark"] .ilmt-gloss-fx-plus {
  color: #5eead4;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="settled"] .ilmt-gloss-fx-plus {
  animation: ilmt-magnet-plus 1100ms ease-out forwards;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-animations="off"] .ilmt-gloss-fx-body,
[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-animations="off"] .ilmt-gloss-fx-field,
[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-animations="off"] .ilmt-gloss-fx-filing,
[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-animations="off"] .ilmt-gloss-fx-plus {
  animation: none;
}

@keyframes ilmt-magnet-idle {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(1.4px); }
}

@keyframes ilmt-magnet-pull {
  0% { transform: translateY(0) scale(1); }
  18% { transform: translateY(-3.5px) scale(1.04, 1.02); }
  55% { transform: translateY(1.5px) scale(.98, 1.03); }
  80% { transform: translateY(-.6px) scale(1.01); }
  100% { transform: translateY(0) scale(1); }
}

@keyframes ilmt-magnet-breathe {
  0%, 100% { opacity: .5; }
  50% { opacity: .9; }
}

@keyframes ilmt-magnet-flare {
  0% { opacity: .55; transform: scale(1); }
  35% { opacity: 1; transform: scale(1.06); }
  100% { opacity: .22; transform: scale(1); }
}

@keyframes ilmt-magnet-filing {
  0% { opacity: 0; transform: translate(0, 0) scale(.6); }
  25% { opacity: 1; }
  100% { opacity: 0; transform: translate(var(--dx, 0), var(--dy, 10px)) scale(.45); }
}

@keyframes ilmt-magnet-plus {
  0% { opacity: 0; transform: translate(6px, -40%) scale(.8); }
  22% { opacity: 1; transform: translate(6px, -56%) scale(1.04); }
  78% { opacity: 1; transform: translate(6px, -64%) scale(1); }
  100% { opacity: 0; transform: translate(6px, -76%) scale(1); }
}
`;

export const magnetEffect: ClaimEffect = {
  id: EFFECT_ID,
  label: "磁铁",
  summary: "词下方一块磁铁，点一下把词吸进两极之间。",
  reserve: { above: 0, below: 48 },
  css: CSS,
  mount(ctx): ClaimHandle {
    const { doc, root, animations, theme } = ctx;
    root.dataset.ilmtEffect = EFFECT_ID;
    root.dataset.ilmtTheme = theme;
    root.dataset.ilmtAnimations = animations ? "on" : "off";

    const button = doc.createElement("button");
    button.type = "button";
    button.className = "ilmt-gloss-fx-hit";
    button.setAttribute("aria-label", ctx.label("按"));

    const plus = doc.createElement("span");
    plus.className = "ilmt-gloss-fx-plus";
    plus.textContent = "+1 已收录";

    button.append(plus, magnetSvg(doc));
    root.appendChild(button);

    let phase: LocalPhase = "idle";
    let busy = false;
    let destroyed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const paint = (): void => {
      root.dataset.ilmtState = phase;
    };
    paint();

    const finalize = (result: { ok: boolean; created: boolean }): void => {
      if (destroyed) return;
      busy = false;
      if (!result.ok) {
        phase = "idle";
        paint();
        ctx.announce("收录失败");
        return;
      }
      phase = result.created ? "settled" : "known";
      paint();
      ctx.announce(result.created ? "已收录" : "这个词已经在学习库里了");
    };

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (busy || phase !== "idle") return;
      busy = true;
      phase = "hit";
      paint();

      void ctx
        .claim()
        .catch(() => ({ ok: false, created: false }))
        .then((result) => {
          if (destroyed) return;
          if (!animations) {
            finalize(result);
            return;
          }
          timer = setTimeout(() => finalize(result), PULL_MS);
        });
    });

    return {
      setState(next: ClaimPhase): void {
        if (busy) return;
        phase = next;
        paint();
      },
      destroy(): void {
        destroyed = true;
        if (timer !== undefined) clearTimeout(timer);
        button.remove();
      },
    };
  },
};

registerEffect(magnetEffect);
