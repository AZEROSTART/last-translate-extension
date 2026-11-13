# 收录特效（Claim Effect）抽象 + 洞口地鼠 + 划词自动收录 设计

- 日期：2026-11-13
- 状态：待实现
- 相关：`2026-11-12-learning-loop-design.md`（学习库与 learn-word）、`2026-11-11-hover-glossary-design.md`（悬停卡片）
- 视觉基线：`docs/previews/gopher-options.html` 里的 B 方案（用户已选定）

## 1. 问题

现在的「认领角色」是卡片页脚的一个 44×44 SVG 按钮：

- 位置和动作都写死在卡片里（`src/content/glossary.ts:291-350`），皮肤只能换一张脸。
- 状态机只有「压扁 180ms → 换图」，`MascotSkin.render(state, theme)` 一次只返回一帧。
- 卡片必须知道角色的文案（`caughtLabel` / `knownLabel`）、时长（`hitDurationMs`）、权重（`weight`）。

用户要的是：

1. 角色出现在**悬停卡片里的词上**，不是正文原词，也不是页脚。
2. 被点之后**真的掉进洞里**，不弹回原位。
3. 以后会有**多种特效**让用户自己挑，甚至动作形式完全不同（砸进洞、撕掉一张纸、盖章）。
4. 划词点「解释」说明不认识这个词，应该**自动收录**。

所以抽象的不是「三帧渲染」，而是「**一次点击 = 一次收录**」这个动作本身。

## 2. 目标与非目标

### 目标

1. 定义 `ClaimEffect` 契约：特效自己建 DOM、自己决定怎么被点、自己决定动画时序；卡片只提供收录能力与展示位。
2. 卡片保留全部不变式：幂等收录、防重复、失败回滚、屏幕阅读器播报、动效开关、销毁。
3. 洞口地鼠作为第一个特效按新契约重写，交互与动效以预览页 B 为准。
4. 划词「解释」完成后自动收录短词/短语。
5. 设置页：勾选启用的特效，并可固定其中一个；每项能点一下试。

### 非目标

- 不改 `learn-word` 消息结构、不改学习库 schema（复用，`mascotId` 字段沿用）。
- 不改复习卡评级流程，只把静态头像改成复用同一个 `mount`。
- 不做远程特效包、不做用户自定义动画。
- 不改悬停卡片「只显示目标语言」的既有规则。

## 3. 契约

### 3.1 类型

```ts
// src/content/effects/types.ts
export type ClaimPhase = "idle" | "settled" | "known";

export interface ClaimResult {
  ok: boolean;
  /** false 表示这个词之前已经收录过，本次没有写库。 */
  created: boolean;
}

export interface ClaimContext {
  doc: Document;
  /** 卡片里的那个词，特效必须相对它定位。 */
  surface: HTMLElement;
  /** 特效根节点的容器，卡片已经按 reserve 留好空间。 */
  root: HTMLElement;
  theme: "light" | "dark";
  /** 用户关闭动效或系统 prefers-reduced-motion 时为 false。 */
  animations: boolean;
  /** 收录当前词，幂等；重复调用不会写第二条。 */
  claim(): Promise<ClaimResult>;
  /** 读屏播报，卡片提供 live region。 */
  announce(text: string): void;
  /** 统一的 aria-label 文案（不同特效动词不同）。 */
  label(verb: string): string;
}

export interface ClaimHandle {
  /** 卡片在「这个词已收录过」时回填状态。 */
  setState(phase: ClaimPhase): void;
  /** 卡片关闭、换词、或主题变化时调用；特效必须清理定时器与监听器。 */
  destroy(): void;
}

export interface ClaimEffect {
  id: string;
  /** 设置页显示名，如「洞口地鼠」。 */
  label: string;
  /** 设置页一句话说明。 */
  summary: string;
  /** 卡片要在词的上/下额外留出的像素。 */
  reserve: { above: number; below: number };
  /** 只作用于 [data-ilmt-effect="<id>"] 的样式，卡片注入一次。 */
  css?: string;
  mount(ctx: ClaimContext): ClaimHandle;
}
```

`MascotSkin`（`render/caughtLabel/knownLabel/hitDurationMs/verb/weight`）删除。

### 3.2 卡片保证的不变式

| 不变式 | 落点 |
|---|---|
| 一次点击只收一次 | `claim()` 内部 `busy` 短路 |
| 同一词不重复写库 | `claim()` 按 `termLang:surface` 去重，已收录直接返回 `{ok:true, created:false}` |
| 写库失败回滚 | `claim()` 返回 `ok:false`，并调用 `handle.setState("idle")` |
| 不打断阅读 | 收录请求失败不弹窗、不抛错，只 `announce("收录失败")` |
| 动效可关 | `ctx.animations === false` 时特效必须直接呈现 settled |
| 清理干净 | 卡片关闭/换词/主题变化时调用 `destroy()` |
| 无障碍 | 特效自己的可点元素必须带 `ctx.label(verb)` 作为 aria-label |

卡片**不**再渲染可见的「已收录」文案。视觉反馈由特效自己决定（地鼠沉在洞里就是反馈），卡片只保留视觉隐藏的 live region。

### 3.3 展示位与占位

- 特效挂在卡片里 `.ilmt-word` 的 `.ilmt-surface` 旁边（同一个词行），而不是页脚。
- `reserve` 由卡片翻译成 `padding-top` / `margin-bottom`，卡片自身不再有写死的上内边距。
- 顺序：建卡片 DOM → 挂载特效 → 应用 reserve → `positionCard()` 定位。测量必须在挂载之后，否则高度算错。
- `reserve` 是上限约束：特效的绘制高度不得超过它声明的值；超过部分由卡片 `overflow: hidden` 裁掉（防呆，不靠自觉）。

### 3.4 CSS 注入

- 每个特效把样式放在自己的 `css` 字符串里，作用域选择器统一为 `[data-ilmt-effect="<id>"]`。
- 卡片首次挂载时把**所有已注册**特效的 `css` 拼起来，注入一个 `<style data-ilmt-effects>`，只注入一次。
- 类名继续用构建期前缀 `ilmt-gloss-`，与 `inject.css` 一致，避免与页面样式撞名。
- 深色：宿主在特效根节点上写 `data-ilmt-theme="light|dark"`，特效 CSS 用 `[data-ilmt-theme="dark"]` 覆盖颜色，不再依赖 JS 传值。

### 3.5 注册表

`src/content/mascots/` → `src/content/effects/`：

```
registerEffect(effect)     // 同 id 覆盖
getEffects()               // 设置页列表
getEffect(id)              // 找不到时 undefined，调用方回退第一个
pickEffect({ enabledIds, lastPicks })   // 沿用现有加权 + 最近两次避让
```

持久化字段**不改名**：`settings.mascot.{ mode, fixedId, enabledIds, animations }`、`learnedWord.mascotId` 继续用，避免数据迁移；只在 UI 与代码层改叫「收录特效」。

### 3.6 第一个特效：洞口地鼠（`gopher-hole`）

视觉与动效以 `docs/previews/gopher-options.html` 的 B 为准，要点：

- 洞是椭圆，位于词的正下方；`reserve = { above: 0, below: 48 }`。
- 地鼠从洞里探出上半身；点击后先被顶起 3px，再下沉 22（同时缩放 0.92），**停在洞里**。
- 洞沿分前后两段：后沿在身体之前绘制（被挡住），前沿在身体之后绘制（压在身上）。
- 身体用 SVG `mask` 裁到「洞口线以上 ∪ 洞内」，下沉是真的被洞壁遮住，不是半透明。
- 落定后眼睛从圆眼换成 ×；特效自己画 `+1 已收录`，不依赖卡片文案。
- 时序：`0 → 10% 顶起 → 68% 砸到洞底 → 84% 轻微回弹 → 100% 停住`，620ms，`forwards`。
- 动效关闭时直接渲染落定形态（在洞里、× 眼），不播 CSS 动画。

### 3.7 划词「解释」自动收录

挂在侧栏（`src/panel/main.ts:913 handleFinish`），因为只有那里能看到完整回答：

1. 仅当 `lastRequest.quote` 存在（由划词「解释」发起），且设置 `autoClaimOnExplain` 打开。
2. 只收短词/短语：`quote.trim()` 长度 ≤ 24 且 ≤ 4 个词（按空白与中英标点切）；超出则只解释不收录。
3. `surface` 取 quote 原文（trim）；`termLang` 取页面 `lang` 的主语言。
4. `meaning` 取助手回答的第一句（到第一个 `。！？.!?\n` 为止），截断 120 字；回答为空或失败则不收录。
5. `sentence` 取 `pendingQuote.context` 里的原句（已有 `SelectionContext`）。
6. 失败静默：不打断对话，不弹错，只写 `console.debug`。
7. 与悬停收录共用 `mergeLearnedWord`：已存在则只补 `glosses`/`contexts`，不重置 box。

设置项 `autoClaimOnExplain`（默认开）放在「学习设置」里，与学习目标同区。

### 3.8 设置页

「学习设置」里的「认领角色」改成「收录特效」：

- 列表：每个特效一行 `[☑] 名称 — 一句话说明 [试一试]`。
- 「试一试」在行内开一个预览框，用同一个 `mount()`，`ctx.claim()` 换成不写库的桩，点一下只看动画。
- 选择方式：`随机轮换` / `固定为 →`（下拉只列已勾选的特效），即 `mode: rotate | fixed`。
- 勾选为空时保存按钮禁用，并提示「至少启用一个特效」。
- 现有 `animations` 开关保留。

### 3.9 复习卡头像

`src/panel/review.ts:329` 现在直接 `skin.render("idle", theme)`。改成同一套 `mount()`：容器是复习卡的头像位，`claim` 传永不写库的桩，`animations: false`。一份代码两处复用。

## 4. 边界情况

| 情况 | 行为 |
|---|---|
| 同一个词再次悬停 | 卡片 `mount` 后立即 `setState("known")`；地鼠直接是洞里的 × 眼 |
| 本次新收录 | 特效播完动画后保持落定形态；`announce("已收录")` |
| 写库失败 | `setState("idle")` 复位 + `announce("收录失败")` |
| 用户关闭动效 | 不播动画，直接落定 |
| 系统深色/浅色 | `data-ilmt-theme` 切换，特效 CSS 覆盖颜色 |
| `fixedId` 指向不存在的特效 | 回退到第一个已注册特效 |
| 已收录词的 `mascotId` 指向已删除的特效 | 复习卡头像回退第一个，不报错 |
| 卡片被页面滚动/关闭 | `destroy()`：清定时器、rAF、事件监听 |

## 5. 测试

单测：

- 注册表：`pickEffect` 在 `enabledIds` 为空/有值、`lastPicks` 避让下的选择结果（复用现有 `tests/unit/mascots.test.ts`）。
- `claim()`：连点两次只发一次 `learn-word`；已收录词直接返回 `created:false`；失败返回 `ok:false`。
- reserve：按特效声明写入卡片的 padding/margin。
- 自动收录规则：短词收录、长句不收录、释义截断 120 字、空回答不收录。
- 设置序列化：勾选集合、固定 id、关掉动效都能往返。

E2E：

- 悬停卡片里特效出现在词旁，点击后地鼠在洞里（断言 transform 落定值 + `learn-word` 只写一条）。
- 再次悬停同一个词：直接落定形态。
- 设置页「试一试」挂载特效且不发 `learn-word`。
- 划词解释：短选区的回答结束后学习库里多一条；长选区不增加。

## 6. 迁移

- 已存 settings 的 `mascot` 对象结构不变，只是 `fixedId` 可能指向旧 id（`gopher`）→ 新特效 id 为 `gopher-hole`，读到不存在的 id 时回退第一个。
- 学习库里已存词的 `mascotId` 保留旧值，头像回退到第一个特效。

## 7. 落地顺序（供实现计划拆解）

1. 契约与注册表（`effects/`），删旧 `MascotSkin`。
2. 卡片改成挂载式，接入 reserve / CSS 注入 / live region。
3. 洞口地鼠按新契约实现。
4. 设置页：勾选 + 固定 + 试一试。
5. 划词自动收录（侧栏 + 设置项）。
6. 复习卡头像复用 `mount()`。
7. 单测、E2E、P0 主流程。
