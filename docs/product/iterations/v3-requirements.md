# v3 需求：让积累被看见（词库规模 · 毕业收尾 · 回来时说实话）

- 日期：2026-11-16
- 迭代：v3 / 3（最后一版）
- 状态：待开发（本轮只出需求，不改代码、不提交）
- 前置：v1 `8969a5b`（翻译呈现）、v2 `5f6e13c`（复习更符合人性）均已判定 PASS
- 主题（已定）：**提升留存与参与感，不使用暗黑模式**
- 一句话：让用户看见「我收进来的东西在长大」，让一个词的最后一次复习有收尾，让隔了几天回来时看到的数字和语气都是真的。

---

## 1. 观察到的问题

v1 解决了「读得清」，v2 解决了「敢诚实、撤得回、结束说真话」。复习页现在有：三档后果、一次撤销、三种真实的结束页、揭晓时的画面钩子。缺的是**主角**——那个被用户一点点攒起来的词库，在任何界面上都不是一个「东西」，只是一个分母。

### O1 词库的规模不可见：它只在「欠债」时出现，从不在「积累」时出现

- 证据：`src/background/badge.ts:5-9` 的 `badgeText()` 在数量 ≤ 0 时返回空串，`refreshBadge()`（:14-27）只算到期数；徽标是唯一的常驻入口，而它只会显示「还欠几张」。
- 证据：`src/panel/main.ts:357`：`reviewTab.textContent = dueReviews > 0 ? \`复习 (${dueReviews})\` : "复习";`——没有到期词时，连数字都消失。
- 证据：`src/popup/main.ts:65`：`if (due <= 0) return;`——没有到期词时 popup 里没有这一行。
- 证据：`src/panel/review.ts:706-788` 的 `renderFinish()` 只统计「本轮 / 今天 / 明日」；`words.length` 在 :715 只被当成布尔用（判断是否为零词），从未显示。`mastered` 在全仓只有 `src/shared/srs.ts:44-46`（状态迁移）与 `src/shared/learning-storage.ts:228-241`（超限淘汰时优先删）两处消费，**没有任何界面读过它**。
- 证据（截图）：`docs/previews/mnemonic/review-scene.png` 顶部只有 `对话 | 复习 (1)`，卡片之外没有任何词库数字。
- 实际行为：库里有 24 个词、今天没有到期词时，用户看到的是「复习」两个字、一个空徽标、一页「今天没有要复习的词 · 今天已复习 0 个」。用户攒了两周的东西，在界面上等于不存在；他唯一能感知到的数字是「还欠多少」。

### O2 「毕业」是 SRS 的终点，但产品里没有这一刻

- 证据：`src/shared/srs.ts:44-46`：box 5 再评「认识」→ `status:"mastered"`、`dueAt:null`。这是词离开复习队列的唯一方式，也是唯一不可逆的正向结果。
- 证据：`src/panel/review.ts:665-671` 的 `gradeConsequence()` 与 `:929` 的回执，是「已毕业」在 UI 上出现过的全部位置——一句 `已记录 · 已毕业`，出现几秒后被下一张替换。
- 证据：结束页摘要（`review.ts:773`）写的是 `本轮 N 个 · 认识 M`，一个毕业的词和一次普通的「认识」在数字上完全相同；用户无法知道「刚才那个是它最后一次出现」。
- 证据（测试现状）：`tests/unit/srs.test.ts:77-78` 只断言 `previewDueLabel` 的「已毕业」文案；`tests/e2e/learning.spec.ts:200-201` 只断言结束页含「今天没有要复习的词」且不含「答对」。全仓没有一个用例关心 `status === "mastered"` 的界面表现。
- 实际行为：一个词的生命周期在「下一张」之后静默结束。它不再出现在队列里，也没有任何一句话告诉用户「你把它学完了」。

### O3 「今天已复习 N 个」跨日不归零：v2 的「说真话」漏了一处

- 证据：`src/panel/review.ts:712`：`const todayReviewed = state.all?.stats.todayReviewed ?? 0;`——直接读字段，没有和当天比对；:742 与 :784 把它渲染成「今天已复习 N 个」。
- 证据：`src/shared/learning-storage.ts:366-370` 只在**写下一次复习**时按 `localDay(now)` 重置；`parseLearningState`（:189-194）原样搬运；读路径没有归零。
- 证据：`src/shared/types.ts:140` 的注释写的是「todayReviewed resets when the day changes」，但「换日」实际是懒重置（等下一次写入），读侧没有实现。
- 证据（测试为什么没抓到）：`tests/unit/panel-review.test.ts:40` 固定 `stats: { day: "2026-11-12", todayReviewed: 0 }`，而 `NOW = 1_700_000_000_000`（本地 2023-11-15）：日期根本对不上，但计数是 0，观测不到差异。`v2-test-report.md:86` 记录的「另有今天已复习 0 个」同理。
- 实际行为（可复现）：第 1 天复习 4 个；第 2 天打开侧栏，点「结束」，B 页显示「今天已复习 4 个」。当天一个都没做，数字却说做了 4 个。这正是 v2 立下的标准（`v2-requirements.md` §2）不能容忍的错误。

### O4 隔了几天回来，界面和隔了一小时回来一模一样

- 证据：`stats.day` 记录着「最后一次复习是哪天」（写入 `learning-storage.ts:368-370`、撤销时 :430-437、解析 :189-194），但全仓**没有任何读侧消费**（`grep stats.day` 只命中 storage 层）。
- 证据：`refreshDueReviews()`（`src/panel/main.ts:349-358`）、徽标、popup 入口都只算到期数；没有任何地方表达「你上次来是几天前」或「东西都还在」。
- 实际行为：离开 3 天和离开 30 天，看到的是同一个「复习 (12)」。产品没有兑现「不清零、不指责」的承诺——不是因为它清了零，而是因为它从没说过「你的东西还在」。久别之后的第一次打开，界面只有一笔待还的账，没有一句安顿。

---

## 2. 本轮目标与非目标

### 目标

1. 复习页常驻一行**精确**的词库规模（收录数、毕业数），让「积累」和「欠债」同时可见（O1）。
2. 让「毕业」在结束页有一次安静的收尾：哪个词毕业了、它由哪个角色收着（O2）。
3. 把「今天」改成真正的今天，并对久别回来的人说一句真话：不在就是不在，词一个没少（O3、O4）。

### 非目标（本轮明确不做，防扩写）

- 不做「本周复习 / 连续天数 / 热力图 / 日历 / 统计页 / 成就徽章」。这些需要新的按日历史；`reviews` 只保留每词最近 10 条（`learning-storage.ts:17`），用它反推本周会得到**会缩水的数字**，与 v2 刚立的「说真话」冲突。宁可没有，不做近似。
- 不做排行榜、社交、分享、积分、抽奖、付费引导、断签惩罚、红点、倒计时、推送（不新增任何权限）。
- 不改 SRS：`INTERVALS_MS`、`MAX_BOX`、`applyGrade`、三档语义、间隔文案一律不动。
- 不改 v2 的撤销：深度仍是 1、窗口仍是 10 分钟、回执与失败文案不变。
- 不改揭晓与四选一：画面钩子、`play()`、改判、锁定全部保持。
- 不改悬停卡、翻译链路、`prompt.ts`、`inject.css`、popup 布局、设置页、四个特效的造型与契约。
- 不做词库列表页、搜索、删除、暂停某个词。
- 不改徽标语义（仍是到期数、0 时隐藏）——把积累塞进徽标会把它变成第二个提醒。
- 不新增存储 key、不新增字段、不新增依赖、不改 manifest、不动构建。
- 不新增动画、音效、庆祝彩带；不把「毕业」做成奖励事件。

### 优先级与实现顺序

三条都落在 `src/panel/review.ts`，**必须由同一个开发 agent 按 1 → 2 → 3 串行完成**，避免同文件冲突。需求 3 额外碰 `src/shared/learning-storage.ts`（导出两个纯函数），放最后。

三条都不大；若中途必须砍，先砍需求 2 的角色展示（保留文字），不砍需求 1 与 3。

---

## 3. 需求

### 需求 1（P0）复习页常驻一行「我的词库」：收录多少、毕业多少

**用户场景**
用户每天点开侧栏是想看看「今天要复习什么」。今天刚好没有到期词，他看到的是「复习」两个字和一页「今天没有要复习的词」。他想不起来自己到底攒了多少词、有没有学完过——因为界面上从来没有这个数字。他攒的东西只在「欠债」时才被提起。

**期望行为**
1. 复习视图容器 `.ilmt-review` 的**第一个子节点**是 `<p class="ilmt-review-shelf">`，排在语言筛选、回执、卡片、结束页之前。任何状态（卡片 / B 页 / C 页）都在。
2. 文案规则（`words` = `state.all.words`，`mastered` = `status === "mastered"` 的数量）：
   - `mastered === 0`：`已收录 ${words.length} 个`
   - `mastered > 0`：`已收录 ${words.length} 个 · 已毕业 ${mastered} 个`
   - 分隔符固定为空格 + `·` + 空格（与现有摘要文案一致）。
3. 口径固定为**全库**：包含已毕业的词、包含所有语言；不随语言 chip（`state.termLang`）与答案语言（`state.glossLang`）变化。语言 chip 已经负责按语言拆分的到期数，这一行回答的是「我一共有多少」。
4. 数字来源是当前 `state.all`。提交成功后用 `review-answer` 返回的 `word` **就地替换** `state.all.words` 里同 `id` 的词条（不额外读库），保证毕业发生时同一帧的 shelf 就是新值，不依赖 `chrome.storage.onChanged` 的时序。
5. `words.length === 0` 时**不渲染**该节点（零词由 A 页的引导负责，不显示「已收录 0 个」）。
6. 纯文本：不可点击、无图标、无进度条、无百分比、无目标值、无「还差 N 个」。
7. 视觉：12px、`var(--ilmt-muted)`、单行不换行、左对齐、`margin: 0`。

**可断言的验收标准**

| # | 断言 | 方式 |
| --- | --- | --- |
| 1.1 | 3 个词、其中 1 个 `status:"mastered"`、1 个到期：`.ilmt-review` 第一个元素子节点是 `.ilmt-review-shelf`，`textContent` 严格为 `已收录 3 个 · 已毕业 1 个` | 单测，`tests/unit/panel-review.test.ts` |
| 1.2 | 3 个词全部 `learning`：文本严格为 `已收录 3 个`，全文不含「已毕业」 | 单测，同上 |
| 1.3 | `words: []`：`.ilmt-review-shelf` 不存在，且 A 页既有文案与「不含本轮 / 不含今天已复习」的断言仍然通过 | 单测，同上（扩既有「guides a brand-new library」用例） |
| 1.4 | shelf 在 `.ilmt-review-langs`（语言 chip）之前；从「全部」切到 `es` chip 后，shelf 文本不变 | 单测，同上 |
| 1.5 | 卡片视图、B 页（中途结束）、C 页（今天做完）三种状态下 `.ilmt-review-shelf` 都存在且文本相同 | 单测，同上 |
| 1.6 | E2E：收录 1 个词后打开侧栏，`.ilmt-review-shelf` 文本为 `已收录 1 个`（不含「已毕业」） | E2E，`tests/e2e/learning.spec.ts` |

**涉及界面 / 数据位置**
- `src/panel/review.ts`：`render()` 在 `renderFilters()` 之前插入 shelf；`commit()` 成功后把 `response.word` 写回 `state.all.words`。
- `src/styles/panel.css`：`.ilmt-review-shelf`（12px、muted、nowrap）。

**失败 / 边界处理**
- `state.all === null`（首次 `getState()` 失败或尚未加载）：不渲染 shelf，不显示 0；加载成功后随下一次 `render()` 出现。
- 词库达到 2000 上限（`learning-storage.ts:228-241` 会淘汰最旧的 `mastered`）：数字随之下降。这是真实状态，不补偿、不伪造「历史累计」。
- 撤销：撤销不改变词数；若撤销的是毕业那次提交，`status` 回到 `learning`，shelf 的「已毕业」数应回到撤销前的值（由需求 2 的本地回写 + `undoLast()` 已有的 `await refresh()` 保证）。
- 窄侧栏 300px：最长组合（`已收录 2000 个 · 已毕业 1234 个`，约 220px @12px）单行放得下，不换行、不省略。

---

### 需求 2（P0）毕业有收尾：结束页告诉你「哪个词毕业了」

**用户场景**
一个词跟了用户两个月，今天最后一次复习，他点了「认识」。回执写着「已记录 · 已毕业」，一秒钟后换成「今天没有要复习的词 · 本轮 4 个 · 认识 3」。他其实不知道刚才有哪个词走完了全程，也不知道它以后还会不会出现。这是产品里唯一不可逆的好事，却没有任何一刻属于它。

**期望行为**
1. 面板状态新增本轮内存集合 `graduated: LearningWord[]`（不落库）。`commit()` 成功且 `response.word.status === "mastered"` 时，把 `response.word` 追加进去（按 `id` 去重，保持提交顺序）。
2. 结束页 B（中途结束、还有到期）与 C（今天做完）在**摘要之后、「今天已复习 N 个」之前**渲染 `.ilmt-review-graduated`：
   - 每个词一行 `.ilmt-review-graduated-row`：左侧是**该词自己的收录特效**（静态、不播动画），右侧 `.ilmt-review-graduated-word` 文案 `outlive 毕业了`。
   - 最多展示 3 行；超出的部分渲染 `.ilmt-review-graduated-more`：`还有 ${n} 个也毕业了`。
   - 集合为空时整个 `.ilmt-review-graduated` 不渲染。
3. 特效挂载复用现有约定：`deps.effect(word.mascotId)` + `ensureEffectStyles()`；容器用现有的 `.ilmt-review-scene-stage`（64×58，内部 `scale(.72)`），`animations: false`，`claim` 传永不写库的桩，`announce` 空实现，容器 `aria-hidden="true"`，内部所有 `button` 的 `tabIndex = -1`。
4. 生命周期：每次 `render()` 与 `view.destroy()` 里销毁这些挂载句柄（与现有 `mountedEffect` / `sceneEffect` 同款处理）；挂载抛错时该行只显示文字，不抛错、不挡结束页。
5. 重置点：新挂载、点「继续复习」、切换语言 chip——与 v2 重置 `answered` / `correct` 的位置完全一致（收尾块属于「本轮」，shelf 的数字才是永久的）。
6. 撤销：`undoLast()` 成功后从 `graduated` 里移除该 `id`（如果它是毕业那次）；若因此为空，整个块消失，B/C 页回到 v2 形态。

**可断言的验收标准**

| # | 断言 | 方式 |
| --- | --- | --- |
| 2.1 | box 5 的词提交「认识」（`answer` 返回 `status:"mastered"`、`dueAt:null`）→ 进入结束页；`.ilmt-review-graduated` 存在，文本含 `word1 毕业了`；同一帧 `.ilmt-review-shelf` 为 `已收录 1 个 · 已毕业 1 个` | 单测，`tests/unit/panel-review.test.ts` |
| 2.2 | 普通「认识」（box 0 → 1，`status:"learning"`）→ `.ilmt-review-graduated` 不存在，结束页文本不含「毕业了」 | 单测，同上 |
| 2.3 | 一轮内 4 个词毕业：`.ilmt-review-graduated-row` 恰好 3 个，顺序等于提交顺序，另有 `.ilmt-review-graduated-more` 文本为 `还有 1 个也毕业了` | 单测，同上 |
| 2.4 | B 页场景（结束前仍有 2 个到期词）同样出现毕业行，且既有的「本轮先到这 / 还有 2 个到期 / 继续复习」断言不变 | 单测，同上 |
| 2.5 | 点回执「撤销」撤掉毕业那次提交后：`.ilmt-review-graduated` 消失，shelf 回到 `已收录 1 个`，撤销后重新评级并再次毕业时仍只有 1 行（去重） | 单测，同上 |
| 2.6 | `deps.effect().mount` 抛错：毕业行仍渲染 `.ilmt-review-graduated-word`，无 `[data-ilmt-effect]`，不抛错 | 单测，同上 |
| 2.7 | 毕业行内的特效容器带 `aria-hidden="true"`、内部按钮 `tabIndex === -1`、`mount` 收到的 `animations === false` | 单测，同上 |
| 2.8 | E2E：把唯一的到期词种成 `box:5`，点评级 → 下一张 → 结束页含 `outlive 毕业了`，shelf 含 `已毕业 1 个`，徽标清空 | E2E，`tests/e2e/learning.spec.ts` |

**涉及界面 / 数据位置**
- `src/panel/review.ts`：`ReviewState.graduated`、`commit()`、`undoLast()`、`renderFinish()`、`render()` 的清理、`destroy()`、三处重置点。
- `src/styles/panel.css`：`.ilmt-review-graduated`、`.ilmt-review-graduated-row`、`.ilmt-review-graduated-word`、`.ilmt-review-graduated-more`（复用 `.ilmt-review-scene-stage`，不改特效 CSS、不改 `ClaimEffect` 契约）。
- 不新增字段、不新增消息、不改 `LearningWord`。

**失败 / 边界处理**
- 特效 id 未知（旧 `mascotId` 指向已删特效）：`deps.effect()` 已回退到第一个已注册特效（`review.ts:119-122`），照常显示。
- 一轮毕业超过 3 个：只显示 3 行 + 计数，避免结束页变成列表。
- 毕业后再撤销再毕业：`graduated` 去重，只有一行。
- 结束页 B/C 都已渲染毕业块；A 页（零词）不可能有毕业词，不涉及。
- `继续复习` 后重新开始一轮：毕业块清空（本轮语义），shelf 的「已毕业」保持——这正是「永久的积累 + 一轮的收尾」的分工。
- 结束页关闭：内存态随视图销毁，不落库、不需要迁移。

---

### 需求 3（P0）回来时数字与语气都是真的：今天就是今天，词还在

**用户场景**
第 1 天复习了 4 个词。第 2 天早上打开侧栏，做完了仅有的 1 张卡，结束页写着「今天已复习 4 个」——今天他明明只做了 1 个。另一个场景：出差一周回来，看到的还是「复习 (12)」，界面没有任何一句话告诉他这一周里东西有没有丢、要不要从头开始。

**期望行为**
1. 「今天已复习 N 个」（`review.ts:742`、`:784` 两处）改成按当天口径计算：
   `todayReviewed = state.all.stats.day === localDay(now) ? state.all.stats.todayReviewed : 0`。
   只修正读侧，`applyReviewAnswer` 的懒重置逻辑不动。
2. `src/shared/learning-storage.ts` 导出两个纯函数：
   - `localDay(now: number): string`（把现有私有函数改为导出，行为不变，仍返回本地 `YYYY-MM-DD`）；
   - `daysSinceDay(day: string, now: number): number | null`：解析 `YYYY-MM-DD` 为本地零点，返回与今天零点的整天差；空串、格式非法、非法日期（如 `2026-13-40`）返回 `null`；未来日期返回负数。
3. 复习页在 shelf 之后渲染 `<p class="ilmt-review-return">`，仅在**同时满足**以下条件时出现：
   - `daysSinceDay(stats.day, now) !== null` 且 `>= 3`；
   - 当前有到期词（`dueCount(state.all.words, now) > 0`）。
   文案：
   - `3 ≤ 天数 ≤ 13`：`有 ${天数} 天没见了 · ${words.length} 个词都还在`
   - `天数 ≥ 14`：`有一阵子没见了 · ${words.length} 个词都还在`
4. 自愈：用户做完任意一次复习后，`stats.day` 变成今天 → 下一次 `render()` 时该行消失。不需要「知道了 / 关闭」按钮，不需要本地存储记录「已读」。
5. 不新增字段、不新增存储 key、不新增消息；`stats` 结构不变。

**可断言的验收标准**

| # | 断言 | 方式 |
| --- | --- | --- |
| 3.1 | `localDay` 导出且返回本地 `YYYY-MM-DD`；`daysSinceDay(今天, now) === 0`、`daysSinceDay(昨天, now) === 1`、`daysSinceDay("", now) === null`、`daysSinceDay("2026-13-40", now) === null`、`daysSinceDay(明天, now) === -1`（跨月/跨年各一组） | 单测，`tests/unit/learning-storage.test.ts` |
| 3.2 | `stats.day = 今天`、`todayReviewed = 4`、无到期词：C 页含「今天已复习 4 个」 | 单测，`tests/unit/panel-review.test.ts` |
| 3.3 | `stats.day = 昨天`、`todayReviewed = 4`、无到期词：C 页严格含「今天已复习 0 个」，全文不含「4 个」作为今日计数 | 单测，同上 |
| 3.4 | `stats.day = 昨天`、`todayReviewed = 4`、结束后仍有到期词：B 页同样显示「今天已复习 0 个」 | 单测，同上 |
| 3.5 | `stats.day` 为 5 天前、1 个到期词、库里共 24 个词（含 3 个 mastered）：`.ilmt-review-return` 文本严格为 `有 5 天没见了 · 24 个词都还在`，且它是 `.ilmt-review-shelf` 的下一个兄弟节点（`shelf.nextElementSibling`） | 单测，同上 |
| 3.6 | `stats.day` 为 14 天前：文本严格为 `有一阵子没见了 · 24 个词都还在` | 单测，同上 |
| 3.7 | 边界：`daysSinceDay` 结果 2 → 不渲染；3 → 渲染；`stats.day === ""` → 不渲染；无到期词 → 不渲染；`stats.day` 为未来日期 → 不渲染 | 单测，同上 |
| 3.8 | 提交一次复习（`getState` 返回 `stats.day = 今天`）并 `await view.refresh()` 后，`.ilmt-review-return` 消失，`.ilmt-review-shelf` 仍在 | 单测，同上 |
| 3.9 | E2E：种下 `stats = { day: 5 天前的本地日, todayReviewed: 4 }` + 1 个到期词；打开复习 → `.ilmt-review-return` 含 `有 5 天没见了`；不评级直接点「结束」→ B 页含「今天已复习 0 个」，不含「今天已复习 4 个」 | E2E，`tests/e2e/learning.spec.ts` |

**涉及界面 / 数据位置**
- `src/shared/learning-storage.ts`：导出 `localDay`、新增 `daysSinceDay`（纯函数，无 chrome 依赖）。
- `src/panel/review.ts`：`renderFinish()` 的今日口径；`render()` 插入 `.ilmt-review-return`（条件见上）。
- `src/styles/panel.css`：`.ilmt-review-return`（11px、muted、`margin: 0`、左对齐）。

**失败 / 边界处理**
- 从未复习过（`stats.day === ""`，例如只收录过词）：不显示回归行；C 页「今天已复习 0 个」本来就是真的。
- 时钟回拨 / 时区变化：`daysSinceDay` 用渲染时的 `now` 与本地日期比较，不做缓存；未来日期不显示回归行。天数按两个本地零点之差取整（`Math.round`），避免夏令时把某天算成 23 / 25 小时。
- 跨午夜正在面板里：每次 `render()` 重新取 `now`，两条文案随日切自然变化，不需要定时器。
- `state.all === null`：与 shelf 一致，不渲染回归行。
- 12 天没来、今天又想先看别的：这一行只是陈述，不拦截、不弹窗、不重复提醒；一次复习后彻底消失。

---

## 4. 交互与视觉说明

### 4.1 复习页顶部（需求 1 + 需求 3）

```
┌────────────────────────────────────┐
│           对话        [ 复习 (12) ] │
│                                    │
│ 已收录 24 个 · 已毕业 3 个           │  12px  --ilmt-muted  单行
│ 有 6 天没见了 · 24 个词都还在        │  11px  --ilmt-muted  仅在 gap≥3 且有到期时
│                                    │
│ [ 全部 12 ] [ 英语 10 ] [ 西语 2 ]  │  现有筛选 chip
│ 答案语言                 按单词默认 ▾│
└────────────────────────────────────┘
```

- 两行都在 `overflow-y: auto` 的容器内，滚动时随内容走，不吸顶（不做 sticky，避免变成常驻横幅）。
- 颜色只用现有的 `var(--ilmt-muted)`，不新增颜色变量，深色主题自动成立。
- 两行都是纯文本，不是按钮、不带箭头、不带链接色——它们不邀请操作，只陈述状态。
- `prefers-reduced-motion`：无动画、无过渡，不需要分支。

状态矩阵：

| 情况 | shelf | return |
| --- | --- | --- |
| 零词 | 不渲染 | 不渲染 |
| 有词、有毕业 | `已收录 24 个 · 已毕业 3 个` | 按 gap 与到期数决定 |
| 有词、无毕业 | `已收录 24 个` | 按 gap 与到期数决定 |
| gap < 3 / 从未复习 / 无到期 / 日期非法 | — | 不渲染 |
| 切换语言 chip | 不变（全库口径） | 不变（全库口径） |

### 4.2 结束页（需求 2）

```
C 今天做完了                          B 中途结束
┌──────────────────────────┐        ┌──────────────────────────┐
│   今天没有要复习的词       │        │      本轮先到这           │
│  本轮 4 个 · 认识 3       │        │     还有 2 个到期         │
│                          │        │                          │
│  ┌──┐ outlive 毕业了      │        │  ┌──┐ outlive 毕业了      │
│  └──┘                    │        │  └──┘                    │
│  还有 1 个也毕业了（>3 时）│        │  今天已复习 3 个          │
│                          │        │     [ 继续复习 ]          │
│  今天已复习 4 个          │        └──────────────────────────┘
└──────────────────────────┘
```

- 毕业行左端复用 `.ilmt-review-scene-stage`（64×58），特效以 `scale(.72)` 静态呈现：贴纸猫是彩色的、地鼠停在洞里、猫抱着词、磁铁夹着词——它们各自的 `known` / `settled` 终态就是这个意思。**不播动画、不加音效、不加彩带**。
- 舞台 `aria-hidden="true"`：读屏只读「outlive 毕业了」。信息由文字承担，图形只是装饰。
- 一行 13px 正文色（`var(--ilmt-text)`）；`还有 N 个也毕业了` 用 11px muted。
- 最多 3 行，结束页仍是结束页，不是排行榜。
- 动画开关关闭时行为一致（本来就不播动画，无需额外分支）。

### 4.3 文案汇总

| 位置 | 现在 | v3 |
| --- | --- | --- |
| 复习页顶部 | — | `已收录 24 个 · 已毕业 3 个` / `已收录 24 个` |
| 复习页顶部（久别） | — | `有 6 天没见了 · 24 个词都还在` / `有一阵子没见了 · 24 个词都还在` |
| 结束页毕业区 | — | `outlive 毕业了` + （>3 时）`还有 N 个也毕业了` |
| 结束页今日计数 | 跨日会显示昨天的数量 | `今天已复习 N 个`（N 按当天口径） |

语气约定：不出现「坚持」「连续」「断」「还差」「目标」「别放弃」「终于」；不出现感叹号；不出现红色。

---

## 5. 测试计划

不新增命令，全部跑在现有门禁上：

```bash
npm run verify:delivery   # 单测 + tsc + build + check-build
npm run test:e2e          # headless，含 P0：快捷键/翻译与恢复/popup/复习
```

| 验收点 | 层级 | 具体做法 | 判定 |
| --- | --- | --- | --- |
| 1.1 / 1.2 / 1.3 | 单测 | `panel-review.test.ts` 复用现有 `mount()`：三个词（含 mastered）/ 三个 learning / 空数组各一条；断言 `.ilmt-review-shelf` 的严格文本与存在性 | 逐字相等，A 页既有断言不改仍绿 |
| 1.4 / 1.5 | 单测 | 多语言 fixture 下切 chip；卡片 / B / C 三种状态各断言一次 shelf 文本 | 文本不变、位置在 chip 之前 |
| 1.6 | E2E | `learning.spec.ts` 收录路径末尾打开面板，断言 `.ilmt-review-shelf` 为 `已收录 1 个` | 全绿 |
| 2.1 / 2.2 | 单测 | `mountReview` 注入 `answer` 返回 `status:"mastered"` / `"learning"` 的 word（或复用 `mountStored` + `box:5` 词让 `applyReviewAnswer` 真算）；点到结束页 | 毕业区出现 / 不出现 |
| 2.3 / 2.4 | 单测 | 4 个 `box:5` 词依次提交；另一种场景结束前留 2 个到期词 | 3 行 + `还有 1 个也毕业了`；B 页既有断言语义不变 |
| 2.5 | 单测 | 复用 v2 的 `mountStored`（真实 `undoReviewAnswer`）：毕业 → 撤销 → 再毕业 | 区块消除、shelf 数字回退、去重后 1 行 |
| 2.6 / 2.7 | 单测 | `deps.effect` 返回 `mount` 抛错的 effect / 记录 `animations` 与句柄的 effect；断言文字仍在、`aria-hidden`、`tabIndex=-1`、`animations === false` | 不抛错、属性精确 |
| 2.8 | E2E | `learning.spec.ts`：种 `box:5` + `dueAt` 过去 → 打开面板 → 评级 → 下一张 → 断言结束页毕业行与 shelf、徽标清空 | 全绿 |
| 3.1 | 单测 | `learning-storage.test.ts`：导出的 `localDay` 与新增 `daysSinceDay` 的今天/昨天/明天/空串/非法日期/跨月/跨年（固定 `now`） | 精确相等 |
| 3.2 – 3.4 | 单测 | `panel-review.test.ts`：改造 `state()` 辅助函数支持传入 `stats`；分别断言 C 页与 B 页的今日计数 | 昨天 → 0，今天 → N |
| 3.5 – 3.8 | 单测 | 同上：gap 5 / gap 14 / gap 2 / gap 3 / 空 day / 无到期 / 未来日期 / 提交后 refresh | 文本与渲染条件逐条精确 |
| 3.9 | E2E | `learning.spec.ts`：在 worker 里用本地日期算 5 天前写进 `learning.stats`，打开面板断言回归行；点「结束」断言 B 页为 0 | 全绿 |
| P0 不回退 | E2E | 快捷键 `⌥A/⌥Q/⌥S`、翻译 10/10 + 译文在原文下方 + 恢复、popup provider/model、复习「点评级 → 揭晓 → 下一张写库 → 撤销」 | 与今天一致，全绿 |
| 人工抽查 | 人工 | `opencli ... --window background` 打开面板（300 / 320px）：两行不换行、不压住 chip；深色主题下对比度可读；关闭动效后毕业行仍正常；`prefers-reduced-motion` 下无动画 | 无红色报错，文字不截断 |

既有用例的影响：**既有断言不需要改写**（本轮是纯增量 + 一处读侧口径修正）。两处测试代码的必要改动：`panel-review.test.ts:40` 的 `state()` 辅助函数加一个可选的 `stats` 覆盖参数（不是断言）；1.3 是在既有「guides a brand-new library」用例末尾**追加**一条 `.ilmt-review-shelf` 为 null 的断言。另外，既有 fixture 的 `stats.day`（`"2026-11-12"`）相对固定 `NOW` 是未来日期，3.7 的「未来日期不渲染」正好覆盖它，回归行不会在旧用例里意外出现。若实现过程中发现必须改既有断言，视为设计偏差，先在需求里补理由。

---

## 6. 风险与取舍

### 对 P0 的影响

| P0 项 | 影响 |
| --- | --- |
| 快捷键绑定 | 无（不动 manifest / 命令） |
| 翻译与恢复 | 无（不动 content script / 翻译链路） |
| popup | 无（不动 popup） |
| 复习链路 | **有，且是唯一风险面**：`review.ts` 的 `render()` 顶层结构、`commit()` 成功路径、`renderFinish()` 的节点顺序。三条都只**追加**节点与本地状态，不改「点评级 → 揭晓 → 下一张写库一次」的时序，不改 `review-answer` / `review-undo` 的调用次数。 |

- 新增节点必须放在既有断言的作用域之外：`v2` 的断言都落在 `.ilmt-review-done-title / -summary / -today`、`.ilmt-review-receipt`、`.ilmt-review-grade*` 上，v3 的新类名与它们不重叠。
- 毕业块依赖 `response.word`，而回执已经依赖它（`review.ts:921-931`）——不新增请求、不新增等待。

### 数据结构与兼容

- **本轮不新增字段、不新增存储 key、不改 `LearningState.version`。** `graduated` 只存在于面板内存，关掉侧栏即消失。
- `stats.day` 的旧值：可能为空串（从未复习）、缺失、非法（`parseLearningState` 已归一为 `""`）。三种情况统一按「无回归信息」处理：不显示回归行，今日计数按 0。**不回写、不迁移、不批量修数据。**
- 旧数据（v1 / v2 写入的 `learning`）整体照常加载；v3 读到旧数据时 shelf 直接可用（只用 `words.length` 与 `status`）。
- 反向兼容：v3 写入的 `learning` 与 v2 完全同构，旧版本扩展读到时行为不变。

### 性能

- shelf：每次 `render()` 一次 `words` 遍历（O(n)，n ≤ 2000），微秒级。
- return：一次 `dueCount` 遍历（已在 `buildReviewQueue` 里做过同类扫描）。
- 毕业块：每次结束页 `render()` 最多 3 次静态 `mount()`（内联 SVG，无动画、无定时器），并在 `render()` / `destroy()` 里同步销毁。
- 不新增 `MutationObserver` / `IntersectionObserver` / `setInterval` / 存储监听 / 网络请求。

### 无障碍

- 三个新元素都是纯文本或纯装饰：信息在文字里，不靠颜色、不靠图形。
- 毕业行舞台 `aria-hidden="true"`，内部按钮不可 Tab（`tabIndex=-1`）；读屏只播报「outlive 毕业了」。
- 不使用 `aria-live`：每次提交都播报一次词库数字会变成噪音；已提交的结果由 v2 的回执（`role="status"`）负责播报。
- 无动画，`prefers-reduced-motion` 不需要额外分支；没有自动消失的提示。
- 300px 窄侧栏：两行均为单行短文本，不需要横向滚动。

### 伦理边界（逐条说明为什么不算暗黑模式）

1. **需求 1（词库规模）**：这是「我的东西有多大」，不是「我表现如何」。没有目标值、没有对比对象（不显示别人、不显示历史最佳）、没有「还差 N 个」、没有红黄绿分级、不计时、不推送、不需要点击。它只会因为用户主动收录而变大；唯一的变小来自已有的 2000 词上限淘汰，且那种情况下数字下降是事实，不是惩罚。
2. **需求 2（毕业收尾）**：毕业是 SRS 里**本来就存在**的终态（box 5），不是新发明的奖励；不给积分、不给徽章、不给抽奖、不给概率掉落、不做稀有度、不排名、不分享。它把「一个词走完了」这件事说出来，属于完成感，不属于胜利感。不播动画、不加音效、每次最多 3 行，明确拒绝把结束页做成领奖台。
3. **需求 3（今天与久别）**：
   - 修正「今天已复习 N 个」是把**错误信息改对**，不是加功能；暗黑模式的特征之一是「用夸张的数字制造情绪」，这里做的是相反的事。
   - 回归行说「词都还在」，这是对「你不做就会失去」的**明确否认**：不清零、不惩罚、不要求补课、不给「恢复连续」的任务。它只陈述「上次是哪天、东西还在」，不带祈使句、不带感叹号、不红字、不倒数。
   - 阈值 3 天避免把周末变成事件；14 天以上不给精确天数（「有一阵子」），避免把回归变成清算。
   - 一次复习后立即消失，不需要「知道了」按钮——不留可点痕迹，就不会变成待办。
4. **全局约束**：不新增通知/推送权限；不做排行榜、社交攀比、付费诱导、断签惩罚、倒计时、红点、可变比率抽奖、无限滚动；不把「答对」做成考试（文案里继续使用「认识 / 毕业」，不使用「得分 / 正确率 / 等级」）。

### 取舍

- **为什么放在复习页顶部，而不是 popup 或徽标**：popup 与徽标是「入口 / 提醒」，把积累放进去会把它变成第二个催促。复习页是用户主动来做这件事的地方，成长信息应当与动作同屏。
- **为什么不做「本周复习」**：需要新的按日历史；用每词 10 条截断历史反推会得到会缩水的数字，与 v2 的「说真话」直接冲突。本轮宁可少一个数字，也不引入一个会说谎的数字（见非目标）。
- **为什么「已毕业 0 个」不显示**：0 既是噪音也是一种隐形的目标提示；有毕业才说。
- **为什么毕业不做动画**：动画会把毕业变成演出，演出需要重复、重复就会贬值；静止的角色收着词，信息量已经足够。
- **为什么只显示 3 行**：结束页要能一屏读完；多余的部分用一句话概括。
- **为什么回归行不做「关闭」**：可关闭的提示会留下一个需要管理的对象；这一行的生命周期由真实行为（做一次复习）决定，最干净。

---

## 7. 与 v1 / v2 的关系

v1 的 16 条验收分布在悬停卡、译行 / 配对高亮、段落联动；v2 的 27 条分布在评级后果、撤销回执、结束页三分支。本轮只碰 `src/panel/review.ts`、`src/styles/panel.css` 与 `src/shared/learning-storage.ts` 的导出，**不碰** `src/content/`、`src/shared/prompt.ts`、`src/styles/inject.css`、`src/popup/`、`src/settings/`、`src/shared/srs.ts`。

| v1 / v2 区域 | v3 影响 | 保证方式 |
| --- | --- | --- |
| v1 需求 1：卡片三层 + 始终在视口内（1.1–1.5） | 无 | 不改 `glossary.ts` / `inject.css`；门禁与现有单测照跑 |
| v1 需求 2：译行进卡片 + 译文点亮（2.1–2.6） | 无 | 不改 `prompt.ts`（`FORMAT_VERSION` 仍为 4）、不改 highlight |
| v1 需求 3：段落联动 + banner 文案（3.1–3.5） | 无 | 不改 content 的 pointer 委托与 banner |
| v2 需求 1：三档后果（1.1–1.9） | 无 | `renderGrades()` 一行不碰；`[data-grade]` 结构与文案不变 |
| v2 需求 2：撤销回执（2.1–2.12） | 有（增量） | 只在 `undoLast()` 成功后追加「从 `graduated` 移除」；回执文本、失败分支、焦点、计数回滚一律不动。`learning-storage` 只新增导出，不改 `applyReviewAnswer` / `undoReviewAnswer` |
| v2 需求 3：结束页三分支（3.1–3.6） | 有（增量） | A 页零词：shelf / return / 毕业块都不渲染，既有断言原样通过。B / C 页：只在摘要与「今天已复习」之间插入毕业块；标题、摘要文案、`继续复习` 全部不变。3.2–3.5 的「今天已复习」在测试数据里都是 0，今日口径修正不改变这些断言的结果 |
| P0：快捷键 / 翻译与恢复 / popup | 无 | 不动 manifest、content、popup |
| P0：复习链路 | 有（见 §6） | `learning.spec.ts` 既有 5 条用例必须原样通过；新增用例只追加 |

唯一有意的语义变更：「今天已复习 N 个」在跨日时从「昨天的 N」变成「0」。这不是回归，是 v2 需求的延续（`v2-requirements.md` §3 需求 3 的「按真实情况说话」）。

交付判定：需求 1、2、3 的验收表全部 PASS，且 `npm run verify:delivery` 与 `npm run test:e2e` 的 P0 主流程（快捷键 / 翻译与恢复 / popup / 复习链路）保持通过，才算 v3 交付完成。这是最后一版：不追求更多数字，只要求这三个数字和这一句话都是真的。
