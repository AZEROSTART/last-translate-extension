import { registerEffect } from "./index";
import type { ClaimEffect, ClaimHandle, ClaimPhase } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";
const EFFECT_ID = "gopher-hole";
/** Dive animation length; the settled still is the same pose. */
const DIVE_MS = 620;

type LocalPhase = ClaimPhase | "hit";

let maskSeq = 0;

function node<K extends keyof SVGElementTagNameMap>(
  doc: Document,
  name: K,
  attrs: Record<string, string> = {},
): SVGElementTagNameMap[K] {
  const element = doc.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}

function ear(doc: Document, cx: number, cy: number): SVGElement {
  return node(doc, "circle", {
    cx: String(cx),
    cy: String(cy),
    r: "3.5",
    fill: "var(--ilmt-fur)",
    stroke: "#8a5f3b",
    "stroke-width": "1.1",
  });
}

function paw(doc: Document, cx: number, cy: number): SVGElement {
  return node(doc, "ellipse", {
    cx: String(cx),
    cy: String(cy),
    rx: "3.4",
    ry: "2.4",
    fill: "var(--ilmt-fur-light)",
    stroke: "#8a5f3b",
    "stroke-width": "1.1",
  });
}

function face(doc: Document, cx: number, cy: number): SVGElement {
  const g = node(doc, "g");
  g.append(
    node(doc, "ellipse", {
      cx: String(cx),
      cy: String(cy + 3.4),
      rx: "8.6",
      ry: "6.4",
      fill: "var(--ilmt-belly)",
    }),
    node(doc, "ellipse", {
      cx: String(cx - 5.8),
      cy: String(cy + 1.6),
      rx: "2.2",
      ry: "1.5",
      fill: "#f19aa2",
      opacity: ".6",
    }),
    node(doc, "ellipse", {
      cx: String(cx + 5.8),
      cy: String(cy + 1.6),
      rx: "2.2",
      ry: "1.5",
      fill: "#f19aa2",
      opacity: ".6",
    }),
    node(doc, "ellipse", {
      cx: String(cx),
      cy: String(cy + 1.2),
      rx: "1.8",
      ry: "1.35",
      fill: "#2b1d12",
    }),
    node(doc, "path", {
      d: `M${cx} ${cy + 2.6} q0 3.2 2.8 3.2`,
      fill: "none",
      stroke: "#2b1d12",
      "stroke-width": "1.1",
      "stroke-linecap": "round",
    }),
  );
  for (const dx of [-2.2, 0.4]) {
    g.append(
      node(doc, "rect", {
        x: String(cx + dx),
        y: String(cy + 3.6),
        width: "1.8",
        height: "2.6",
        rx: "0.6",
        fill: "#fff",
        stroke: "#2b1d12",
        "stroke-width": ".55",
      }),
    );
  }
  return g;
}

function eyes(doc: Document, cx1: number, cy1: number, cx2: number, cy2: number): SVGElement {
  const g = node(doc, "g");
  for (const [cx, cy] of [
    [cx1, cy1],
    [cx2, cy2],
  ]) {
    g.append(
      node(doc, "circle", { cx: String(cx), cy: String(cy), r: "3.2", fill: "#2b1d12" }),
      node(doc, "circle", {
        cx: String(cx - 1),
        cy: String(cy - 1.1),
        r: "1",
        fill: "#fff",
      }),
    );
  }
  return g;
}

/**
 * B — head out of a hole below the word. The body is masked to "above the rim
 * OR inside the opening", so sinking really hides it behind the hole's wall.
 * The far rim is drawn before the body (hidden by it) and the near rim after
 * (drawn on top), which is the depth ordering of a real hole.
 */
function gopherSvg(doc: Document): SVGElement {
  const maskId = `ilmt-gopher-rim-${maskSeq++}`;
  const defs = node(doc, "defs");
  const mask = node(doc, "mask", {
    id: maskId,
    maskUnits: "userSpaceOnUse",
    maskContentUnits: "userSpaceOnUse",
    x: "0",
    y: "0",
    width: "56",
    height: "70",
  });
  mask.append(
    node(doc, "rect", { x: "0", y: "0", width: "56", height: "36", fill: "#fff" }),
    node(doc, "ellipse", { cx: "28", cy: "36", rx: "17", ry: "7.5", fill: "#fff" }),
  );
  defs.append(mask);

  const svg = node(doc, "svg", {
    viewBox: "0 0 56 70",
    width: "50",
    height: "62.5",
    "aria-hidden": "true",
    focusable: "false",
  });

  const g = node(doc, "g");
  g.append(
    node(doc, "ellipse", { cx: "28", cy: "36", rx: "17", ry: "7.5", fill: "var(--ilmt-hole)" }),
    node(doc, "ellipse", {
      cx: "28",
      cy: "33.4",
      rx: "13",
      ry: "3.8",
      fill: "#5b4630",
      opacity: ".38",
    }),
    // the far rim is behind the gopher
    node(doc, "path", {
      d: "M11 36 a 17 7.5 0 0 1 34 0",
      fill: "none",
      stroke: "#19120b",
      "stroke-width": "1.3",
      opacity: ".7",
    }),
  );

  const body = node(doc, "g");
  body.setAttribute("class", "ilmt-gloss-fx-body");
  body.append(
    node(doc, "path", {
      d: "M15 44 q0 -27 13 -27 q13 0 13 27 z",
      fill: "var(--ilmt-fur)",
      stroke: "#8a5f3b",
      "stroke-width": "1.1",
    }),
    ear(doc, 18, 10),
    ear(doc, 38, 10),
    node(doc, "circle", {
      cx: "28",
      cy: "17",
      r: "14.6",
      fill: "var(--ilmt-fur)",
      stroke: "#8a5f3b",
      "stroke-width": "1.1",
    }),
    face(doc, 28, 18),
  );

  const open = node(doc, "g");
  open.setAttribute("class", "ilmt-gloss-fx-open");
  open.append(eyes(doc, 21.8, 14.8, 34.2, 14.8));

  const dizzy = node(doc, "g");
  dizzy.setAttribute("class", "ilmt-gloss-fx-dizzy");
  for (const [cx, cy] of [
    [21.8, 14.8],
    [34.2, 14.8],
  ]) {
    dizzy.append(
      node(doc, "path", {
        d: `M${cx - 2.6} ${cy - 2.6} l5.2 5.2`,
        stroke: "#2b1d12",
        "stroke-width": "1.8",
        "stroke-linecap": "round",
      }),
      node(doc, "path", {
        d: `M${cx + 2.6} ${cy - 2.6} l-5.2 5.2`,
        stroke: "#2b1d12",
        "stroke-width": "1.8",
        "stroke-linecap": "round",
      }),
    );
  }

  body.append(open, dizzy, paw(doc, 12, 32), paw(doc, 44, 32));

  // The mask lives outside the transform, so it stays put while the body sinks.
  const masked = node(doc, "g", { mask: `url(#${maskId})` });
  masked.append(body);
  g.append(masked);
  // the near rim is closer to the viewer than the gopher
  g.append(
    node(doc, "path", {
      d: "M11 36 a 17 7.5 0 0 0 34 0",
      fill: "none",
      stroke: "#19120b",
      "stroke-width": "1.4",
      opacity: ".9",
    }),
  );

  svg.append(defs, g);
  return svg;
}

const CSS = `
[data-ilmt-effect="${EFFECT_ID}"] {
  --ilmt-fur: #d3a274;
  --ilmt-fur-light: #ecd0ad;
  --ilmt-belly: #fbe7cd;
  --ilmt-hole: #33261a;
  display: block;
  width: 50px;
  height: 44px;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-theme="dark"] {
  --ilmt-fur: #c3966c;
  --ilmt-fur-light: #e0bd97;
  --ilmt-belly: #edd4b4;
  --ilmt-hole: #080b0f;
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
  animation: ilmt-fx-peek 3.6s ease-in-out infinite;
  transform-origin: 28px 36px;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="hit"] .ilmt-gloss-fx-body {
  animation: ilmt-fx-dive 620ms cubic-bezier(.34, .72, .3, 1) both;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="settled"] .ilmt-gloss-fx-body,
[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="known"] .ilmt-gloss-fx-body {
  animation: none;
  transform: translateY(22px) scale(.92);
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-dizzy {
  opacity: 0;
  transition: opacity .16s ease .12s;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="settled"] .ilmt-gloss-fx-dizzy,
[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="known"] .ilmt-gloss-fx-dizzy {
  opacity: 1;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="settled"] .ilmt-gloss-fx-open,
[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="known"] .ilmt-gloss-fx-open {
  opacity: 0;
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-sparks {
  position: absolute;
  left: 50%;
  top: 62%;
  width: 0;
  height: 0;
  pointer-events: none;
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-spark {
  position: absolute;
  left: -3.5px;
  top: -3.5px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #2dd4bf;
  opacity: 0;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="hit"] .ilmt-gloss-fx-spark {
  animation: ilmt-fx-spark 560ms ease-out forwards;
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-spark:nth-child(1) { --dx: -22px; --dy: -20px; animation-delay: 30ms; }
[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-spark:nth-child(2) { --dx: -4px; --dy: -30px; animation-delay: 80ms; }
[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-spark:nth-child(3) { --dx: 20px; --dy: -22px; animation-delay: 50ms; }
[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-spark:nth-child(4) { --dx: -24px; --dy: 4px; animation-delay: 100ms; }
[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-spark:nth-child(5) { --dx: 23px; --dy: 2px; animation-delay: 70ms; }

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-dust {
  position: absolute;
  left: 50%;
  top: 28px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #b9a184;
  opacity: 0;
  pointer-events: none;
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-dust-b {
  --dx: -16px;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="hit"] .ilmt-gloss-fx-dust {
  animation: ilmt-fx-dust 620ms ease-out 180ms forwards;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="hit"] .ilmt-gloss-fx-dust-b {
  animation-delay: 90ms;
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-plus {
  position: absolute;
  left: 100%;
  top: 28px;
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
  animation: ilmt-fx-plus 1100ms ease-out forwards;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-animations="off"] .ilmt-gloss-fx-body,
[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-animations="off"] .ilmt-gloss-fx-spark,
[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-animations="off"] .ilmt-gloss-fx-dust,
[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-animations="off"] .ilmt-gloss-fx-plus {
  animation: none;
}

@keyframes ilmt-fx-peek {
  0%, 100% { transform: translateY(0); }
  55% { transform: translateY(1.5px); }
}

@keyframes ilmt-fx-dive {
  0% { transform: translateY(0) scale(1, 1); }
  10% { transform: translateY(-4px) scale(1.12, .9); }
  40% { transform: translateY(9px) scale(1.06, .94); }
  68% { transform: translateY(24px) scale(1.14, .78); }
  84% { transform: translateY(20.5px) scale(.97, 1.03); }
  100% { transform: translateY(22px) scale(.92); }
}

@keyframes ilmt-fx-spark {
  0% { opacity: 1; transform: translate(0, 0) scale(.35); }
  100% { opacity: 0; transform: translate(var(--dx), var(--dy)) scale(1.05); }
}

@keyframes ilmt-fx-dust {
  0% { opacity: .95; transform: translate(0, 0) scale(.35); }
  100% { opacity: 0; transform: translate(var(--dx, 14px), -14px) scale(1); }
}

@keyframes ilmt-fx-plus {
  0% { opacity: 0; transform: translate(6px, -40%) scale(.8); }
  22% { opacity: 1; transform: translate(6px, -56%) scale(1.04); }
  78% { opacity: 1; transform: translate(6px, -64%) scale(1); }
  100% { opacity: 0; transform: translate(6px, -76%) scale(1); }
}
`;

export const gopherHoleEffect: ClaimEffect = {
  id: EFFECT_ID,
  label: "洞口地鼠",
  summary: "词下方开个洞，点一下地鼠把词收进洞里。",
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
    button.setAttribute("aria-label", ctx.label("打"));

    const sparks = doc.createElement("span");
    sparks.className = "ilmt-gloss-fx-sparks";
    for (let i = 0; i < 5; i += 1) {
      const spark = doc.createElement("i");
      spark.className = "ilmt-gloss-fx-spark";
      sparks.appendChild(spark);
    }

    const plus = doc.createElement("span");
    plus.className = "ilmt-gloss-fx-plus";
    plus.textContent = "+1 已收录";

    const dustA = doc.createElement("i");
    dustA.className = "ilmt-gloss-fx-dust";
    const dustB = doc.createElement("i");
    dustB.className = "ilmt-gloss-fx-dust ilmt-gloss-fx-dust-b";

    button.append(sparks, plus, dustA, dustB, gopherSvg(doc));
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
          timer = setTimeout(() => finalize(result), DIVE_MS);
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

registerEffect(gopherHoleEffect);
