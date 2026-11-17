# v4 测试报告：把「结算」改成「回忆」（复习页重设计第一阶段）

- 日期：2026-11-17
- 被测提交：`ddfe5b6`（初验）→ `60b1c5e` + `3eac836`（P2 修复后复验，见 §9；范围 `55b9224..HEAD`）
- 设计：`docs/superpowers/specs/2026-11-17-review-redesign-design.md`
- 计划：`docs/superpowers/plans/2026-11-17-review-redesign.md`
- 规则：`AGENTS.md`、`docs/delivery-verification.md`
- 基线：`v1-test-report.md`（16 条）、`v2-test-report.md`（27 条）、`v3-test-report.md`（23 条）
- 测试方式：独立验证（自写单测 25 条 + 自写浏览器用例 3 条，断言不引用开发用例的期望值）+ 官方门禁复跑 2 次 + 反向对照（把同一套独立单测跑在改动前 `55b9224` 上）；修复后另做 9 条定向单测与 3 条定向浏览器用例（§9）
- 结论：**PASS**

> 测试 agent 未修改源码 / 设计 / 计划，未提交、未推送。临时脚本保存在 `/tmp/v4-audit/`，
> 并已从仓库删除；当前 `git status --porcelain` 只列出本报告这一个未跟踪文件。

---

## 1. 方法与门禁

### 1.1 官方门禁（初验复跑）

| 命令 | 结果 | 耗时 |
| --- | --- | --- |
| `npm run verify:delivery` | **通过**：`Test Files 48 passed (48)` / `Tests 775 passed (775)`；`tsc --noEmit` 无输出（0 错误）；`vite build` 61 modules；`dist check passed: manifest and every referenced entry are present.`；exit 0 | 单测 5.46s，build 47ms |
| `npm run test:e2e`（headless，第 1 次） | **通过**：`21 passed (31.9s)`，exit 0 | 31.9s |
| `npm run test:e2e`（headless，第 2 次，稳定性） | **通过**：`21 passed (31.6s)`，exit 0 | 31.6s |
| `npx vitest run tests/unit/panel-review.test.ts` | **通过**：`55 passed (55)` | 3.51s |

`npm run verify:delivery` 覆盖 `npm test`（775/775）、`tsc --noEmit`、`vite build`、`node scripts/check-build.mjs` 四步，全部 exit 0。

### 1.2 独立验证（初验，本报告的判定依据）

| 脚本（临时，已删除） | 覆盖 | 结果 |
| --- | --- | --- |
| `tests/unit/zz-v4-audit.test.ts` | U1–U17 + 回执三种文案、撤销后重评、撤销没想起来、空语境、多语言、失败重试、A/B 页 | **25 / 25 通过**（1.77s） |
| `tests/unit/zz-v4-write.test.ts` | 「点档位只写一次」（飞行中连点 3 次仍 1 次写入）；「下一张」重复触发的白盒探针 | 1 通过 / 1 失败（见 §6 P2-2；失败为不可由真实输入触发的探针） |
| `tests/e2e/zz-v4-audit.spec.ts` | E1–E5：真实 `dist/` + headless Chromium，自写断言与流程 | **3 / 3 通过**，连跑两次（7.7s、7.2s） |
| `/tmp/v4-old`（`git worktree` @ `55b9224`）反向对照 | 同一套 `zz-v4-audit.test.ts` 跑在改动前的实现上 | **19 失败 / 6 通过** —— 证明这 25 条断言真的区分「旧复习页」与「新复习页」，不是空断言 |

反向对照失败的 19 条集中在 prompt/revealed/lesson/receipt 与写库时序；通过的 6 条是有意保留的 shelf / return / A / C2 / B 文案。

修复后（`60b1c5e`）同一套 25 条断言复跑仍 25/25；写库探针 2/2（初验里「旧节点双击跳卡」的探针现已通过）。见 §9。

### 1.3 环境与约定

- macOS；Playwright chromium（headless）+ 仓库 `dist/` 未打包扩展；官方 e2e 使用 `tests/mock-server.ts` 的 mock provider。
- 按 `AGENTS.md` 2026-11-13 约定：未注入任何真实按键、未 `osascript activate`、未使用 `--window foreground`；快捷键只断言 `chrome.commands.getAll()` 的注册结果。
- 真实 Chrome（用户自己的浏览器 + 重载 `dist/`）未抽查，见 §7.3。

---

## 2. 单测验收 U1–U17

判定全部来自独立单测（jsdom，断言自写），括号内为对应的独立用例。

| # | 判定 | 证据 |
| --- | --- | --- |
| U1 | **PASS** | prompt 态 `.ilmt-review-word` = `measuring`、`.ilmt-review-pos` = `n.`、`.ilmt-review-sentence` 含 `____` 且不含 `measuring`、`.ilmt-review-reveal` = `看答案`；`.ilmt-review-option / -choices / -grade / -grades / -meaning / -gloss / -langs / -mascot / -next / -scene / -grade-due / -grade-note / -next-note` 全为 `null`；正文不含「测量」（答案未提前泄露）；动作区只有 1 个按钮。（U1） |
| U2 | **PASS** | 点「看答案」后 `.ilmt-review-meaning` = `义1`；`answer` 0 次；`.ilmt-review-grade` 恰 2 个，`data-grade` 依次 `good`/`again`，文案 `想起来了`/`没想起来`；`[data-grade="hard"]` 为 `null`；两按钮 `className` 集合大小为 1、均可用、无默认高亮标记。（U2） |
| U3 | **PASS** | revealed 态 `.ilmt-review-grade-due`、`.ilmt-review-grade-note`、`.ilmt-review-next` 均为 `null`；全文不含「数字是下次」「天后再见」。（U3） |
| U4 | **PASS** | 点「想起来了」：`answer` 恰 1 次且 `{id:"en:w1", grade:"good"}`；点下去即 `box` 0→1（无需「下一张」）；队列前进到 `word2` 且为 prompt；`.ilmt-review-next` 为 `null`；回执首段严格 `word1 · 义1 · 明天再见` 且含「撤销」；焦点在 `.ilmt-review-reveal`；随后 `refresh()` 不再写库（仍 1 次）。（U4） |
| U5 | **PASS** | 点「没想起来」：`answer` 恰 1 次且 `grade:"again"`；仍停在 `word1`；`.ilmt-review-lesson` 与 `.ilmt-review-scene-caption`（`猫把它抱进怀里`）出现；`.ilmt-review-next` = `下一张`；`.ilmt-review-receipt` 为 `null`；`.ilmt-review-scene-replay` 为 `null`；存储 `box=0`、`dueAt = now + 10 分钟`。（U5） |
| U6 | **PASS** | 点「下一张」：队列前进到 `word2`；`answer` 累计仍 1 次；回执出现且为 `word1 · 义1 · 10 分钟后再见`；焦点落在新的「看答案」。（U6） |
| U7 | **PASS** | `answer` 返回 `{ok:false}`：停在 revealed、仍是 `word1`、释义仍在、两档仍 2 个且 `disabled=false`、`.ilmt-review-error` 严格 `没写进去 · 再点一次`、进度 `1 / 2`、无回执、存储 `box` 仍 0；再点一次成功后正常前进、错误行消失。（U7） |
| U8 | **PASS** | revealed 态 `await view.refresh()`：仍是 `word1`、释义 `义1` 仍在、仍 2 档、`answer` 0 次。（U8） |
| U9 | **PASS** | revealed 态点「结束」：`answer` 0 次；标题 `本轮先到这`；含 `还有 2 个到期`；「继续复习」存在；无回执。（U9） |
| U10 | **PASS** | `contexts: []`：`.ilmt-review-sentence` 与 `.ilmt-review-blank` 均为 `null`，全文无 `____`；词面与「看答案」仍在。（U10） |
| U11 | **PASS** | 单语言库：`.ilmt-review-lang-label` 为 `null`；`en`+`es` 混库：存在且文本 `英语`、标签是 `<span>`（不可点），`.ilmt-review-langs` 为 `null`。（U11） |
| U12 | **PASS** | 回执撤销：`undo` 1 次；`box` 回 0；`dueAt` 回到原值；回执消失；卡片回到 `word1` 的 prompt（无释义/档位，`.ilmt-review-reveal` = `看答案`）；进度 `1 / 2`；焦点在 `.ilmt-review-card`；`answer` 仍 1 次。（U12） |
| U13 | **PASS** | 本轮 3 个作答、1 个 again：标题 `3 个都过完了`、副行 `1 个没想起来`、全文无「认识」；全部想起来时标题 `2 个都过完了`、无副行、无「没想起来」。（U13 ×2） |
| U14 | **PASS** | 本轮 0 作答、无到期：标题仍 `今天没有要复习的词`；有明日到期时含 `明日还有 1 个`；不渲染卡片。（U14） |
| U15 | **PASS** | `.ilmt-review-shelf` 是 `.ilmt-review` 的第一个元素子节点；文本 `已收录 3 个 · 已毕业 1 个`；无毕业时为 `已收录 3 个`。（U15） |
| U16 | **PASS** | gap 2 → 不渲染；3 → `有 3 天没见了 · 10 个词都还在`；13 → `有 13 天没见了 · 10 个词都还在`；14 → `有一阵子没见了 · 10 个词都还在`；`stats.day == ""` → 不渲染；无到期 → 不渲染（未来日期的 `daysSinceDay === -1` 分支由未改动的既有用例覆盖，代码同源）。（U16） |
| U17 | **PASS** | 毕业行 `.ilmt-review-graduated-word` = `done 毕业了`；舞台 `aria-hidden="true"`；内部按钮 `tabIndex === -1`；`mount` 收到的 `animations === false`。（U17） |

补充边界（U 表外、任务要求）：

| 断言 | 判定 | 证据 |
| --- | --- | --- |
| 回执缺释义：`词 · 下次再见` | **PASS** | `glosses: []` → revealed 显示 `释义还没生成`，回执严格 `word1 · 明天再见`；两档仍可用 |
| 已毕业不带「再见」 | **PASS** | 回执严格 `word1 · 义1 · 已毕业`，全文不含「再见」 |
| 撤销后重评 | **PASS** | good → 撤销 → again：`answer` 调用序列 `[good, again]`；`box=0`、`dueAt = now + 10 分钟`；lesson 出现 |
| 撤销「没想起来」 | **PASS** | 翻页后撤销：回到 prompt，`box=0`、`dueAt` 回到原值，lesson 消失 |
| 释义语言优先级 | **PASS** | `glossLang:"es"` + `[zh, es]` → 显示 `sentido` |
| A 页 / B 页原样 | **PASS** | A：`还没有收录的词` + `⌥A`、无 shelf、无「今天已复习」；B：`本轮先到这` / `还有 2 个到期` / `继续复习`，继续后回卡片且无回执 |
| 点档位只写一次 | **PASS** | `answer` 挂起时连点「想起来了」3 次，`answer` 仍 1 次，落地后只前进一张 |

---

## 3. E2E 验收 E1–E5

来源：官方 `tests/e2e/learning.spec.ts`（复跑 2 次）+ 测试 agent 自写 `zz-v4-audit.spec.ts`（连跑 2 次，3/3）。两条路径都跑在真实 `dist/` + headless Chromium 上。

| # | 判定 | 证据 |
| --- | --- | --- |
| E1 | **PASS** | `captures a hovered word and reviews it from the side panel`：prompt 只有词/挖空句/`看答案`（`.ilmt-review-grade`、`.ilmt-review-meaning`、`.ilmt-review-langs` 均 0）；点「看答案」后释义出现、2 档、`hard` 0、`box` 仍 0；点 `good` 后 poll 到 `box=1`、回执含 `outlive` + `明天再见`、结束页 `1 个都过完了`、徽标 `""`。独立用例逐条复验同一链路，并额外断言回执含释义、不含「已记录」。 |
| E2 | **PASS** | 官方用例：`readWords()` 中 `remembered[0].mnemonic === undefined`；独立用例同样断言 `mnemonic` 未写入，且页面无 `.ilmt-review-scene`。 |
| E3 | **PASS** | `teaches a missed word and asks it again in ten minutes`：`box=0`、`dueAt ∈ [missedAt+10min−5s, now+10min+5s]`；字幕 `outlive 被猫抱进了怀里`；「下一张」后回执含 `10 分钟后再见`、结束页 `1 个都过完了` + `1 个没想起来`；`mnemonic.caption` 已缓存。独立用例另断言「下一张」前后 `dueAt` 不变（不二次写库）。 |
| E4 | **PASS** | `undoes the last review and returns the same card`：撤销后 `box=0`、`dueAt` 精确回到评级前、回执消失、词回到 prompt、`.panel-tab` 恢复 `复习 (1)`。独立用例做了同样断言。 |
| E5 | **PASS** | `shows the size of the library once the first word is kept`（shelf `已收录 1 个`、不含「已毕业」）与 `tells a returning user the truth about the gap and about today`（`有 5 天没见了`、B 页 `今天已复习 0 个`、不回显 4）原样通过；独立用例另验毕业链路：`outlive 毕业了`、shelf `已收录 1 个 · 已毕业 1 个`、徽标清空。 |

---

## 4. P0 与 v1 / v2 / v3 回归

### 4.1 P0（`docs/delivery-verification.md`）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 自动门禁 | **通过** | 775/775 单测、`tsc` 0 错误、build、`check-build` exit 0 |
| 快捷键 ⌥A / ⌥Q / ⌥S | **通过** | `advertises the real shortcut bindings…`：`translate-page=Alt+A`、`ask-selection=Alt+Q`、`toggle-side-panel=Alt+S`（macOS 的 ⌥ 归一为 Alt+） |
| 翻译与恢复 10/10 | **通过** | `translates an English article and restores it`：10 条 `.ilmt-tr`、逐段原文保留/译文非空/在原文下方/无 loading；二次 activate 后 `.ilmt-tr` 归 0、原文 10 段仍在；mock 确有 POST |
| popup provider/model | **通过** | `shows settings sections and the active provider in the popup`：5 个分区、`settings-active-provider` 含 `E2E`、`settings-model-summary` 含 `mock-model` |
| 复习写库与撤销 | **通过** | E1/E3/E4 用例：`box` 前移、`dueAt` 前后值、徽标清空、撤销逐字段回滚 |
| 控制台 | **通过（自动路径）** | 21 条 e2e 全绿，无失败 trace；未做真实 Chrome 控制台抽查（见 §7.3） |

### 4.2 v1 / v2 / v3 回归

| 已交付 | 结果 | 证据 |
| --- | --- | --- |
| v1 悬停卡三层信息 / 术语点亮 / 段落联动 | **无回退** | `translate.spec.ts`：`shows a glossary card on hover and clears it on restore`、`keeps the hover card inside a narrow viewport for every card size`、`lights only the hovered paragraph's translation`、`keeps hover notes when the glossary block splits the numbered lines` 全绿；源码 diff 为空 |
| v2 需求 2（撤销一次 + 回执） | **保留并加强** | 撤销链路 E4 全绿；回执从 `已记录 · 明天再见` 改为 `词 · 释义 · 明天再见`，`role="status"`/`aria-live` 仍在 |
| v3 需求 1（shelf） | **保留** | 位置（`.ilmt-review` 首子节点）、文案、状态矩阵、三种页面均通过；仅「语言 chip 切换」半条随 chips 删除而作废（§2.2 #7 有意删除） |
| v3 需求 2（毕业行） | **保留** | 毕业行文案、静态特效、shelf 同帧、撤销后消失再毕业去重均通过（U17 + 官方 `graduates…`） |
| v3 需求 3（回来行 / 今日口径） | **保留** | U16 + 官方 `tells a returning user…` 全绿 |
| v2 需求 1（三档 + 间隔预告 + 说明行） | **有意作废** | 按新设计 §8 判定，不据此 FAIL；`previewDueLabel` 纯函数与 `srs.test.ts` 保留 |
| v2 四选一（`spot.ts`） | **有意退役** | UI 与写入停止；`spot.ts` 与 `spot.test.ts` 保留；`review-answer` 不再带 `spot`/`spotCorrect`（源码 diff 确认） |
| 11-12「先评级后揭晓 / 改判」 | **有意作废顺序** | 三条实质保留：一次复习只写一次、失败不推进、答案可见（U2/U7） |
| 11-16「再看一次」 | **有意删除** | `.ilmt-review-scene-replay` 在 DOM 与 CSS 中均不存在；演出与字幕保留在 lesson |

---

## 5. 边界核查

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 越界文件 | **无** | 初验 `git diff 55b9224..ddfe5b6 --name-status` 仅 6 项：`src/panel/review.ts`、`src/styles/panel.css`、`tests/unit/panel-review.test.ts`、`tests/e2e/learning.spec.ts`、两份 docs；修复后 `ddfe5b6..HEAD` 仅 3 项（`review.ts`、其单测、设计状态行），见 §9 |
| 冻结路径 | **diff 为空** | `git diff 55b9224..HEAD -- src/shared src/background src/content src/popup manifest.json package.json tsconfig.json vite.config.ts scripts` 输出 0 行（含 `srs.ts`、`learning-storage.ts`、`types.ts`、`background/*`、`content/*`、`popup`） |
| 新依赖 | **无** | `package.json` 不在 diff 内 |
| 新权限 | **无** | `manifest.json` 不在 diff 内 |
| 新存储 key | **无** | `review.ts` 不再触碰 `sessionStorage`/`localStorage`/`chrome.storage`；`ilmt:review-lang`、`ilmt:review-gloss-lang` 的读写均已删除 |
| 新 `LearningWord` 字段 / version | **无 / 仍为 1** | `src/shared/types.ts` diff 为空；`LearningState.version: 1` 字面量未改 |
| `review-answer` 消息结构 | **基础不变** | 仍为 `{type,id,grade,glossLang}`；不再附加 `spot`/`spotCorrect`（§4 有意） |
| 复习视图内红色 | **无** | `panel.css` 复习段（334–719）无 `--ilmt-danger`、无红色字面量；diff 删除了旧的 `color: var(--ilmt-danger)` 与卡片 `box-shadow: var(--ilmt-glow)` |
| 触控目标 ≥ 44px | **通过** | `.ilmt-review-end` 44、`.ilmt-review-reveal` 44、`.ilmt-review-grade` 44、`.ilmt-review-next/-continue` 44、`.ilmt-review-receipt-undo` 44、`.ilmt-review-scene-retry` 44 |
| 颜色不新增变量 | **通过** | 文字/边框/底色全部复用现有 `--ilmt-text/-muted/-accent/-border/-border-soft/-input/-glass`；主按钮的 12% 青底沿用改动前已有的 `rgba(45, 212, 191, …)` 写法，未引入新变量 |
| `review.ts` 行数 | **876 行**（初验 870，修复 +6；原 1174） | 仍低于设计 §9 的 900 行门槛 |
| 死代码 | **已清干净** | `renderFilters`、`renderSpot`、`pickSpotOption`、`spotSeed`、`spotQuestion`、`spotResult`、`suppressedSpot`、`previewDueLabel`、`buildSpotQuestion`、`shouldSpotCheck` 的引用在 `review.ts` 中全部为 0；`tsc` 开启 `noUnusedLocals`/`noUnusedParameters` 仍 0 错误，说明无未用 import |
| 旧 CSS 选择器 | **已删** | `.ilmt-review-langs/-lang/-gloss/-mascot/-effect-host/-options/-option/-spot-note/-grade-due/-grade-note/-next-note/-scene-replay/-sentence-full/-meaning-more` 在 `panel.css` 中均无匹配（`-lang` 只剩 `-lang-label`） |

---

## 6. 缺陷清单

### P0（阻断交付）

无。

### P1（应修）

无。

### P2（观察，不阻断）

**P2-1 `defaultGlossLang` 是死参数，`reviewAnswerLang` 设置项在复习页失效** —— **已关闭（`60b1c5e`，见 §9.1）**

- 复现：`src/panel/review.ts:61-67` 仍声明 `defaultGlossLang?: () => string`，`mountReview()` 从不读取；`src/panel/main.ts:342` 仍传入 `reviewAnswerLang`。
- 实际：释义固定取 `word.glossLang` → 回退 `glosses[0]`；设置页里的「答案语言」对复习页不再有任何影响（设置仍被保存）。
- 期望：要么在 `primaryMeaning()` 里优先用设置值，要么下一轮连同 `main.ts` 的调用点一起删掉该参数与设置项。
- 影响：无功能错误（符合设计 §3.4 的「`word.glossLang` 优先」），但会误导后续读者以为这里还有语言选择。

**P2-2 `advance()` 对「已脱离文档的旧节点」不是幂等的** —— **已关闭（`60b1c5e`，见 §9.2）**

- 复现（白盒，真实输入不可达）：`const b = document.querySelector('.ilmt-review-next'); b.click(); b.click();`
- 实际：第一次点击翻到下一张；第二次点击仍绑定在已脱离 DOM 的旧按钮上，导致队列再 `shift()` 一次，直接跳过一张卡（探针用例失败，`answer` 仍只有 1 次，说明「下一张不写库」本身正确）。
- 期望：一次翻页只消费一张卡。建议 `advance()` 加一次性/`busy` 守卫。
- 影响：P2。真实鼠标/键盘双击时第一次点击已同步重建 DOM，第二次事件命中新节点（焦点已移到「看答案」），因此用户不可达。

**P2-3 文档状态与已交付事实不一致** —— **状态行已关闭（`3eac836`，见 §9.3）**

- 初验时设计文档头部写「状态：设计（未实施）」；计划里 7 个 Task 的复选框全部未勾选；两份文档是在实现提交之后才提交的（`bbf313c` 晚于 `fb28a02`/`0b809be`/`f6649b8`）。
- 影响：只影响追溯，不影响行为；建议下一轮把状态改为「已实施（第一阶段）」。
- 复验：设计状态行已改为「已实施（第一阶段，见 v4-test-report）」；计划里仍有 34 个未勾选的 `- [ ]`、提交顺序也无法改写，仅留作追溯注记，不再视为缺陷。

**P2-4 「3 分钟 / 8 张卡」没有自动化断言**

- 官方 E2E 每轮只用 1 张到期卡；单测最多覆盖 4 张；没有 8 卡时序用例，也没有耗时断言。设计 §10.4 已承认这一点。
- 影响：本轮验收不受影响（U/E 未要求），但「8 张 3 分钟」只能靠人工抽查。

**P2-5 C2 副行措辞与设计文案有一字差异**

- 设计 §3.7 C2 写作「明天还有 N 个」，实现沿用 v3 的「明日还有 N 个」；设计同时注明「与现在一致」，故实现按现状是对的，仅提示后续写文档时统一。

---

## 7. 偏差、有意作废与遗留

### 7.1 偏差

- 提交切分与计划不同：计划 7 个 Task，实际 5 个提交，Task 1–5 合并进 `fb28a02`，样式在 `0b809be`，E2E 在 `f6649b8`，焦点修复在 `ddfe5b6`。功能覆盖不受影响，仅追溯粒度变粗。
- 初验的两条 P2（`defaultGlossLang` 死参数、`advance()` 旧节点重入）已在 `60b1c5e` 修复；设计状态行在 `3eac836` 修正。复验见 §9。

### 7.2 有意作废（不判 FAIL）

- v2 需求 1：三档各标下次间隔、说明行、`hard`/「模糊」——按新设计 §8 作废；`previewDueLabel` 与 `srs.test.ts` 保留。
- 四选一与 `spot`/`spotCorrect` 写入——退役；模块与单测留一轮。
- 11-12 的「先评级后揭晓、可改判」——顺序作废；保留一次写入、失败不推进、答案可见。
- 11-16 的「再看一次」——删除。
- v3 需求 1.4 的 `es` 语言 chip 半条——chips 按设计删除；shelf 位置与文案不变。

### 7.3 遗留

- **真实 Chrome 未抽查**：按 `AGENTS.md` 约定，agent 不代点 `chrome://extensions`、不注入真实按键、不抢焦点；同一份 `dist/` 的 P0 与复习链路已由 headless Chromium 覆盖（官方 21 条 ×2 + 独立 3 条 ×2）。真机肉眼确认需用户自行重载 `dist/` 后查看。
- 设计 §9 第二阶段（键盘流、停留时长、按正确方式做回四选一）本轮未做，符合范围。
- `check-build` 只校验构建产物引用，不做视觉回归；CSS 的 44px/无红色由样式表静态核查，未做像素截图。

---

## 8. 结论

**PASS（修复后复验仍为 PASS，见 §9）。**

- §6 的 U1–U17 全部通过（独立单测 25/25；反向对照在旧实现上 19 条失败，证明断言有效；修复后复跑仍 25/25）。
- §6 的 E1–E5 全部通过（官方 e2e 21/21 连跑两次 + 独立浏览器用例 3/3 连跑两次；修复后官方 21/21 再跑两次、独立回归 3/3）。
- P0 主流程（快捷键 / 翻译与恢复 / popup / 复习写库与撤销）无回退；v1 / v3 回归无回退；v2 回执与撤销保留，v2 需求 1 与四选一按新设计作废。
- 边界核查未发现越界改动：初验 6 个文件；修复只动 `review.ts`、其单测与设计状态行，冻结路径 diff 仍为空、无新依赖/权限/存储 key/字段、`version` 仍为 1、复习视图无红色、触控目标 ≥ 44px、死代码清干净。
- P2-1（答案语言失效）与 P2-2（翻页重入）已关闭；P2-3 的状态行已修正；剩余 P2 为「3 分钟无自动化」与「C2 明日/明天措辞」，均不影响第一阶段验收。

---

## 9. 修复后复验（`60b1c5e` + `3eac836`）

- 范围：`git diff ddfe5b6..HEAD --name-status` 只有 3 个文件——`src/panel/review.ts`、`tests/unit/panel-review.test.ts`、设计文档；`src/panel/main.ts` 与所有冻结路径（`src/shared`、`background`、`content`、`popup`、`manifest.json`、`package.json`）仍为 0 改动。
- 方法与初验相同：断言由测试 agent 自写，不引用开发新增用例的期望值；定向单测 9 条、定向浏览器用例 3 条均为临时文件，跑完已删除。

### 9.1 P2-1 答案语言：已关闭

实现改为 `设置语言 → word.glossLang → glosses[0]`（`primaryMeaning(word, deps.defaultGlossLang())`），揭晓释义与回执共用同一选择。

定向单测（`tests/unit/zz-v4-p2.test.ts`，语言 6 条 + 翻页 3 条 = 9/9，842ms；语言部分如下）：

| 场景 | 期望 | 实际 |
| --- | --- | --- |
| `defaultGlossLang → "es"`，词有 `zh-CN`/`es` | 揭晓 = `sentido1`；回执 = `word1 · sentido1 · 明天再见` | PASS |
| `defaultGlossLang → ""` | 回退 `word.glossLang` → `中文义1` | PASS |
| 完全不传该选项 | 回退 `word.glossLang` → `中文义1` | PASS |
| `defaultGlossLang → "fr"`（词里没有） | 回退 `word.glossLang` → `中文义1` | PASS |
| 设置语言与 `glossLang` 都不存在 | 回退 `glosses[0]` → `第一义` | PASS |
| `"es"` + 没想起来路径 | lesson 释义 = `sentido1`；下一张后回执 = `word1 · sentido1 · 10 分钟后再见` | PASS |

定向浏览器（`tests/e2e/zz-v4-lang.spec.ts`，真实 `dist/` + headless Chromium）：

| 场景 | 期望 | 结果 |
| --- | --- | --- |
| 设置页存 `reviewAnswerLang:"es"` | 揭晓 `.ilmt-review-meaning` = `sobrevivir a`；回执含 `sobrevivir a`、不含 `比……存在得更久` | PASS（1.8s） |
| 未配置（`""`） | 揭晓 = `比……存在得更久`；回执同样 | PASS（1.8s） |
| 未知语言 `"fr"` | 回退 `比……存在得更久` | PASS（1.9s） |

结论：设置页的答案语言真的生效；空值、未配置、词内没有该语言三种回退均正确。P2-1 关闭。

### 9.2 P2-2 翻页幂等：已关闭

`advance()` 现在要求 `phase === "lesson"` 且仍有当前词，并且只 `shift()` 一次。

定向单测（其中翻页 3 条）：

| 场景 | 期望 | 实际 |
| --- | --- | --- |
| 3 词，`没想起来` 后对**已脱离的旧「下一张」节点**程序化连点 3 次 | 只前进到 `word2`，不跳到 `word3`、不进结束页；进度 `2 / 3`；`answer` 仍 1 次；回执为 `word1 · 中文义1 · 10 分钟后再见` | PASS |
| 翻到 prompt 后旧节点再点一次 | 仍停在 `word2`，无结束页 | PASS |
| 真实路径点一次「下一张」 | 正常翻到 `word2`，prompt 态、回执出现、无「下一张」 | PASS |

初验的白盒探针（连点旧节点）同一条此时通过，写库探针 2/2。官方 E3（没想起来 → 下一步 → 结束页）仍 21/21 全绿，真实路径无跳卡或提前结束。P2-2 关闭。

### 9.3 P2-3 文档状态：状态行已关闭

`git show 3eac836` 为 1 个文件、1 行新增 / 1 行删除，只改：

```diff
- 状态：设计（未实施）
+ 状态：已实施（第一阶段，见 v4-test-report）
```

正文（含 §3.4 的释义规则、§6 验收表）未动。计划的 34 个 `- [ ]` 仍未勾选、文档提交顺序仍是历史事实，作为追溯注记保留，不再计为缺陷。

### 9.4 回归、门禁与稳定性（复跑）

| 命令 / 用例 | 结果 | 耗时 |
| --- | --- | --- |
| `npm run verify:delivery` | **通过**：`48 files / 778 tests passed`（初验 775，+3 为本次新增开发单测）；`tsc` 0 错误；`vite build` 61 modules；`dist check passed`；exit 0 | 单测 5.34s，build 35ms |
| `npm run test:e2e`（第 1 次） | **通过**：`21 passed`，exit 0 | 31.8s |
| `npm run test:e2e`（第 2 次） | **通过**：`21 passed`，exit 0 | 31.2s |
| 初验独立单测全量复跑 | **通过**：25/25 + 写库探针 2/2 | 1.77s |
| 初验独立浏览器 E1–E5 回归 | **通过**：3/3 | 2.4s / 2.3s / 2.1s |
| 定向单测（§9.1 + §9.2） | **通过**：9/9 | 842ms |
| 定向浏览器（§9.1） | **通过**：3/3 | 1.8s / 1.8s / 1.9s |

U1–U17、E1–E5 的语义未被这两处修复改变；边界仍只有允许文件。

### 9.5 复验结论

**PASS。** P2-1、P2-2 关闭；P2-3 的状态行随 `3eac836` 修正。剩余 P2 仅「3 分钟 / 8 张卡无自动化断言」与「C2 明日/明天措辞」。

文档注记（非缺陷，不计入 P2）：设计 §3.4 仍写「`word.glossLang` 优先」，实现现在按协调者要求改为「设置语言优先 → `word.glossLang` → `glosses[0]`」；建议下一轮在 §3.4 补一句，免得文档与实现再次不一致。
