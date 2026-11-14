import { registerEffect } from "./index";
import type { ClaimEffect, ClaimHandle, ClaimPhase } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";
const EFFECT_ID = "cat-hoard";
/** Paw-lift + word-drop + hug animation length. */
const HUG_MS = 720;

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

/** One tapered mitten, mirrored by `side` so the paws hug inward. */
function paw(doc: Document, side: "left" | "right"): SVGElement {
  const g = node(doc, "g");
  g.setAttribute("class", `ilmt-gloss-fx-paw ilmt-gloss-fx-paw-${side === "left" ? "l" : "r"}`);
  const d =
    side === "left"
      ? "M19.6 44.8c1.9-1.6 4.9-1.4 6.2.6 1 1.5.6 3.4-.9 4.4l-2.2 1.4c-1.6 1-3.6.4-4.4-1.3l-.9-1.9c-.7-1.4.2-2.6 2.2-3.2z"
      : "M44.4 44.8c-1.9-1.6-4.9-1.4-6.2.6-1 1.5-.6 3.4.9 4.4l2.2 1.4c1.6 1 3.6.4 4.4-1.3l.9-1.9c.7-1.4-.2-2.6-2.2-3.2z";
  const toes = side === "left" ? "M22.6 46.4v2.6M24.8 46.6v2.4" : "M41.4 46.4v2.6M39.2 46.6v2.4";
  g.append(
    node(doc, "path", {
      d,
      fill: "var(--ilmt-cat-belly)",
      stroke: "var(--ilmt-cat-ink)",
      "stroke-width": "1.1",
    }),
    node(doc, "path", {
      d: toes,
      stroke: "var(--ilmt-cat-ink)",
      "stroke-width": ".75",
      "stroke-linecap": "round",
      opacity: ".45",
    }),
  );
  return g;
}

/**
 * A golden chinchilla curled up around the word: wide flat face, half-lidded
 * eyes, tail flipping out to the right. Drawn from the user's photo, not
 * traced over it — the pose is what carries the character.
 */
function catSvg(doc: Document): SVGElement {
  const svg = node(doc, "svg", {
    viewBox: "0 0 64 60",
    width: "64",
    height: "60",
    "aria-hidden": "true",
    focusable: "false",
  });

  const tail = node(doc, "g");
  tail.setAttribute("class", "ilmt-gloss-fx-tail");
  tail.append(
    node(doc, "path", {
      d:
        "M45.2 52.8c8.4 1.6 15-2.4 16.6-9 .8-3.6 0-6.4-2.6-7.4-2.2-.9-4.6.2-5.8 2.6 2.2-1.2 4.2-.6 4.8 1.2.8 2.4-.6 5.2-3.2 7-2.8 2-6.4 2.4-9.6 1.2z",
      fill: "var(--ilmt-cat-fur)",
      stroke: "var(--ilmt-cat-ink)",
      "stroke-width": "1.2",
      "stroke-linejoin": "round",
    }),
  );

  const torso = node(doc, "g");
  torso.setAttribute("class", "ilmt-gloss-fx-torso");
  torso.append(
    node(doc, "path", {
      d:
        "M32.6 31.6c9.8 0 17.4 5.4 18.6 13.2.6 4.2-2 7.8-6.2 7.8H20.2c-4.2 0-6.8-3.6-6.2-7.8 1.2-7.8 8.8-13.2 18.6-13.2z",
      fill: "var(--ilmt-cat-fur)",
      stroke: "var(--ilmt-cat-ink)",
      "stroke-width": "1.3",
    }),
    node(doc, "path", {
      d: "M44.6 37.4c3.6 2 5.4 5.4 5 9.6",
      fill: "none",
      stroke: "var(--ilmt-cat-fur-2)",
      "stroke-width": "1.5",
      "stroke-linecap": "round",
      opacity: ".65",
    }),
    node(doc, "path", {
      d:
        "M32.6 40.6c5.6 0 9.4 2.8 9.8 7.4.2 1.8-1.3 3.2-3.1 3.2H25.9c-1.8 0-3.3-1.4-3.1-3.2.4-4.6 4.2-7.4 9.8-7.4z",
      fill: "var(--ilmt-cat-belly)",
    }),
  );

  // The word itself: a small paper chip the cat pulls under its chin.
  const chip = node(doc, "g");
  chip.setAttribute("class", "ilmt-gloss-fx-chip");
  const chipBody = node(doc, "g", { transform: "rotate(-4 32 44.6)" });
  chipBody.append(
    node(doc, "rect", {
      x: "28.0",
      y: "40.0",
      width: "8.2",
      height: "9.4",
      rx: "1.8",
      fill: "var(--ilmt-cat-chip)",
      stroke: "var(--ilmt-cat-ink)",
      "stroke-width": ".9",
    }),
    node(doc, "path", {
      d: "M29.6 42.6h5M29.6 45.2h3.4M29.6 47.8h4.2",
      stroke: "var(--ilmt-cat-chip-line)",
      "stroke-width": ".9",
      "stroke-linecap": "round",
    }),
  );
  chip.append(chipBody);
  torso.append(chip, paw(doc, "left"), paw(doc, "right"));

  const head = node(doc, "g");
  head.append(
    node(doc, "path", {
      d: "M16.6 18.6 16.4 8.4c0-1.2 1.4-1.8 2.3-1l7.7 5.9z",
      fill: "var(--ilmt-cat-fur)",
      stroke: "var(--ilmt-cat-ink)",
      "stroke-width": "1.3",
      "stroke-linejoin": "round",
    }),
    node(doc, "path", {
      d: "M19.6 15.8 19.5 10.6l3.8 3z",
      fill: "var(--ilmt-cat-ear)",
      opacity: ".9",
    }),
    node(doc, "path", {
      d: "M47.4 18.6 47.6 8.4c0-1.2-1.4-1.8-2.3-1l-7.7 5.9z",
      fill: "var(--ilmt-cat-fur)",
      stroke: "var(--ilmt-cat-ink)",
      "stroke-width": "1.3",
      "stroke-linejoin": "round",
    }),
    node(doc, "path", {
      d: "M44.4 15.8 44.5 10.6l-3.8 3z",
      fill: "var(--ilmt-cat-ear)",
      opacity: ".9",
    }),
    node(doc, "ellipse", {
      cx: "32",
      cy: "24.4",
      rx: "17.6",
      ry: "15.2",
      fill: "var(--ilmt-cat-fur)",
      stroke: "var(--ilmt-cat-ink)",
      "stroke-width": "1.4",
    }),
    node(doc, "path", {
      d: "M28.4 10.6v3.4M32 9.8v3.8M35.6 10.6v3.4",
      stroke: "var(--ilmt-cat-fur-2)",
      "stroke-width": "1.7",
      "stroke-linecap": "round",
      opacity: ".5",
    }),
    // muzzle
    node(doc, "ellipse", {
      cx: "32",
      cy: "30.4",
      rx: "8.6",
      ry: "4.8",
      fill: "var(--ilmt-cat-belly)",
      opacity: ".9",
    }),
    node(doc, "path", {
      d: "M22.6 31.4q2.2 2.6 4.4.4M41.4 31.4q-2.2 2.6-4.4.4",
      fill: "none",
      stroke: "var(--ilmt-cat-ink)",
      "stroke-width": ".6",
      "stroke-linecap": "round",
      opacity: ".25",
    }),
    // nose + down-turned mouth
    node(doc, "path", { d: "M30.5 27.8h3l-1.5 1.8z", fill: "var(--ilmt-cat-nose)" }),
    node(doc, "path", {
      d: "M32 29.6v1.2",
      stroke: "var(--ilmt-cat-ink)",
      "stroke-width": ".9",
      "stroke-linecap": "round",
    }),
    node(doc, "path", {
      d: "M32 30.8c-.7 1.3-1.9 1.7-3 .9M32 30.8c.7 1.3 1.9 1.7 3 .9",
      fill: "none",
      stroke: "var(--ilmt-cat-ink)",
      "stroke-width": ".95",
      "stroke-linecap": "round",
    }),
    // whiskers
    node(doc, "path", {
      d: "M23.4 29.6 18.2 28.4M23.4 31.4 18.3 31.8M40.6 29.6 45.8 28.4M40.6 31.4 45.7 31.8",
      stroke: "var(--ilmt-cat-ink)",
      "stroke-width": ".65",
      "stroke-linecap": "round",
      opacity: ".45",
    }),
  );

  const leftEye = node(doc, "g");
  leftEye.setAttribute(
    "class",
    "ilmt-gloss-fx-eye-l ilmt-gloss-fx-eyes-open",
  );
  leftEye.append(
    node(doc, "path", { d: "M20.6 24.6q3.4 2.6 6.8 0", fill: "var(--ilmt-cat-iris)" }),
    node(doc, "path", { d: "M20.9 25.0q3.2 1.9 6.2 0", fill: "var(--ilmt-cat-iris)" }),
    node(doc, "ellipse", {
      cx: "24",
      cy: "25.4",
      rx: ".85",
      ry: "1.15",
      fill: "var(--ilmt-cat-eye)",
    }),
    node(doc, "path", {
      d: "M20.4 24.6q3.6-1.6 7.2-.5",
      fill: "none",
      stroke: "var(--ilmt-cat-eye)",
      "stroke-width": "1.5",
      "stroke-linecap": "round",
    }),
    node(doc, "circle", { cx: "22.2", cy: "25.2", r: ".4", fill: "#fff", opacity: ".85" }),
  );

  const rightEye = node(doc, "g");
  rightEye.setAttribute(
    "class",
    "ilmt-gloss-fx-eye-r ilmt-gloss-fx-eyes-open",
  );
  rightEye.append(
    node(doc, "path", { d: "M43.4 24.6q-3.4 2.6-6.8 0", fill: "var(--ilmt-cat-iris)" }),
    node(doc, "path", { d: "M43.1 25.0q-3.2 1.9-6.2 0", fill: "var(--ilmt-cat-iris)" }),
    node(doc, "ellipse", {
      cx: "40",
      cy: "25.4",
      rx: ".85",
      ry: "1.15",
      fill: "var(--ilmt-cat-eye)",
    }),
    node(doc, "path", {
      d: "M43.6 24.6q-3.6-1.6-7.2-.5",
      fill: "none",
      stroke: "var(--ilmt-cat-eye)",
      "stroke-width": "1.5",
      "stroke-linecap": "round",
    }),
    node(doc, "circle", { cx: "41.8", cy: "25.2", r: ".4", fill: "#fff", opacity: ".85" }),
  );

  const closedEyes = node(doc, "g");
  closedEyes.setAttribute("class", "ilmt-gloss-fx-eyes-closed");
  closedEyes.append(
    node(doc, "path", {
      d: "M21.2 25.6c1.6 1.6 3.8 1.6 5.4 0M37.4 25.6c1.6 1.6 3.8 1.6 5.4 0",
      fill: "none",
      stroke: "var(--ilmt-cat-eye)",
      "stroke-width": "1.5",
      "stroke-linecap": "round",
    }),
  );

  const wink = node(doc, "g");
  wink.setAttribute("class", "ilmt-gloss-fx-wink");
  wink.append(
    node(doc, "path", {
      d: "M37.4 25.6c1.6 1.6 3.8 1.6 5.4 0",
      fill: "none",
      stroke: "var(--ilmt-cat-eye)",
      "stroke-width": "1.5",
      "stroke-linecap": "round",
    }),
  );

  head.append(leftEye, rightEye, closedEyes, wink);
  svg.append(tail, torso, head);
  return svg;
}

const CSS = `
[data-ilmt-effect="${EFFECT_ID}"] {
  --ilmt-cat-fur: #cda87e;
  --ilmt-cat-fur-2: #b28a5f;
  --ilmt-cat-belly: #f4e6cc;
  --ilmt-cat-ear: #e7a6a2;
  --ilmt-cat-eye: #2b2018;
  --ilmt-cat-iris: #b8923d;
  --ilmt-cat-nose: #cf9292;
  --ilmt-cat-ink: #6f5033;
  --ilmt-cat-chip: #fffdf6;
  --ilmt-cat-chip-line: #2dd4bf;
  display: block;
  width: 64px;
  height: 56px;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-theme="dark"] {
  --ilmt-cat-fur: #c39d75;
  --ilmt-cat-fur-2: #a5815b;
  --ilmt-cat-belly: #e8d5b6;
  --ilmt-cat-ear: #d69b98;
  --ilmt-cat-eye: #100c08;
  --ilmt-cat-iris: #cba044;
  --ilmt-cat-nose: #c98d8d;
  --ilmt-cat-ink: #5f4530;
  --ilmt-cat-chip: #f0e7d4;
  --ilmt-cat-chip-line: #5eead4;
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-hit {
  position: relative;
  display: block;
  width: 64px;
  height: 56px;
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
  border-radius: 12px;
}

[data-ilmt-effect="${EFFECT_ID}"] svg {
  display: block;
  overflow: visible;
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-tail {
  transform-origin: 46px 50px;
  animation: ilmt-cat-tail 4.2s ease-in-out infinite;
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-torso {
  transform-origin: 32px 54px;
  animation: ilmt-cat-breathe 4.2s ease-in-out infinite;
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-paw {
  transition: transform .18s ease;
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-paw-l {
  transform-origin: 22px 52px;
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-paw-r {
  transform-origin: 42px 52px;
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-chip {
  opacity: 0;
  transform-origin: 32px 44px;
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-eyes-closed,
[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-wink {
  opacity: 0;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="hit"] .ilmt-gloss-fx-tail {
  animation: ilmt-cat-swish 720ms ease-in-out;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="hit"] .ilmt-gloss-fx-torso {
  animation: ilmt-cat-dip 720ms cubic-bezier(.3, .7, .35, 1) both;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="hit"] .ilmt-gloss-fx-paw-l {
  animation: ilmt-cat-hug-l 720ms cubic-bezier(.3, .7, .35, 1) both;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="hit"] .ilmt-gloss-fx-paw-r {
  animation: ilmt-cat-hug-r 720ms cubic-bezier(.3, .7, .35, 1) both;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="hit"] .ilmt-gloss-fx-chip {
  animation: ilmt-cat-chip-in 720ms cubic-bezier(.3, .7, .35, 1) both;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="settled"] .ilmt-gloss-fx-chip,
[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="known"] .ilmt-gloss-fx-chip {
  opacity: 1;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="settled"] .ilmt-gloss-fx-eyes-open {
  opacity: 0;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="settled"] .ilmt-gloss-fx-eyes-closed {
  opacity: 1;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="settled"] .ilmt-gloss-fx-torso,
[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="known"] .ilmt-gloss-fx-torso {
  animation: none;
  transform: translateY(1.5px);
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="settled"] .ilmt-gloss-fx-paw-l {
  transform: translate(3px, -3px) rotate(10deg);
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="settled"] .ilmt-gloss-fx-paw-r {
  transform: translate(-3px, -3px) rotate(-10deg);
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="settled"] .ilmt-gloss-fx-tail {
  animation: none;
  transform: rotate(-4deg);
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="known"] .ilmt-gloss-fx-eye-r {
  opacity: 0;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="known"] .ilmt-gloss-fx-wink {
  opacity: 1;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="known"] .ilmt-gloss-fx-paw-l {
  transform: translate(2px, -2px) rotate(8deg);
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="known"] .ilmt-gloss-fx-paw-r {
  transform: translate(-2px, -2px) rotate(-8deg);
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="known"] .ilmt-gloss-fx-tail {
  animation: none;
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-plus {
  position: absolute;
  left: 100%;
  top: 26px;
  transform: translate(4px, -50%);
  color: #0f766e;
  font-size: 10.5px;
  line-height: 1;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-theme="dark"] .ilmt-gloss-fx-plus {
  color: #5eead4;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="settled"] .ilmt-gloss-fx-plus {
  animation: ilmt-cat-plus 1100ms ease-out forwards;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-animations="off"] .ilmt-gloss-fx-tail,
[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-animations="off"] .ilmt-gloss-fx-torso,
[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-animations="off"] .ilmt-gloss-fx-paw,
[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-animations="off"] .ilmt-gloss-fx-chip,
[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-animations="off"] .ilmt-gloss-fx-plus {
  animation: none;
  transition: none;
}

@keyframes ilmt-cat-tail {
  0%, 100% { transform: rotate(0deg); }
  50% { transform: rotate(-8deg); }
}

@keyframes ilmt-cat-swish {
  0%, 100% { transform: rotate(0deg); }
  30% { transform: rotate(-11deg); }
  65% { transform: rotate(4deg); }
}

@keyframes ilmt-cat-breathe {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(.7px); }
}

@keyframes ilmt-cat-dip {
  0% { transform: translateY(0); }
  22% { transform: translateY(-1.2px) scale(1.03, .98); }
  62% { transform: translateY(1.6px) scale(1.01, .99); }
  100% { transform: translateY(1.5px); }
}

@keyframes ilmt-cat-hug-l {
  0% { transform: translate(0, 0) rotate(0deg); }
  24% { transform: translate(1px, -6px) rotate(12deg); }
  62% { transform: translate(4px, -5px) rotate(13deg); }
  100% { transform: translate(3px, -3px) rotate(10deg); }
}

@keyframes ilmt-cat-hug-r {
  0% { transform: translate(0, 0) rotate(0deg); }
  24% { transform: translate(-1px, -6px) rotate(-12deg); }
  62% { transform: translate(-4px, -5px) rotate(-13deg); }
  100% { transform: translate(-3px, -3px) rotate(-10deg); }
}

@keyframes ilmt-cat-chip-in {
  0% { opacity: 0; transform: translateY(-14px) scale(.7); }
  18% { opacity: 1; transform: translateY(-11px) scale(.82); }
  62% { opacity: 1; transform: translateY(-1px) scale(1.02); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes ilmt-cat-plus {
  0% { opacity: 0; transform: translate(4px, -42%) scale(.85); }
  22% { opacity: 1; transform: translate(4px, -52%) scale(1.04); }
  78% { opacity: 1; transform: translate(4px, -58%) scale(1); }
  100% { opacity: 0; transform: translate(4px, -68%) scale(1); }
}
`;

export const catHoardEffect: ClaimEffect = {
  id: EFFECT_ID,
  label: "怀里猫",
  summary: "猫伸爪把词扒进怀里藏着，收过就睁一只眼瞥你。",
  reserve: { above: 0, below: 60 },
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

    button.append(plus, catSvg(doc));
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
          timer = setTimeout(() => finalize(result), HUG_MS);
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

registerEffect(catHoardEffect);
