# v1 需求：翻译呈现（对齐 · 术语 · 卡面）

- 日期：2026-11-16
- 迭代：v1 / 3
- 状态：已交付（`8969a5b`；2026-11-16 复盘修订：卡片去掉译行，见 §8）
- 主题（已定）：**翻译的可视化呈现更贴合、更精准**
- 一句话：让「哪句对应哪句」「这个词在译文里怎么写」在页面上直接可见，同时把悬停卡压到不挡阅读。

---

## 1. 观察到的问题

### O1 悬停卡里的例句与正文逐字重复，把卡撑到近 200px 高

- 证据：`src/shared/prompt.ts:33` 的注释 schema 要求 `"example":"原文中的短例句"`；
  `src/content/glossary.ts:304-309` 把它渲染成 `.ilmt-gloss-example`。
- 证据：`docs/previews/cat-shots/sticker-settled-card.png`（281×193）里卡片下方那句
  `Small tools often outlive their larger competitors.` 与 `tests/fixtures/article.html:13` 首段原文逐字相同。
- 实际行为：卡片高度 193px（贴纸猫）/ 169px（地鼠），其中约 48px 是这句重复的原文；
  正文行高约 26px 时，等于用 2 行空间重复用户刚刚读过的内容，且没有翻译。

### O2 卡片只夹水平边界，会跑出视口下方

- 证据：`src/content/glossary.ts:267-277`：`left` 有 `Math.min/Math.max` 夹取，`top` 只判断
  「上方放不放得下」，没有对 `innerHeight` 取最小。
- 实际行为：读页面底部段落时词在视口下沿，卡高 169–193px，`top = rect.bottom + 8` 直接把
  「词性 / 释义 / 例句」推出可视区域，用户看到的是一个被腰斩的卡片。

### O3 术语和译文之间没有任何绑定，卡片信息无法被验证

- 证据：`src/shared/types.ts:30-41` 的 `GlossaryNote` 只有 `surface/pos/meaning/example/glosses`，
  没有「这个词在这段译文里被译成了什么」。
- 证据：`src/shared/prompt.ts:22` 的注释规则只要求 `surface` 逐字出现在**原文**，从不校验它和
  `[n] 译文` 里的措辞一致；`meaning` 和译文是模型同一次生成里的两条独立表述。
- 证据：高亮只落在原文文本节点上（`src/content/glossary.ts:555`），`src/content/glossary-range.ts:9`
  明确把 `.ilmt-tr` 排除在外——译文里那个词永远是普通文字。
- 实际行为：用户读到译文「……比它们更大的竞争对手存在得更久」，再悬停原文 `outlive` 看到
  「比……存在得更久」，只能靠猜两者是不是同一个东西；换个模型/温度就可能读成两个说法。
- 现有测试也不覆盖这一致性：`tests/unit/glossary.test.ts:83-86` 只断言卡片文本。

### O4 原文段落和它自己的译文块之间没有视觉联动

- 证据：译文节点只有 `data-ilmt-for`（`src/content/render.ts:180-186`），`inject.css:4-31` 里
  `.ilmt-tr` 没有任何悬停/配对状态。
- 证据：E2E 只断言「有译文、在原文下方、无 loading 残留」（`tests/e2e/translate.spec.ts:241-258`），
  不断言「这段的译文就是这块」。
- 实际行为：一屏 4–6 段、每段下方都挂着一块灰字译文时，读长文容易串段；用户要靠左侧 2px 竖线
  和段间距自己数。

### O5 顶部提示文案描述的是已经不存在的视觉

- 证据：`src/content/main.ts:1004-1012` 的 banner 文案是「…个词可悬停（**带虚线**的词）」。
- 证据：`src/styles/inject.css:186-191` 的实际样式是中性灰 + `text-shadow`，**没有下划线**；
  `docs/delivery-verification.md:157` 记录「无底色框/下划线」是用户确认过的既定行为。
- 实际行为：用户按文案去找虚线，找不到，以为悬停功能没生效。

---

## 2. 本轮目标

1. 悬停卡只出现「此刻需要的信息」，且任何视口下都完整可见（O1、O2）。
2. 一个术语在原文、卡片、译文三处指的是同一件事，用户能当场核对（O3）。
3. 悬停原文段落时，只有它自己的译文块被点亮，长页不串段（O4）。
4. 界面上的说明文字与实际视觉一致（O5）。

**实现顺序：需求 1 → 需求 2 → 需求 3。** 需求 2 的译行要落在需求 1 定下的三层结构里，所以先收
卡面；需求 3 与两者无耦合，可最后做。三条各自独立可测，任一条 FAIL 不影响另外两条判定。

### 非目标（本轮明确不做，防扩写）

- 不改翻译链路：段落切分、批量、并发、懒加载、缓存策略、错误提示、恢复逻辑的判定标准都不动。
- 不改划词「解释 / 追问」气泡与侧栏对话的信息密度（这是 v2/v3 的题）。
- 不改收录特效（地鼠 / 磁铁 / 怀里猫 / 贴纸猫）的造型、动画、`reserve` 数值与轮换规则。
- 不改复习面板（含画面钩子、评级、写库）、不改 popup、设置页、快捷键。
- 不做双栏对照、点击段落跳转、整段译文折叠、译文常驻术语标注（只在卡片打开时临时点亮一处）。
- 不改原文注释词现有视觉（灰字 + 阴影），也不加下划线——这是 2026-11-12 用户确认过的样子。
- 不做暗色主题适配：卡片仍是浅色卡面。
- 不新增依赖、不改 manifest、不动构建。

---

## 3. 需求

### 需求 1（P0）悬停卡只留三层信息，且始终完整落在视口内

**用户场景**
读到长文中间一个生词，悬停看释义。现在卡片 169–193px 高，盖住刚读过的 5–7 行，其中近 50px 是
与正文逐字相同的英文例句；在页面底部附近悬停时，卡片下半截直接跑出屏幕。

**期望行为**
1. 卡面结构固定为两层，自上而下：词头（词 + 词性 + 收录状态）→ 本段释义。译法不再重复进卡片，只在该段译文里点亮（需求 2）。
2. 不再渲染原文例句：不生成 `.ilmt-gloss-example`，旧缓存里带 `example` 的注释也不显示。
3. 卡片水平、垂直都夹在视口内，四周各留 8px；卡片与悬停词之间保持 8px 间距，不覆盖词本身。
4. 宽度自适应：`max-width: min(280px, calc(100vw - 16px))`，320px 宽的侧栏里不横向溢出。
5. 极短视口（卡片高于 `100vh - 16px`）时，卡片限高 `calc(100vh - 16px)` 且内容可滚动，不裁字。

**可断言的验收标准**

| # | 断言 | 方式 |
| --- | --- | --- |
| 1.1 | 注释带 `example` 时，`[role=tooltip]` 内不存在 `.ilmt-gloss-example`，且 `textContent` 不含该例句 | 单测（jsdom），`tests/unit/glossary.test.ts` |
| 1.2 | 视口高 300、卡高 120、词 `rect.top=280` 时 `8 ≤ top ≤ 172` 且卡片不遮词；词在视口顶部时同样 `top ≥ 8` | 单测（桩卡片 `getBoundingClientRect`） |
| 1.3 | 320×600 视口下，滚动到 `#article-p10` 后悬停注释词，卡片 `boundingBox()` 满足 `x ≥ 0 && x+width ≤ 320 && y ≥ 0 && y+height ≤ 600` | E2E，`translate.spec.ts` |
| 1.4 | 固定贴纸猫时卡片高度 `≤ 175`；固定地鼠或磁铁时 `≤ 155` | E2E（`boundingBox().height`） |
| 1.5 | 卡内文本顺序为 词头 → 释义，两层各至多一个节点；不出现「译 ·」行（无重复释义、无重复例句） | 单测（DOM 顺序断言） |

**涉及界面位置**
- `.ilmt-gloss-card` 的结构与定位：`src/content/glossary.ts`（`showCard` / `positionCard`）
- 卡面尺寸与留白：`src/styles/inject.css`

**失败 / 边界处理**
- 模型没给 `example`（本轮后属正常情况）：卡面直接少一行，不留空行。
- 注释只有 `surface` + `meaning`：卡片高度自然变矮，不报错、不占位。
- 视口高 < 200px：卡片走限高 + 滚动，仍可读到释义；不显示「更多」按钮（v1 不做展开）。
- 页面自定义 `style-src` 限制：不影响——卡片样式来自 `inject.css`（manifest content_scripts CSS），
  与现有特效 CSS 的注入方式不同，不新增风险。

---

### 需求 2（P0）术语的译文写法进卡片，并在译文里就地对应点亮

**用户场景**
卡片说「比……存在得更久」，译文里那句话的写法未必一样。用户想知道：这段译文到底把这个词译成了
什么、译得对不对，现在没有任何入口。

**期望行为**
1. 翻译请求的注释 schema 增加 `translated`：**该词在本段译文中的实际写法，必须逐字出现在同段译文里**。
2. 解析器校验后才保留：非空、长度 ≤ 32、是该段译文里逐字出现的子串；任何一条不满足就丢弃
   `translated`（保留注释本身），绝不把对不上的内容显示给用户。
3. 卡片**不**重复显示译法：`translated` 只用于点亮译文对应处，不渲染「译 ·」行（实测它与释义读起来重复，且译文里已经点亮）。
4. 卡片打开期间，该段译文节点里 `translated` 那一处用与原文注释词相同的视觉（同色灰 + 同样的
   浮起阴影，独立注册名 `ilmt-gloss-pair`），让用户一眼看到「就是这里」。
5. 卡片关闭 / 移开 / 滚动 / 还原后，该处标记立即撤销，不残留。

**可断言的验收标准**

| # | 断言 | 方式 |
| --- | --- | --- |
| 2.1 | `buildFormatPrompt({glossaryEnabled:true})` 含 `"translated"` 键与「逐字出现在译文里」规则；`FORMAT_VERSION === 4` | 单测，`tests/unit/prompt.test.ts` |
| 2.2 | `translated` 与译文一致 → note 保留该字段；为空 / 不在译文里 / 超 32 字 → 字段被丢弃且 note 仍在 | 单测，`tests/unit/prompt.test.ts` |
| 2.3 | note 带 `translated` → 卡内**不**出现 `.ilmt-gloss-translated`/`.ilmt-gloss-translated-line`，卡片文本不含「译 ·」；不带同样不出现 | 单测，`tests/unit/glossary.test.ts` |
| 2.4 | 卡片打开后 `CSS.highlights.get("ilmt-gloss-pair").size === 1`，且其 range 落在该段 `.ilmt-tr` 的文本节点内；移开（120+180ms）后为 0 | 单测 + E2E |
| 2.5 | E2E：mock 返回 `translated:"存在得更久"`，翻译后悬停 `outlive`，卡片不含「译 ·」而译文对应处被点亮；`restore()` 后 `ilmt-gloss-pair` 与 `ilmt-gloss` 都为 0 | E2E，`translate.spec.ts` |
| 2.6 | 原文注释高亮数量不受影响：加入译行后 `ilmt-gloss` 的 size 与改动前一致（只标原文，不在原文里多标） | E2E（与 2.5 同一条用例） |

**涉及界面位置**
- 提示词与解析：`src/shared/prompt.ts`（schema、规则、`parseGlossaryNotes`、`parseAnnotatedResponse`）
- 数据类型：`src/shared/types.ts`（`GlossaryNote.translated?: string`）
- 卡片渲染与配对高亮：`src/content/glossary.ts`
- 在译文节点里取 range：`src/content/glossary-range.ts`（需要允许 `.ilmt-tr` 内部匹配）
- 视觉：`src/styles/inject.css`（`::highlight(ilmt-gloss-pair)`）

**失败 / 边界处理**
- 模型没给 `translated`（旧缓存、或模型不听话）：卡片不变，只是译文里不点亮对应处，功能安静降级，不弹错误条。
- `translated` 命中译文多处：只标第一处（与原文 `findSurfaceRange` 的语义一致）。
- 译文仍在流式更新：每次打开卡片时重新计算 range；文本节点已不连通则跳过标记，不缓存 Range。
- 译文被 SPA 重写 / 段落被 prune：随 `.ilmt-tr` 节点一起消失，`ilmt-gloss-pair` 在卡片关闭时清空。
- 目标语言是日语/西语：规则与校验都基于「逐字出现在该段译文」，与语言无关。

---

### 需求 3（P1）悬停原文段落，只点亮它自己的译文块

**用户场景**
一屏里 4–6 段、每段下面一块译文，读着读着就不知道这块译文接的是哪一段；用户想要的是「指哪打哪」。

**期望行为**
1. 指针进入带 `data-ilmt-p` 的原文块时，只给它名下的 `.ilmt-tr` 加 `data-ilmt-peer="1"`：
   左侧竖线不透明度提高、底色加 5% 同色淡染、文字 `opacity` 从 0.78 提到 1。
2. 移出、滚动、切换段落时撤销上一条的属性；同一时刻最多一个段落处于点亮状态。
3. 纯属性 + CSS，不移动 DOM、不改行高、不触发布局；不加动画时长（瞬时切换）。
4. 顶部 banner 文案改成与真实视觉一致：`翻译已开启 · N 个词可悬停`（去掉「带虚线」）。

**可断言的验收标准**

| # | 断言 | 方式 |
| --- | --- | --- |
| 3.1 | 给定 `data-ilmt-p="p_3"` 的段根与两个 `.ilmt-tr`，标记后只有 `data-ilmt-for="p_3"` 的节点带 `data-ilmt-peer="1"`；传 null 时全部清除 | 单测（新 `tests/unit/peer.test.ts` 或 `main-ui.test.ts`） |
| 3.2 | E2E：翻译后 `#article-p3.hover()` → `#article-p3 .ilmt-tr` 有 `data-ilmt-peer="1"` 且 computed `opacity` 为 `1`；`#article-p2 .ilmt-tr` 无该属性 | E2E，`translate.spec.ts` |
| 3.3 | E2E：从 p3 移到 p5 后，同时带该属性的节点数恰为 1，且属于 p5 | 同上 |
| 3.4 | E2E：`restore()` 后 `.ilmt-tr` 数量为 0 且无 `[data-ilmt-peer]` 残留 | 同上 |
| 3.5 | banner 文本含「个词可悬停」、不含「虚线」 | E2E（现有 banner 断言扩一句） |

**涉及界面位置**
- 事件委托与标记：`src/content/main.ts`（激活时挂 `pointerover` / `pointerout`，还原时解绑）
- 视觉：`src/styles/inject.css`（`.ilmt-tr[data-ilmt-peer="1"]`）
- 文案：`src/content/main.ts` 的 `updateActiveBannerHint`

**失败 / 边界处理**
- 触屏：`event.pointerType === "touch"` 不启用（与悬停卡一致）。
- 正在拖选文字：`selection` 非折叠时跳过，避免与划词气泡抢戏。
- 一个段根有多个 id（同一块里被 `<br>` 切开的多个分片）：它的**所有**译文一起点亮。
- SPA 重扫 / 段落被替换：属性随旧节点消失；新节点默认不点亮，不需要额外清理。
- 高 DPI / 缩放：不涉及坐标计算，只做 `closest()`，不受影响。

---

## 4. 视觉与交互说明

### 4.1 卡面（宽 280，左右内边距 12，上下 10，行高 1.45）

```
┌──────────────────────────────┐
│ outlive  v.                  │  词头：13px / 600；词性 12px #6e7781
│ ┌────────┐                   │
│ │ 特效    │   +1 已收录      │  特效尺寸由各自 reserve 决定（48/60/84）
│ └────────┘                   │
│ 比……存在得更久                │  释义：13px #1f2328
└──────────────────────────────┘
```

- 层级：词头（最重）> 释义（正文灰）。两行都是 13px，靠字重和颜色区分，不靠加框——卡面已有的
  1px 边框足够。
- 没有例句分隔线后，卡内不再有横向分隔线（现有 `.ilmt-gloss-example` 的 `border-top` 一并消失）。
- 状态：
  - 固定两行，卡高自动缩；
  - 有 `translated` 时不加行：只在译文里点亮（见 4.2）；
  - 译文仍在 loading（`.ilmt-tr[data-loading]`）：不点亮，不误标；
  - 已收录（`known`）：只影响特效，不影响文字区。

### 4.2 术语在三处的对应关系

| 位置 | 默认 | 卡片打开时 |
| --- | --- | --- |
| 原文注释词 | 中性灰 + 浮起阴影（现状，不改） | 不变 |
| 卡片文字 | `surface` + `pos` + `meaning`（不重复译法） | — |
| 该段译文里的对应处 | 与正文一致（不标注） | 同款中性灰 + 同款浮起阴影（`ilmt-gloss-pair`），关闭即撤销 |

- 只在卡片打开期间点亮，避免译文里长期出现灰点和「满页重点」。这是有意的取舍：v1 要的是
  「核对一次」，不是「永不消失的标注」。
- 卡片不再用「译 ·」抄一遍译法：译文里已经点亮，且实测这一行与释义读起来重复。

### 4.3 段落联动

```
原文段（悬停中）
  译文块 ← 左侧竖线加深、5% 同色淡染、文字不透明        data-ilmt-peer="1"
其它译文块（未悬停）
  译文块 ← 0.78 透明度、28% currentColor 竖线          现状
```

- 不使用边框加粗、不使用背景高亮块：`border-color` 与 `background` 的变化不触发布局，滚动时不会跳。
- `.ilmt-block` 现有 `opacity: 0.78 !important` 与 `border-left-color: … !important`（`inject.css:10-21`），
  联动样式必须同样用 `!important` 才能覆盖，别指望提高选择器权重。
- `data-ilmt-peer` 只是视觉提示，不承载信息：去掉它页面仍然可读（无障碍约定）。

### 4.4 文案

| 位置 | 现在 | v1 |
| --- | --- | --- |
| 顶部 banner | `翻译已开启 · N 个词可悬停（带虚线的词）` | `翻译已开启 · N 个词可悬停` |
| 卡片译行 | — | 不显示（译法只在译文里点亮） |

---

## 5. 测试计划

所有验收跑在现有门禁上，不新增命令：

```bash
npm run verify:delivery   # 单测 + tsc + build + check-build
npm run test:e2e          # headless，含 P0：快捷键/翻译与恢复/popup/复习
```

| 验收点 | 层级 | 具体做法 | 判定 |
| --- | --- | --- | --- |
| 1.1 / 1.5 | 单测 | `tests/unit/glossary.test.ts`：带 `example` 的 note → 无 `.ilmt-gloss-example`，文本不含例句；两层节点顺序与数量，且不出现「译 ·」 | 通过 = 断言全绿，且原有「渲染模型文本不走 HTML」用例仍绿 |
| 1.2 | 单测 | 桩 `Range.getBoundingClientRect`（已有）+ 桩卡片 `getBoundingClientRect`；分别测视口高 300 / 词在顶部两种 | `top` 落在 `[8, innerHeight-height-8]` |
| 1.3 | E2E | `translate.spec.ts` 新增：`setViewportSize({width:320,height:600})` → 翻译 → 滚到 `#article-p10` → 悬停注释词 → 读 `boundingBox()` | 完全在视口内 |
| 1.4 | E2E | 同一用例里先固定贴纸猫（`effectSettings` 预置）测一次，再固定地鼠测一次 | 高度 ≤ 175 / ≤ 155 |
| 2.1 / 2.2 | 单测 | `tests/unit/prompt.test.ts`：提示词含 `translated` 与校验规则；四种解析输入（一致 / 空 / 不在译文 / 超 32 字） | 版本号 = 4，字段保留或丢弃符合预期，note 从不整条丢失 |
| 2.3 / 2.4 | 单测 | `tests/unit/glossary.test.ts`：有/无 `translated` 时卡内都没有译行；打开卡后 `ilmt-gloss-pair` size=1、移开后=0 | 断言全绿，且 `ilmt-gloss` 数量不变 |
| 2.5 / 2.6 | E2E | mock 的 glossary 加 `translated:"存在得更久"`（需扩 `MockGlossaryNote` 类型），按现有「悬停出卡」用例走一遍 + `restore()` | 卡片不含「译 ·」；译文对应处点亮；还原后两个 highlight 都为空 |
| 3.1 | 单测 | 新 `tests/unit/peer.test.ts`：构造段根 + 两个 `.ilmt-tr`，调标记函数 | 只有目标 id 带属性；清除后为 0 |
| 3.2 – 3.4 | E2E | `translate.spec.ts`：`hover()` p3 → p5，断言属性与 computed `opacity`；`restore()` 后无残留 | 同时最多 1 个段落点亮 |
| 3.5 | E2E | 现有 banner 断言加两条（含 / 不含） | 文案一致 |
| P0 不回退 | E2E | 快捷键 `⌥A/⌥Q/⌥S`、翻译 10/10 + 译文在原文下方 + 恢复、popup provider/model、复习收录与评级揭晓 | 与今天一致，全绿 |
| 人工抽查 | 人工 | `opencli ... --window background` 打开 `tests/fixtures/article.html`，悬停注释词 / 悬停段落，看卡片是否贴边、译文是否点亮 | 无红色报错；卡片不出屏、不压字 |

单测改动范围预期：`glossary.test.ts`（1.1/1.5/2.3/2.4）、`prompt.test.ts`（2.1/2.2）、
新增 `peer.test.ts`（3.1）、`translate.spec.ts`（E2E 全部）。

---

## 6. 风险与取舍

### 对 P0 的影响

- 三处改动都落在 content script 的展示层：`.ilmt-tr` 节点与 `data-ilmt-for` 契约不变，
  翻译 / 恢复 / 批量 / 懒加载的判定标准不变；快捷键、popup、复习链路完全不碰。
- 唯一有风险的是「还原」：新增一个 highlight 注册（`ilmt-gloss-pair`）和 `data-ilmt-peer` 属性，
  `restore()` 必须一并清空。漏清会直接变成 P0 回归（页面上残留高亮），
  用现有 `shows a glossary card on hover and clears it on restore` 扩两条断言兜住。
- 复习卡复用 `GlossaryNote.meaning`，本轮不新增字段写入学习库，SRS 数据不受影响。

### 成本与取舍

- **缓存**：注释 schema 变了，必须把 `FORMAT_VERSION` 3 → 4，否则旧缓存页面永远没有「译」行，
  同一功能一半页面生效一半不生效。代价是所有缓存一次性失效，用户升级后每页多一次（且仅一次）翻译
  请求。这与 2026-11-13 加 `glosses` 时的处理一致（那次也是 2 → 3）。
- **提示词**：多一个键 + 一条规则，约 +40 token/请求。相比「悬停时再发一次翻译」便宜得多。
- **模型可靠性**：`translated` 仍由模型生成，校验只能保证「不撒谎」（必须逐字出现在译文里），
  保证不了「最贴切」。宁可整行不显示，也不显示对不上的内容。
- **视觉噪音**：译文里的术语只在卡片打开时点亮，代价是用户无法「扫一眼看全文有哪些注释词」；
  这符合「不挡阅读」优先。

### 性能

- 卡片高亮：只在开/关卡片时注册/注销 1 个 range，不随段落数量增长。
- 段落联动：`pointerover` 委托 + `closest()`，只在段落变化时改 1–2 个节点属性；
  只写 `border-color / background / opacity`，均不触发布局，不读 `getBoundingClientRect`。
- 不新增 MutationObserver、定时器或滚动监听。

### 无障碍

- 三块新视觉都只是「辅助」：读屏仍按 DOM 顺序读到原文 → 译文；译行是纯文本，不靠颜色传达含义。
- 不把 `role=tooltip` 改成可聚焦控件（保持现状），因此键盘用户依旧通过 banner 的「N 个词可悬停」
  得知注解存在——这也是 O5 文案必须改准的原因。
- `prefers-reduced-motion`：本轮不新增动画，无需额外分支。

### 已知限制（v1 接受）

- 卡片仍会遮住约 130–170px 高的正文（其中 48–84px 是收录特效本身的占位）。彻底解决要把特效与
  信息区拆开，属于后续迭代。
- 只做「原文 → 译文」单向联动；悬停译文不会反查原文段落。
- 同一段译文里出现两次同一个词时只标第一处。

---

## 7. 交付判定

三条需求的验收表全部为 PASS，且 `npm run verify:delivery`、`npm run test:e2e` 的 P0 主流程
（快捷键绑定 / 翻译与恢复 / popup / 复习链路）保持通过，才算 v1 交付完成。

## 8. 修订（2026-11-16，交付后复盘）

- 原因：用户实测卡片里「译 · 存在得更久」与释义「比……存在得更久」读起来是同一件事；
  译文里已经点亮对应词，第三行只增加高度，与 v1「不挡阅读」的目标相反。
- 决定：卡片固定两层（词头 → 释义）。`translated` 的生成、逐字校验与译文点亮
  （需求 2 的第 1、2、4、5 条）全部保留——双译仍然是学习入口，只是不把译法再抄进卡片。
- 验收调整：1.5 改为两层；2.3 改为「带/不带 translated 都不出现译行」；
  2.5 改为「卡片不含『译 ·』，译文对应处点亮」。
- 落实：`src/content/glossary.ts` 删除译行渲染与对应 CSS；两处测试同步更新，与本文档同一次提交。
