# 交付验证主流程（P0）

- 状态：主流程，稳定不变
- 适用：每次开发任务完成后、向用户汇报前
- 原则：只覆盖核心用户路径；边界场景放回归检查，不塞进主流程
- 变更规则：除非用户明确要求，不修改本流程的步骤和判定标准

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

4. 用 opencli 打开英文测试页（带时间戳，强制新页面，避免旧 content script）：

   ```bash
   opencli browser delivery open \
     "http://127.0.0.1:4173/article.html?delivery=$(date +%s)" \
     --window foreground
   ```

5. 确认当前 provider 可用（popup 里显示当前 provider/model；交付验证用真实 provider，不用 mock）。
6. 确认测试页所在的 Chrome 窗口在前台。快捷键没反应时，先点一下测试页再按；并在 `chrome://extensions/shortcuts` 确认「翻译当前页面」是 `⌥A`。

## 2. P0 检查

### 2.1 Opt+A 开始翻译

让 Chrome 前台，发送真实快捷键：

```bash
osascript -e 'tell application "Google Chrome" to activate' \
  -e 'delay 0.3' \
  -e 'tell application "System Events" to key code 0 using option down'
```

等待 2～3 秒后检查：

```bash
opencli browser delivery eval '({count: document.querySelectorAll(".ilmt-tr").length, banner: document.querySelector(".ilmt-active-banner")?.textContent ?? null, error: document.querySelector(".ilmt-error-banner")?.textContent ?? null})'
```

通过：

- `count` 为 10（`tests/fixtures/article.html` 有 10 个正文段落）
- `banner` 包含「翻译已开启」
- `error` 为 `null`

### 2.2 译文在原文下方，双语同时存在

```bash
opencli browser delivery eval '(() => {
  const rows = [...document.querySelectorAll("#article p")].map((p) => {
    const tr = p.querySelector(":scope > .ilmt-tr");
    const clone = p.cloneNode(true);
    clone.querySelectorAll(".ilmt-tr").forEach((n) => n.remove());
    return {
      id: p.id,
      source: clone.textContent.replace(/\s+/g, " ").trim(),
      hasTr: !!tr,
      trText: (tr?.textContent || "").trim(),
      below: !!tr && tr.getBoundingClientRect().top >= p.getBoundingClientRect().top,
      loading: tr?.getAttribute("data-loading") === "1",
    };
  });
  return {
    count: document.querySelectorAll(".ilmt-tr").length,
    bad: rows.filter((r) => !r.hasTr || !r.source || !r.trText || !r.below || r.loading),
  };
})()'
```

通过：

- `count` 为 10
- `bad` 为空数组
- 每条原文还在，译文非空，译文位置在原文下方
- 没有残留 `data-loading="1"` 骨架

### 2.3 再按 Opt+A 恢复原文

```bash
osascript -e 'tell application "Google Chrome" to activate' \
  -e 'delay 0.3' \
  -e 'tell application "System Events" to key code 0 using option down'
```

然后检查：

```bash
opencli browser delivery eval '({count: document.querySelectorAll(".ilmt-tr").length, banner: document.querySelector(".ilmt-active-banner")?.textContent ?? null, sources: document.querySelectorAll("#article p").length})'
```

通过：

- `count` 为 0
- `banner` 为 `null`
- `sources` 为 10（原文段落仍在）

### 2.4 点击扩展图标出现 popup

1. 点击 Chrome 工具栏里的扩展图标（未固定时从拼图菜单里点）。
2. 检查 popup 是否正常出现，而不是空白或报错。
3. 检查是否显示：
   - 标题「翻译设置」
   - 当前 provider（例如 `DeepSeek (当前)`）
   - 当前 model
   - 脱敏后的 API Key（例如 `已保存（sk-****...）`）
   - 「保存」「测试连接」「打开翻译侧栏」等按钮
4. 按 `Esc` 关闭 popup。

通过：popup 正常渲染，当前 provider/model 可见，无空白、无错误提示。

### 2.5 划词「解释」打开侧栏并自动发送

1. 在英文正文里选中一段文字。
2. 点击浮出的「解释」。
3. 等待侧栏打开并返回回答。
4. 如果侧栏提示「上下文已失效」，点「针对新页面重新会话」后重试一次。

通过：

- 侧栏打开
- 用户消息里出现本次选中的原文引用
- 出现助手回答（有明确错误提示也算链路失败，需要修复）
- 不出现红色报错横幅

### 2.6 控制台检查

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
- Opt+A 翻译：通过 / 失败（count、banner）
- 双语在原文下方：通过 / 失败（bad 数量）
- 再按 Opt+A 恢复：通过 / 失败
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
- 悬停释义：翻译后原文出现虚线下划线；悬停显示词/词性/释义；移开消失；还原后高亮和卡片清除。

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
