# 复习页重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把复习卡从「四选一 + 三档算账」改成「先回忆、后确认、只判断一次」，让 8 张卡在 3 分钟内过完。

**Architecture:** 只改侧栏复习视图（`src/panel/review.ts` + `src/styles/panel.css`）与两组测试。每张卡三态：`prompt`（词 + 挖空句 + 看答案）→ `revealed`（释义 + 两档）→ 想起直接翻页；没想起进 `lesson`（释义 + 演出 + 钩子 + 下一张）。写库只在点档位时发生一次。SRS、storage、background、types 全部不动。

**Tech Stack:** TypeScript, 原生 DOM, vitest/jsdom, Playwright (headless), Vite.

**Spec:** `docs/superpowers/specs/2026-11-17-review-redesign-design.md`

## Global Constraints

- 不改 `src/shared/srs.ts`、`src/shared/learning-storage.ts`、`src/shared/types.ts`、`src/background/*`、`src/content/*`、`popup`、`manifest.json`、构建配置。
- 不新增依赖、权限、存储 key、`LearningWord` 字段；`LearningState.version` 仍为 1。
- 复习视图内不出现红色；新增触控目标 ≥ 44px；颜色复用现有 `--ilmt-*` 变量。
- 每张卡恰好一次 `review-answer`；写库失败不推进；揭晓态点「结束」不写库。
- 既有 v1/v2/v3 验收中与删除元素无关的部分必须保持通过：shelf、return、graduated、undo、结束页 A/B。
- `spot.ts` 与 `srs.test.ts` / `spot.test.ts` 保留，不删除模块；只停止 UI 消费与写入。
- 提交在 `product-loop` 子工作区，**不 push、不合并**。

## Review Focus

- 写库失败（`answer` 返回 `{ok:false}`）：必须停在 `revealed`，两档可点，提示「没写进去 · 再点一次」，队列不前进。
- 词没有 `contexts[].sentence`：不渲染空句子行，卡片仍有词面与「看答案」。
- 库内有 ≥2 种目标语言：只显示语言标签，不显示筛选；队列混合。
- 想起后翻页再撤销：词回到 `prompt`，box 回退，计数回滚，焦点回卡片。
- 画面请求失败或很慢：`lesson` 仍可「下一张」；想起来的路径不发起任何 mnemonic 请求。

---

### Task 1: 提示态只剩「词 + 挖空句 + 看答案」

**Files:**
- Modify: `src/panel/review.ts`（`renderCard`、`renderFilters`、`renderSpot`、`renderAnswer` 调用）
- Test: `tests/unit/panel-review.test.ts`

**Interfaces:**
- Consumes: 现有 `renderCard()`、`blankedSentence()`、`state.all`。
- Produces: prompt 态 DOM 约定——`.ilmt-review-word`、`.ilmt-review-sentence`（含 `.ilmt-review-blank` 或 `____`）、`.ilmt-review-reveal`（文本「看答案」）；不出现 `.ilmt-review-option`、`.ilmt-review-choices`、`.ilmt-review-meaning`、`.ilmt-review-gloss`、`.ilmt-review-langs`、`.ilmt-review-mascot`、`.ilmt-review-grades`。

- [ ] **Step 1: 写失败测试** — U1、U10、U11：
  - prompt 态断言上述节点存在/不存在，`reveal` 文本严格为「看答案」。
  - 无 `contexts` 的词：`.ilmt-review-sentence` 为 null，仍存在 `.ilmt-review-word` 与 `.ilmt-review-reveal`。
  - 单语言库无 `.ilmt-review-lang-label`；构造 2 种 `termLang` 时有。
- [ ] **Step 2: 跑测试确认失败** — `npx vitest run tests/unit/panel-review.test.ts`。
- [ ] **Step 3: 实现** — `renderCard` 只渲染 headword、可选语言标签、可选句子、「看答案」；删除 `renderFilters` 调用与 `renderSpot` 分支；`state` 去掉 `spotQuestion` / `spotResult` / `suppressedSpot`；按钮文案「看答案」。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交** — `feat: ask the word once before showing the answer`。

### Task 2: 揭晓态两档，点档位即写库；想起直接翻页

**Files:**
- Modify: `src/panel/review.ts`（`renderAnswer`、`renderGrades`、`commit`、`pickGrade`）
- Test: `tests/unit/panel-review.test.ts`

**Interfaces:**
- Consumes: Task 1 的 prompt DOM；`deps.answer`。
- Produces: revealed 态两个 `.ilmt-review-grade`，`data-grade="good"`（想起来了）/`"again"`（没想起来）；点 `good` 成功后队列前进一步并渲染下一张 prompt；点 `again` 成功后停留在该词并进入 lesson（Task 3）。不出现 `.ilmt-review-grade-due`、`.ilmt-review-grade-note`、`.ilmt-review-next`（good 路径）。

- [ ] **Step 1: 写失败测试** — U2、U3、U4、U7、U8、U9：
  - 点「看答案」后：释义出现、`answer` 未被调用、恰好两个 grade、`hard` 为 null、无间隔预览/说明行。
  - 点「想起来了」：`answer` 一次且 `grade==="good"`；队列前进；新卡为 prompt；回执含「词面 · 释义 · 明天再见」；无「下一张」。
  - 写库失败：停留 revealed，两档可点，错误文案含「没写进去」，`answer` 只调一次。
  - 揭晓态 `refresh()`：同词、释义仍在、`answer` 未调用。
  - 揭晓态点「结束」：`answer` 未调用，进 B 页。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现** — 新增 `phase: "prompt" | "revealed" | "lesson"`；`renderGrades` 只渲两档；`pickGrade` 直接 `answer`，成功且 `good` 时 `advance()`，`again` 时进 lesson；失败留在 revealed 并渲染 `.ilmt-review-error`。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交** — `feat: write the grade when it is picked`。

### Task 3: 「没想起来」的 lesson 态

**Files:**
- Modify: `src/panel/review.ts`（`renderScene`、`renderNext`、`ensureScene`）
- Test: `tests/unit/panel-review.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `again` 成功路径；`deps.mnemonic`、`deps.effect`。
- Produces: `.ilmt-review-lesson`（含释义、`.ilmt-review-scene`、`.ilmt-review-scene-caption`、`.ilmt-review-next`）；「下一张」只翻页、不再调用 `answer`；good 路径不调用 `deps.mnemonic`。

- [ ] **Step 1: 写失败测试** — U5、U6 + mnemonic 调用断言：
  - `again` 后：`answer` 一次、仍在该词、lesson 与字幕出现、next 可见、无回执。
  - 点 next：队列前进、`answer` 累计仍 1、回执出现。
  - good 路径：`mnemonic` 调用次数为 0；again 路径为 1。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现** — `renderScene` 只在 lesson 调用；`ensureScene` 只在 lesson 触发；`renderNext` 的点击改为 `advance()`（不写库）；删除「再看一次」按钮。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交** — `feat: teach only the words that were missed`。

### Task 4: 回执改成「词 · 释义 · 下次」并可撤销

**Files:**
- Modify: `src/panel/review.ts`（`renderReceipt`、`undoLast`、`commit` 的 receipt 来源）
- Test: `tests/unit/panel-review.test.ts`

**Interfaces:**
- Consumes: Task 2/3 的写库结果 `ReviewAnswerResponse.word`。
- Produces: `.ilmt-review-receipt` 文本 `词面 · 释义 · 下次再见`；释义缺失时 `词面 · 下次再见`；`已毕业` 不加「再见」；撤销按钮回到该词 prompt、计数回滚、焦点 `.ilmt-review-card`。

- [ ] **Step 1: 写失败测试** — U12：good 后回执文本；撤销后状态；E4 对应单测。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现** — `state.receipt` 保存 `{word, dueLabel}`；`renderReceipt` 按文案规则拼接；`undoLast` 成功后 `phase="prompt"`、`refresh()`、焦点回卡片。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交** — `feat: make the receipt say what the word was`。

### Task 5: 结束页 C 说本轮，保留 A/B/C2 与 v3 元素

**Files:**
- Modify: `src/panel/review.ts`（`renderFinish`）
- Test: `tests/unit/panel-review.test.ts`

**Interfaces:**
- Consumes: `state.answered`、`state.missed`（由 again 计数）、`state.graduated`、`stats`。
- Produces: C 页标题 `${answered} 个都过完了`；`missed > 0` 时副行 `${missed} 个没想起来`；不出现「认识」；A/B/C2 文案不变；shelf/return/graduated 仍按现有规则渲染。

- [ ] **Step 1: 写失败测试** — U13、U14、U15、U16、U17。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现** — C 分支改写；`missed` 在 again 写库成功时 +1；其余分支保持。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交** — `feat: close the round with what actually happened`。

### Task 6: 样式删减与排版

**Files:**
- Modify: `src/styles/panel.css`
- Test: `tests/e2e/translate.spec.ts` 的窄视口用例（不新增视觉单测）

**Interfaces:**
- Consumes: Task 1–5 的类名。
- Produces: 词 24px/600 text 色；句子 15px/1.65 左对齐；卡片去光晕、`min-height: 268px`、动作区钉底；「看答案」实线主按钮；两档等权；回执 12px 无底色；删除列表见 spec §9。

- [ ] **Step 1: 跑现有 E2E 确认基线** — `npm run test:e2e`（应仍绿，除已改的复习用例）。
- [ ] **Step 2: 改 CSS** — 删除 spec §9 列出的选择器；新增 `.ilmt-review-blank`、`.ilmt-review-lesson`、`.ilmt-review-error`；调整排版。
- [ ] **Step 3: 构建 + 窄视口 E2E** — `npm run build && npx playwright test tests/e2e/translate.spec.ts`。
- [ ] **Step 4: 提交** — `style: give the review card one reading axis`。

### Task 7: E2E 改写与全量门禁

**Files:**
- Modify: `tests/e2e/learning.spec.ts`

**Interfaces:**
- Consumes: Task 1–6 的全部实现。
- Produces: E1–E5 通过；P0 全绿。

- [ ] **Step 1: 写/改 E2E** — E1（good 链）、E2（good 不生成 mnemonic）、E3（again 链 + 10 分钟）、E4（撤销）、E5（shelf/return 原样）。
- [ ] **Step 2: 跑 `npm run test:e2e`** — 预期全绿。
- [ ] **Step 3: 跑 `npm run verify:delivery`** — 单测、tsc、build、check-build 全绿。
- [ ] **Step 4: 清理死代码** — `renderFilters`、`renderSpot`、`spotSeed`、`pickSpotOption`、`srs.previewDueLabel` 的 UI 引用、未用 import；确认 `review.ts` 行数明显下降。
- [ ] **Step 5: 再跑两条门禁 + 提交** — `refactor: remove the review UI the redesign replaced`。

## Self-Review

- **Spec coverage:** §3.1–3.10 分别落在 Task 1–6；§6 的 U1–U17 分布见各 Task；E1–E5 在 Task 7。§7 非目标写进 Global Constraints。§9 第一阶段完整覆盖。
- **Step scan:** 每个 Step 只有一个动作；测试步骤给出断言，代码步骤给出状态与文案，不写完整实现。
- **Type consistency:** `phase`、`state.receipt`、`state.missed`、`.ilmt-review-lesson`、`.ilmt-review-error` 在 Task 2–5 中命名一致。
- **Review Focus:** 五个失败/边界都有对应 Task 的测试（Task 2、1、4、3、5）。
- **Proportion:** 计划约 150 行，spec 527 行；代码块只保留测试断言与命令。
