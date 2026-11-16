# v2 需求：复习更符合人性（看得见后果 · 撤得回来 · 结束说真话）

- 日期：2026-11-16
- 迭代：v2 / 3
- 状态：待开发（本轮只出需求，不改代码）
- 前置：v1 已交付并判定 PASS（提交 `8969a5b`，见 `v1-test-report.md`）
- 主题（已定）：**学习与复习更符合人性**
- 一句话：让用户在按下「忘了 / 模糊 / 认识」之前就知道代价、按错之后能撤回、结束时看到的数字是真的。

---

## 1. 观察到的问题

### O1 评级的后果完全不可见，用户只能靠「猜哪个更安全」来点

- 证据：`src/panel/review.ts:573-595` 的 `renderGrades` 只渲染三个词 `忘了 / 模糊 / 认识`，
  没有任何「下次什么时候再见」的信息；`data-grade` 只用于样式与测试选择器。
- 证据：间隔表在 `src/shared/srs.ts:4-11`（10 分钟 / 1 天 / 3 天 / 7 天 / 16 天 / 35 天），
  档位语义在 `src/shared/srs.ts:29-49`：`again` 直接把 box 归零，`hard` 保持 box，`good` 前进一格。
  这套语义只存在于代码里，UI 一个字都没说。
- 证据：`src/shared/srs.ts:68-76` 已有 `formatDueLabel()`，但它在本项目里只被
  `src/background/learning.ts:50` 用来拼 `LearnWordResponse.nextDueLabel`；而唯一消费该响应的地方
  （`src/content/glossary.ts:381-404`）只读 `ok` / `created`，文案从未显示给用户。
  也就是说「下次什么时候」这套能力已经写好了，但用户一次都没见过。
- 证据（现状截图）：`docs/previews/mnemonic/review-scene.png` —— 已评级、已揭晓、`下一张` 就绪，
  但整张卡没有任何「这次选择会把它推到多久以后」的提示。
- 实际行为：v1 之后揭晓一侧已经很厚（释义、多语言、画面钩子、特效演出），**决定一侧反而最薄**：
  用户在信息最少的那一秒做最有后果的选择。诚实成本被隐藏，最省事的做法是永远点「认识」。

### O2 点错就是定局，没有任何撤回入口

- 证据：`src/panel/review.ts:759-799` 的 `commit()`：一次 `review-answer` 成功后立刻
  `state.queue.shift()`（:792）并重渲染，下一张顶上来，上一张无处可回。
- 证据：`src/shared/types.ts:68-76` 的 `ReviewEntry` 只有「评完之后的 box」，
  没有评级前的快照；`src/shared/learning-storage.ts:303-349` 的 `applyReviewAnswer` 是单向覆盖，
  没有逆操作，也没有可回滚的数据。
- 代价是具体的：一个已经到 box 4（16 天）的词，误点「忘了」后 `box` 归 0
  （`src/shared/srs.ts:34-36`），要再连续答对 5 次才回到 16 天档。误点「认识」则把
  10 分钟推到 24 小时，当天就再也不会出现。
- 证据（测试现状）：`tests/unit/panel-review.test.ts:449-467` 只断言「下一张」写库一次，
  没有任何「写错了怎么办」的路径。
- 实际行为：复习是一条不可逆的传送带。用户越怕点错，越倾向点最安全的「认识」。

### O3 「结束」与空状态说的不是真话，也没有第一次使用的引导

- 证据：`src/panel/review.ts:805-815` 的 `endRound()` 把 `queue` 清空后直接 `render()`，
  而 `renderFinish()`（`src/panel/review.ts:640-684`）**无条件**写死标题「今天没有要复习的词」。
  中途结束、还剩 9 个到期词时，标题依然是「今天没有要复习的词」。
- 证据：同一个函数里 `tomorrow`（:650-656）只统计 `dueAt > now && dueAt <= now + 24h`，
  当前已到期但没做的词不计入，于是「明日还有」显示 0，而实际还有一堆。
- 证据：一个词都没收录的新用户看到的也是同一屏：标题「今天没有要复习的词」+
  「本轮 0 个 · 答对 0 · 明日还有 0 个」+「今天已复习 0 个」，没有任何「词从哪来」的说明。
  该行为被 `tests/unit/panel-review.test.ts:123-129` 锁死（断言含「今天没有要复习的词」「本轮」）。
- 证据：`src/panel/review.ts:791` 把「自评认识」记进 `correct`，`:659` 又把它写成「答对」。
  自评不是判卷，「答对 N」在语义上是一次误报，也在语气上把复习变成考试。
- 实际行为：中途退出后回到结束页会被「今天没有要复习的词」误导（只有一个小按钮「继续复习」暗示还有活），
  新用户则完全不知道下一步该做什么。

---

## 2. 本轮目标与非目标

### 目标

1. 评级当下就能看到三档各自的下次复习时间，让「诚实」变得便宜（O1）。
2. 刚提交的那一张可以撤回一次，撤回后队列、计数、到期时间都回到提交前（O2）。
3. 结束页与空状态按真实情况说话：还剩几张、今天做完没有、一个词都没有时怎么做第一步（O3）。

### 非目标（本轮明确不做，防扩写）

- 不改 SRS：`INTERVALS_MS`、`MAX_BOX`、`applyGrade` 的判定一律不动；不改档位数量与名称
  （仍是 `忘了 / 模糊 / 认识`），不把三档改成二选一，不新增第四档。
- 不改揭晓：评级后展开答案、可改判、只写一次库、四选一锁定、画面钩子与特效演出全部保持
  （`2026-11-12-review-reveal-after-grade-design.md`、`2026-11-16-review-mnemonic-scene-design.md`）。
- 不做多次撤销：撤销深度固定为 1（只撤「刚提交、还没提交下一张」的那一张），不做撤销栈、不做跨会话撤销。
- 不做排行榜、社交、付费引导、断签惩罚、倒计时/进度条焦虑化；不加任何「还剩 X 天」的催促。
- 不做「跳过这张」、不做「稍后再复习」、不做手动调间隔。
- 不改复习 tab 的计数口径（仍是「现在到期」的数量，`src/panel/main.ts:349-358`），不改 popup、设置页、
  快捷键、翻译链路、悬停卡、收录特效。
- 不新增依赖、不改 manifest、不动构建；不写新的存储 key（`learning` 之外一律不加）。

### 优先级与实现顺序

三条需求互相独立判定，但都落在 `src/panel/review.ts`，**必须按 1 → 3 → 2 顺序、由同一个开发 agent
串行完成**，避免同文件冲突。需求 2 是唯一会碰 `shared/` 与 `background/` 的一条，放最后。

---

## 3. 需求

### 需求 1（P0）三档评级各自标出「下次什么时候再见」

**用户场景**
读到 `outlive`，心里清楚自己只是想不起来，但「忘了」看起来像认输、又不知道按下去会怎样，
于是手指落在最安全的「认识」上。系统因此以为你记住了，把下一次复习推到 24 小时后——而其实你并没有。

**期望行为**
1. `src/shared/srs.ts` 新增纯函数 `previewDueLabel(word, grade, now): string`：
   内部调用 `applyGrade(word, grade, now)`，再用 `formatDueLabel(result.dueAt, now)` 返回文案。
   **不复制间隔表、不改 SRS**。
2. 每个评级按钮变成两行：第一行是档位词（`忘了` / `模糊` / `认识`，不改），第二行是该档位对应的
   `previewDueLabel` 结果（`10 分钟后` / `明天` / `3 天后` / `7 天后` / `16 天后` / `35 天后` / `已毕业`）。
3. 三个按钮的第二行**同时可见**（不是只在悬停或选中时出现），让用户在没有点下去之前就能横向比较。
4. 评级行下方固定一行浅色说明：`数字是下次见到它的时间`（11px，`--ilmt-muted`，居中）。
5. 选中/改判/提交中：三个按钮的第二行始终保留，不闪、不消失；`aria-pressed`、`.is-active`、
   `data-grade` 属性与现有语义完全不变。
6. 四选一卡没有三档按钮，改在「下一张」上方显示同样的后果：`记为认识 · 明天再见`
   （`记为${档位词} · ${previewDueLabel}再见`；`已毕业` 时不加「再见」）。
7. 纯预览：算出来的值不写库、不改 `word.box`、不触达 background。

**可断言的验收标准**

| # | 断言 | 方式 |
| --- | --- | --- |
| 1.1 | box 0、`dueAt` 已过：`previewDueLabel(word,"again",now)="10 分钟后"`、`"hard"="10 分钟后"`、`"good"="明天"` | 单测，`tests/unit/srs.test.ts` |
| 1.2 | box 2：`again="10 分钟后"`、`hard="3 天后"`、`good="7 天后"`；box 4：`good="16 天后"` | 单测，同上 |
| 1.3 | box 5（手工构造）：`good="已毕业"`，`applyGrade` 返回 `dueAt:null`、`status:"mastered"` | 单测，同上 |
| 1.4 | `previewDueLabel` 不修改传入的 word 对象（深比较前后一致），也不调用 `chrome.storage` | 单测，同上 |
| 1.5 | 渲染后 `[data-grade="again"]` 的文本包含「忘了」与「10 分钟后」；`[data-grade="hard"]` 含「模糊」与当前 box 间隔；`[data-grade="good"]` 含「认识」与该词下一格间隔；三者第 2 行同时存在 | 单测，`tests/unit/panel-review.test.ts` |
| 1.6 | 评级行下方存在 `.ilmt-review-grade-note`，文本为「数字是下次见到它的时间」，只出现一次 | 单测，同上 |
| 1.7 | 点「认识」进入 graded、再点「模糊」改判后，三个按钮的第二行仍各自存在，且 `answer` 一次都没被调用 | 单测，同上 |
| 1.8 | 四选一卡作答后，`.ilmt-review-next` 之前存在 `.ilmt-review-next-note`，文本为 `记为认识 · 明天再见`（答错时为 `记为忘了 · 10 分钟后再见`） | 单测，同上 |
| 1.9 | E2E：进入复习后，`.ilmt-review-grade[data-grade="good"]` 文本含「明天」；点它后仍含「明天」；点「下一张」后 `box` 仍为 1（既有断言不变） | E2E，`tests/e2e/learning.spec.ts` |

**涉及界面 / 数据位置**
- 纯函数：`src/shared/srs.ts`（`previewDueLabel`，复用 `applyGrade` + `formatDueLabel`）
- 渲染：`src/panel/review.ts`（`renderGrades`、`renderNext` / `renderSpot`）
- 样式：`src/styles/panel.css`（`.ilmt-review-grade` 两行布局、`.ilmt-review-grade-note`、`.ilmt-review-next-note`）

**失败 / 边界处理**
- `word.box` 非法（非数字）：`applyGrade` 已有 `clampBox` 兜底（`src/shared/srs.ts:51-54`），文案照常出。
- 跨午夜：预览用的是渲染时的 `now`，文案按「分钟 / 小时 / 明天 / N 天」自然滚动，不缓存。
  分钟级文案（如「10 分钟后」）在卡片上停留不超过一次复习，不存在「显示 9 分钟后」的抖动问题。
- 极窄侧栏（≤ 300px）：第二行 `11px`、不换行、`text-overflow` 不需要——最长文案「35 天后」4 个字符宽约 44px，
  三列各约 90px，放得下；`min-height` 由 44px 提到 48px 以容纳两行，仍满足触控目标。
- 深色主题：第二行用 `var(--ilmt-muted)`，不新增颜色变量。
- `已毕业` 分支：正常队列里不会出现（box 5 的词已是 `mastered`，`buildReviewQueue` 只收
  `status === "learning"`），但分支保留并用单测锁住，防止以后改调度时文案缺一档。
- `prefers-reduced-motion`：本轮不新增动画，无需分支。

---

### 需求 2（P0）刚提交的那一张可以撤回一次，提交后回执说清「下次什么时候」

**用户场景**
连着复习到第 6 张，手快点完「认识」再点「下一张」，才发现刚才那个词其实没想起来。
它现在的到期时间已经被推到明天，今天的复习里再也不会出现——除了等，没有任何补救。

**期望行为**
1. 提交成功后，在容器顶部（筛选条之下、卡片/结束页之上）出现一行回执 `.ilmt-review-receipt`：
   `已记录 · 明天再见` + 一个文字按钮 `撤销`。
   文案规则：`已记录 · ${formatDueLabel(response.word.dueAt, now)}${dueAt === null ? "" : "再见"}`，
   即 `10 分钟后再见` / `明天再见` / `3 天后再见` / `已毕业`。
2. 回执只保留**最后一张**：提交下一张时被替换；点「撤销」后消失；点「继续复习」重新开始一轮时清空。
   点「结束」**不清空**（结束前若已评级会先提交，回执正是那一张的）；整个侧栏页关闭后自然消失。
   没有倒计时、没有「还能撤销 5 秒」的催促。
3. 撤销走新消息 `{ type: "review-undo", id }`，由 background 复原到评级前的状态：
   - `ReviewEntry` 增加可选快照 `before?: ReviewSnapshot`
     （`{ box, dueAt, status, reviewsCount, correctCount, checksSinceSpot }`），
     由 `applyReviewAnswer` 在写新条目时从**评级前**的 word 上抄下来；
     同时把**上一条** entry 的 `before` 删掉，保证每个词最多只在最后一条上留一份快照（体积有界，撤销深度 1）。
   - `undoReviewAnswer(state, {id}, now)`：要求该词存在、`reviews` 非空、最后一条 entry 带 `before`、
     且 `now - entry.at <= 10 分钟`；满足则弹出最后一条 entry、把 `before` 的六个字段写回 word、
     `reviewsCount` 等计数一并复原；若 `entry.at` 与 `now` 是同一个本地日，`stats.todayReviewed` 减 1。
   - 失败原因（可断言）：`unknown-word` / `not-latest`（没有可撤的条目）/ `unsupported`（旧数据没有 `before`）/
     `too-old`（超过 10 分钟）。
4. 撤销成功后 badge 立刻刷新（复用 `refreshBadge()`），复习 tab 的 `复习 (N)` 重新出现。
5. 面板侧：成功后清空回执、回滚本轮计数（`answered -= 1`；被撤的那一档是 `good` 时 `correct -= 1`，
   两者都不小于 0），并把该词 id 记进本轮的面板本地集合 `suppressedSpot`（不落库，仅本轮有效；
   本轮不再对它出四选一，避免重问刚答过的题）。
   队列由既有的 `load()` 从存储重建（`src/panel/review.ts:707-742`），不手工插队；
   回到的那张卡是 idle 态（答案收起、三档可点），用户重新选。
   若撤销发生在结束页（`state.ended === true`），先 `state.ended = false` 再 `refresh()`，
   让被撤的词回到队列、结束页消失；**不要**走「继续复习」的计数重置，保留上面已回滚的值。
   提交中（`state.busy`）禁用「撤销」，避免与写库交错。
6. 撤销失败分两种，说清楚能不能再试：
   - 终态（`too-old` / `unsupported` / `not-latest` / `unknown-word`）：回执文案改为 `这张改不回来了`，
     **移除**撤销按钮，不再邀请重试；队列与计数不变。
   - 暂时性（`undo` 抛错，或返回 `{ok:false}` 且没有 reason）：文案 `撤销失败 · 再试一次`，按钮保留，
     队列与计数不变。
7. 焦点：撤销成功后把焦点移到 `.ilmt-review-card`（`tabindex="-1"`），键盘用户不会掉回页面顶部。

**可断言的验收标准**

| # | 断言 | 方式 |
| --- | --- | --- |
| 2.1 | `applyReviewAnswer` 写入的 entry 带 `before`，且 `before` 六个字段等于评级前的 word；同一个词再次提交时，旧 entry 的 `before` 已被移除（每个词最多一份） | 单测，`tests/unit/learning-storage.test.ts` |
| 2.2 | `undoReviewAnswer` 后 word 的 `box/dueAt/status/reviewsCount/correctCount/checksSinceSpot` 与评级前逐字段相等，`reviews` 长度减 1；同一本地日 `stats.todayReviewed` 减 1 | 单测，同上 |
| 2.3 | 撤销边界：id 不存在 → `unknown-word`；`reviews` 为空 → `not-latest`；最后一条无 `before`（旧数据形态）→ `unsupported`；`entry.at` 距今 > 10 分钟 → `too-old`；四种都不改存储 | 单测，同上 |
| 2.4 | `parseLearningState` 读入带合法 `before` 的 entry 时保留它；`before` 字段缺失或类型错（如 `box:"1"`）时只丢掉 `before` 不丢 entry，word 仍可用；旧数据（完全没有 `before`）整体照常加载 | 单测，同上 |
| 2.5 | background：`{type:"review-undo", id}` 返回 `{ok:true, word}` 并落库；`isLearningMessageType("review-undo")` 为 true | 单测，`tests/unit/learning-messages.test.ts` |
| 2.6 | 面板：点「下一张」成功后出现 `.ilmt-review-receipt`，文本含 `已记录` 与 `明天再见`，内含一个可点按钮「撤销」 | 单测，`tests/unit/panel-review.test.ts` |
| 2.7 | 面板：点「撤销」只调用一次 `undo({type:"review-undo", id})`；成功后回执消失、`.ilmt-review-progress` 从 `2 / 2` 回到 `1 / 2`、当前卡又是刚才那个词、`document.activeElement` 是 `.ilmt-review-card` | 单测，同上 |
| 2.8 | 面板：`undo` 返回 `{ok:false}`（无 reason，模拟网络/存储异常）时回执保留、文案含「撤销失败」、按钮仍可点、进度数字不变、`answer` 不再被调用 | 单测，同上 |
| 2.9 | E2E：点「下一张」后 `box` 变 1、`dueAt` 后移；点回执里的「撤销」后 `box` 回到 0、`dueAt` 回到评分前、`复习 (1)` 重新出现，且没有产生第二个词 | E2E，`tests/e2e/learning.spec.ts` |
| 2.10 | 撤销回来的是四选一卡时：该卡以 idle 态重现（`.ilmt-review-option` 为 0、`.ilmt-review-grade` 为 3），本轮不再重问同一道题 | 单测，`tests/unit/panel-review.test.ts` |
| 2.11 | 面板：`undo` 返回 `{ok:false, reason:"too-old"}`（或 `unsupported` / `not-latest` / `unknown-word`）时回执文案为「这张改不回来了」、撤销按钮消失、进度数字不变 | 单测，同上 |
| 2.12 | 面板：在结束页点「撤销」成功后，结束页消失、当前卡是被撤的那个词（idle 态），本轮 `answered` 保持回滚后的值（不重置为 0） | 单测，同上 |

**涉及界面 / 数据位置**
- 类型：`src/shared/types.ts`（`ReviewSnapshot`、`ReviewEntry.before?`、`ReviewUndoMessage`、`ReviewUndoResponse`）
- 存储：`src/shared/learning-storage.ts`（`applyReviewAnswer` 写快照与清理旧快照、`parseReviews` 解析 `before`、
  新增 `undoReviewAnswer`）
- 消息：`src/background/learning.ts`（`LEARNING_TYPES` 加 `review-undo`、新增 `case`）
- 面板：`src/panel/review.ts`（`ReviewDeps.undo`、`state.receipt`、回执渲染、撤销处理、计数回滚、焦点）
- 样式：`src/styles/panel.css`（`.ilmt-review-receipt`、`.ilmt-review-receipt-undo`）

**失败 / 边界处理**
- 旧数据（没有 `before`）：回执照常显示，点「撤销」得到 `unsupported` → 终态文案「这张改不回来了」，
  按钮移除；不崩、不丢数据。已存储的 entry 不会被重写补齐（不做迁移）。
- 面板关闭 / 切到「对话」tab 再回来：`mountReview` 未销毁时回执仍在；整页关闭后回执消失，
  撤销只在本轮内有效——这是有意的克制，不做跨会话撤销。
- 撤销后再点「下一张」：正常写入一条新 entry（旧的已被弹出，不会重复计数）。
- 撤销写库失败（`chrome.storage` 异常）：同 2.8 的失败路径，不回滚 UI 计数。
- 并发：`runLearningUpdate` 已串行化写入（`src/background/storage-queue.ts`），撤销与下一次提交不会交叉。
- 存储体积：每词最多 1 份快照（约 90 字节），2000 词上限即约 180KB 增量，远低于 `storage.local` 配额。

---

### 需求 3（P0）结束页与空状态按真实情况说话

**用户场景**
早上点开「复习 (12)」，做了 3 张就按「结束」去开会。结束页写着「今天没有要复习的词」，
第二天回来才发现还有 9 张积压。第一次用扩展的人则看到三个 0 和一句同样的「今天没有要复习的词」，
不知道如何开始。

**期望行为**
`renderFinish()` 按三种真实情况分支，文案固定如下：

| 情况 | 判定 | 标题 | 摘要 | 其他 |
| --- | --- | --- | --- | --- |
| A 一个词都没有 | `words.length === 0` | `还没有收录的词` | `翻译一页英文，把鼠标移到浅灰标记的词上，点卡片里的角色就能收进来。` | 末尾一行 `翻译当前页：⌥A`；不显示「本轮 / 认识 / 明日还有 / 今天已复习」 |
| B 主动结束且还有到期 | `state.ended && remaining > 0` | `本轮先到这` | `还有 ${remaining} 个到期` | `今天已复习 ${todayReviewed} 个`；`继续复习` 按钮 |
| C 今天真的做完了 | 其余 | `今天没有要复习的词` | `answered > 0` 时：`本轮 ${answered} 个 · 认识 ${correct}`，`tomorrow > 0` 时再接 ` · 明日还有 ${tomorrow} 个`；`answered === 0` 时：只在 `tomorrow > 0` 时显示 `明日还有 ${tomorrow} 个`，否则不显示摘要行 | `今天已复习 ${todayReviewed} 个` |

1. `remaining` = 结束后**真正还没做**的到期词数。为保证不是陈旧快照上的数字：
   `endRound()` 在提交完当前选择后，先 `await deps.getState()` 刷新一次 `state.all`
   （显式点「结束」才多一次本地读，无网络、无轮询），再置 `state.ended`、清空队列、渲染结束页；
   `remaining` 用刷新后的 `state.all.words` 按 `isDue(word, now)` 统计（`src/shared/srs.ts:56-58`），
   不再用「24 小时内到期」那一套来近似。`todayReviewed` 同样取刷新后的 `stats`。
2. 计数文案把「答对」改为「认识」（`本轮 N 个 · 认识 M`），因为三档是自评，不是判卷；
   `state.correct` 的统计口径不变（仍是 `grade === "good"` 与四选一答对）。
3. 情况 B 不显示「明日还有」，避免拿一个不确定的数字盖住确定的「还有 N 个」。
4. 「继续复习」的行为不变（重置本轮计数并重新拉队列，`src/panel/review.ts:669-681`）。
5. 不写库、不新增存储字段；只把「结束」时读到的最新快照放进内存里的 `state.all`。

**可断言的验收标准**

| # | 断言 | 方式 |
| --- | --- | --- |
| 3.1 | 零词：`.ilmt-review-done-title` 为「还没有收录的词」，文本含「浅灰」与「⌥A」，不含「本轮」「答对」「明日还有 0」 | 单测，`tests/unit/panel-review.test.ts` |
| 3.2 | 主动结束且还有 2 个到期：标题为「本轮先到这」，文本含「还有 2 个」，**不含**「今天没有要复习的词」，`继续复习` 存在 | 单测，同上 |
| 3.3 | 队列空但有 1 个词明天到期：标题为「今天没有要复习的词」，文本含「明日还有 1 个」 | 单测，同上 |
| 3.4 | 本轮做了 2 张、其中 1 张「认识」：摘要为 `本轮 2 个 · 认识 1 · …`，全文不含「答对」 | 单测，同上 |
| 3.5 | `answered === 0` 且无到期词：不出现「本轮」前缀，不出现「明日还有 0 个」 | 单测，同上 |
| 3.6 | E2E：唯一的到期词做完后，结束页含「今天没有要复习的词」，且不含「答对」 | E2E，`tests/e2e/learning.spec.ts` |

**涉及界面 / 数据位置**
- `src/panel/review.ts`（`renderFinish`、`endRound` 的一次 `deps.getState()` 刷新）
- 复用 `src/shared/srs.ts` 的 `isDue`（只读，不改）
- 样式沿用现有 `.ilmt-review-done-*`，不新增类名（情况 A 的提示行复用 `.ilmt-review-done-today`）

**失败 / 边界处理**
- `state.all === null`（首次加载失败）：按零词处理，显示情况 A 的引导文案，不显示错误。
- 结束页是点「结束」那一刻的快照，不随后台写入自动刷新（没有定时器）；点「继续复习」后才重新计算。
- 跨午夜：`stats.todayReviewed` 的日切由 `applyReviewAnswer` 处理，本轮已提交的 `answered` 仍属「本轮」，
  标题文案不区分日期，不会出现负数。
- 与需求 2 共存：回执位于结束页**上方**（撤销对最后一张有效，按钮在回执里），
  结束页主体内不出现第二个撤销入口。

---

## 4. 交互与视觉说明

### 4.1 评级行（需求 1）

```
┌──────────────┬──────────────┬──────────────┐
│    忘了      │    模糊      │    认识      │   第 1 行 14px，颜色沿用现状
│  10 分钟后   │   3 天后     │   7 天后     │   第 2 行 11px，#6e7781（--ilmt-muted）
└──────────────┴──────────────┴──────────────┘
            数字是下次见到它的时间               11px，居中，--ilmt-muted
```

- 按钮 `min-height` 由 44px 提到 48px，两行间距 2px；第 1 行保持原字号与语义色
  （`again` 用 `--ilmt-danger`、`good` 用 `--ilmt-accent`），第 2 行**统一用 muted**，
  不让「忘了」看起来比别的更可怕。
- 选中态只体现在边框与底色（`.is-active` / `aria-pressed`），不改变第 2 行。
- 状态：
  - idle / graded：三个按钮都显示第 2 行；
  - busy（提交中）：`disabled` 置灰，但两行文字都在，不塌陷；
  - 四选一卡：不出现评级行，改在「下一张」上方出现一行 `.ilmt-review-next-note`
    （11px，居中，muted）：`记为认识 · 明天再见`。

### 4.2 回执（需求 2）

```
┌────────────────────────────────────────────┐
│ 已记录 · 明天再见                    撤销   │   13px / 12px；底色 rgba(45,212,191,.08)
└────────────────────────────────────────────┘
```

- 位置：筛选条之下、卡片或结束页之上，占一整行；出现/消失都是瞬时的，不做淡出（避免「来不及看清」的焦虑）。
- 语义：`role="status"`，`aria-live="polite"`，读屏播报「已记录 · 明天再见」。
- 「撤销」是文字按钮（下划线，`28px` 高，沿用 `button:focus-visible` 的青色描边），
  位于回执的右端，不抢视线；不出现任何倒计时。
- 三种文案：`已记录 · 10 分钟后再见` / `已记录 · 明天再见` / `已记录 · 已毕业`；
  失败态两种：终态 `这张改不回来了`（无撤销按钮）、暂时性 `撤销失败 · 再试一次`。

### 4.3 结束页（需求 3）

```
A 一个词都没有                 B 中途结束                  C 今天做完了
┌────────────────────┐      ┌────────────────────┐      ┌────────────────────┐
│  还没有收录的词      │      │    本轮先到这       │      │ 今天没有要复习的词  │
│ 翻译一页英文，把鼠标  │      │   还有 9 个到期     │      │ 本轮 3 个 · 认识 2 │
│ 移到浅灰标记的词上，  │      │  今天已复习 3 个    │      │  · 明日还有 1 个   │
│ 点卡片里的角色就能收  │      │                    │      │ 今天已复习 3 个    │
│ 进来。              │      │   [ 继续复习 ]      │      │                    │
│ 翻译当前页：⌥A       │      └────────────────────┘      └────────────────────┘
└────────────────────┘
```

- 三种情况都不出现感叹号、不出现「坚持」「连续」类措辞、不出现负数或红字。
- 情况 A 的一段话是唯一的引导，长度不超过 40 字，不换行成三条 bullet。
- 情况 B / C 的「继续复习」只出现在 B（C 里没有可继续做的到期词；与现状一致）。

### 4.4 文案汇总

| 位置 | 现在 | v2 |
| --- | --- | --- |
| 评级按钮 | `忘了 / 模糊 / 认识` | 两行：`忘了` + `10 分钟后` 等 |
| 评级行说明 | — | `数字是下次见到它的时间` |
| 四选一「下一张」上方 | — | `记为认识 · 明天再见` |
| 提交回执 | — | `已记录 · 明天再见` + `撤销` |
| 结束页标题（还有到期） | `今天没有要复习的词` | `本轮先到这` |
| 结束页标题（零词） | `今天没有要复习的词` | `还没有收录的词` |
| 本轮摘要 | `本轮 N 个 · 答对 M · 明日还有 K 个` | `本轮 N 个 · 认识 M · 明日还有 K 个` |

---

## 5. 测试计划

不新增命令，全部跑在现有门禁上：

```bash
npm run verify:delivery   # 单测 + tsc + build + check-build
npm run test:e2e          # headless，含 P0：快捷键/翻译与恢复/popup/复习
```

| 验收点 | 层级 | 具体做法 | 判定 |
| --- | --- | --- | --- |
| 1.1–1.4 | 单测 | 扩 `tests/unit/srs.test.ts`：box 0/2/4/5 × 三档的 `previewDueLabel` 文案；调用前后 word 不变 | 文案逐字相等，纯函数无副作用 |
| 1.5–1.8 | 单测 | `panel-review.test.ts`：断言三个 `[data-grade]` 的第二行、说明行、改判后仍在、四选一的 `.ilmt-review-next-note` | 选择器 `data-grade` 不变，既有用例不改 |
| 1.9 | E2E | `learning.spec.ts`：复习卡上 `[data-grade="good"]` 含「明天」；`box` 0 → 1 的既有断言语义不变 | 全绿 |
| 2.1–2.4 | 单测 | `learning-storage.test.ts`：快照写入与旧快照清理、撤销后逐字段复原、四种失败原因、`before` 的解析容错 | 逐字段 `toEqual`，失败原因精确 |
| 2.5 | 单测 | `learning-messages.test.ts`：`review-undo` 走通并落库；`isLearningMessageType` 认这个类型 | 存储里 box 复原 |
| 2.6–2.8、2.10–2.12 | 单测 | `panel-review.test.ts`：注入 `undo` 桩，断言回执文本、只调一次、计数回滚、焦点、两种失败态、结束页撤销后继续本轮；四选一撤销后回到 idle | 进度 `2 / 2 → 1 / 2` |
| 2.9 | E2E | `learning.spec.ts`：`box 0 → 1 → 撤销 → 0`，`dueAt` 复原，`复习 (1)` 重新出现，词数仍为 1 | 全绿，无重复词 |
| 3.1–3.5 | 单测 | `panel-review.test.ts`：改写现有「queue 为空」用例为三种情况各一条；3.2 的 `getState` 桩要可变（结束后返回「1 张已推到明天、2 张仍到期」） | 文案逐字断言 |
| 3.6 | E2E | `learning.spec.ts`：结束页含「今天没有要复习的词」、不含「答对」 | 全绿 |
| P0 不回退 | E2E | 快捷键 `⌥A/⌥Q/⌥S`、翻译 10/10 + 在原文下方 + 恢复、popup provider/model、复习「点评级 → 揭晓 → 下一张写库」 | 与今天一致，全绿 |
| 人工抽查 | 人工 | `opencli ... --window background` 打开 `article.html`，按用户自己的节奏走一次复习（agent 不注入按键）；窄侧栏看两行按钮是否挤 | 无红色报错；文字不截断 |

需要随本轮改动的既有用例（有意变更，不算回归）：

- `tests/unit/panel-review.test.ts:123-129`「shows the finish card when the queue is empty」：
  该用例的 `mount([])` 是**零词**，v2 后应断言「还没有收录的词」，并另加「有词但没到期」的用例断言
  「今天没有要复习的词」（见 3.1 / 3.3）。
- 其余既有复习用例（揭晓、改判、下一张写库、四选一锁定、继续复习）不需要改：
  评级按钮仍带 `data-grade`，`aria-pressed` 语义不变。

---

## 6. 风险与取舍

### 对 P0 的影响

| P0 项 | 影响 |
| --- | --- |
| 快捷键绑定 | 无（不动 manifest / 命令） |
| 翻译与恢复 | 无（不动 content script / 翻译链路） |
| popup | 无（不动 popup） |
| 复习链路 | **有，且是本轮唯一的风险面**：`review.ts` 的评级渲染与提交后流程、`learning-storage` 的 entry 形状、background 的消息分发。`learning.spec.ts` 现有的「点评级后 box 仍为 0、下一张后 box 变 1」是不变量，需求 1 只加显示、需求 2 只在提交**之后**追加一条可选路径，两者都不改这条主线的写入次数与时序。 |

- 撤销入口必须晚于写库成功：只有拿到 `{ok:true, word}` 才显示回执，写库失败仍然停在原卡（现有行为）。
- 撤销不得影响「一次复习恰好一次 `review-answer`」：撤销是独立消息，不复用 `review-answer`，
  也不会在 `commit()` 内部被触发。

### 数据迁移

- `LearningState.version` 保持 `1`；`ReviewEntry` 只是**新增可选字段** `before`。
- 旧数据：`parseReviews` 缺字段时照常解析，`before` 缺失即「不可撤销」，不回写、不补齐、不批量迁移。
- 新数据被旧版本扩展读到：未知字段被忽略，SRS 行为不变（向前/向后都安全）。
- 体积：每词最多 1 份快照（约 90 字节），2000 词约 180KB，且在 `MAX_REVIEWS = 10` 的既有上限内。

### 性能

- 需求 1：每次渲染多 3 次 `applyGrade` 纯函数调用（微秒级），不新增监听器、定时器或请求。
- 需求 2：一次撤销 = 一次 `storage.local.get` + `set` + 一次 badge 刷新，与一次收录同级。
- 需求 3：一次数组遍历（`isDue`）；点「结束」时多一次 `deps.getState()`（本地 storage 读，显式动作触发）。
- 三处都没有新增 `MutationObserver` / `IntersectionObserver` / `setInterval`。

### 无障碍

- 评级按钮的可访问名会变成「忘了 10 分钟后」，因为两行文字都在按钮内部；不另加 `aria-label`
  （否则会盖掉可见文字）。
- 第二行不靠颜色传达信息（时间本身是文字），色弱用户同样可读。
- 回执用 `role="status"` + `aria-live="polite"`；撤销是真正的 `<button>`，可 Tab 到。
- 撤销后焦点回到卡片（`tabindex="-1"`），键盘用户不会被扔回页面顶部。
- 不新增动画，`prefers-reduced-motion` 无需额外分支；不出现闪烁或自动消失的回执。

### 取舍

- **多一行字换来的密度**：评级行从 3 个词变成 3 个词 + 3 个时间 + 1 行说明。窄侧栏里更密，但换来的是
  「敢诚实点」——这是本轮唯一愿意用密度换的东西。若实测过挤，优先砍说明行（1.6），不砍时间。
- **第 0 格时「忘了」与「模糊」都是「10 分钟后」**：这是 SRS 的真实语义（`hard` 保持 box 0），
  不为好看去改间隔表或隐藏其中一档。用户看到「模糊」没带来更长间隔，会自然学会区分。
- **撤销深度只做 1**：做撤销栈要引入「已提交历史回滚」的一致性问题（跨卡、跨轮、跨设备），
  而误点的窗口只有几秒。用「一条回执 + 一次撤销」把复杂度锁死在可控范围。
- **不做跨会话撤销**：关闭面板后不提供撤销，符合现有「未提交即不记账、提交即定稿」的 fail-closed 原则。
- **10 分钟撤销窗口是防御性上限**，不是 UI 倒计时，用户看不到它。
- **结束页不再讨好**：情况 B 会明确告诉用户「还有 9 个到期」，这比现状更「有压力」，但压力来自事实而非
  装饰，并且同时给了「继续复习」的出口。不做断签、不做红点、不做催促文案。

---

## 7. 与 v1 的关系

v1 的 16 条验收标准（`v1-test-report.md` §2）分布在悬停卡、译行/配对高亮、段落联动三块，
本轮**完全不碰** `src/content/`、`src/shared/prompt.ts`、`src/styles/inject.css`，因此：

| v1 区域 | v2 影响 | 保证方式 |
| --- | --- | --- |
| 需求 1：卡片三层 + 始终在视口内（1.1–1.5） | 无 | 不改 `glossary.ts` / `inject.css`；`npm run verify:delivery` + 现有单测照跑 |
| 需求 2：译行进卡片 + 译文点亮（2.1–2.6） | 无 | 不改 `prompt.ts`（`FORMAT_VERSION` 仍为 4）、不改 highlight 注册 |
| 需求 3：段落联动 + banner 文案（3.1–3.5） | 无 | 不改 `main.ts` 的 pointer 委托与 banner |
| P0：快捷键 / 翻译与恢复 / popup | 无 | 不动 manifest、content、popup |
| P0：复习链路 | 有（见 §6） | `learning.spec.ts` 既有 4 条用例必须原样通过；新增撤销用例只追加、不改旧断言 |

唯一有意变更的既有测试是 `panel-review.test.ts` 的空状态用例（零词 → 「还没有收录的词」），
已在 §5 写明理由：v1 的那条用例锁定的正是 O3 的错误文案。

交付判定：需求 1、2、3 的验收表全部 PASS，且 `npm run verify:delivery` 与 `npm run test:e2e`
的 P0 主流程（快捷键 / 翻译与恢复 / popup / 复习链路）保持通过，才算 v2 交付完成。
