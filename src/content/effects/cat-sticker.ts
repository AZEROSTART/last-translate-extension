import { registerEffect } from "./index";
import type { ClaimEffect, ClaimHandle, ClaimPhase } from "./types";
import catHeldUrl from "./assets/cat-held.webp";

const EFFECT_ID = "cat-sticker";
/** Peel the sticker up and slap it back down. */
const PEEL_MS = 720;

type LocalPhase = ClaimPhase | "hit";

const CSS = `
[data-ilmt-effect="${EFFECT_ID}"] {
  display: block;
  width: 80px;
  height: 78px;
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-hit {
  position: relative;
  display: block;
  width: 80px;
  height: 78px;
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

/* The cut-out photo carries a baked white die-cut edge; the shadow keeps that
   edge readable on light cards, where the border alone would disappear. */
[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-img {
  display: block;
  width: 80px;
  height: auto;
  will-change: transform;
  -webkit-user-drag: none;
  user-select: none;
  pointer-events: none;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .22));
  animation: ilmt-sticker-bob 3.8s ease-in-out infinite;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="hit"] .ilmt-gloss-fx-img {
  animation: ilmt-sticker-peel 720ms cubic-bezier(.34, .7, .36, 1) both;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="settled"] .ilmt-gloss-fx-img {
  animation: none;
  transform: none;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-state="known"] .ilmt-gloss-fx-img {
  animation: none;
  transform: translateY(1px);
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .18)) saturate(.25) opacity(.9);
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-plus {
  position: absolute;
  left: 100%;
  top: 34px;
  transform: translate(2px, -50%);
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
  animation: ilmt-sticker-plus 1100ms ease-out forwards;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-animations="off"] .ilmt-gloss-fx-img,
[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-animations="off"] .ilmt-gloss-fx-plus {
  animation: none;
}

/* The review card keeps a 50×44 avatar slot; the photo is wider than that. */
.ilmt-review-mascot [data-ilmt-effect="${EFFECT_ID}"] {
  transform: scale(.62);
  transform-origin: top left;
}

@keyframes ilmt-sticker-bob {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  50% { transform: translateY(-2px) rotate(-.7deg); }
}

/* Peel the sticker off the card, then slap it back down. */
@keyframes ilmt-sticker-peel {
  0% { transform: translateY(0) rotate(0deg) scale(1); }
  18% { transform: translateY(-7px) rotate(-4deg) scale(1.03); }
  36% { transform: translateY(-9px) rotate(-5deg) scale(1.04); }
  56% { transform: translateY(2px) rotate(1deg) scale(1.02, .96); }
  74% { transform: translateY(-1px) rotate(-.5deg) scale(.99, 1.01); }
  100% { transform: translateY(0) rotate(0deg) scale(1); }
}

@keyframes ilmt-sticker-plus {
  0% { opacity: 0; transform: translate(2px, -42%) scale(.85); }
  22% { opacity: 1; transform: translate(2px, -52%) scale(1.04); }
  78% { opacity: 1; transform: translate(2px, -58%) scale(1); }
  100% { opacity: 0; transform: translate(2px, -68%) scale(1); }
}
`;

export const catStickerEffect: ClaimEffect = {
  id: EFFECT_ID,
  label: "贴纸猫",
  summary: "照片抠出来的猫贴在词下面，点一下掀起来再拍回去。",
  reserve: { above: 0, below: 84 },
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

    const img = doc.createElement("img");
    img.className = "ilmt-gloss-fx-img";
    img.src = catHeldUrl;
    img.alt = "";
    img.draggable = false;
    img.decoding = "async";

    const plus = doc.createElement("span");
    plus.className = "ilmt-gloss-fx-plus";
    plus.textContent = "+1 已收录";

    button.append(img, plus);
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
          timer = setTimeout(() => finalize(result), PEEL_MS);
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

registerEffect(catStickerEffect);
