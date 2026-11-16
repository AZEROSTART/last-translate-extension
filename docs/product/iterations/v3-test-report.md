# v3 测试报告：让积累被看见（词库规模 · 毕业收尾 · 回来时说实话）

- 日期：2026-11-16
- 被测提交：`0e02e06` — `feat: show the library, send the graduates off, and tell the truth about today`
- 需求：`docs/product/iterations/v3-requirements.md`
- 基线：`v1-requirements.md` + `v1-test-report.md`（16 条）、`v2-requirements.md` + `v2-test-report.md`（27 条）
- 规则：`AGENTS.md`、`docs/delivery-verification.md`
- 测试方式：独立验证（断言脚本不引用开发写的测试；官方门禁另外复跑；真实 `dist/` 在 headless Chromium 中渲染；真实 Chrome 后台窗口抽查）
- 结论：**PASS**（3 条需求 / 23 条验收标准全部通过；P0 与 v1 / v2 回归无回退；未发现超出需求文档范围的改动）

> 测试 agent 未修改源码、未修改需求文档、未提交、未推送。临时脚本、日志与截图在
> `/tmp/v3probe/` 与 `/tmp/ilmt-v3/`（不随仓库提交）。

---

## 1. 方法与门禁

### 1.1 官方门禁（复跑）

```bash
npm run verify:delivery
npm run test:e2e
```

- `verify:delivery`：exit 0
  - `npm test`：`Test Files 48 passed (48)` / `Tests 780 passed (780)`，5.40s
  - `npx tsc --noEmit`：无错误
  - `npm run build`：62 modules，`dist` 产出正常
  - `node scripts/check-build.mjs`：`dist check passed: manifest and every referenced entry are present.`
- `test:e2e`（headless）：20/20 passed，28.7s，exit 0
  - 含 v3 新增 3 条：`shows the size of the library once the first word is kept`、`graduates the last due word and clears the badge`、`tells a returning user the truth about the gap and about today`

### 1.2 独立验证（不依赖开发的测试）

| 脚本 | 内容 | 结果 |
| --- | --- | --- |
| `/tmp/v3probe/probe.cjs` | 把 `src/panel/review.ts`、`src/shared/learning-storage.ts` 单独编译到 `/tmp`，用 jsdom 自己 mount；重算 shelf / return / 今日计数 / 毕业块 / 撤销 / 2000 上限 / 日期函数 | **32/32** |
| `/tmp/ilmt-v3/browser-check.mjs` | 真实 `dist/` + headless Chromium（`--load-extension`），300px 侧栏、深色主题、reduced-motion、零词、2000 词、毕业流程、撤销 | **35/35** |
| `/tmp/ilmt-v3/v2-regression.mjs` | **v2 时期写的**独立浏览器回归脚本原样重跑（v1 卡片 / 译行 / 配对高亮 / P0 翻译 / popup / v2 三档后果 / 撤销 / 结束页） | **40/40** |
| `npx vitest run`（6 个相关文件） | `glossary` / `prompt` / `srs` / `learning-storage` / `learning-messages` / `panel-review` | **171/171** |

开发新增的单测没有被当作唯一证据：上面 32 条独立断言重新算了一遍日期、文本、节点位置、撤销去重与上限行为。

---

## 2. 验收标准逐条判定

### 需求 1（P0）复习页常驻一行「我的词库」

| # | 断言 | 判定 | 证据 |
| --- | --- | --- | --- |
| 1.1 | 3 词（1 mastered、1 到期）→ `.ilmt-review` 第一个元素子节点是 `.ilmt-review-shelf`，文本严格 `已收录 3 个 · 已毕业 1 个` | **PASS** | 独立 jsdom：`firstElementChild === shelf`、文本逐字相等；真实浏览器 300px：`已收录 24 个 · 已毕业 3 个`，`review.firstElementChild === shelf` |
| 1.2 | 3 词全 learning → `已收录 3 个`，全文不含「已毕业」 | **PASS** | 独立 jsdom：文本相等且 `root.textContent` 不含「已毕业」 |
| 1.3 | `words: []` → 无 `.ilmt-review-shelf`，A 页既有文案与「不含本轮 / 不含今天已复习」仍通过 | **PASS** | 独立 jsdom + 真实浏览器：零词时 shelf / return / graduated 均为 `null`，标题仍是「还没有收录的词」，全文不含「已收录 0 个」 |
| 1.4 | shelf 在 `.ilmt-review-langs` 之前；切到 `es` chip 后文本不变 | **PASS** | 独立 jsdom：`compareDocumentPosition` 断言 shelf 在前；切 chip 后仍为 `已收录 3 个`。真实浏览器（25 词、2 语言）：`已收录 25 个 · 已毕业 3 个` → 切 es 后不变 |
| 1.5 | 卡片 / B 页 / C 页三种状态都存在且文本相同 | **PASS** | 独立 jsdom 三态各断言一次；真实浏览器覆盖卡片态、C 页（毕业后）；B 页由开发单测与 v2 回归覆盖 |
| 1.6 | E2E：收录 1 词后打开侧栏，shelf = `已收录 1 个`，不含「已毕业」 | **PASS** | `learning.spec.ts › shows the size of the library once the first word is kept`（1.8s，绿） |

### 需求 2（P0）毕业有收尾

| # | 断言 | 判定 | 证据 |
| --- | --- | --- | --- |
| 2.1 | box 5 评「认识」→ 结束页有 `.ilmt-review-graduated`，含 `word1 毕业了`；同帧 shelf 为 `已收录 1 个 · 已毕业 1 个` | **PASS** | 独立 jsdom（真实 `applyReviewAnswer`）：文本、shelf、回执「已毕业」三者同时成立；真实浏览器：`outlive 毕业了` + `已收录 1 个 · 已毕业 1 个`。代码路径为 `commit()` 内先就地替换 `state.all.words` 再 `render()`，不依赖 `storage.onChanged` |
| 2.2 | 普通「认识」（0 → 1）→ 无毕业块，结束页不含「毕业了」 | **PASS** | 独立 jsdom：`.ilmt-review-graduated` 为 `null`，全文不含「毕业了」 |
| 2.3 | 一轮 4 个毕业 → 恰好 3 行、顺序等于提交顺序，另有 `还有 1 个也毕业了` | **PASS** | 独立 jsdom：行数 3，文本顺序 `word1/word2/word3 毕业了`，`more` 文案逐字相等 |
| 2.4 | B 页（结束前仍有 2 个到期）同样出现毕业行，「本轮先到这 / 还有 2 个到期 / 继续复习」不变 | **PASS** | 独立 jsdom：毕业行存在，且其下一个兄弟节点就是 `.ilmt-review-done-today`；B 页三项旧断言同时成立；真实浏览器 v2 回归里 B 页文案仍为「本轮先到这 / 还有 2 个到期」 |
| 2.5 | 撤销毕业提交 → 块消失、shelf 回 `已收录 1 个`；再毕业仍 1 行（去重） | **PASS** | 独立 jsdom 与真实浏览器双跑：撤销后 `graduated === null`、shelf `已收录 1 个`、词卡回来；重新评级再毕业后 `rows === 1`、无 `more` |
| 2.6 | `deps.effect().mount` 抛错 → 仍显示 `.ilmt-review-graduated-word`，无 `[data-ilmt-effect]`，不抛错 | **PASS** | 独立 jsdom：文本 `outlive 毕业了` 存在，块内无 `[data-ilmt-effect]`，视图继续渲染 |
| 2.7 | 特效容器 `aria-hidden="true"`、内部按钮 `tabIndex === -1`、`mount` 收到 `animations === false` | **PASS** | 独立 jsdom：`animations === false`（记录型 effect）、`known` 状态；真实浏览器：`aria-hidden="true"`、按钮 `[-1]`、`data-ilmt-animations="off"`、`animationName: none` |
| 2.8 | E2E：唯一到期词种成 box 5 → 评级 → 下一张 → 结束页含 `outlive 毕业了`，shelf 含「已毕业 1 个」，徽标清空 | **PASS** | `learning.spec.ts › graduates the last due word and clears the badge`（1.9s，绿）；真实浏览器另测 `getBadgeText() === ""` |

### 需求 3（P0）今天就是今天，词还在

| # | 断言 | 判定 | 证据 |
| --- | --- | --- | --- |
| 3.1 | `localDay` 导出且返回本地 `YYYY-MM-DD`；今天 0 / 昨天 1 / 明天 -1 / `""` null / `2026-13-40` null；跨月、跨年 | **PASS** | 独立重算（本地 2026-11-16 09:30）：今天 0、昨天 1、明天 -1；`2026-10-31 → 16`、`2026-09-30 → 47`、`2025-12-31 → 320`、`2024-11-16 → 730`；`""`、`2026-13-40`、`2026-02-30`、`2026-11-16T00:00`、`2026-1-1` 全为 `null`；23:59:59 → 0、次日 00:00:01 → 1 |
| 3.2 | `stats.day = 今天`、`todayReviewed = 4`、无到期 → C 页「今天已复习 4 个」 | **PASS** | 独立 jsdom：文本逐字相等 |
| 3.3 | `stats.day = 昨天`、`todayReviewed = 4`、无到期 → C 页严格「今天已复习 0 个」，全文不含「已复习 4 个」 | **PASS** | 独立 jsdom：两项断言均成立 |
| 3.4 | 昨天 + 4、结束后仍有到期 → B 页同样 0 | **PASS** | 独立 jsdom：点「结束」后 `.ilmt-review-done-today` 为「今天已复习 0 个」 |
| 3.5 | 5 天前、1 个到期、24 词（3 mastered）→ 严格 `有 5 天没见了 · 24 个词都还在`，且是 shelf 的下一个兄弟节点 | **PASS** | 独立 jsdom：文本逐字相等且 `shelf.nextElementSibling === return`；真实浏览器 300px：同文本，`review.children = [shelf, return, …]` |
| 3.6 | 14 天前 → `有一阵子没见了 · 24 个词都还在` | **PASS** | 独立 jsdom：14 天与 30 天均为「有一阵子」，13 天仍为精确「有 13 天没见了」；真实浏览器 30 天同文案 |
| 3.7 | gap 2 不渲染；3 渲染；`stats.day === ""` 不渲染；无到期不渲染；未来日期不渲染 | **PASS** | 独立 jsdom 五组边界逐条断言；另测非法日期 `2026-13-40` 不渲染 |
| 3.8 | 提交一次复习并 `await view.refresh()` 后 return 消失，shelf 仍在 | **PASS** | 独立 jsdom：return 为 `null`，shelf 仍为 `已收录 1 个` |
| 3.9 | E2E：种 5 天前 + 1 到期 → 复习页含「有 5 天没见了」；不评级点「结束」→ B 页「今天已复习 0 个」 | **PASS** | `learning.spec.ts › tells a returning user the truth about the gap and about today`（1.9s，绿） |

**小计：23/23 PASS。**

---

## 3. P0 回归

| P0 项 | 结果 | 证据 |
| --- | --- | --- |
| 快捷键 ⌥A / ⌥Q / ⌥S 被 Chrome 解析 | **PASS** | `translate.spec.ts › advertises the real shortcut bindings without an OS keystroke`（397ms）；v2 时期独立脚本复跑 `P0 ⌥A/⌥Q/⌥S 已注册` |
| 翻译 10/10、译文在原文下方、再次激活恢复 | **PASS** | `translates an English article and restores it`（595ms）；独立脚本：10 段都有译文、原文保留、无 loading 残留、320×600 正常；`restore` 后 0 译文 |
| popup 显示 provider/model | **PASS** | `shows settings sections and the active provider in the popup`（569ms）；独立脚本：popup 文本含 `OWN` 与 `mock-model` |
| 复习链路：点评级 → 揭晓 → 下一张写库 → 撤销 | **PASS** | `learning.spec.ts` 5 条复习用例全绿；独立浏览器：点「认识」后第二行仍在、下一张后 `box 0 → 1`、回执「已记录 · 明天再见」、撤销后 `box/dueAt` 复原、进度 `2/4 → 1/4`、焦点回卡片、tab 计数与徽标恢复 |
| 控制台 | **PASS** | Playwright 面板 / 页面无红色报错；真实 Chrome `opencli browser delivery console --since 2m`：0 条消息 |

### 真实 Chrome 后台抽查（不抢焦点）

- `opencli browser delivery --window background open "http://127.0.0.1:4173/article.html?delivery=…"`：通过
- CDP 选中首段 30 字符 + 派发 `mouseup`：气泡出现，按钮为「解释 / 追问」：通过
- 点击「解释」：命令返回成功；`opencli browser delivery console --since 2m` 为 0 条（无 error）：通过
- **未确认**：弹出的是 Chrome 侧栏（浏览器 UI，不属于标签页），opencli 的截图 / tab 列表都看不到侧栏内部；截图里气泡仍可见。该限制与 v1 / v2 记录一致（`delivery-verification.md` §5、§17）。本轮未改 content script / 划词链路，侧栏页面本身由 Playwright 的 `panel.html` 用例覆盖。

---

## 4. v1 + v2 回归

### 4.1 v1（16 条，重点：悬停卡、译行、配对高亮）

| 区域 | 结果 | 证据 |
| --- | --- | --- |
| 1.1 旧 `example` 不渲染 | PASS | 独立脚本：卡片无 `EXAMPLE_SENTINEL_SHOULD_NOT_RENDER` |
| 1.2 / 1.3 卡片始终在视口内（含 320×600） | PASS | 独立脚本：320×600 下卡片 `x/y/width/height` 完全在视口内；E2E `keeps the hover card inside a narrow viewport for every card size` 覆盖 |
| 1.4 贴纸猫 ≤175 / 地鼠磁铁 ≤155 | PASS | E2E 同一条用例逐项断言 `sticker.height ≤ 175`、`gopher.height ≤ 155`（`translate.spec.ts`，绿） |
| 1.5 卡片三层顺序 | PASS | 独立脚本：词头 → 释义 → 译行 |
| 2.1 / 2.2 prompt 契约与 `FORMAT_VERSION = 4` | PASS | 独立脚本：请求 body 含 `translated`、不含 `example`；`prompt.test.ts` 43 条绿 |
| 2.3 译行进卡 | PASS | 独立脚本：卡内含「译 · 存在得更久」 |
| 2.4 / 2.6 配对高亮落在译文、原文高亮数量不变 | PASS | 独立脚本：`ilmt-gloss-pair` 恰 1 条、原文仍 2 个词条 |
| 2.5 恢复后两个 highlight 清空 | PASS | 独立脚本：`restore()` 后 0 残留 |
| 3.1 段根标记只作用于目标段 | PASS | `peer.test.ts` 4 条绿 |
| 3.2 – 3.4 段落联动、只点亮一段、恢复干净 | PASS | 独立脚本：p3 → p5 同时只有 1 个 `data-ilmt-peer`；恢复后 0 |
| 3.5 banner 文案（含「个词可悬停」、不含「虚线」） | PASS | 独立脚本逐字断言 |

### 4.2 v2（27 条，重点：结束页三分支、回执文案、撤销计数）

| 区域 | 结果 | 证据 |
| --- | --- | --- |
| 1.1 – 1.4 三档间隔文案、纯函数无副作用 | PASS | `srs.test.ts` 9 条绿；独立浏览器首卡预览 `10 分钟后 / 10 分钟后 / 明天` |
| 1.5 – 1.8 评级两行、说明行、改判、四选一 note | PASS | `panel-review.test.ts` 60 条绿；独立浏览器可访问名、说明行一条、选中后第二行仍在、300 / 320px 均不溢出 |
| 1.9 E2E box 0 → 1、按钮含「明天」 | PASS | `learning.spec.ts` 复习用例绿 |
| 2.1 – 2.4 撤销快照、逐字段复原、四种失败原因、旧数据兼容 | PASS | `learning-storage.test.ts` 24 条、`learning-messages.test.ts` 11 条绿 |
| 2.5 background 撤销消息落库 | PASS | 同上；独立浏览器 `box/dueAt` 复原 |
| 2.6 – 2.8 回执文案 / 只调一次 / 失败态 / 焦点 | PASS | 独立浏览器：`已记录 · 明天再见`、`role=status`、`aria-live=polite`、进度 `2/4`、300px 不溢出、焦点回卡片、idle 恢复 |
| 2.9 E2E 撤销后计数与徽标恢复 | PASS | 独立浏览器：tab 含 4、`getBadgeText() === "4"` |
| 2.10 – 2.12 四选一撤销、终态文案、结束页撤销不回零 | PASS | `panel-review.test.ts` 绿；独立浏览器结束页撤销后回到 `2/4` |
| 3.1 零词引导 | PASS | 独立 jsdom + 真实浏览器：标题「还没有收录的词」，不含「本轮 / 今天已复习」 |
| 3.2 B 页「本轮先到这 / 还有 2 个到期 / 继续复习」 | PASS | 独立浏览器：三项同时成立，且不含「今天没有要复习的词」 |
| 3.3 C 页「今天没有要复习的词 / 明日还有 N 个」 | PASS | 单元用例绿；独立 jsdom 多次进入 C 页 |
| 3.4 / 3.5 摘要文案、无「答对」、0 时不出现前缀 | PASS | 单元用例绿 |
| 3.6 E2E 结束页不说「答对」 | PASS | `learning.spec.ts` 绿 |

v2 时期的独立浏览器脚本（40 条，写在 v3 之前）在 v3 构建上原样重跑 **40/40 通过**，是 v1/v2 无回退的强证据。

---

## 5. 伦理 / 文案约束核查

| 约束（需求 §4.3、§6） | 结果 | 证据 |
| --- | --- | --- |
| 新增文本不含「坚持」「连续」「断」「还差」「目标」「别放弃」「终于」 | PASS | 新增 UI 文案只有：`已收录 N 个`、`已毕业 N 个`、`有 N 天没见了`、`有一阵子没见了`、`N 个词都还在`、`<词> 毕业了`、`还有 N 个也毕业了`；逐条扫描无禁用词 |
| 不含感叹号 | PASS | 新文案与新增代码无 `！` / `!`（排除 `!==` 等语法） |
| 新节点不出现红色 | PASS | 新增 CSS 只用 `var(--ilmt-muted)` / `var(--ilmt-text)`；真实浏览器两种主题计算色均为 `rgb(110, 159, 153)`，非红 |
| 不新增权限 / host_permissions | PASS | `public/manifest.json` 与 v2 提交 `5f6e13c` **逐字节相同**（`diff` 为空） |
| 不新增 storage key | PASS | 仍是 `learning`；`review.ts` 只发既有 `review-answer` / `review-undo` / `mnemonic`，不写 `chrome.storage`；`sessionStorage` 仍只用于既有语言偏好 |
| 不新增 `LearningWord` 字段 | PASS | `src/shared/types.ts` 未改 |
| `LearningState.version` 仍为 1 | PASS | `types.ts:146` 未改；`parseLearningState` 未改 |
| 毕业块无动画、无音效 | PASS | `animations: false` → `data-ilmt-animations="off"`，计算 `animationName: none`；新增 CSS 无 `animation` / `transition`；无音频代码 |
| 舞台 `aria-hidden="true"` | PASS | 真实浏览器读取属性为 `"true"` |
| 内部按钮不可 Tab | PASS | 舞台内全部 `button.tabIndex === -1` |
| 无新增 `aria-live`、无自动消失提示 | PASS | 只有既有回执 `role=status`；shelf / return 为普通 `<p>`，无 role、无 tabIndex |
| 不做排行榜 / 积分 / 推送 / 红点 / 倒计时 | PASS | 无新增消息类型、无新权限、无计时器/监听器 |

---

## 6. 边界与异常

| 边界 | 结果 | 证据 |
| --- | --- | --- |
| 零词：shelf / return / 毕业块都不渲染 | PASS | 独立 jsdom + 真实浏览器 |
| `state.all === null` / `getState` 抛错 | PASS | 独立 jsdom：`getState` reject 时不崩、不渲染 shelf / return（实现内部回退为空状态，shelf 同样不出现） |
| 2000 词上限淘汰后数字真实 | PASS | 独立 jsdom：2001 词里最旧 mastered 被淘汰后为 2000，shelf 为 `已收录 2000 个`；真实浏览器种 2000 词：`已收录 2000 个 · 已毕业 1234 个`，未伪造历史累计 |
| 毕业特效 `mount` 抛错只显示文字 | PASS | 独立 jsdom：文字在、特效节点无、无异常 |
| 毕业后再撤销再毕业只有 1 行 | PASS | 独立 jsdom + 真实浏览器：撤销块消失、shelf 回退；再毕业 `rows === 1` |
| 窄侧栏 300px 两行不溢出 | PASS | 真实浏览器 300px：shelf `overflow=0`、高度 18（单行）；return `overflow=0`、高 16.5；最长组合 `已收录 2000 个 · 已毕业 1234 个` 宽 264 / 容器 264，`white-space: nowrap`；两行在 DOM 中均排在语言 chip 之前（`render()` 顺序 + jsdom 位置断言） |
| 深色主题可读 | PASS | 真实浏览器深色：前景 `rgb(110,159,153)`，背景 `rgb(4,6,12)`，对比度 **6.83:1**；浅色同样使用 muted 变量 |
| `prefers-reduced-motion` | PASS | 真实浏览器：新增节点 `animationName: none`，过渡时长 0.01ms（`theme.css` 的全局 reduced-motion 规则），毕业行同样无动画 |
| 时钟回拨 / 未来日期 | PASS | 未来日期不渲染 return；`daysSinceDay` 返回负数（-1） |
| 跨午夜在面板内 | PASS | 每次 `render()` 取 `deps.now()`；独立重算 23:59:59 → 0、00:00:01 → 1 |

---

## 7. 越界检查

```text
git show --stat 0e02e06
 src/panel/review.ts                  | 145 +++-
 src/shared/learning-storage.ts       |  28 +-
 src/styles/panel.css                 |  47 +++
 tests/e2e/learning.spec.ts           | 100 ++++
 tests/unit/learning-storage.test.ts  |  28 ++
 tests/unit/panel-review.test.ts      | 418 ++++++-
 6 files changed, 757 insertions(+), 9 deletions(-)
```

- **6 个文件**，与需求 §5 / §7 列出的实现面一致（3 个源码 + 3 个测试）。
- 受保护路径 `git diff 5f6e13c 0e02e06 -- src/shared/srs.ts src/content src/shared/prompt.ts src/styles/inject.css public/manifest.json src/popup src/settings src/background src/shared/types.ts`：**空**。
- `package.json` / `package-lock.json` / `vite.config.ts` / 构建脚本：未改（无新依赖、无构建变更）。
- 测试侧删除行只有 4 行：`panel-review.test.ts` 的 import 两行与 `state()` 辅助函数签名（需求 §5 允许），**没有删除或放宽任何既有断言**；1.3 是在既有「guides a brand-new library」用例末尾追加一条断言，3.1 是新增的 `describe("local days")`。
- `docs/` 在本次提交中未改（`docs/product/` 至今未跟踪，本报告是新增文件）。

---

## 8. 缺陷清单

- **P0：无**
- **P1：无**
- **P2：无需要修复项**

以下为观察，不影响验收，供后续留档：

1. **2000 上限与「数字下降」的措辞**：库满 2000 后再收录新词，会淘汰最旧 mastered，显示数字保持 `2000` 而不是变小；只有把超过 2000 的状态裁回 2000 时才会看到下降。实现始终等于 `words.length`，符合「真实状态、不补偿、不伪造历史累计」的意图。
2. **毕业舞台的实际尺寸**：容器复用了 `.ilmt-review-scene-stage`（CSS 名义 64×58），但特效自己的根节点样式把盒子压到 50×44，内部仍是 `scale(.72)`。这与揭晓场景的既有行为一致，且需求明确「不改特效 CSS」，不算偏差。
3. **日期格式严格**：`daysSinceDay("2026-1-1")` 返回 `null`（只接受补零的 `YYYY-MM-DD`）。需求定义的就是该格式，`stats.day` 的写入方也始终补零，不会误伤真实数据。
4. **真实 Chrome 侧栏不可见**：opencli 截图与 tab 列表都拿不到 side panel 内部，无法确认「解释」点击后侧栏里的引用与回答（气泡与无报错已确认）。这是工具限制，不是产品缺陷。

**修复清单（仅 FAIL 时需要）：无。** 23 条验收标准、P0、v1/v2 回归、伦理与越界检查全部通过，开发侧不需要改动。

---

## 9. 结论

需求 1（词库规模）、需求 2（毕业收尾）、需求 3（今天与久别）的 **23 条验收标准全部 PASS**；
官方门禁 780/780 单测、`tsc`、build、`check-build` 全绿，E2E 20/20；
P0（快捷键 / 翻译与恢复 / popup / 复习链路）与 v1 的 16 条、v2 的 27 条回归均无回退（v2 时期独立浏览器脚本原样重跑 40/40）；
伦理与文案约束、权限 / 数据结构不变、越界检查全部通过。

**v3 判定 PASS。** 无需开发修复项。

---

## 10. 证据索引与复现

| 证据 | 位置 |
| --- | --- |
| 官方 E2E 日志 | `/tmp/ilmt-v3/e2e.log`（20 passed） |
| 官方单测明细 | `/tmp/ilmt-v3/vitest.json`（780 passed / 0 failed） |
| 独立 jsdom 断言 | `/tmp/v3probe/probe.cjs`、日志 `/tmp/ilmt-v3/independent-unit.log`（32/32） |
| 独立浏览器断言（v3） | `/tmp/ilmt-v3/browser-check.mjs`、日志 `/tmp/ilmt-v3/browser-check.log`（35/35） |
| v2 时期独立回归脚本 | `/tmp/ilmt-v3/v2-regression.mjs`、日志 `/tmp/ilmt-v3/v2-regression.log`（40/40） |
| 真实 Chrome 抽查截图 | `/tmp/ilmt-v3/explain.png` |

复现命令：

```bash
cd /Users/presence/orca/workspaces/translate/product-loop

# 官方门禁
npm run verify:delivery
npm run test:e2e

# 独立 jsdom（先编译到 /tmp/v3probe/build）
node /tmp/v3probe/probe.cjs

# 独立真实 Chromium（需要 dist/，headless）
node /tmp/ilmt-v3/browser-check.mjs
node /tmp/ilmt-v3/v2-regression.mjs
```
