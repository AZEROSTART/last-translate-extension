# v1 测试报告：翻译呈现（对齐 · 术语 · 卡面）

- 日期：2026-11-16
- 被测提交：`8969a5b` — `feat: tighten the hover card and link terms to their translations`
- 需求：`docs/product/iterations/v1-requirements.md`
- 规则：`AGENTS.md`、`docs/delivery-verification.md`
- 测试方式：独立验证（本报告的断言脚本不引用开发写的测试；P0 另外复跑官方门禁）
- 结论：**PASS**（3 条需求 / 16 条验收标准全部通过；P0 主流程无回退）

> 测试 agent 未修改源码、未修改需求文档、未提交、未推送。临时脚本与截图在
> `/tmp/ilmt-verify/`（不随仓库提交）。

---

## 1. 方法与门禁

### 1.1 官方门禁（复跑）

```bash
npm run verify:delivery     # 728/728 单测、tsc、build、check-build，6.5s，exit 0
npm run test:e2e            # 16/16，22.5s，headless，exit 0
npx tsc --noEmit            # 单独复核：exit 0，0.6s
```

- 单测：`Test Files 48 passed (48)` / `Tests 728 passed (728)`，6.27s
- `tsc`：无错误
- 构建：`dist` 产出正常，`dist check passed: manifest and every referenced entry are present.`
- E2E：`16 passed (22.5s)`（含快捷键、翻译与恢复、popup、复习、窄视口卡片、段落联动）

### 1.2 独立验证（不依赖开发的测试）

| 脚本 | 内容 | 结果 |
| --- | --- | --- |
| `/tmp/ilmt-verify/parser.test.ts` | 2.1 / 2.2，自写 8 条断言（含跨段反例、32/33 边界） | 8/8 通过 |
| `/tmp/ilmt-verify/card.test.ts` | 1.1 / 1.2 / 1.5 / 2.3 / 2.4，自写 10 条断言（含定位属性扫描） | 10/10 通过 |
| `/tmp/ilmt-verify/peer.test.ts` | 3.1，自写 5 条断言 | 5/5 通过 |
| `/tmp/ilmt-verify/independent-e2e.mjs` | 自建 mock provider + 自建页面 + 自写 53 条 E2E 断言（播放真实 `dist/`） | 53/53 通过 |

独立单测合计 **23/23（3 个文件，2.0s）**；独立 E2E 合计 **53/53**。

独立 E2E 使用自己的 mock（不引用 `tests/mock-server.ts`）、自己的 fixture
（`article/single/mismatch/dark/longcard`）、自己的 Playwright 启动代码；断言按需求文字写，
不读开发 spec 的期望值。

运行方式（可复现）：

```bash
npx vitest run --config /tmp/ilmt-verify/vitest.config.mjs \
  /tmp/ilmt-verify/parser.test.ts /tmp/ilmt-verify/card.test.ts /tmp/ilmt-verify/peer.test.ts
node /tmp/ilmt-verify/independent-e2e.mjs
```

截图证据（临时路径，未提交）：
`/tmp/ilmt-verify/shots/card-with-translated.png`、
`/tmp/ilmt-verify/shots/card-320x600.png`、
`/tmp/ilmt-verify/shots/card-dark-page.png`。

---

## 2. 验收表逐条判定

### 需求 1（P0）卡片三层 + 始终完整可见

| # | 判定 | 证据 |
| --- | --- | --- |
| 1.1 | **PASS** | 独立单测：带 `example` 的旧形注释 → 无 `.ilmt-gloss-example`，`textContent` 不含例句，词头/释义仍正常。独立 E2E：mock 返回带 `example` 的注释，卡片 `innerText` 为 `outlive / v. / +1 已收录 / 比……存在得更久 / 译 · 存在得更久`，不含例句。 |
| 1.2 | **PASS** | 独立单测按需求原值复算：视口高 300、卡高 120、词 `rect.top=280` → `top=152`，落在 `[8,172]` 且 `top+120 ≤ 280`（不遮词）；词在顶部（`top=0`）→ `top≥8`。另做属性扫描：3 种视口高（240/300/600）× 4 种卡高（80/120/155/175）× 每个词位置（步长 8）→ 卡片始终在视口内、左右各留 8px，且只要上/下有一侧放得下就与词保持 ≥8px 不重叠（0 失败）。 |
| 1.3 | **PASS** | 独立 E2E（真实 `dist/`）：视口 320×600，滚到页面底部后悬停 `#article-p10` 的 `hooks`（词在视口 y≈516/600，命中元素为 `P`）→ 卡片 `boundingBox = {x:195.08, y:373.23, w:80.56, h:125.88}`，满足 `x≥0 && x+w≤320 && y≥0 && y+h≤600`。截图 `card-320x600.png`。 |
| 1.4 | **PASS** | 独立 E2E 逐个固定特效并重新翻译（特效设置在页面扫描时读取）：`cat-sticker` 卡高 161.875 ≤ 175；`magnet` 125.875 ≤ 155；`gopher-hole` 125.875 ≤ 155；同时断言卡内 `[data-ilmt-effect]` 确实是对应特效（排除“设置没生效、三次都量同一个特效”的假通过）。 |
| 1.5 | **PASS** | 独立单测：三层节点逐一为 `ilmt-gloss-word / ilmt-gloss-meaning / ilmt-gloss-translated-line`，顺序正确且各 1 个。独立 E2E 直接子节点顺序为 `word, meaning, translated-line, sr-only`。另测 320×160 + 长释义：卡高 144（= `100vh-16px`）、`overflow-y:auto`、`scrollHeight 162 > clientHeight 142`（内容可滚动、未裁字）、`scrollWidth == clientWidth`（无横向溢出）、译行仍在 DOM 内。 |

### 需求 2（P0）译行进卡片 + 译文就地对应点亮

| # | 判定 | 证据 |
| --- | --- | --- |
| 2.1 | **PASS** | 独立单测：`buildFormatPrompt({glossaryEnabled:true})` 含 `"translated"`、含「逐字出现在译文里」、不再含 `"example"` 键；`FORMAT_VERSION === 4`。独立 E2E：抓取真实请求体，system prompt 同时含这两个字符串。 |
| 2.2 | **PASS** | 独立单测 7 组：① 与同段译文逐字一致 → 保留；② 32 字 → 保留、33 字 → 丢弃；③ **只出现在别的段译文里 → 丢弃**（防止拿错段落校验）；④ 空串/纯空格/数字/`null`/数组 → 丢弃且 note 仍在；⑤ 没有 translation map（旧调用路径）→ 丢弃；⑥ 完整 `parseAnnotatedResponse` 链路 → 保留；⑦ 旧形 `example` 注释 → 原样保留、不伪造字段。E2E 反例：mock 返回 `translated:"译文里根本没有这个词"` → 卡片只有词头+释义、无「译」行、`ilmt-gloss-pair` size=0、无错误横幅。 |
| 2.3 | **PASS** | 独立单测：有 `translated` → `.ilmt-gloss-translated` 文本严格等于 `存在得更久`，`textContent` 含 `译 · 存在得更久`；无 `translated` → `.ilmt-gloss-translated-line` 与 `.ilmt-gloss-translated` 均不存在，卡片文本不含「译」「暂无」。译文 `data-loading="1"` 时不显示译行（需求 §4.1 的边界）。E2E 同样通过。 |
| 2.4 | **PASS** | 独立单测：开卡后 `CSS.highlights.get("ilmt-gloss-pair").size === 1`，range 的 `startContainer.parentElement.closest(".ilmt-tr").data-ilmt-for === "p_1"`（落在该段译文文本节点内），`range.toString() === "存在得更久"`；移开并走完 120+180ms 后 `get("ilmt-gloss-pair")` 为 `undefined`；滚动关卡同样清空。E2E：开卡 size=1，移开 size=0。 |
| 2.5 | **PASS** | 独立 E2E：mock 返回 `translated:"存在得更久"`，悬停 `outlive` → 卡片含「译 · 存在得更久」；`restore()` 后 `ilmt-gloss` 与 `ilmt-gloss-pair` 均为 0、`.ilmt-tr` 为 0。另在“卡片开着时 restore”场景复测（见 §4），同样 0 残留。 |
| 2.6 | **PASS** | 独立 E2E：开卡前 `ilmt-gloss.size = 2`，开卡后仍为 2，`ilmt-gloss-pair` 为 1（只标原文，不在原文里多标）。 |

### 需求 3（P1）悬停段落只点亮自己的译文

| # | 判定 | 证据 |
| --- | --- | --- |
| 3.1 | **PASS** | 独立单测 5 组：只标本根 `data-ilmt-p` 对应的 `.ilmt-tr`（不波及兄弟段）；一个根带多个 id（`p_7 p_8`）时两块都标；切根后最多 1 个段落点亮；传 `null` 全清且幂等；译文节点已被移除后再清空不抛错。属性值严格为 `"1"`，段落本身不挂该属性。 |
| 3.2 | **PASS** | 独立 E2E：`#article-p3.hover()` → `#article-p3 .ilmt-tr[data-ilmt-peer="1"]`、computed `opacity === "1"`；`#article-p2` 无该属性；全页带属性节点数 = 1。 |
| 3.3 | **PASS** | 独立 E2E：从 p3 移到 p5 → 带属性节点恰好 1 个且 `closest("#article-p5")` 成立，p3 的属性已撤销。另测真实滚动（临时加高页面后 `scrollBy`）→ 属性归 0。 |
| 3.4 | **PASS** | 独立 E2E：`restore()` 后 `.ilmt-tr` 0 个、`[data-ilmt-peer]` 0 个、`[data-ilmt-p]` 0 个、banner 0 个、tooltip 0 个。 |
| 3.5 | **PASS** | 独立 E2E：banner 文本 `翻译已开启 · 2 个词可悬停`，含「个词可悬停」、不含「虚线」；开发 E2E 同断言。 |

---

## 3. P0 回归

| 项 | 判定 | 证据 |
| --- | --- | --- |
| 快捷键绑定 | **PASS** | `chrome.commands.getAll()`：`translate-page=⌥A`、`ask-selection=⌥Q`、`toggle-side-panel=⌥S`（独立脚本与开发用例一致；非 macOS 归一为 `Alt+`）。 |
| 翻译与恢复 | **PASS** | 独立 E2E：10/10 段插入 `.ilmt-tr`、原文 10 段保留、译文在原文下方、无 `data-loading="1"` 残留；第二次 activate 后译文 0、原文 10。 |
| popup | **PASS** | 独立 E2E：`chrome-extension://…/popup.html` 显示 `INDEP（当前）` 与 `mock-model`；开发用例显示 `E2E` / `mock-model`。 |
| 复习链路 | **PASS** | `npm run test:e2e` 的 `learning.spec.ts` 4/4：悬停收录 → 侧栏复习；点评级后答案出现且 `box` 仍为 0；点「下一张」后 `box` 变 1 并写库；画面钩子落库缓存。 |
| 控制台 | **PASS** | 独立 E2E 只出现 1 条 `Failed to load resource: 404`，来自自建 fixture 站点的 `/favicon.ico`，与扩展无关；无 `pageerror`、无扩展报错。真实 Chrome 会话 `console` 0 条（该会话未注入 content script，见 §6）。 |
| 自动门禁 | **PASS** | 728/728 单测、`tsc`、build、`check-build` 全绿（6.5s）。 |

---

## 4. 边界与两处开发偏差

| 场景 | 判定 | 证据 |
| --- | --- | --- |
| 320×600 窄视口、页面底部悬停 | **PASS** | 词在视口 y≈516（不是人为停到屏幕中间），卡片完整落在 320×600 内，高 125.88。 |
| 页面底部（更极端） | **PASS** | 卡片优先放词上方：`top + height ≤ 词 top - 8`；无“下半截出屏”。 |
| 无 `translated` 的旧缓存 / 模型不配合 | **PASS** | 旧形注释（只有 `surface/meaning/example`）渲染正常、无译行；模型给出对不上的词 → 字段丢弃、卡片无译行、无错误条。 |
| `restore()` 后残留 | **PASS** | `ilmt-gloss-pair` / `ilmt-gloss` 为 0、`[data-ilmt-peer]` 为 0、`.ilmt-tr` 为 0。**开卡状态下直接 restore 也为 0**（暗色页用例先开卡再 restore）。 |
| 暗色页面卡片可读 | **PASS** | 卡片背景 computed `rgb(255,255,255)`、正文 `rgb(31,35,40)`，对比度 15.8:1；截图 `card-dark-page.png`。 |
| 极短视口 + 超长内容 | **PASS** | 320×160：卡高 144（`100vh-16px`）、纵向可滚动、无横向溢出、译行未被裁掉。 |
| 偏差 ① `dispatch.ts` 单段流式分支 | **PASS** | 自建“只有 1 段”的页面（独立 mock，走 `runGroup` 的 `group.length === 1` 流式分支）：卡片含「译 · 存在得更久」，`ilmt-gloss-pair` size=1 且 range 文本为「存在得更久」。传译文进 `parseGlossaryNotes` 的改动有效，`translated` 未丢。 |
| 偏差 ② `FORMAT_VERSION` 3→4 | **PASS（含一处文档口径说明）** | 5 个页面首轮翻译共 5 次 POST；同页第二次翻译 5→5、刷新后 5→5（命中缓存，不反复请求）。v3 旧记录因 `promptVersion` 进入 `buildCacheKey` 而不可达（`FORMAT_VERSION` 变更 → 哈希变化），这是需求 §6 明确选择的一次性失效；旧形态注释若被渲染则正常显示、无译行（独立单测覆盖）。 |

---

## 5. 缺陷清单

**未发现 P0 / P1 / P2 缺陷。** 无“期望 vs 实际”不一致。

以下为不影响判定的观察（不计缺陷）：

1. **测试强度（非产品问题）**：开发新增的 1.3 E2E 用
   `scrollBy(0, initial.top - 300)` 把词停在视口中间，测的是“卡片在视口内”，
   不是需求描述的“滚到 `#article-p10` 后在页面底部悬停”。本次独立用例按需求场景复测通过，
   建议后续把该用例的停放位置改回自然位置，减少“测试比需求宽松”的隐患。
2. **“旧缓存仍能显示”的口径**：`FORMAT_VERSION` 进入 `promptVersion`，再进入 `buildCacheKey`，
   因此 v3 缓存记录升级后不会被读取（需求 §6 正是一次性失效的取舍）。若产品真实意图是
   “旧缓存继续显示、只是没有译行”，需要另一套方案（例如缓存键不带版本、按字段做兼容），
   与 §6 的表述冲突；本报告按 §6 判定为 PASS。
3. **大小写策略不对称**：`parseTranslated` 用区分大小写的 `includes`，而配对高亮
   `findSurfaceRange` 会转小写。方向是“宁可不显示也不显示错的”，符合需求“宁可整行不显示”；
   若目标语言是英语等可能大小写变化，会出现个别译行被丢弃，但不产生错误数据。
4. **真实 Chrome 抽查未执行（环境阻塞）**：`opencli browser delivery --window background` 打开
   `article.html` 后 `typeof globalThis.__ilmtMain === "undefined"`，该 Chrome 会话里扩展 content
   script 未注入；按约定测试 agent 不点 `chrome://extensions`、不注入按键。同一份 `dist/` 的翻译、
   恢复、卡片、联动、popup、复习由 16/16 Playwright 与 53/53 独立 E2E 覆盖。

---

## 6. 复现与证据索引

| 证据 | 位置 |
| --- | --- |
| 门禁日志 | `/tmp/ilmt-verify/verify-delivery.log` |
| 独立 E2E 完整输出 | `/tmp/ilmt-verify/e2e-run.log`（53/53） |
| 独立单测脚本 | `/tmp/ilmt-verify/parser.test.ts`、`card.test.ts`、`peer.test.ts` |
| 独立 E2E 脚本 | `/tmp/ilmt-verify/independent-e2e.mjs` |
| 截图 | `/tmp/ilmt-verify/shots/card-with-translated.png`、`card-320x600.png`、`card-dark-page.png` |

关键命令：

```bash
npm run verify:delivery
npm run test:e2e
npx vitest run --config /tmp/ilmt-verify/vitest.config.mjs \
  /tmp/ilmt-verify/parser.test.ts /tmp/ilmt-verify/card.test.ts /tmp/ilmt-verify/peer.test.ts
node /tmp/ilmt-verify/independent-e2e.mjs
```

---

## 7. 结论

需求 1、2、3 的 16 条验收标准全部 PASS，P0 主流程（快捷键 / 翻译与恢复 / popup / 复习链路）
无回退，门禁与 E2E 全绿。v1 判定 **PASS**。无需开发修复项。
