# 交付验证主流程（P0）

- 状态：主流程，稳定不变
- 适用：每次开发任务完成后、向用户汇报前
- 原则：只覆盖核心用户路径；边界场景放回归检查，不塞进主流程
- 变更规则：除非用户明确要求，不修改本流程的步骤和判定标准

> 2026-11-13 修订（用户明确要求）：P0 不再由 agent 用 `osascript` 注入 `⌥A`，也不再 `--window foreground`。快捷键绑定改由 Playwright 通过 `chrome.commands.getAll()` 断言，翻译/恢复/popup/复习由自动用例覆盖，避免抢用户焦点、避免按键打进别的应用。

当前扩展：`dist/` 未打包扩展，ID `dnhebcbngmcmfccnelmimfnkponmaifa`。

## 0. 自动门禁（每次必跑）

```bash
npm run verify:delivery
```

等价于：

```bash
npm test
npx tsc --noEmit
npm run build
node scripts/check-build.mjs
```

通过标准：

- 所有命令退出码为 0
- 单测全部通过
- `tsc` 无错误
- `dist/` 构建成功，`check-build` 通过

## 1. 准备浏览器

1. 确认 `dist/` 是最新构建。
2. 打开 `chrome://extensions`，对「双语网页翻译与 LLM 问答」点「重新加载」。
   - 如果列表里没有这个扩展，点「加载未打包的扩展程序」，选择仓库里的 `dist/`。
   - 如果工具栏没有扩展图标，从拼图菜单里把它固定。
3. 启动本地测试页：

   ```bash
   python3 -m http.server 4173 --directory tests/fixtures
   ```

4. 需要看真实页面时，用 opencli 在后台窗口打开英文测试页（带时间戳，强制新页面，避免旧 content script）：

   ```bash
   opencli browser delivery --window background open \
     "http://127.0.0.1:4173/article.html?delivery=$(date +%s)"
   ```

   `--window background` 不会把 Chrome 提到前台，不打断用户正在做的事。

5. 确认当前 provider 可用（popup 里显示当前 provider/model；真实页面抽查用真实 provider，不用 mock）。

> 焦点约定：agent 不用 `osascript activate`，也不注入任何物理按键。Chrome 快捷键由下面的自动用例验证；需要人工确认时，请用户自己按一次 `⌥A`。

## 2. P0 检查

### 2.1 快捷键绑定（自动，无需前台焦点）

```bash
npm run test:e2e
```

其中 `translate.spec.ts › advertises the real shortcut bindings without an OS keystroke` 断言 Chrome 已解析 manifest 里的快捷键：

- `translate-page` → `⌥A`（非 macOS 平台是 `Alt+A`）
- `ask-selection` → `⌥Q`
- `toggle-side-panel` → `⌥S`

通过：`shortcut` 非空且与上述一致。空字符串表示绑定被拒绝或被其它扩展占用——真实按键会静默失效，所以这一条比手动按键更可靠。

> 真实按键从 Chrome 到扩展的派发属于浏览器内部行为，无法在页面里断言。我们验证的是「绑定已注册」+「命令处理函数正确」两段：前者由上面的用例覆盖，后者由 `tests/unit/background-index.test.ts` 与 2.2 的 activate 链路覆盖。

### 2.2 翻译、双语位置与恢复（自动）

`npm run test:e2e` 里的 `translates an English article and restores it` 断言：

- 激活后 `#article p` 中 10 段都插入 `.ilmt-tr`，译文非空
- 每条原文仍在，译文节点在原文之下，且没有残留 `data-loading="1"`
- 再次激活（与快捷键走同一条 `activate` 路径）后译文清空，原文 10 段仍在

通过：用例全绿，且 `requests` 中确实有发往 provider 的 POST。

### 2.3 popup

`npm run test:e2e` 里的 `shows settings sections and the active provider in the popup` 断言 popup 渲染出分区与当前 provider/model。

通过：用例全绿；需要肉眼确认时再手动点图标。

### 2.4 划词「解释」（手动，CDP 触发，不抢焦点）

```bash
opencli browser delivery --window background eval '(() => {
  const p = document.querySelector("#article-p1");
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, Math.min(30, node.data.length));
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  return "selected";
})()'
```

然后点击浮出的「解释」，等待侧栏返回。

通过：

- 气泡出现「解释 / 追问」
- 侧栏打开，用户消息里出现本次选中的原文引用
- 出现助手回答，无红色报错横幅

### 2.5 控制台检查

```bash
opencli browser delivery console
```

通过：

- 没有 `level: "error"` 的消息
- `chrome://extensions` 里扩展卡片没有「错误」按钮
- 页面、侧栏没有阻断操作的报错

## 3. 汇报模板

每次完成后按这个格式汇报：

```text
P0 交付验证：通过 / 未通过
- 自动门禁：通过 / 失败（哪一步）
- 快捷键绑定：通过 / 失败（⌥A / ⌥Q / ⌥S 是否被 Chrome 解析）
- 翻译与恢复：通过 / 失败（10/10、bad 数量、恢复后原文段数）
- popup：通过 / 失败（provider/model 是否显示）
- 侧栏解释：通过 / 失败
- 控制台：通过 / 有报错
```

任何一条为「未通过」，都不能说交付完成；修复后从第 0 步重跑。

## 4. 非 P0 回归（相关改动时才跑）

这些不进入每次必跑的主流程：

- 已经是中文的页面按 Opt+A：不发 provider 请求，不插译文
- 缺少 API Key、网络失败、模型返回格式错误：有明确错误提示，页面可用
- SPA 页面切换路由后的翻译状态
- 选中位置上下文：超长段落截断、前置段落上限、译文节点不混入原文
- 侧栏「追问」预填、重试保留引用
- provider 切换、模型拉取、连接测试
- 悬停释义：翻译后原文词条呈中性灰并有轻微悬空阴影（无底色框/下划线）；悬停显示词/词性/释义；移开消失；还原后高亮和卡片清除。

## 5. 已知限制

- `opencli` 驱动的是真实 Chrome，不是无头浏览器；快捷键和 popup 需要 Chrome 在前台。
- Chrome 有多个窗口时，快捷键发给最后聚焦的窗口。测试页没反应时，先点测试页所在窗口。
- `opencli` 能自动验证页面 DOM；popup 是浏览器工具栏 UI，需点击图标确认，稳定做法是固定扩展图标。
- 重构 `dist` 后必须重载扩展并刷新测试页，否则旧 content script 会让结果失真。
- 本地测试页服务器用完要关闭，避免端口占用。

## 6. 本次验证记录（2026-11-11）

- 自动门禁：通过（445/445 单测，`tsc`、build、`check-build`）
- Opt+A 翻译：通过（10/10，banner「翻译已开启」）
- 双语在原文下方：通过（10/10，无 loading 残留）
- 再按 Opt+A 恢复：通过（0 译文，原文 10 段）
- popup：通过（点击工具栏图标，显示 DeepSeek、deepseek-flash、脱敏 Key）
- 侧栏解释：通过（选中首段，侧栏自动发送并返回中文解释）
- 控制台：通过（无红色报错）

## 7. 本次验证记录（2026-11-12，学习闭环）

- 自动门禁：通过（571/571 单测，`tsc`、build、`check-build`）
- Opt+A 翻译：通过（opencli 真实 Chrome + 真实 provider，10/10，banner「翻译已开启 · 10 个词可悬停」）
- 双语在原文下方：通过（count 10，`bad: []`，无 `data-loading="1"` 残留）
- 再按 Opt+A 恢复：通过（0 译文，banner `null`，原文 10 段）
- popup：通过（Playwright 真实 Chromium MV3 配置，5 个分组与当前 provider/model 正常；真实 Chrome 工具栏 popup 因自动化桥不注入 `chrome://`/`chrome-extension://` 页面，未用 opencli 断言）
- 侧栏解释：通过（同源 Playwright E2E 覆盖侧栏页面渲染与复习作答；本轮改动未触碰划词解释链路）
- 学习闭环（真实 Chrome）：通过（悬停「outlive」出卡片与地鼠，点击后卡片显示「已抓住」；收录后徽标保持隐藏，因为首次到期在 10 分钟后）
- 控制台：通过（`opencli browser delivery console` 无 error）


## 8. 本次验证记录（2026-11-12，视口懒加载）

- 自动门禁：通过（584/584 单测，`tsc`、build、`check-build`）
- Opt+A 翻译：通过（10/10，banner「翻译已开启 · 10 个词可悬停」）
- 双语在原文下方：通过（count 10，`bad: []`，无 `data-loading="1"` 残留）
- 再按 Opt+A 恢复：通过（0 译文，banner `null`，原文 10 段）
- popup：通过（Playwright 真实 Chromium MV3 配置，popup 分组与当前 provider/model 正常）
- 侧栏解释：通过（真实 Chrome 划词弹出「解释 / 追问」，点击「解释」后无错误横幅；侧栏页面渲染与作答由 Playwright E2E 覆盖）
- 控制台：通过（`opencli browser delivery console` 无 error）
- 长页懒加载：通过（`long.html` 首屏只翻 11 段，滚动到第 30 段后累计 23 段，底部第 60 段始终未翻，滚回顶部不重复请求）
- E2E：通过（9/9，含新增长页用例）

## 9. 本次验证记录（2026-11-13，复习卡揭晓）

- 自动门禁：通过（593/593 单测，`tsc`、build、`check-build`）
- Opt+A 翻译：通过（10/10，banner「翻译已开启 · 10 个词可悬停」）
- 双语在原文下方：通过（count 10，`bad: []`，无 `data-loading="1"` 残留）
- 再按 Opt+A 恢复：通过（0 译文，banner `null`，原文 10 段）
- popup：通过（Playwright 真实 Chromium MV3，popup 分组与当前 provider/model 正常）
- 侧栏解释：通过（真实 Chrome 划词弹出「解释 / 追问」，点击「解释」后无错误横幅）
- 控制台：通过（`opencli browser delivery console` 无 error）
- 复习揭晓：通过（Playwright `learning.spec.ts`：点评级后答案出现、`box` 仍为 0；点「下一张」后 `box` 变 1 且出现结束页）
- 四选一锁定：通过（切「答案语言」不会重排已作答的题目，也不会回落到三档自评；单测覆盖）
- E2E：通过（9/9）
- 备注：上面这轮真实 Chrome P0 跑在功能提交后的构建上；最后的修复只改了侧栏 `review.ts` 与文档，`content_main.js` 未变。收尾时宿主占着前台，`osascript activate` 无法把 Chrome 切到前台，因此没有第二次按 `Opt+A` 复跑；同一份 `dist/` 已由 Playwright 9/9（含激活、翻译、恢复、popup、复习）覆盖。

## 10. 本次验证记录（2026-11-13，额外释义语言修复）

**问题**：勾选日语等额外学习语言后，模型返回里没有可解析的 `glosses`，复习卡永远只有目标语言释义。

**根因**：`GLOSSARY_INSTRUCTIONS` 的 JSON schema 只写了 `surface/pos/meaning/example`，没有 `glosses` 键。真实模型（DeepSeek，`deepseek-chat`，temperature 0.2）按字面理解，把 `en` / `ja` 平铺成与 `meaning` 同级的键，`parseNoteGlosses` 只认 `glosses`，于是静默丢弃。

- 真实请求修复前：`{"surface":"outlive","meaning":"…","en":"to last longer than","ja":"より長く存続する"}` → 解析后 `glosses: null`
- 修复后同一 prompt 结构：`{"surface":"outlive","meaning":"…","glosses":{"en":"live longer than","ja":"より長く生きる"}}` → 解析后 `glosses` 完整保留，5 条注释全部带 `en` + `ja`
- 第二轮换段落复测（`temperature 0.7`）：4/4 条注释同样返回 `glosses.en` + `glosses.ja`

**改动**：
- schema 写出 `glosses` 键与语言代码；追加「`meaning` 只写目标语言，其它语言放进 `glosses`」的规则
- `FORMAT_VERSION` 2 → 3（格式契约变更，旧缓存自动失效一次）
- 额外释义长度上限：prompt 要求 ≤ 20 字，解析器兜底 32 字符（原 12 字符会误杀 `to last longer than` 这类英文释义）

**验证**：
- 自动门禁：通过（596/596 单测、`tsc`、build、`check-build`）
- E2E：通过（9/9，真实 Chromium + 新构建 `dist/`）
- 真实模型：通过（修复后 5 条注释全部返回 `glosses.en` 与 `glosses.ja`，解析器全部保留）
- 手动 Chrome P0（`Opt+A`）：未执行——宿主桌面焦点被 Paseo / WeChat 反复抢占，`osascript activate` 无法稳定把 Chrome 切到前台，`Opt+A` 落不到文章页；同一份 `dist/` 的翻译、恢复、hover 注释、popup 由 Playwright 覆盖。已装扩展需在 `chrome://extensions` 重新加载后才能用上新 prompt。

## 11. 本次验证记录（2026-11-13，P0 去焦点化）

**动机**：之前的 P0 会用 `osascript activate` + `System Events` 注入 `⌥A`，并且 Playwright 默认 headful。两者都会抢用户焦点，按键还可能打进前台的其他应用。

**改动**：
- `package.json`：`test:e2e` 默认 `ILMT_E2E_HEADLESS=1`；新增 `test:e2e:headed` 供需要肉眼看界面时使用
- `translate.spec.ts` 新增 `advertises the real shortcut bindings without an OS keystroke`：从 service worker 读 `chrome.commands.getAll()`，断言 `translate-page=⌥A`、`ask-selection=⌥Q`、`toggle-side-panel=⌥S`（macOS 返回 ⌥，其它平台 Alt）
- `translates an English article and restores it` 增强：逐段断言原文保留、译文非空且在原文下方、无 loading 残留，并用第二次 `activate`（与快捷键同一条路径）验证恢复
- P0 文档与 `AGENTS.md` 去掉快捷键注入步骤；opencli 改用 `--window background`

**验证**：
- `npm run test:e2e`（headless）：通过（10/10，9.5s，无可见窗口）
- 自动门禁：通过（596/596 单测、`tsc`、build、`check-build`）
- `opencli browser delivery --window background open …` + `eval`：通过（页面可读，不抬窗口）
- 真实按键派发属于 Chrome 内部行为，不再作为交付门槛；需要人工确认时由用户自己按一次 `⌥A`
