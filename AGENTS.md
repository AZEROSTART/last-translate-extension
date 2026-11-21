# AGENTS.md

## 快捷键翻译（不可丢，每次推送前强制）

这条链路任何一环断了，`⌥A` 就会静默失效。推送前逐项确认，任何一项不过就停下修复，不得推送：

1. **源码**：`public/manifest.json` 仍有三个命令和默认键——`translate-page`=Alt+A、`ask-selection`=Alt+Q、`toggle-side-panel`=Alt+S。
2. **构建**：`dist/manifest.json` 与源码一致，由 `tests/unit/build.test.ts › never loses the page-translation shortcuts` 锁住。
3. **绑定**：`tests/e2e/translate.spec.ts › advertises the real shortcut bindings without an OS keystroke` 断言 Chrome 解析出 `⌥A / ⌥Q / ⌥S`。
4. **命令处理**：`tests/unit/background-index.test.ts` 覆盖 `chrome.commands.onCommand` → `activate` / `ask-selection` / 打开侧栏。
5. **端到端**：`tests/e2e/translate.spec.ts › translates on one activate and restores on the next` 只发一次 `activate`（与快捷键同一条路径）就翻译，第二次恢复。
6. **可见性**：popup 打开时，若快捷键未绑定或当前页没有内容脚本，必须显示 `.popup-host-warning`；不允许静默失败。

不得删除或改名：manifest 的 `commands`、`chrome.commands.onCommand`、content 的 `activate` 处理、右键「翻译当前页面」、popup 的快捷键提示。确需改动，先得到用户明确同意。

**宿主限制**：Orca 内置浏览器不注入 content scripts（`chrome.scripting` 未实现，`chrome.tabs.sendMessage` 返回 `Receiving end does not exist`），因此不能用它验证网页翻译。快捷键翻译必须在 Chrome / Chromium 里验证；Orca 只用于侧栏与复习。汇报时必须写明是在哪个宿主验证的。

## 交付验证（强制）

每次开发任务完成后、向用户汇报前，必须按 `docs/delivery-verification.md` 的 P0 主流程验证一遍。

最低要求：

1. 运行 `npm run verify:delivery`，确保单测、`tsc`、build、`check-build` 全部通过。
2. 运行 `npm run test:e2e`（默认 headless，不抢用户焦点），完成浏览器 P0：
   - 快捷键绑定：`chrome.commands.getAll()` 断言 `⌥A` / `⌥Q` / `⌥S` 已被 Chrome 解析
   - 翻译与恢复：10/10 段落有译文、原文保留、译文在原文下方、再次激活后恢复
   - popup 正常显示 provider/model
   - 复习链路（收录 + 点评级揭晓 + 下一张写库）
3. 真实 Chrome 抽查只做不需要抢焦点的部分（`opencli ... --window background` + 划词「解释」），并在完成后检查控制台无红色报错。
4. 任何一项未通过，先修复并重跑；不得在未通过时声称交付完成。
5. 汇报时使用文档里的模板，明确写出每项通过/失败。
6. 验证通过并提交后，直接 `git push origin main`，不用再等用户确认；推送失败（鉴权、网络、非快进）才停下来汇报。

> 2026-11-13：用户明确要求去掉「agent 注入 `⌥A`」这一步。不要用 `osascript activate`、不要发 `System Events` 按键、不要 `--window foreground`；真实按键只有在用户自己愿意按的时候才算验证依据。

除非用户明确要求，不修改这条主流程的步骤和判定标准。中文页、缺 Key、网络错误、SPA 等放在文档的「非 P0 回归」里，不占每次必跑的主流程。
