# v2 测试报告：复习更符合人性（看得见后果 · 撤得回来 · 结束说真话）

- 日期：2026-11-16
- 被测提交：`5f6e13c` — `feat: show grade consequences, allow one undo, and tell the truth at the end`
- 需求：`docs/product/iterations/v2-requirements.md`
- 规则：`AGENTS.md`、`docs/delivery-verification.md`
- v1 基线：`docs/product/iterations/v1-requirements.md` + `v1-test-report.md`（提交 `8969a5b`）
- 测试方式：独立验证（自写断言脚本，不引用开发新增用例的期望值）+ 复跑官方门禁
- 结论：**PASS**（3 条需求 / 27 条验收标准全部通过；P0 主流程与 v1 的 16 条验收无回退）

> 测试 agent 未修改源码、未修改需求文档、未提交、未推送。临时脚本与日志在
> `/tmp/ilmt-v2/`（不随仓库提交）。

---

## 1. 方法与门禁

### 1.1 官方门禁（复跑）

| 命令 | 结果 | 耗时 |
| --- | --- | --- |
| `npm run verify:delivery` | **通过**：`Test Files 48 passed (48)` / `Tests 759 passed (759)`；`tsc --noEmit` 无错误；`vite build` 62 modules；`dist check passed: manifest and every referenced entry are present.`；exit 0 | 单测 5.76s，build 36ms |
| `npm run test:e2e`（headless） | **通过**：`17 passed (24.8s)`，exit 0 | 24.8s |

### 1.2 独立验证（本报告的判定依据）

| 脚本 | 覆盖 | 结果 |
| --- | --- | --- |
| `/tmp/ilmt-v2/srs.independent.test.ts` | 1.1–1.4：用间隔表独立重算 box −2…7 × 三档文案；已毕业；纯函数无副作用 | 11/11 |
| `/tmp/ilmt-v2/undo-storage.independent.test.ts` | 2.1–2.5：快照写入/清理、撤销逐字段复原、四种失败原因与「不改存储」、`before` 解析容错、background 消息 | 23/23 |
| `/tmp/ilmt-v2/panel.independent.test.ts` | 1.5–1.8、2.6–2.12、3.1–3.5 + 计数回滚/继续复习/busy 等边界：自建 store（真实 `applyReviewAnswer`/`undoReviewAnswer`）+ 自写 DOM 断言 | 24/24 |
| `/tmp/ilmt-v2/browser-check.mjs` | 真实 `dist/` + 真实 Chromium（headless）+ 自建 mock provider/fixture：v1 回归抽查、P0、v2 窄侧栏/深色/减动效/aria/焦点/撤销/结束页 | 40/40 |

- 独立单测合计：`Test Files 3 passed (3)` / `Tests 58 passed (58)`，约 1.5s，exit 0。
- 独立浏览器检查合计：**40/40**，4.36s，exit 0。
- 独立检查不使用 `tests/mock-server.ts`、不读 `tests/unit/*` 的期望值；浏览器脚本自带 mock、fixture 与 Playwright 启动代码，按需求文字断言。

### 1.3 环境与约定

- macOS；Playwright `chromium`（headless）+ `dist/` 未打包扩展。
- 按 `AGENTS.md` 2026-11-13 约定：**未注入任何真实按键**、未 `osascript activate`、未使用 `--window foreground`。快捷键只断言 `chrome.commands.getAll()` 的注册结果。
- 真实 Chrome 工具栏人工肉眼抽查未执行（见 §6 观察 5）；同一份 `dist/` 的页面行为由 headless 真实 Chromium 与官方 e2e 覆盖。

---

## 2. 验收表逐条判定

### 需求 1（P0）三档评级各自标出「下次什么时候再见」

| # | 判定 | 证据 |
| --- | --- | --- |
| 1.1 | **PASS** | 独立单测：box 0、`dueAt` 已过 → `again="10 分钟后"`、`hard="10 分钟后"`、`good="明天"`。另对 box −2…7 × 三档做穷举，逐项等于「用 `INTERVALS_MS` 独立重算」的值（again 恒为 10 分钟；hard 取当前格；good 前进一格；box 5 毕业）。 |
| 1.2 | **PASS（按 `srs.ts` 源码语义；文档 box 4 一句为笔误，见 §7）** | 独立单测：box 2 → `again="10 分钟后"`、`hard="3 天后"`、`good="7 天后"`；box 3 的 good = `16 天后`；box 4 的 good = `35 天后`。真实浏览器面板：box 0 的首卡三档为 `10 分钟后 / 10 分钟后 / 明天`。 |
| 1.3 | **PASS** | 独立单测：box 5 的 `good="已毕业"`；`applyGrade` 返回 `{box:5, dueAt:null, status:"mastered", correct:true}`；`previewDueLabel` 的「已毕业」分支不再拼「再见」（1.8 的四选一文案同源）。 |
| 1.4 | **PASS** | 独立单测：调用前后 `structuredClone` 深比较完全一致（含嵌套对象）；`vi.spyOn(chrome.storage.local, "get"/"set")` 零调用；两次不同 `now` 的调用不缓存。 |
| 1.5 | **PASS** | 独立单测（jsdom）：box 2 时三个 `.ilmt-review-grade-due` 依次为 `10 分钟后 / 3 天后 / 7 天后`，且各按钮文本分别含 `忘了/模糊/认识`。真实浏览器：320px 与 300px 下三个按钮 `scrollWidth-clientWidth=0`、第二行 `scrollWidth-clientWidth=0`、第二行 bbox 完全落在按钮内，字号 11px，按钮高 48px（`min-height` 已从 44 → 48）。 |
| 1.6 | **PASS** | 独立单测：`.ilmt-review-grade-note` 恰好 1 个，文本严格等于「数字是下次见到它的时间」；真实浏览器同样 1 个、同文案。 |
| 1.7 | **PASS** | 独立单测：点「认识」进入 graded 后再点「模糊」，三段第二行仍各存在、值不变，`aria-pressed` 正确切换，`answer` 调用次数为 0；另用挂起的 `answer` 验证提交中（busy）三档按钮 `disabled` 时两行文本仍在、不塌陷。 |
| 1.8 | **PASS** | 独立单测：四选一答对 → `.ilmt-review-next-note` 为 `记为认识 · 明天再见`；答错 → `记为忘了 · 10 分钟后再见`；DOM 上该 note 就是 `.ilmt-review-next` 的前一个兄弟节点。 |
| 1.9 | **PASS** | 官方 e2e `learning.spec.ts › captures a hovered word and reviews it from the side panel`：首卡 `[data-grade="good"]` 含「明天」，点击后仍含「明天」，`review-answer` 前 `box` 仍为 0；点「下一张」后 `box` 变 1（既有断言语义未变）。 |

### 需求 2（P0）刚提交的那一张可以撤回一次，回执说清「下次什么时候」

| # | 判定 | 证据 |
| --- | --- | --- |
| 2.1 | **PASS** | 独立单测（3 条）：`applyReviewAnswer` 的 entry 带 `before`，六字段与评级前 word 完全一致；同词第二次提交后，旧 entry 的 `before` 已不存在（`"before" in entry === false`），全历史中带快照的 entry 恰为 1；10 条历史后再提交仍只有 1 份（`MAX_REVIEWS` 截断后快照仍在最新一条）。 |
| 2.2 | **PASS** | 独立单测：撤销后 `box/dueAt/status/reviewsCount/correctCount/checksSinceSpot` 与评级前逐字段 `toEqual`；`reviews` 长度减 1；同一本地日 `stats.todayReviewed` 7 → 8 → 撤销回 7；box 5 毕业后再撤销回到 `learning` + 原 `dueAt`；只撤一步（第二次撤销得 `unsupported`）。 |
| 2.3 | **PASS** | 独立单测（纯函数 + background 双层）：`unknown-word`（id 不存在）、`not-latest`（`reviews` 为空）、`unsupported`（旧 entry 无 `before`）、`too-old`（`entry.at` 改为 11 分钟前）四种 reason 逐一精确匹配；四种的返回 state 与入参深比较完全相等；background 层对 `too-old`/`unsupported`/`not-latest`/`unknown-word` 调用后，`chrome.storage.local` 里 `learning` 的完整快照与调用前 `toEqual`。窗口边界：恰好 10 分钟可撤，10 分钟 + 1ms 得 `too-old`。 |
| 2.4 | **PASS** | 独立单测：合法 `before` 原样保留；`box:"1"`、`dueAt:"soon"`、`status:"unknown"`、非对象四种坏快照只丢 `before`，entry 与 word 照常加载；完全没有 `before` 的旧数据整体可用（`undoReviewAnswer` 得 `unsupported`）；`LearningState.version` 恒为 1（原始 `version:99` 与 `null` 读入后都是 1）；快照经 JSON 往返后仍可撤销。 |
| 2.5 | **PASS** | 独立单测：`isLearningMessageType("review-undo") === true`；background `{type:"review-undo", id}` 返回 `{ok:true, word}` 并落库（`box` 0、`dueAt` 与评级前一致、`reviews=[]`、`todayReviewed=0`）。 |
| 2.6 | **PASS** | 独立单测：点「下一张」后 `.ilmt-review-receipt` 出现，文本含 `已记录` 与 `明天再见`，内含真正的 `<button>撤销`。真实浏览器：`role="status"`、`aria-live="polite"`；300px 下回执 `scrollWidth-clientWidth=0`，撤销按钮完整落在回执内。 |
| 2.7 | **PASS** | 独立单测：点撤销后 `undo` 恰好调用 1 次，参数严格为 `{type:"review-undo", id:"<刚才那个词>"}`；回执消失；进度 `2 / 2 → 1 / 2`；当前卡回到同一个词（idle，三档 3 个、四选一 0 个）；`document.activeElement` 是 `.ilmt-review-card`。真实浏览器 4 词场景：`2 / 4 → 1 / 4`，同一张卡，焦点类名 `ilmt-review-card`。 |
| 2.8 | **PASS** | 独立单测：`undo` 返回 `{ok:false}`（无 reason）→ 回执保留、文案为 `撤销失败 · 再试一次`、按钮保留且可点（第二次点击真的再次调用）、进度仍 `2 / 2`、`answer` 不再被调用；`undo` 抛错时同样落 `撤销失败 · 再试一次`。 |
| 2.9 | **PASS** | 官方 e2e `learning.spec.ts › undoes the last review and returns the same card`：点「下一张」后 `box 0 → 1`、`dueAt` 后移；点「撤销」后 `box → 0`、`dueAt` 精确等于评分前、`复习 (1)` 重新出现、词数仍为 1。独立浏览器复测同一链路，并额外验证 badge 撤销后刷新为 `4`、复习 tab 为 `复习 (4)`。 |
| 2.10 | **PASS** | 独立单测：四选一答对 → 下一张写库 → 撤销：同一词以 idle 重现（`.ilmt-review-option = 0`、`.ilmt-review-grade = 3` 且三行第二行齐全），本轮不再重问该题（`suppressedSpot` 生效）。 |
| 2.11 | **PASS** | 独立单测：对 `too-old` / `unsupported` / `not-latest` / `unknown-word` 四种 reason 逐个断言回执文案严格为 `这张改不回来了`、回执内按钮数量为 0、进度仍 `2 / 2`。 |
| 2.12 | **PASS** | 独立单测：4 词、做完 2 张后点「结束」进入 B 页（有回执），点撤销 → 结束页消失、当前卡是被撤的那个词且 idle，进度为 `2 / 4`（若把 `answered` 重置为 0 会是 `1 / 3`，此值证明计数只是回滚而非重置）。真实浏览器同场景同样得到 `2 / 4`。 |

### 需求 3（P0）结束页与空状态按真实情况说话

| # | 判定 | 证据 |
| --- | --- | --- |
| 3.1 | **PASS** | 独立单测：零词时标题为 `还没有收录的词`；正文含「浅灰」与「⌥A」；不含「本轮」「认识」「答对」「明日还有 0」「今天已复习」；无「继续复习」按钮；无计数摘要。 |
| 3.2 | **PASS** | 独立单测 + 真实浏览器：标题 `本轮先到这`、正文 `还有 2 个到期`、**不含** `今天没有要复习的词`、不含「明日还有」、`继续复习` 存在、回执保留。真实浏览器里 `state.all` 是挂载时的旧快照（4 个到期），显示 2 证明 `endRound` 的 `getState()` 刷新确实生效（若不刷新会显示 4）。 |
| 3.3 | **PASS** | 独立单测：队列空、1 个词 3 小时后到期 → 标题 `今天没有要复习的词`，正文 `明日还有 1 个`，另有 `今天已复习 0 个`。 |
| 3.4 | **PASS** | 独立单测：做 2 张、其中 1 张「认识」→ 摘要严格为 `本轮 2 个 · 认识 1 · 明日还有 2 个`（第二张 hard 10 分钟后到期，计入明日），全文不含「答对」。 |
| 3.5 | **PASS** | 独立单测：`answered=0`、无到期、无 24h 内到期 → 不出现「本轮」，不出现「明日还有 0 个」，`.ilmt-review-done-summary` 节点不存在，仍有 `今天已复习 0 个`。 |
| 3.6 | **PASS** | 官方 e2e `captures a hovered word and reviews it from the side panel`：唯一到期词做完后结束页含 `今天没有要复习的词`，且 `not.toContainText("答对")`。 |

---

## 3. P0 回归

按 `docs/delivery-verification.md` 的模板：

```text
P0 交付验证：通过
- 自动门禁：通过（759/759 单测、tsc、build、check-build，exit 0）
- 快捷键绑定：通过（translate-page=⌥A，ask-selection=⌥Q，toggle-side-panel=⌥S）
- 翻译与恢复：通过（10/10 译文；原文 10 段保留；译文在原文内、视觉在原文下方；无 loading 残留；第二次 activate 后译文 0、原文 10）
- popup：通过（OWN · mock-model 正常显示）
- 侧栏解释：本轮未改动划词链路，未重复执行（v1 已通过；官方 e2e 覆盖侧栏渲染与复习作答）
- 控制台：通过（独立浏览器会话仅 1 条 fixture `/favicon.ico` 404，与扩展无关；无页面 error、无扩展报错）
```

| 项 | 判定 | 证据 |
| --- | --- | --- |
| 快捷键 ⌥A/⌥Q/⌥S | **PASS** | 独立脚本 `chrome.commands.getAll()`：`translate-page=⌥A`、`ask-selection=⌥Q`、`toggle-side-panel=⌥S`（`_execute_action` 为空是既有行为）。官方 e2e 同名用例通过。 |
| 翻译与恢复 | **PASS** | 独立浏览器：`.ilmt-tr` 10/10 且非空、每段都是该段 `:scope > .ilmt-tr`、`getBoundingClientRect().top >= 段落 top`、移除译文后原文逐字等于翻译前、`[data-loading="1"]` 为 0；第二次 activate 后 `.ilmt-tr` 0、原文 10、`[data-ilmt-peer]` 0、配对高亮 0。 |
| popup | **PASS** | 独立浏览器打开 `chrome-extension://…/popup.html`，正文含 `OWN`、`mock-model` 与 `OWN（当前）`。官方 e2e 通过。 |
| 复习链路 | **PASS** | 官方 e2e 17/17（含点评级后 `box` 仍 0、下一张写库、揭晓场景、撤销）；独立浏览器 40/40（评级 → 揭晓 → 下一张 → 回执 → 撤销 → 结束页 → 结束页撤销；四选一由独立单测覆盖）。 |

---

## 4. v1 的 16 条验收抽查（确认无回退）

前置事实：`git diff 8969a5b..5f6e13c --stat -- src/content src/shared/prompt.ts src/styles/inject.css src/manifest.json public/` 输出为空——v1 的翻译呈现链路一行未改。在此基础上做行为抽查：

| v1 # | 区域 | 判定 | 证据 |
| --- | --- | --- | --- |
| 1.1 | 卡片三层、不显示旧 `example` | **PASS** | 独立浏览器：mock 返回带 `example` 的注释，卡片不含哨兵字符串；词头/释义正常。 |
| 1.2 | 视口夹取（任意高度） | **PASS** | 官方 e2e `keeps the hover card inside a narrow viewport for every card size`；独立浏览器 320×600 底部悬停 `hooks`，卡片 `{x:195.08,y:382.11,w:80.56,h:125.88}` 完全在视口内。 |
| 1.3 | 320×600 页面底部 | **PASS** | 同上；词在视口下半部（自然位置，未人为居中）。 |
| 1.4 | 三种特效卡高上限 | **PASS** | 官方 e2e 每卡高用例遍历特效；本轮未改特效与卡片。独立浏览器实测 `gopher-hole` 卡高 125.88（上限 155）。 |
| 1.5 | 三层节点与顺序 | **PASS** | 独立浏览器直接子节点顺序 `word, meaning, translated-line, sr-only`；`.ilmt-gloss-word` 含词 + 词性 + `+1 已收录`。 |
| 2.1 | prompt 契约 | **PASS** | 独立浏览器抓取真实请求：system prompt 含 `"translated"` 与「逐字出现在译文里」，不含 `"example"` 键（`FORMAT_VERSION` 未变）。 |
| 2.2 | `translated` 校验 | **PASS（由未改源码 + 门禁保证）** | `src/shared/prompt.ts` 与 v1 一致；759 条单测含跨段/长度边界反例。本轮未单独重写反例（抽查范围外）。 |
| 2.3 | 译行进卡 | **PASS** | 独立浏览器：`.ilmt-gloss-translated` 严格等于「存在得更久」，卡片文本含「译 · 存在得更久」。 |
| 2.4 | 配对高亮 | **PASS** | 独立浏览器：`CSS.highlights.get("ilmt-gloss-pair").size===1`，文本「存在得更久」，range 起点在 `.ilmt-tr` 内；移开/恢复后为 0。 |
| 2.5 | 译行随恢复清除 | **PASS** | 独立浏览器 restore 后 `.ilmt-tr` 0、pair 0、卡片 0，原文 10 段仍在。 |
| 2.6 | 原文词条不被重复标 | **PASS** | 独立浏览器：开卡前 `ilmt-gloss` highlight size=2、pair=0；开卡后仍 2、pair=1。 |
| 3.1 | 只标本段译文 | **PASS** | 独立浏览器：p3 悬停 → 带 `data-ilmt-peer="1"` 节点恰 1 个且都在 `#article-p3`；切到 p5 后同上。 |
| 3.2 | 段落联动的 computed 效果 | **PASS** | 官方 e2e `lights only the hovered paragraph's translation`；属性值与节点归属独立复测。 |
| 3.3 | 滚动/移开清除 | **PASS** | 官方 e2e 覆盖滚动；独立浏览器移开与 restore 后属性归 0。 |
| 3.4 | restore 后无残留 | **PASS** | 独立浏览器：`.ilmt-tr` 0、`[data-ilmt-peer]` 0、`ilmt-gloss-pair` 0、原文 10 段。 |
| 3.5 | banner 文案 | **PASS** | 独立浏览器：`翻译已开启 · 2 个词可悬停`，含「个词可悬停」，不含「虚线」。 |

---

## 5. 边界专项

| 场景 | 判定 | 证据 |
| --- | --- | --- |
| 窄侧栏 320 / 300px 两行评级 | **PASS** | 真实浏览器：两档宽度下按钮与第二行均无横向溢出（差值 0），第二行 bbox 完全在按钮内，字号 11px，按钮高 48px。300px 下回执也无溢出（宽 264，`overflow=0`）。 |
| 深色主题 | **PASS** | 真实浏览器：面板本身是 `data-theme="quantum"` 深色主题；第二行 computed color 严格等于 `--ilmt-muted`（`#6e9f99`），且与第一行语义色不同（good `#2dd4bf`、again `#fb7185`）。`theme.css` 中 `--ilmt-muted` 只有一处定义，本轮 CSS 未新增颜色变量。 |
| `prefers-reduced-motion` | **PASS** | 真实浏览器 `emulateMedia({reducedMotion:"reduce"})`：评级按钮与说明行 `animation-name: none`；本轮新增选择器没有任何 `animation/transition`（`panel.css` 静态检查同样为 0）。 |
| `aria-live` 回执 | **PASS** | 真实浏览器：回执 `role="status"` + `aria-live="polite"`；「撤销」是真正的 `<button>`（300px 下仍可点）；评级按钮可访问名为 `button "忘了 10 分钟后"`（两行都在名字里，未用 aria-label 覆盖）。 |
| 撤销后焦点 | **PASS** | jsdom 与真实浏览器均断言 `document.activeElement` 是 `.ilmt-review-card`（`tabindex="-1"`）。 |
| 撤销窗口 | **PASS** | 恰好 10 分钟可撤；10 分钟 + 1ms → `too-old`；存储不变。 |
| 撤销后再提交 | **PASS** | 撤销后重新评级并下一张：`reviews` 长度 1、`reviewsCount` 1、`box` 1、`todayReviewed` 1，结束摘要 `本轮 1 个 · 认识 1 · 明日还有 1 个`，没有重复计数。 |
| 「继续复习」清空回执 | **PASS** | 从 B 页点「继续复习」：回执 0 个、结束页消失、计数重置后从 `1 / 2` 开始。 |
| 旧数据（无 `before`） | **PASS** | 旧 entry 整体可加载；面板正常显示三档（box 1 → `10 分钟后 / 明天 / 3 天后`），新提交可正常写库并可撤销；`LearningState.version` 始终为 1。 |
| 提交中禁用撤销 | **PASS** | 撤销请求挂起时回执按钮 `disabled`；对已脱离 DOM 的旧按钮再次点击被 busy 闩锁吸收，`undo` 仍只调用 1 次。 |
| 首次加载失败 | **PASS** | `getState` reject 时按零词处理，显示 A 的引导文案，不抛错。 |

---

## 6. 缺陷清单

**未发现 P0 / P1 / P2 缺陷。** 未发现「期望 vs 实际」不一致。

以下为不影响判定的观察（不计缺陷）：

1. **需求文档 1.2 的 box 4 笔误**：见 §7。判定以 `src/shared/srs.ts` 为准。
2. **回执文案的时间锚点**：需求 2.1 的公式写 `formatDueLabel(response.word.dueAt, now)`（`now` 为面板时钟），实现用的是 `response.word.updatedAt`（写库时的后台时钟）。这是必要的偏差：面板时钟晚几毫秒会把「明天」算成「24 小时后」。实际输出与需求期望一致（`明天再见`），判定不算缺陷。
3. **跨午夜撤销**：需求 2.2 只规定「同一本地日才 `todayReviewed -= 1`」。实测 23:58 评级、00:02 撤销：word 正常复原、撤销成功，但前一日计数保持 +1（4 仍是 4）。实现与需求文字一致；如果产品希望跨日也回退，需要另立需求。
4. **失败路径仍会写一次内容相同的状态**：`review-undo` 的四种失败仍走 `runLearningUpdate`，把完全相同的 `learning` 快照写回。实测字节级内容不变（四组 `toEqual` 全过），满足「四种都不改存储」的语义；若追求「零写入」可提前返回，但不影响本轮判定。
5. **真实 Chrome 人工肉眼抽查未执行**：本机自动化会话不代点 `chrome://extensions`、不注入真实按键（`AGENTS.md` 约定）。同一份 `dist/` 的翻译、卡片、联动、popup、复习、撤销、结束页由 40 条独立真实 Chromium 断言与官方 e2e 17/17 覆盖；需要肉眼确认时请用户自行重载扩展并按一次 `⌥A`。

---

## 7. 文档笔误记录（验收 1.2）

需求 `v2-requirements.md` §3 验收 1.2 写：

> box 2：`again="10 分钟后"`、`hard="3 天后"`、`good="7 天后"`；**box 4：`good="16 天后"`**

`src/shared/srs.ts` 的真实语义是 `good` **前进一格**：

| box | good 的 `applyGrade` | `INTERVALS_MS` | 文案 |
| --- | --- | --- | --- |
| 2 | box 2 → 3 | 7 天 | `7 天后` |
| 3 | box 3 → 4 | 16 天 | `16 天后` |
| 4 | box 4 → 5 | 35 天 | `35 天后` |
| 5 | 已到 `MAX_BOX`，`dueAt:null`、`mastered` | — | `已毕业` |

即「16 天后」对应的是 **box 3 的 good**，不是 box 4。独立单测 `documented 1.2 typo: box 4 good is 35 天后; box 3 good is 16 天后` 锁住了这条语义。判定按源码，不据此判 FAIL；建议下一轮把需求 1.2 的「box 4」改成「box 3」，或补一行「box 4 → 35 天后」。

---

## 8. 修复清单

无。所有验收标准与 P0/v1 回归均通过，不需要开发修复项。

---

## 9. 证据索引与复现

| 证据 | 位置 |
| --- | --- |
| 官方门禁日志 | `/tmp/ilmt-v2/verify-delivery.log` |
| 官方 E2E 日志 | `/tmp/ilmt-v2/e2e.log`（17 passed / 24.8s） |
| 独立单测日志 | `/tmp/ilmt-v2/independent-unit.log`（58 passed） |
| 独立浏览器日志 | `/tmp/ilmt-v2/independent-browser.log`（40/40） |
| 独立单测脚本 | `/tmp/ilmt-v2/srs.independent.test.ts`、`undo-storage.independent.test.ts`、`panel.independent.test.ts` |
| 独立浏览器脚本 | `/tmp/ilmt-v2/browser-check.mjs` |
| 测试用 Vitest 配置 | `/tmp/ilmt-v2/vitest.config.mjs` |

复现命令：

```bash
cd /Users/presence/orca/workspaces/translate/product-loop

# 官方门禁
npm run verify:delivery
npm run test:e2e

# 独立单测（58 条）
npx vitest run --config /tmp/ilmt-v2/vitest.config.mjs

# 独立真实 Chromium 检查（40 条，自带 mock 与 fixture）
node /tmp/ilmt-v2/browser-check.mjs
```

---

## 10. 结论

需求 1（三档后果可见）、需求 2（一次撤销 + 真实回执）、需求 3（结束页三分支）的 27 条验收标准全部 **PASS**；
P0 主流程（快捷键 / 翻译与恢复 / popup / 复习链路）与 v1 的 16 条验收抽查无回退；官方门禁 759/759 单测、
`tsc`、build、`check-build` 全绿，E2E 17/17。v2 判定 **PASS**。唯一需要收尾的是把需求 1.2 的
「box 4 → 16 天后」笔误改正（不影响实现）。
