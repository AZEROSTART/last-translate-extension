# 收录特效（Claim Effect）实现计划

- 日期：2026-11-13
- 设计文档：`docs/superpowers/specs/2026-11-13-claim-effects-design.md`（已批准）
- 视觉基线：`docs/previews/gopher-options.html` 的 B 方案
- 目标读者：没看过这套代码的工程师。按任务顺序做，每个任务都能独立通过 `npm test` + `npx tsc --noEmit`。

## 总体架构

```
src/content/effects/
  types.ts        ClaimEffect / ClaimContext / ClaimHandle / ClaimPhase
  index.ts        registerEffect / getEffects / getEffect / pickEffect
  gopher-hole.ts  第一个特效（洞口地鼠）
```

卡片（`src/content/glossary.ts`）永远负责：把特效挂到词旁边、按 `reserve` 留位、注入特效 CSS、提供 `claim()` 幂等写入、失败回滚、读屏播报、关闭时 `destroy()`。特效只负责：自己的 DOM、点击目标、动画时序、落定形态。

**持久化字段不改名**：`settings.mascot.{mode,fixedId,enabledIds,animations}`、`learnedWord.mascotId`、`learn-word` 消息结构全部原样保留。只改代码里的类型名与 UI 文案。

**构建期类名前缀**必须原样写成 `ilmt-gloss-`，包括写在 TS 字符串里的特效 CSS。

---

## Task 0 · 先把设计资料入库

**文件**

- 新增（已存在，未跟踪）：`docs/superpowers/specs/2026-11-13-claim-effects-design.md`
- 新增（已存在，未跟踪）：`docs/previews/gopher-options.html`

**步骤**

1. `git status --short` 应该只看到这两个未跟踪文件。
2. 提交：

```bash
git add docs/superpowers/specs/2026-11-13-claim-effects-design.md docs/previews/gopher-options.html
git commit -m "docs: specify claim effects and record the gopher preview"
```

---

## Task 1 · 契约与注册表

**目标**：新增 `ClaimEffect` 契约与注册表，暂不动卡片。旧的 `src/content/mascots/` 继续存在，保证本任务结束时项目仍可构建。

**文件**

- 新增 `src/content/effects/types.ts`
- 新增 `src/content/effects/index.ts`
- 新增 `tests/unit/effects.test.ts`
- 修改 `src/shared/types.ts`：`MascotSettings` → `EffectSettings`（属性名 `mascot` 不变）
- 修改 `src/shared/storage.ts`：`normalizeMascot` → `normalizeEffectSettings`（存储键不变）
- 修改 `src/content/main.ts`、`src/content/glossary.ts`、`src/settings/sections/learning.ts` 的 import 名（**只改类型名，不改行为**）

### 1.1 `src/content/effects/types.ts`

```ts
/**
 * A claim effect is one thing: a click on the word turns into one learning
 * write. How that click looks, how long it takes and what is left on screen
 * afterwards belongs to the effect; the card only guarantees the write.
 */

/** Visible phases. `settled` = this reveal just claimed the word. */
export type ClaimPhase = "idle" | "settled" | "known";

export interface ClaimResult {
  ok: boolean;
  /** false = the word was already in the store; nothing was written. */
  created: boolean;
}

export interface ClaimContext {
  doc: Document;
  /** The word shown on the card. Effects anchor to it; previews pass a stand-in. */
  surface: HTMLElement;
  /** Container the effect fills. The caller owns its position and size. */
  root: HTMLElement;
  theme: "light" | "dark";
  /** False when the user disabled animations or prefers-reduced-motion is on. */
  animations: boolean;
  /** Claim the current word. Idempotent: repeat calls never write twice. */
  claim(): Promise<ClaimResult>;
  /** Screen-reader announcement; the caller supplies the live region. */
  announce(text: string): void;
  /** Shared aria-label wording, so every effect reads consistently. */
  label(verb: string): string;
}

export interface ClaimHandle {
  /** Called with `known` when the word was already captured earlier. */
  setState(phase: ClaimPhase): void;
  /** Clear timers and listeners; the caller removes the DOM. */
  destroy(): void;
}

export interface ClaimEffect {
  id: string;
  /** Settings-page name, e.g. 洞口地鼠. */
  label: string;
  /** One line shown under the name on the settings page. */
  summary: string;
  /** Pixels the card must reserve above and below the word row. */
  reserve: { above: number; below: number };
  /** Scoped to [data-ilmt-effect="<id>"]; injected once by the card. */
  css?: string;
  mount(ctx: ClaimContext): ClaimHandle;
}
```

### 1.2 `src/content/effects/index.ts`

```ts
import type { ClaimEffect } from "./types";

export type {
  ClaimContext,
  ClaimEffect,
  ClaimHandle,
  ClaimPhase,
  ClaimResult,
} from "./types";

const effects: ClaimEffect[] = [];

/** Register at module load. Re-registering an id replaces the previous effect. */
export function registerEffect(effect: ClaimEffect): void {
  const index = effects.findIndex((item) => item.id === effect.id);
  if (index >= 0) effects[index] = effect;
  else effects.push(effect);
}

export function getEffects(): ClaimEffect[] {
  return [...effects];
}

export function getEffect(id: string): ClaimEffect | undefined {
  return effects.find((effect) => effect.id === id);
}

/** Small deterministic PRNG so rotation can be unit-tested. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PickEffectOptions {
  /** Empty = every registered effect. Unknown ids are ignored. */
  enabledIds: string[];
  /** Most recent picks, newest last; the last two are avoided. */
  lastPicks: string[];
  seed?: number;
}

/** Pick an effect, avoiding the last two picks unless that leaves nothing. */
export function pickEffect(options: PickEffectOptions): ClaimEffect {
  const enabled = options.enabledIds
    .map((id) => getEffect(id))
    .filter((effect): effect is ClaimEffect => effect !== undefined);
  const pool = enabled.length > 0 ? enabled : [...effects];
  if (pool.length === 0) throw new Error("No claim effect registered");

  const recent = new Set(options.lastPicks.slice(-2));
  const fresh = pool.filter((effect) => !recent.has(effect.id));
  const candidates = fresh.length > 0 ? fresh : pool;

  const random = options.seed === undefined ? Math.random : mulberry32(options.seed);
  const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length));
  return candidates[index];
}
```

### 1.3 改类型名（只改名，不改行为）

`src/shared/types.ts`：

```ts
/** How the claim effect is chosen on the hover card. */
export interface EffectSettings {
  mode: "rotate" | "fixed";
  fixedId?: string;
  /** Empty array = every registered effect. */
  enabledIds: string[];
  animations: boolean;
}
```

`Settings.mascot` 的字段名与类型保持不变，只把类型换成 `EffectSettings`。加一行注释：

```ts
  /** Claim effects. The property name is legacy; the storage key never changes. */
  mascot: EffectSettings;
```

`src/shared/storage.ts`：把 `normalizeMascot` 改名为 `normalizeEffectSettings`（函数体、默认值、返回值都不变），同步改 import 与调用点。默认值里的 `{ mode: "rotate", enabledIds: [], animations: true }` 不动。

其余改 import 名（搜索 `MascotSettings`）：

- `src/content/main.ts`（`let mascotSettings: EffectSettings`）
- `src/content/glossary.ts`（deps 里 `getMascotSettings?: () => EffectSettings | undefined` 先保留旧名，任务 3 再一起改成 `getEffectSettings`）
- `src/settings/sections/learning.ts`

### 1.4 `tests/unit/effects.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  getEffect,
  getEffects,
  pickEffect,
  registerEffect,
} from "../../src/content/effects";
import type { ClaimEffect } from "../../src/content/effects/types";

function effect(id: string): ClaimEffect {
  return {
    id,
    label: id,
    summary: `${id} summary`,
    reserve: { above: 0, below: 0 },
    mount: () => ({ setState: () => {}, destroy: () => {} }),
  };
}

registerEffect(effect("a"));
registerEffect(effect("b"));
registerEffect(effect("c"));

describe("effect registry", () => {
  it("registers effects and overwrites the same id", () => {
    registerEffect({ ...effect("a"), label: "A2" });
    expect(getEffect("a")?.label).toBe("A2");
    expect(getEffects()).toHaveLength(3);
  });

  it("ignores unknown enabled ids and falls back to every effect", () => {
    registerEffect(effect("a"));
    const picked = pickEffect({ enabledIds: ["gone"], lastPicks: [], seed: 1 });
    expect(["a", "b", "c"]).toContain(picked.id);
  });

  it("never repeats the last two picks", () => {
    const picked = pickEffect({ enabledIds: ["a", "b", "c"], lastPicks: ["a", "b"], seed: 1 });
    expect(picked.id).toBe("c");
  });

  it("falls back when the only enabled effect was just used", () => {
    expect(pickEffect({ enabledIds: ["a"], lastPicks: ["a"], seed: 2 }).id).toBe("a");
  });

  it("rotates evenly across three effects", () => {
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    const lastPicks: string[] = [];
    for (let i = 0; i < 3_000; i += 1) {
      const picked = pickEffect({ enabledIds: ["a", "b", "c"], lastPicks, seed: i + 1 });
      counts[picked.id] += 1;
      lastPicks.push(picked.id);
      if (lastPicks.length > 2) lastPicks.shift();
    }
    for (const id of ["a", "b", "c"]) {
      expect(counts[id] / 3_000).toBeGreaterThan(0.28);
      expect(counts[id] / 3_000).toBeLessThan(0.39);
    }
  });
});
```

**验证**

```bash
npm test -- tests/unit/effects.test.ts
npx tsc --noEmit
```

**提交**

```bash
git add src/content/effects src/shared/types.ts src/shared/storage.ts src/content/main.ts src/content/glossary.ts src/settings/sections/learning.ts tests/unit/effects.test.ts
git commit -m "feat: add the claim effect contract and registry"
```

---

## Task 2 · 洞口地鼠特效

**目标**：把预览页 B 方案 1:1 移植成 `gopher-hole`，用 `mount()` 契约，自带 CSS。

**文件**

- 新增 `src/content/effects/gopher-hole.ts`
- 新增 `tests/unit/gopher-hole.test.ts`

### 2.1 `src/content/effects/gopher-hole.ts`

```ts
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
    fill: "var(--ilmt-belly)",
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
  --ilmt-fur: #a97a52;
  --ilmt-belly: #e8cdb0;
  --ilmt-hole: #080b0f;
  display: block;
  width: 50px;
  height: 44px;
}

[data-ilmt-effect="${EFFECT_ID}"][data-ilmt-theme="dark"] {
  --ilmt-fur: #b98a63;
  --ilmt-belly: #d9bb9c;
  --ilmt-hole: #05080c;
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
  left: 62%;
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
  left: 62%;
  top: 62%;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #b9a998;
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
  animation-delay: 270ms;
}

[data-ilmt-effect="${EFFECT_ID}"] .ilmt-gloss-fx-plus {
  position: absolute;
  left: 100%;
  top: 30px;
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
    let timer: ReturnType<typeof setTimeout> | undefined;

    const paint = (): void => {
      root.dataset.ilmtState = phase;
    };
    paint();

    const finalize = (result: { ok: boolean; created: boolean }): void => {
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
        if (timer !== undefined) clearTimeout(timer);
        button.remove();
      },
    };
  },
};

registerEffect(gopherHoleEffect);
```

> 注意：`label`、`root`、`theme` 的默认值只影响渲染，不影响写库。

### 2.2 `tests/unit/gopher-hole.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gopherHoleEffect } from "../../src/content/effects/gopher-hole";
import type { ClaimContext } from "../../src/content/effects/types";

function context(over: Partial<ClaimContext> = {}): ClaimContext {
  const doc = document;
  return {
    doc,
    surface: doc.createElement("span"),
    root: doc.createElement("div"),
    theme: "light",
    animations: true,
    claim: vi.fn().mockResolvedValue({ ok: true, created: true }),
    announce: vi.fn(),
    label: (verb: string) => `把地鼠${verb}下去，收录这个单词`,
    ...over,
  };
}

describe("gopher-hole effect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("claims once, however often the head is clicked", async () => {
    const ctx = context();
    gopherHoleEffect.mount(ctx);
    const button = ctx.root.querySelector("button")!;

    button.click();
    button.click();
    expect(ctx.claim).toHaveBeenCalledTimes(1);
    expect(ctx.root.dataset.ilmtState).toBe("hit");

    await vi.advanceTimersByTimeAsync(620);
    expect(ctx.root.dataset.ilmtState).toBe("settled");
    expect(ctx.announce).toHaveBeenCalledWith("已收录");
  });

  it("settles on known when the word was already stored", async () => {
    const ctx = context({
      claim: vi.fn().mockResolvedValue({ ok: true, created: false }),
    });
    gopherHoleEffect.mount(ctx);
    ctx.root.querySelector("button")!.click();
    await vi.advanceTimersByTimeAsync(620);
    expect(ctx.root.dataset.ilmtState).toBe("known");
    expect(ctx.announce).toHaveBeenCalledWith("这个词已经在学习库里了");
  });

  it("returns to idle when the write fails", async () => {
    const ctx = context({ claim: vi.fn().mockResolvedValue({ ok: false, created: false }) });
    gopherHoleEffect.mount(ctx);
    ctx.root.querySelector("button")!.click();
    await vi.advanceTimersByTimeAsync(620);
    expect(ctx.root.dataset.ilmtState).toBe("idle");
  });

  it("does not animate when animations are off", async () => {
    const ctx = context({ animations: false });
    gopherHoleEffect.mount(ctx);
    ctx.root.querySelector("button")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.root.dataset.ilmtAnimations).toBe("off");
    expect(ctx.root.dataset.ilmtState).toBe("settled");
  });

  it("shows the known state without a click", () => {
    const ctx = context();
    const handle = gopherHoleEffect.mount(ctx);
    handle.setState("known");
    expect(ctx.root.dataset.ilmtState).toBe("known");
    expect(ctx.claim).not.toHaveBeenCalled();
  });

  it("labels the button through the shared wording", () => {
    const ctx = context();
    gopherHoleEffect.mount(ctx);
    expect(ctx.root.querySelector("button")!.getAttribute("aria-label")).toBe(
      "把地鼠打下去，收录这个单词",
    );
  });
});
```

**验证**

```bash
npm test -- tests/unit/gopher-hole.test.ts
npx tsc --noEmit
```

**提交**

```bash
git add src/content/effects/gopher-hole.ts tests/unit/gopher-hole.test.ts
git commit -m "feat: add the gopher-hole claim effect"
```

---

## Task 3 · 卡片改成挂载式

**目标**：悬停卡片不再渲染页脚角色，改为在词行挂载特效；`claim()` 承担幂等写入与回滚。

**文件**

- 修改 `src/content/glossary.ts`
- 修改 `src/content/main.ts`（依赖接线改名）
- 修改 `src/styles/inject.css`
- 修改 `tests/unit/glossary.test.ts`

### 3.1 `src/content/glossary.ts`

**imports**（替换旧的 mascots 导入）

```ts
import { getEffect, getEffects, pickEffect } from "./effects";
import type { ClaimEffect, ClaimHandle, ClaimPhase, ClaimResult } from "./effects/types";
import "./effects/gopher-hole";
```

**常量**：`MASCOT_HISTORY_KEY` → `EFFECT_HISTORY_KEY = "ilmt:effect-history"`（sessionStorage，无需迁移）。

**`GlossControllerDeps`** 改为：

```ts
export interface GlossControllerDeps {
  now?: () => number;
  sendLearn?: (message: LearnWordMessage) => Promise<LearnWordResponse | null>;
  /** Overrides rotation entirely (used by tests). */
  resolveEffect?: () => ClaimEffect;
  /** Live effect settings; read when a card opens so mode changes apply. */
  getEffectSettings?: () => EffectSettings | undefined;
  /** Current translation language, used as the card's answer language. */
  getGlossLang?: () => string;
}
```

**`readMascotHistory` / `writeMascotHistory` / `nextMascot`** 替换为：

```ts
  function readEffectHistory(): string[] {
    try {
      const raw = view?.sessionStorage?.getItem(EFFECT_HISTORY_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((id): id is string => typeof id === "string").slice(-2);
    } catch {
      return [];
    }
  }

  function writeEffectHistory(ids: string[]): void {
    try {
      view?.sessionStorage?.setItem(EFFECT_HISTORY_KEY, JSON.stringify(ids.slice(-2)));
    } catch {
      // Private mode or blocked storage; rotation just restarts.
    }
  }

  function nextEffect(): ClaimEffect {
    if (deps.resolveEffect) return deps.resolveEffect();
    const settings = deps.getEffectSettings?.();
    if (settings?.mode === "fixed") {
      const fixed = settings.fixedId ? getEffect(settings.fixedId) : undefined;
      if (fixed) return fixed;
      const all = getEffects();
      if (all.length > 0) return all[0];
    }
    const history = readEffectHistory();
    let effect: ClaimEffect;
    try {
      effect = pickEffect({ enabledIds: settings?.enabledIds ?? [], lastPicks: history });
    } catch {
      effect = getEffects()[0];
    }
    writeEffectHistory([...history, effect.id]);
    return effect;
  }

  function animationsAllowed(): boolean {
    if (deps.getEffectSettings?.()?.animations === false) return false;
    try {
      return !(view?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
    } catch {
      return true;
    }
  }

  let styleEl: HTMLStyleElement | null = null;

  /** Inject every registered effect's CSS once per document. */
  function ensureEffectStyles(): void {
    if (styleEl?.isConnected) return;
    const css = getEffects()
      .map((effect) => effect.css ?? "")
      .join("\n");
    if (!css.trim()) return;
    styleEl = doc.createElement("style");
    styleEl.dataset.ilmtEffects = "";
    styleEl.textContent = css;
    (doc.head ?? doc.documentElement).appendChild(styleEl);
  }
```

**控制器状态**：

- 新增 `let cardEffect: ClaimHandle | null = null;`。
- `const captured = new Map<string, "caught" | "known">()` 改成 `const captured = new Map<string, ClaimPhase>()`。

**`hideCard()`** 在 `card.remove()` 之前加 `cardEffect?.destroy(); cardEffect = null;`。

**`showCard()`**：保留词/词性/释义/例句的构建，把页脚角色整段（从 `const skin = nextMascot();` 到 `element.appendChild(mascot);`）替换为：

```ts
    ensureEffectStyles();

    const effect = nextEffect();
    const key = entryKey(entry);

    // The effect paints "already captured" itself; this region is screen-reader only.
    const announce = doc.createElement("div");
    announce.className = "ilmt-gloss-sr-only";
    announce.setAttribute("aria-live", "polite");

    const host = doc.createElement("div");
    host.className = "ilmt-gloss-effect-host";

    let claiming = false;
    const claim = async (): Promise<ClaimResult> => {
      if (captured.has(key)) return { ok: true, created: false };
      if (claiming) return { ok: false, created: false };
      claiming = true;
      const message: LearnWordMessage = {
        type: "learn-word",
        surface: entry.note.surface,
        termLang: entry.termLang ?? fallbackTermLang(),
        glossLang: deps.getGlossLang?.() ?? "zh-CN",
        meaning: entry.note.meaning,
        sentence: entry.sentence,
        pageUrl: entry.pageUrl,
        ...(entry.note.pos ? { pos: entry.note.pos } : {}),
        ...(entry.note.glosses ? { glosses: entry.note.glosses } : {}),
        ...(entry.pageTitle ? { pageTitle: entry.pageTitle } : {}),
        mascotId: effect.id,
      };
      const send = deps.sendLearn ?? defaultSendLearn;
      try {
        const response = await send(message);
        if (!response?.ok) return { ok: false, created: false };
        // Remember only the quiet end state: reopening the card must not
        // replay the "+1" animation.
        captured.set(key, "known");
        return { ok: true, created: response.created };
      } finally {
        claiming = false;
      }
    };

    word.appendChild(host);
    element.appendChild(announce);
    doc.body.appendChild(element);

    card = element;
    currentEntry = entry;
    pendingEntry = null;
    showTimer = undefined;

    cardEffect = effect.mount({
      doc,
      surface,
      root: host,
      // `.ilmt-card` has one light palette today; see the note below.
      theme: "light",
      animations: animationsAllowed(),
      claim,
      announce: (text) => {
        announce.textContent = text;
      },
      label: (verb) => `把${effect.label}${verb}下去，收录这个单词`,
    });

    // reserve: above grows the word row, below pushes the meaning down
    if (effect.reserve.above > 0) word.style.paddingTop = `${effect.reserve.above}px`;
    if (effect.reserve.below > 0) word.style.marginBottom = `${effect.reserve.below}px`;

    const stored = captured.get(key);
    if (stored) cardEffect.setState(stored);

    positionCard(element, entry.range);
```

顺序即设计文档要求：建 DOM → `mount` → 应用 `reserve` → `positionCard`。

> 词行、释义、例句的构建（`element.append(word, meaning)` 与 example 分支）保持原样，不要搬动；被替换的只有从 `const skin = nextMascot();` 到 `element.appendChild(mascot);` 那一段。

**同时改 `src/content/main.ts` 的接线**（否则 `tsc` 报未知属性）：

```ts
const gloss = createGlossController(document, {
  getEffectSettings: () => effectSettings,
  getGlossLang: () => targetLang,
});
```

并把 `let mascotSettings: EffectSettings = DEFAULT_SETTINGS.mascot;` 改名为 `let effectSettings: EffectSettings = DEFAULT_SETTINGS.mascot;`（该文件里其它 `mascotSettings` 引用一并改名）。

> 主题说明：当前 `.ilmt-card` 只有浅色底，所以卡片固定传 `"light"`。等卡片做出深色主题时改成 `currentTheme()` 并在 `matchMedia("(prefers-color-scheme: dark)")` 变化时重新挂载。`ctx.theme` 现在由设置页预览与复习卡使用。

> 注意：`host` 是绝对定位，追加到 `word` 之后不参与 flex 布局，也不影响前面已 append 的 `word`/`meaning`/`example` 顺序。

### 3.2 `src/styles/inject.css`

1. 删除整段旧角色样式：`.ilmt-mascot-wrap`、`.ilmt-mascot`、`.ilmt-mascot:hover`、`.ilmt-mascot:focus-visible`、`.ilmt-mascot-status`、`.ilmt-gopher-hit`、`@keyframes ilmt-gopher-hit`、以及末尾的 `@media (prefers-reduced-motion: reduce) { .ilmt-gopher-hit { ... } }`。
2. `.ilmt-card` 增加 `overflow: hidden;`（`reserve` 是硬约束，超出部分裁掉）。
3. `.ilmt-word` 增加 `position: relative;`。
4. 用下面这段替换被删掉的角色样式：

```css
/* 收录特效：宿主只负责定位，造型与动画在特效自己的 CSS 里 */
.ilmt-gloss-effect-host {
  position: absolute;
  left: -8px;
  top: 100%;
  margin-top: -4px;
  z-index: 1;
}

/* 只给读屏看的播报区 */
.ilmt-gloss-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  border: 0;
  white-space: nowrap;
}
```

### 3.3 `tests/unit/glossary.test.ts`

**`describe("mascot capture", ...)` 改名为 `describe("claim effect", ...)`**，三处行为改动：

1. 点击目标：`document.querySelector<HTMLButtonElement>("[role=tooltip] button")` 改成
   `document.querySelector<HTMLButtonElement>('[role=tooltip] [data-ilmt-effect="gopher-hole"] button')`。
2. 等待时长：`vi.advanceTimersByTimeAsync(250)` 改成 `vi.advanceTimersByTimeAsync(620)`（`dive` 动画长度）。
3. 原本断言 `textContent` 含「已抓住」/「已在学习中」，改成断言宿主状态：

```ts
    const host = document.querySelector<HTMLElement>('[data-ilmt-effect="gopher-hole"]')!;
    expect(host.dataset.ilmtState).toBe("settled");
```

（第二次悬停已收录时断言 `"known"`；「不会重复发送」那条仍是 `expect(sendLearn).toHaveBeenCalledTimes(1)`。）

再补两条：

```ts
  it("reserves room below the word for the effect", () => {
    // ...同样的 setup（stubFrame/stubHighlights/paragraph/pointermove）...
    const word = document.querySelector<HTMLElement>(".ilmt-gloss-word")!;
    expect(word.style.marginBottom).toBe("48px");
  });

  it("mounts exactly one effect inside the card", () => {
    // ...同样的 setup...
    expect(document.querySelectorAll('[role=tooltip] [data-ilmt-effect]')).toHaveLength(1);
    expect(document.querySelector("[role=tooltip]")?.textContent).not.toContain("已抓住");
  });
```

> 测试里 class 选择器直接用源文件里的占位符字符串；构建期替换只影响产物。

**验证**

```bash
npm test -- tests/unit/glossary.test.ts
npx tsc --noEmit
npm run build
```

**提交**

```bash
git add src/content/glossary.ts src/content/main.ts src/styles/inject.css tests/unit/glossary.test.ts
git commit -m "feat: mount claim effects on the hover card word"
```

---

## Task 4 · 设置页：勾选、固定、试一试

**文件**

- 修改 `src/settings/sections/learning.ts`
- 修改 `src/styles/settings.css`
- 修改 `tests/unit/settings-dom.test.ts`

### 4.1 `src/settings/sections/learning.ts`

**imports**

```ts
import type { EffectSettings, Settings } from "../../shared/types";
import { getEffects } from "../../content/effects";
import "../../content/effects/gopher-hole";
```

新增 `autoClaimOnExplain` 的 UI 放到任务 5，避免一个任务里混两件事。

**把「认领角色」fieldset 整体替换**为下面的实现（位置不变，仍在学习目标之后）：

```ts
  const effectField = el("fieldset", "field-group effect-settings");
  effectField.appendChild(el("legend", undefined, "收录特效"));

  const enabledBoxes = new Map<string, HTMLInputElement>();
  const registered = getEffects();
  const enabledAtBoot =
    settings.mascot.enabledIds.length > 0
      ? new Set(settings.mascot.enabledIds)
      : new Set(registered.map((effect) => effect.id));

  // 先建动效开关，特效行的「试一试」要读它的当前值
  const animateRow = el("label", "checkbox-row");
  const mascotAnimations = el("input", "global-mascot-animations");
  mascotAnimations.type = "checkbox";
  mascotAnimations.checked = settings.mascot.animations !== false;
  animateRow.append(mascotAnimations, document.createTextNode("播放收录动效"));

  let preview: { cleanup: () => void } | null = null;

  const closePreview = (): void => {
    preview?.cleanup();
    preview = null;
    for (const slot of effectField.querySelectorAll<HTMLElement>(".effect-preview")) {
      slot.hidden = true;
      slot.replaceChildren();
    }
  };

  for (const effect of registered) {
    const row = el("div", "effect-row");
    const label = el("label", "checkbox-row effect-toggle");
    const box = el("input", "global-effect-enabled");
    box.type = "checkbox";
    box.value = effect.id;
    box.dataset.effect = effect.id;
    box.checked = enabledAtBoot.has(effect.id);
    enabledBoxes.set(effect.id, box);
    label.append(box, document.createTextNode(effect.label));
    row.appendChild(label);
    row.appendChild(el("span", "effect-summary", effect.summary));

    const tryButton = makeButton("试一试", "ghost-button effect-try");
    tryButton.dataset.effect = effect.id;
    const slot = el("div", "effect-preview");
    slot.hidden = true;
    tryButton.addEventListener("click", () => {
      const alreadyOpen = !slot.hidden;
      closePreview();
      if (alreadyOpen) return;
      slot.hidden = false;
      preview = mountEffectPreview(slot, effect, mascotAnimations.checked);
    });

    row.append(tryButton, slot);
    effectField.appendChild(row);
  }

  effectField.appendChild(
    el(
      "span",
      "field-hint",
      "勾选的特效会参与随机轮换；至少保留一个。设置页的「试一试」不会写入学习库。",
    ),
  );

  const modeField = el("label", "field");
  modeField.appendChild(el("span", "field-label", "选择方式"));
  const mascotMode = el("select", "global-mascot-mode");
  for (const [value, text] of [
    ["rotate", "随机轮换"],
    ["fixed", "固定为"],
  ] as Array<[EffectSettings["mode"], string]>) {
    const option = el("option");
    option.value = value;
    option.textContent = text;
    mascotMode.appendChild(option);
  }
  mascotMode.value = settings.mascot.mode;
  modeField.appendChild(mascotMode);
  effectField.appendChild(modeField);

  const fixedField = el("label", "field");
  fixedField.appendChild(el("span", "field-label", "固定特效"));
  const mascotFixed = el("select", "global-mascot-fixed");
  fixedField.appendChild(mascotFixed);
  fixedField.hidden = settings.mascot.mode !== "fixed";
  effectField.appendChild(fixedField);

  const rebuildFixedOptions = (): void => {
    const previous = mascotFixed.value || settings.mascot.fixedId || "";
    mascotFixed.replaceChildren();
    const usable = registered.filter((effect) => enabledBoxes.get(effect.id)?.checked);
    for (const effect of usable) {
      const option = el("option");
      option.value = effect.id;
      option.textContent = effect.label;
      mascotFixed.appendChild(option);
    }
    mascotFixed.value = usable.some((effect) => effect.id === previous)
      ? previous
      : (usable[0]?.id ?? "");
    fixedField.hidden = mascotMode.value !== "fixed";
  };
  rebuildFixedOptions();
  mascotMode.addEventListener("change", rebuildFixedOptions);

  effectField.appendChild(animateRow);

  for (const box of enabledBoxes.values()) {
    box.addEventListener("change", () => {
      closePreview();
      rebuildFixedOptions();
    });
  }

  element.appendChild(effectField);
```

`saveButton` / `saved` 仍留在原位置（fieldset 之后）。空勾选的提示在保存回调里处理（见下面「保存逻辑」），所以勾选监听不需要提前引用 `saveButton`。

`mascotAnimations` 被上面的特效行引用，所以**先建 `animateRow`，再渲染特效行**。最终顺序：fieldset → legend → （勾选行 + 试一试 + 预览）→ 提示 → 选择方式 → 固定特效 → 播放动效。

新增模块级辅助函数（放在 `createLearningSection` 之前）：

```ts
function mountEffectPreview(
  slot: HTMLElement,
  effect: ClaimEffect,
  animations: boolean,
): { cleanup: () => void } {
  const surface = el("span", "effect-preview-word", "outlive");
  const host = el("div", "effect-preview-host");
  const line = el("div", "effect-preview-line");
  line.append(surface, host);
  if (effect.reserve.above > 0) line.style.paddingTop = `${effect.reserve.above}px`;
  if (effect.reserve.below > 0) line.style.marginBottom = `${effect.reserve.below}px`;
  slot.replaceChildren(line);

  const style = document.createElement("style");
  style.dataset.ilmtEffects = "";
  style.textContent = getEffects()
    .map((item) => item.css ?? "")
    .join("\n");
  document.head.appendChild(style);

  const handle = effect.mount({
    doc: document,
    surface,
    root: host,
    theme: window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    animations,
    claim: async () => ({ ok: true, created: true }),
    announce: () => {},
    label: (verb) => `把${effect.label}${verb}下去，收录这个词`,
  });

  return {
    cleanup: () => {
      handle.destroy();
      style.remove();
      slot.replaceChildren();
    },
  };
}
```

需要额外 import：

```ts
import type { ClaimEffect } from "../../content/effects/types";
```

**保存逻辑**（`saveButton` 的 click handler）改成：

```ts
      const enabledIds = [...enabledBoxes.entries()]
        .filter(([, box]) => box.checked)
        .map(([id]) => id);
      if (enabledIds.length === 0) {
        saved.textContent = "至少启用一个特效";
        saved.hidden = false;
        return;
      }
      const mode: EffectSettings["mode"] = mascotMode.value === "fixed" ? "fixed" : "rotate";
      saved.textContent = "保存中…";
      saved.hidden = false;
      try {
        await ctx.savePatch({
          learningLangs: normalizeLearningLangs(chosen),
          mascot: {
            mode,
            ...(mode === "fixed" && mascotFixed.value ? { fixedId: mascotFixed.value } : {}),
            enabledIds,
            animations: mascotAnimations.checked,
          },
          reviewAnswerLang: reviewAnswerLang.value,
        });
```

**`update(next)`** 增加：

```ts
      for (const [id, box] of enabledBoxes) {
        box.checked =
          next.mascot.enabledIds.length === 0
            ? true
            : next.mascot.enabledIds.includes(id);
      }
      closePreview();
      rebuildFixedOptions();
      saveButton.disabled = false;
```

**`summary()`**：`${current.mascot.mode === "fixed" ? "固定特效" : "随机轮换"}`。

`saveButton` 在 `update` 里引用，注意把 `const saveButton = makeButton(...)` 提到 fieldset 构建之前（或把点击监听改为函数声明）。

### 4.2 `src/styles/settings.css`

```css
.effect-settings .effect-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
}

.effect-settings .effect-toggle {
  flex: 0 0 auto;
}

.effect-settings .effect-summary {
  flex: 1 1 180px;
  min-width: 0;
  color: var(--text-dim, #6e7781);
  font-size: 12px;
}

.effect-settings .effect-preview {
  flex: 1 1 100%;
  padding: 8px 10px 8px;
  border: 1px dashed var(--border, rgba(0, 0, 0, 0.16));
  border-radius: 8px;
}

.effect-settings .effect-preview-line {
  position: relative;
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 13px;
}

.effect-settings .effect-preview-word {
  font-weight: 600;
}

.effect-settings .effect-preview-host {
  position: absolute;
  left: -8px;
  top: 100%;
  margin-top: -4px;
  z-index: 1;
}

.effect-settings .ghost-button {
  background: transparent;
  border: 1px solid var(--border, rgba(0, 0, 0, 0.16));
}
```

> `ghost-button` 若已存在于 `panel.css` 就复用，不要重复定义。

### 4.3 `tests/unit/settings-dom.test.ts`

把现有 `it("renders the learning section with mascot rotation", ...)` 换成：

```ts
  it("renders the learning section with effect selection", async () => {
    await seed();
    await boot();

    expect(document.querySelectorAll(".global-effect-enabled")).toHaveLength(1);
    expect(document.querySelector<HTMLInputElement>(".global-effect-enabled")!.checked).toBe(true);

    const mode = document.querySelector<HTMLSelectElement>(".global-mascot-mode")!;
    expect(Array.from(mode.options).map((option) => option.textContent)).toEqual([
      "随机轮换",
      "固定为",
    ]);
    expect(document.querySelector(".global-mascot-fixed")).toBeTruthy();
  });

  it("mounts an effect preview without writing to the learning store", async () => {
    await seed();
    await boot();
    const button = document.querySelector<HTMLButtonElement>(".effect-try")!;
    button.click();
    const preview = document.querySelector<HTMLElement>(".effect-preview")!;
    expect(preview.hidden).toBe(false);
    expect(preview.querySelector('[data-ilmt-effect="gopher-hole"]')).toBeTruthy();
    const stored = await chrome.storage.local.get("learning");
    expect(stored.learning).toBeUndefined();
  });

  it("saves the checked effects and the fixed choice", async () => {
    await seed();
    await boot();
    document.querySelector<HTMLSelectElement>(".global-mascot-mode")!.value = "fixed";
    document.querySelector<HTMLSelectElement>(".global-mascot-mode")!.dispatchEvent(new Event("change"));
    document.querySelector<HTMLButtonElement>(".learning-save")!.click();
    await vi.waitFor(async () => {
      const stored = await getSettings();
      expect(stored.mascot.mode).toBe("fixed");
      expect(stored.mascot.fixedId).toBe("gopher-hole");
      expect(stored.mascot.enabledIds).toEqual(["gopher-hole"]);
    });
  });
```

**验证**

```bash
npm test -- tests/unit/settings-dom.test.ts
npx tsc --noEmit
```

**提交**

```bash
git add src/settings/sections/learning.ts src/styles/settings.css tests/unit/settings-dom.test.ts
git commit -m "feat: pick, pin and preview claim effects in settings"
```

---

## Task 5 · 复习卡头像复用 `mount()`，并删除旧皮肤体系

**文件**

- 修改 `src/panel/review.ts`
- 删除 `src/content/mascots/types.ts`、`src/content/mascots/index.ts`、`src/content/mascots/gopher.ts`
- 删除 `tests/unit/mascots.test.ts`
- 修改 `src/styles/panel.css`（头像位尺寸）

### 5.1 `src/panel/review.ts`

```ts
import { getEffect, getEffects } from "../content/effects";
import type { ClaimEffect, ClaimHandle } from "../content/effects/types";
import "../content/effects/gopher-hole";
```

`ReviewDeps`：

```ts
export interface ReviewDeps {
  getState(): Promise<LearningState>;
  answer(message: ReviewAnswerMessage): Promise<ReviewAnswerResponse>;
  /** Never undefined when at least one effect is registered. */
  effect(id?: string): ClaimEffect;
  now(): number;
}
```

默认实现替换 `defaultMascot`：

```ts
function defaultEffect(id?: string): ClaimEffect {
  const all = getEffects();
  return (id ? getEffect(id) : undefined) ?? all[0];
}
```

> `src/content/effects/gopher-hole` 在模块顶层注册，`all[0]` 一定存在；不需要额外判空。

`renderCard()` 里替换 `const skin = deps.mascot(...)` 整段：

```ts
    const effect = deps.effect(word.mascotId);
    const mascot = document.createElement("div");
    mascot.className = "ilmt-review-mascot";
    const host = document.createElement("div");
    host.className = "ilmt-review-effect-host";
    mascot.appendChild(host);
    card.appendChild(mascot);
    let handle: ClaimHandle | null = null;
    try {
      handle = effect.mount({
        doc: document,
        surface: mascot,
        root: host,
        theme: currentTheme(),
        animations: false,
        claim: async () => ({ ok: true, created: false }),
        announce: () => {},
        label: (verb) => `把${effect.label}${verb}下去`,
      });
      mascot.setAttribute("aria-hidden", "true");
      for (const button of mascot.querySelectorAll("button")) button.tabIndex = -1;
    } catch {
      // A broken effect is decoration only; never block a review.
    }
```

`mountReview` 返回的 `destroy()` 里要调用 `handle?.destroy()`：把当前卡的 handle 存到 `state` 外的闭包变量 `let mountedEffect: ClaimHandle | null = null;`，每次 `renderCard()` 开头 `mountedEffect?.destroy(); mountedEffect = null;`，结尾 `mountedEffect = handle;`，并在 view 的 `destroy()` 中清理。

### 5.2 `src/styles/panel.css`

```css
.ilmt-review-mascot {
  position: absolute;
  top: 44px;
  right: 12px;
  width: 50px;
  height: 44px;
  opacity: 0.85;
  pointer-events: none;
}

/* Keep a long headword from running under the effect. */
.ilmt-review-term {
  padding-right: 64px;
}

.ilmt-review-effect-host {
  position: relative;
  display: block;
}
```

### 5.3 删除旧体系

```bash
git rm -r src/content/mascots tests/unit/mascots.test.ts
grep -rn "mascots" src tests || true   # 必须为空
```

**验证**

```bash
npm test
npx tsc --noEmit
npm run build
```

**提交**

```bash
git add -A src/panel/review.ts src/styles/panel.css src/content tests/unit
git commit -m "refactor: use claim effects on review cards and drop the mascot skins"
```

---

## Task 6 · 划词「解释」自动收录

**文件**

- 新增 `src/shared/auto-claim.ts`
- 新增 `tests/unit/auto-claim.test.ts`
- 修改 `src/shared/types.ts`（`OpenChatMessage.termLang?`、`Settings.autoClaimOnExplain`）
- 修改 `src/shared/storage.ts`（默认值 + 规范化）
- 修改 `src/content/main.ts`（`sendOpenChat` 带 `termLang`）
- 修改 `src/background/index.ts`（把 `termLang` 存进 `chat.pendingQuote`）
- 修改 `src/panel/main.ts`（`PendingQuote.termLang`、`lastRequest`、`handleFinish`）
- 修改 `src/settings/sections/learning.ts`（开关）

### 6.1 `src/shared/auto-claim.ts`

```ts
import type { LearnWordMessage } from "./types";

export const AUTO_CLAIM_MAX_CHARS = 24;
export const AUTO_CLAIM_MAX_WORDS = 4;
export const AUTO_CLAIM_MEANING_MAX = 120;

const WORD_SPLIT = /[\s\u3000，。；：！？、（）【】《》“”‘’…·]+/u;
const SENTENCE_END = /[。！？.!?\n]/;

/** Only short words/phrases are worth turning into review cards. */
export function isClaimableTerm(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > AUTO_CLAIM_MAX_CHARS) return false;
  const words = trimmed.split(WORD_SPLIT).filter(Boolean);
  return words.length > 0 && words.length <= AUTO_CLAIM_MAX_WORDS;
}

/** First sentence of an answer, capped for storage. */
export function firstSentence(answer: string): string {
  const trimmed = answer.trim();
  if (!trimmed) return "";
  const match = SENTENCE_END.exec(trimmed);
  const head = (match ? trimmed.slice(0, match.index) : trimmed).trim();
  return head.slice(0, AUTO_CLAIM_MEANING_MAX);
}

export interface AutoClaimInput {
  quote?: string;
  termLang?: string;
  answer?: string;
  paragraph?: string;
  pageUrl: string;
  pageTitle?: string;
  glossLang: string;
}

/** Build the learn-word message for an "explain" answer, or null to skip it. */
export function autoClaimRequest(input: AutoClaimInput): LearnWordMessage | null {
  const quote = input.quote?.trim() ?? "";
  if (!quote || !isClaimableTerm(quote)) return null;

  const meaning = firstSentence(input.answer ?? "");
  if (!meaning) return null;

  const sentence = (input.paragraph?.trim() || quote).slice(0, 240);
  return {
    type: "learn-word",
    surface: quote,
    termLang: input.termLang?.trim() || "en",
    glossLang: input.glossLang,
    meaning,
    sentence,
    pageUrl: input.pageUrl,
    ...(input.pageTitle ? { pageTitle: input.pageTitle } : {}),
  };
}
```

### 6.2 `src/shared/types.ts`

```ts
export interface OpenChatMessage {
  type: "open-chat";
  text: string;
  mode: "explain" | "follow-up";
  context?: SelectionContext;
  /** Page language of the selection; lets the panel claim it without the DOM. */
  termLang?: string;
}
```

`Settings` 增加：

```ts
  /** Claim a short word/phrase automatically after an "explain" answer. */
  autoClaimOnExplain: boolean;
```

### 6.3 `src/shared/storage.ts`

`DEFAULT_SETTINGS` 增加 `autoClaimOnExplain: true,`。`getSettings()` 末尾增加：

```ts
  merged.autoClaimOnExplain = merged.autoClaimOnExplain !== false;
```

### 6.4 `src/content/main.ts`

`sendOpenChat` 增加 termLang：

```ts
  const lang = document.documentElement.getAttribute("lang") ?? "";
  const termLang = lang.trim().toLowerCase().split(/[-_]/)[0] || undefined;
  ...
    const message: OpenChatMessage = {
      type: "open-chat",
      text,
      mode,
      ...(context ? { context } : {}),
      ...(termLang ? { termLang } : {}),
    };
```

### 6.5 `src/background/index.ts`

`chat.pendingQuote` 写入时增加：

```ts
        ...(openChat.termLang ? { termLang: openChat.termLang } : {}),
```

### 6.6 `src/panel/main.ts`

1. `PendingQuote` 增加 `termLang?: string;`
2. `parsePendingQuote`：读出 `termLang`：

```ts
  const termLang = typeof quote.termLang === "string" && quote.termLang.trim() ? quote.termLang : undefined;
```

返回对象里 `...(termLang ? { termLang } : {})`。
3. `lastRequest` 类型增加 `termLang?: string; explain?: boolean;`。
4. `SendRequestOptions` 增加 `termLang?: string; explain?: boolean;`；`sendRequest` 里解构后存 `lastRequest = { text, quote, selectionContext, termLang, explain };`。
5. `applyPendingQuote` 的 explain 自动发送分支加：

```ts
      termLang: quote.termLang,
      explain: true,
```

`pendingQuote` 分支同样保留 `...(quote.termLang ? { termLang: quote.termLang } : {})`（复制到 `pendingQuote` 对象）。
6. `handleSend()`：`const termLang = pendingQuote?.termLang;`（这里没有 `explain: true`，手动输入的追问不自动收录）。
7. `handleRetry()` 的 `sendRequest({...})` 补 `...(request.termLang ? { termLang: request.termLang } : {})` 与 `explain: request.explain`。
8. `handleFinish` 结尾追加：

```ts
  void autoClaimExplanation();
```

并新增：

```ts
/** After an "explain" answer, quietly claim short words/phrases. */
async function autoClaimExplanation(): Promise<void> {
  const request = lastRequest;
  const current = session;
  if (!request?.explain || !request.quote || !current || !panelSettings) return;
  if (panelSettings.autoClaimOnExplain === false) return;
  const answer = current.messages.at(-1);
  if (!answer || answer.role !== "assistant") return;

  const message = autoClaimRequest({
    quote: request.quote,
    termLang: request.termLang,
    answer: answer.content,
    paragraph: request.selectionContext?.paragraph,
    pageUrl: current.pageUrl,
    pageTitle: current.pageTitle,
    glossLang: panelSettings.targetLang,
  });
  if (!message) return;

  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // Auto-claim is a convenience; never interrupt the conversation.
    console.debug("auto-claim failed");
  }
}
```

import：`import { autoClaimRequest } from "../shared/auto-claim";`

> `handleFinish` 里 `persistHistory()` 在 assistant 内容已写入 `session` 之后执行，所以 `session.messages.at(-1)` 是完整回答。

### 6.7 设置页开关

在 `learning.ts` 的「学习目标」之后、收录特效之前插入：

```ts
  const autoClaimRow = el("label", "checkbox-row");
  const autoClaim = el("input", "global-auto-claim");
  autoClaim.type = "checkbox";
  autoClaim.checked = settings.autoClaimOnExplain !== false;
  autoClaimRow.append(autoClaim, document.createTextNode("划词「解释」时自动收录短词/短语"));
  element.appendChild(autoClaimRow);
```

保存 patch 增加 `autoClaimOnExplain: autoClaim.checked,`；`update(next)` 增加 `autoClaim.checked = next.autoClaimOnExplain !== false;`。

### 6.8 `tests/unit/auto-claim.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  AUTO_CLAIM_MEANING_MAX,
  autoClaimRequest,
  firstSentence,
  isClaimableTerm,
} from "../../src/shared/auto-claim";

describe("isClaimableTerm", () => {
  it("accepts a word or a short phrase", () => {
    expect(isClaimableTerm("outlive")).toBe(true);
    expect(isClaimableTerm("  take off  ")).toBe(true);
    expect(isClaimableTerm("yellow-bellied")).toBe(true);
    expect(isClaimableTerm("比……存在得更久")).toBe(true);
  });

  it("rejects long phrases and full sentences", () => {
    expect(isClaimableTerm("Small tools often outlive their larger competitors.")).toBe(false);
    expect(isClaimableTerm("a b c d e")).toBe(false);
    expect(isClaimableTerm("")).toBe(false);
    expect(isClaimableTerm("x".repeat(25))).toBe(false);
  });
});

describe("firstSentence", () => {
  it("cuts at the first sentence end", () => {
    expect(firstSentence("比……存在得更久。例：Small tools outlive them.")).toBe("比……存在得更久");
    expect(firstSentence("first line\nsecond line")).toBe("first line");
  });

  it("caps the meaning length", () => {
    expect(firstSentence("a".repeat(200))).toHaveLength(AUTO_CLAIM_MEANING_MAX);
  });
});

describe("autoClaimRequest", () => {
  const base = {
    quote: "outlive",
    termLang: "en",
    answer: "比……存在得更久。",
    paragraph: "Small tools often outlive their larger competitors.",
    pageUrl: "https://example.com/a",
    pageTitle: "A",
    glossLang: "zh-CN",
  };

  it("builds a learn-word message for a short term", () => {
    expect(autoClaimRequest(base)).toMatchObject({
      type: "learn-word",
      surface: "outlive",
      termLang: "en",
      glossLang: "zh-CN",
      meaning: "比……存在得更久",
    });
  });

  it("skips long quotes, empty answers and blank termLang falls back to en", () => {
    expect(autoClaimRequest({ ...base, quote: "a whole sentence with many words" })).toBeNull();
    expect(autoClaimRequest({ ...base, answer: "   " })).toBeNull();
    expect(autoClaimRequest({ ...base, termLang: "" })?.termLang).toBe("en");
  });

  it("falls back to the quote when there is no paragraph", () => {
    expect(autoClaimRequest({ ...base, paragraph: undefined })?.sentence).toBe("outlive");
  });
});
```

**验证**

```bash
npm test -- tests/unit/auto-claim.test.ts tests/unit/storage.test.ts tests/unit/dispatch.test.ts
npx tsc --noEmit
```

> `Settings` 多了必填字段 `autoClaimOnExplain`，所以 `tests/unit/dispatch.test.ts` 里那份完整 `Settings` 字面量（`mascot: {...}` 附近）要补 `autoClaimOnExplain: true,`。`tests/unit/storage.test.ts` 只断言 `s.mascot`，无需改。

**提交**

```bash
git add src/shared/auto-claim.ts src/shared/types.ts src/shared/storage.ts src/content/main.ts src/background/index.ts src/panel/main.ts src/settings/sections/learning.ts tests/unit/auto-claim.test.ts tests/unit/dispatch.test.ts
git commit -m "feat: claim short words automatically after an explain answer"
```

---

## Task 7 · E2E 与交付验证

**文件**

- 修改 `tests/e2e/learning.spec.ts`
- 新增 `tests/e2e/harness.ts`
- 新增 `tests/e2e/settings.spec.ts`

### 7.1 `tests/e2e/learning.spec.ts`

1. `seedSettings` 里 `mascot: { mode: "rotate", enabledIds: ["gopher"], animations: true }` → `enabledIds: ["gopher-hole"]`。
2. 点击目标改为：

```ts
      const effectButton = card.locator('[data-ilmt-effect="gopher-hole"] button');
      await effectButton.click();
      await expect(card.locator('[data-ilmt-effect="gopher-hole"]')).toHaveAttribute(
        "data-ilmt-state",
        "settled",
      );
```

（删除 `await expect(card).toContainText("已抓住");`）

3. `expect(word.mascotId).toBe("gopher")` → `"gopher-hole"`。
4. 文件头注释里的 “click the mascot” 改成 “click the claim effect”。
5. 新增一条独立用例（同一套 fixture）：

```ts
  test("marks a word already captured and never writes it twice", async () => {
    // ...启动、翻译、悬停出卡（复用上面的流程）...
    // 第一次点击收录
    // 移开鼠标让卡片消失，再悬停同一个词
    await page.mouse.move(0, 0);
    await page.mouse.move(rect!.x, rect!.y);
    const again = page.locator("[role=tooltip]");
    await expect(again.locator('[data-ilmt-effect="gopher-hole"]')).toHaveAttribute(
      "data-ilmt-state",
      "known",
    );
    expect(await readWords(extension.worker)).toHaveLength(1);
  });
```

### 7.2 `tests/e2e/settings.spec.ts`

只验证设置页的预览，不碰写库：

```ts
import { expect, test } from "@playwright/test";
import { launchExtension, seedSettings, type Extension } from "./harness";

test("previews a claim effect without claiming a word", async () => {
  let extension: Extension | undefined;
  try {
    extension = await launchExtension();
    const server = await startMockServer();
    await seedSettings(extension.worker, server.origin);
    const extensionId = new URL(extension.worker.url()).host;

    const page = await extension.context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html?mode=page`);
    await page.locator('.effect-try[data-effect="gopher-hole"]').click();

    const preview = page.locator(".effect-preview:not([hidden])");
    await expect(preview.locator('[data-ilmt-effect="gopher-hole"]')).toBeVisible();
    await preview.locator("button").click();
    await expect(preview.locator('[data-ilmt-effect="gopher-hole"]')).toHaveAttribute(
      "data-ilmt-state",
      "settled",
    );

    const stored = await extension.worker.evaluate(async () => chrome.storage.local.get("learning"));
    expect(stored.learning).toBeUndefined();
    await server.close();
  } finally {
    await extension?.context.close().catch(() => {});
    if (extension) await rm(extension.userDataDir, { recursive: true, force: true }).catch(() => {});
  }
});
```

（`startMockServer` 从 `../mock-server` 导入；`rm` 从 `node:fs/promises`。`seedSettings` 需要一个 origin，所以这里也起一个 mock server。）

**重构 E2E 辅助函数（本任务必须做，否则设置页用例要重复一遍启动逻辑）**

1. 新建 `tests/e2e/harness.ts`，把 `learning.spec.ts` 里的这些声明原样移过去并 `export`：
   - `EXTENSION_PATH`、`ARTICLE`、`TEN_MINUTES`
   - `interface Extension`
   - `launchExtension`、`seedSettings`、`activeTabId`、`findContentMainContext`、`activate`、`evaluateInContent`、`interface StoredWord`、`readWords`
2. `learning.spec.ts` 改成：

```ts
import {
  activate,
  activeTabId,
  ARTICLE,
  evaluateInContent,
  EXTENSION_PATH,
  findContentMainContext,
  launchExtension,
  readWords,
  seedSettings,
  TEN_MINUTES,
  type Extension,
} from "./harness";
```

3. `settings.spec.ts` 用同一份 `launchExtension` / `seedSettings`。

> `harness.ts` 里用到 `test` 之外的 `chromium`、`Worker`、`BrowserContext`、`Page` 类型从 `@playwright/test` 导入；不要 import `test`，它只服务于 spec 文件。

### 7.3 交付验证（`docs/delivery-verification.md` 的 P0 主流程）

```bash
npm run verify:delivery
npm run test:e2e
```

两项都必须整段通过。然后做真实 Chrome 抽查（**不抢焦点**）：

1. `chrome://extensions` 重新加载 `dist/`。
2. `opencli ... --window background` 打开一篇英文文章，翻译后悬停一个词：地鼠在卡片词下方，点击后沉进洞里、眼睛变 ×、`+1 已收录` 出现。
3. 设置页勾选/取消特效、「试一试」能点、固定下拉只列已勾选项。
4. 控制台无红色报错。

**提交**

```bash
git add tests/e2e
git commit -m "test: cover claim effects and the settings preview end to end"
```

---

## 自查清单

- [ ] 卡片是唯一写库入口：特效只调 `ctx.claim()`，没有任何特效直接发 `learn-word`。
- [ ] `claim()` 对同一词幂等：连点、重复悬停、已收录都不写第二条。
- [ ] 写库失败时地鼠回到 `idle`，卡片不抛错。
- [ ] `reserve` 由卡片应用；`above` → 词行 `padding-top`，`below` → 词行 `margin-bottom`。
- [ ] 特效 CSS 全部作用域到 `[data-ilmt-effect="<id>"]`，类名带构建期前缀。
- [ ] `prefers-reduced-motion` 或用户关闭动效时，特效直接呈现落定形态。
- [ ] 旧 `src/content/mascots/` 已删除，`grep -rn "mascots" src tests` 为空。
- [ ] 持久化字段 `settings.mascot` 与 `learnedWord.mascotId` 未改名；旧数据（`mascotId: "gopher"`）回退到第一个特效不报错。
- [ ] 划词自动收录只收 ≤24 字符且 ≤4 词，释义截断 120 字，失败静默。
- [ ] `npm run verify:delivery` 与 `npm run test:e2e` 全绿。

## Review Focus

1. **遮挡顺序**：后洞沿在身体之前画、前洞沿在身体之后画；身体由 `mask` 裁到「洞口线以上 ∪ 洞内」——这三条任一改动都要重新看截图。
2. **两种落定路径一致**：`dive` 动画的 100% 帧与 `[data-ilmt-state="settled"]` 的静态 transform 必须完全相同（`translateY(22px) scale(.92)`），否则动画结束会跳一下。
3. **测量顺序**：`positionCard()` 必须在 `mount` + `reserve` 之后调用，否则卡片高度算错，会盖住原词。
4. **`overflow: hidden`**：加在 `.ilmt-card` 上是为了让 `reserve` 变成硬约束；如果未来某个特效需要向外溢出，改 `reserve`，不要去掉 `overflow`。
5. **幂等键**：`entryKey()` 仍是 `${termLang}:${surface.toLowerCase()}`，与自动收录的 `wordId(termLang, surface)` 语义一致；不要引入大小写敏感的第二个键。
