# AGENTS.md

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

> 2026-11-13：用户明确要求去掉「agent 注入 `⌥A`」这一步。不要用 `osascript activate`、不要发 `System Events` 按键、不要 `--window foreground`；真实按键只有在用户自己愿意按的时候才算验证依据。

除非用户明确要求，不修改这条主流程的步骤和判定标准。中文页、缺 Key、网络错误、SPA 等放在文档的「非 P0 回归」里，不占每次必跑的主流程。
