# 模型配置 popup + 原生 DeepSeek + 新图标 · 设计文档

- 日期：2026-11-09
- 状态：已批准
- 范围：扩展按钮 popup、模型配置 UI、DeepSeek 预设、扩展图标、三界面量子青视觉主题、manifest/build
- 不改：翻译提示词、翻译队列、并发/重试策略、页面翻译 DOM 规则；侧栏只加 thinking 开关和视觉主题，不改聊天结构

## 1. 为什么做

现在配置模型要打开独立的 `options.html`，入口很少；新增 DeepSeek 还要手填 baseURL、`/v1`、请求头。用户希望：

1. 选 DeepSeek 后只填 API Key、选模型，并能拉取模型列表。
2. 点扩展按钮直接弹出模型配置，不跳独立页面。
3. 换掉 Chrome 默认拼图图标。

## 2. 目标

- 扩展按钮点击打开 popup；popup 内完成模型配置的新增、编辑、测试连接、拉取模型。
- 新增「DeepSeek」原生预设：自动使用 `https://api.deepseek.com`，只展示 API Key 和模型。
- popup 底部提供「打开侧栏」和「高级设置」；侧栏仍可通过按钮和 `Alt+S` 打开。
- 新增一套 16/32/48/128 的扩展图标。
- 现有 custom provider、options 页、侧栏聊天、翻译流程保持可用。

## 3. 非目标

- 不把目标语言、并发、提示词、缓存等全局设置搬进 popup。
- 不新增 DeepSeek 之外的协议或 provider adapter。
- 不重做侧栏聊天结构；只加 thinking 开关和视觉主题，不改变 content script 的翻译/采集逻辑。
- 不持久化 API Key 到 `chrome.storage.sync`；仍只用 `chrome.storage.local`。

## 4. 反目标

- popup 塞得过满、需要大量滚动才能完成一次配置。
- 为了 popup 丢掉侧栏入口。
- 把 DeepSeek 做成一套重复的网络层，和现有 OpenAI 兼容实现分叉。
- 让现有 custom 配置在编辑后变成 DeepSeek，或反之。
- 为了「科幻」牺牲正文对比度、焦点可见性或 16px 图标识别度。

## 5. 约束

- Chrome MV3，TypeScript + 原生 DOM，无框架、无远程代码、无内联脚本。
- popup 是扩展页面，使用 `chrome.storage.local`、`chrome.sidePanel.open`、`chrome.runtime.openOptionsPage`。
- Chrome 不允许同一个 action 点击同时弹 popup 和触发 `action.onClicked`；popup 优先。
- `chrome.sidePanel.open()` 必须在用户手势中调用；popup 里的按钮点击满足条件。
- 所有用户可见文案保持中文；API Key 只显示掩码。
- 构建必须继续通过 `npm test`、`npx tsc --noEmit`、`npm run build`。

## 6. 方案对比

### 6.1 模型配置和侧栏冲突

| 方案 | 做法 | 取舍 |
|------|------|------|
| **A. 按钮弹 popup（选）** | popup 放模型配置，底部「打开侧栏」；`Alt+S` 保留 | 配置入口最直接；进侧栏多一次点击 |
| B. 按钮继续开侧栏 | 模型配置做成侧栏内视图 | 少一次点击，但侧栏窄，表单拥挤，且不符合 popup 要求 |

选 A。popup 是配置中心，侧栏是聊天/阅读辅助，两者职责分开。

### 6.2 DeepSeek 接入方式

| 方案 | 做法 | 取舍 |
|------|------|------|
| **OpenAI 兼容预设（选）** | 复用现有 `openai.ts`，DeepSeek 只作为 `kind` 预设和默认值 | 不重复网络层；`/models`、`/chat/completions` 直接可用 |
| 独立 DeepSeek adapter | 另写一套请求/流解析 | 协议相同，重复代码，新增维护面 |

选预设。DeepSeek 的 OpenAI 兼容接口已经覆盖翻译所需能力。

### 6.3 视觉风格

| 方案 | 做法 | 取舍 |
|------|------|------|
| A 深空指挥舱 | 冷蓝全息玻璃、青色辉光、网格 | 稳重耐看，但偏常见 |
| B 赛博霓虹 | 近黑底、品红/紫霓虹、扫描线 | 最张扬，长时间看容易疲劳 |
| **C 量子青（选）** | 深青底、HUD 边角、点阵、青色辉光 | 科幻感来自结构，克制、干净 |

选 C。用户看过三个 popup mockup 后选择；C 应用到 **popup、options、侧栏聊天** 三个界面，统一为一套深青 HUD 视觉。

### 6.4 图标

| 方案 | 做法 | 取舍 |
|------|------|------|
| **X1 字母 X（选）** | 深青圆角底 + HUD 圆环 + 青色字母 X | 16px 最清楚；可能被读成关闭按钮 |
| X2 交叉准星 | HUD 圆环 + X + 中心点 | 最像科幻瞄准界面，不会像关闭 |
| X3 X 徽章 | 六边形外壳 + 双色 X + 中心菱形 | 最独特，但 16px 细节最多 |

选 X1。用户看过 96/64/32/16px 和浅色工具栏预览后选择。已知取舍是「X 可能被读成关闭」；用深青底色、HUD 圆环和青色辉光与关闭按钮区分。如果上线后仍被误读，回退 X2 即可，不改代码结构。

## 7. 数据模型

新增：

```ts
export type ProviderKind = "custom" | "deepseek";

export interface ProviderConfig {
  kind: ProviderKind;
  // 其余字段不变
}
```

DeepSeek 预设集中在一个模块（建议 `src/shared/providers.ts`）：

```ts
export const DEEPSEEK_PRESET = {
  name: "DeepSeek",
  baseURL: "https://api.deepseek.com",
  appendV1: false,
  defaultModel: "deepseek-flash",
  fallbackModels: ["deepseek-flash", "deepseek-v4-pro"],
} as const;
```

说明：

- 2026-11-09 的 DeepSeek 官方模型名是 `deepseek-flash` 和 `deepseek-v4-pro`；`deepseek-chat` / `deepseek-reasoner` 已退役，不再作为默认值。
- `fallbackModels` 只用于「还没拉取成功」时的下拉候选；「拉取模型」成功后以 `/models` 返回为准。
- 已有存量的 `kind: "custom"` 不需要迁移；读取设置时把缺失/未知的 `kind` 归一为 `"custom"`。
- `kind` 只影响 UI 默认值和请求体附加项，不改变缓存键结构。

## 8. Popup 交互

### 8.1 入口和尺寸

- manifest 的 `action.default_popup` 指向 `popup.html`。
- popup 宽度约 380–420px，最大高度不超过 Chrome popup 限制；内容超出时内部滚动。
- 视觉：量子青 C（见 §12）；深青玻璃面板、HUD 边角、青色焦点环。
- 顶部：小图标 + 「翻译设置」；右上角「高级设置」文字按钮。
- 底部固定操作区：「打开侧栏」主按钮，旁边提示 `Alt+S`。

### 8.2 已有 provider

- 顶部一个 `<select>` 列出所有配置，显示名称和当前使用标记。
- 选中后加载到下方表单；表单只编辑该 provider。
- 非当前使用的 provider 旁提供「设为当前」按钮；保存新 provider 时，如果当前没有 active provider，则自动成为 active。
- 删除仍放在 `options.html`，popup 不做破坏性删除。

### 8.3 新增 provider

- 「新增」按钮展开类型选择：
  - **DeepSeek**（默认）：名称自动 `DeepSeek`，baseURL 预设，隐藏 baseURL/`/v1`/请求头。
  - **自定义 OpenAI 兼容**：显示名称、baseURL、自动补 `/v1`、API Key、模型。
- 表单字段：
  - DeepSeek：API Key、模型（input + datalist）、「拉取模型」、「测试连接」、「保存」。
  - 自定义：名称、baseURL、自动补 `/v1`、API Key、模型（input + datalist）、「拉取模型」、「测试连接」、「保存」。
- 编辑已保存 provider 时，API Key 输入框留空表示不修改，占位符显示 `已保存（sk-****1234）`。
- 高级字段（自定义请求头、并发/RPS/温度覆盖、系统提示词）不在 popup 出现，统一去 `options.html` 编辑。

### 8.4 拉取模型

- 点击「拉取模型」时，用当前表单值构造 `ProviderConfig`（已保存的 Key 会复用），调用现有 `listModels`。
- DeepSeek 的 URL 为 `https://api.deepseek.com/models`（`appendV1: false`）。
- 成功：把返回的模型 id 填入 datalist，状态显示「已获取 N 个模型」。
- 失败：状态显示「拉取失败，可直接手填」，不阻塞保存；DeepSeek 仍保留 fallback 候选。
- 不在 popup 打开时自动发网络请求，避免每次点按钮都打 `/models`。

### 8.5 保存和测试连接

- 保存走现有 `upsertProvider` / `getSettings`。
- popup 构造配置时必须以**已保存的 provider 为底**，只覆盖表单里可见/可编辑的字段：`kind`、`name`（可见时）、`baseURL`（DeepSeek 用预设）、`appendV1`（DeepSeek 用 `false`）、`apiKey`（留空保留原值）、`model`。`createdAt`、`lastUsedAt`、`extraHeaders`、`overrides` 原样保留。
- 这样自定义网关的鉴权请求头、覆盖项不会因为 popup 保存/拉取/测试而被清空。
- 校验：DeepSeek 只校验 API Key 和模型；custom 继续校验 baseURL、API Key、模型。
- 「测试连接」复用现有 `complete` 的 ping 行为，显示耗时或分类错误；错误信息不包含 API Key。

### 8.6 打开侧栏

- 「打开侧栏」按钮在 popup 的用户手势中调用：
  - 优先 `chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT })`；
  - 失败时回退到查询当前 tab 后 `chrome.sidePanel.open({ tabId })`。
- 调用后 `window.close()` 关闭 popup。
- 失败静默处理，不把 Chrome 内部错误显示给用户。
- `Alt+S` 命令和现有 `sidePanel.open` 路径保持不变。

### 8.7 侧栏聊天思考开关

- 侧栏 provider 栏在 active provider 为 DeepSeek 时显示一个「思考模式」复选框，默认关闭。
- 开关状态只保存在当前侧栏会话内，不写入设置；重新打开侧栏恢复默认关闭，避免悄悄改变翻译默认行为。
- 开关只影响聊天请求；翻译和「测试连接」永远关闭 thinking。
- 切换 provider 时开关保留用户当前选择，但只对 DeepSeek 生效；custom provider 隐藏该控件。
- 视觉：沿用 C 主题；开关用青色 HUD 样式，但保持至少 44px 点击区域和可见焦点环。
- 聊天请求的协议增加可选 `thinking?: boolean` 字段，由侧栏发送给背景；背景原样传给 provider。

### 8.8 高级设置

- 「高级设置」调用 `chrome.runtime.openOptionsPage()`；失败时回退到 `chrome.tabs.create({ url: chrome.runtime.getURL("options.html") })`。
- `options.html` 继续保留完整 provider CRUD 和全局设置。

## 9. DeepSeek 请求行为

DeepSeek V4 默认开启 thinking mode；翻译场景不需要长推理，且 thinking 模式下 `temperature` 不生效。用户选择：**默认全部关闭，侧栏聊天可手动打开**。

实现方式：

- `CompletionRequest` 增加可选 `thinking?: boolean`；`ChatClientToBackground` 的 `chat` 消息也增加可选 `thinking?: boolean`，从侧栏传到背景。
- `buildBody` 只在 `cfg.kind === "deepseek"` 时处理：
  - `req.thinking === true`：不发送 `thinking` 字段，使用 DeepSeek 默认的 thinking（enabled / high effort）。
  - 其他情况（翻译、测试连接、聊天默认）：发送 `"thinking": { "type": "disabled" }`。
- `custom` provider 完全不发送该字段，避免不支持它的代理报错。
- 翻译的单条流式和多条批量请求都不传 `thinking`，因此默认关闭；测试连接同样不传。
- 侧栏聊天把复选框状态作为 `thinking` 传给背景；`runChat` 再传给 `streamCompletion`。
- 不新增 DeepSeek 专用 adapter；`getAdapter` 仍返回同一套 OpenAI 兼容实现。
- 模型列表和聊天 URL 继续由 `normalizeBaseURL` 生成；DeepSeek 预设固定 `appendV1: false`。

## 10. Options 页面

- provider 表单增加「类型」选择：DeepSeek / 自定义 OpenAI 兼容。
- 类型选择只在**新增**时可切换；编辑已保存 provider 时锁定为原 `kind`，只显示类型标签。要换类型就新建一个配置，避免隐式转换 baseURL/请求头/覆盖项。
- 选择 DeepSeek：自动填 `baseURL` 和 `appendV1: false`，隐藏 baseURL/`/v1` 输入；保留 API Key、模型、请求头、覆盖项、系统提示词等高级字段。
- 选择自定义：显示 baseURL/`/v1`，行为与现在一致。
- `options.html` 的「新增配置」默认类型保持 **custom**，和现有行为/测试一致；只有 popup 的新增默认是 DeepSeek。
- 视觉：options 页换成 C 主题（深色背景、HUD 卡片、青色强调），布局和 DOM 结构不变。
- 全局设置区域不动。

## 11. 背景、manifest、构建

- `public/manifest.json`：
  - `action.default_popup = "popup.html"`
  - `action.default_icon` 和顶层 `icons` 指向 16/32/48/128 PNG
  - `action.default_title = "翻译设置"`
- 删除背景里的 `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`；popup 已接管 action 点击，保留它会误导。
- `Alt+S` 命令、`open-chat` 运行时消息、侧栏 `sidePanel.open` 路径保持不变。
- `vite.config.ts` 增加 `popup: src/popup/index.html` 入口；现有 HTML flatten 插件会输出 `popup.html`。
- `scripts/check-build.mjs` 增加对 `action.default_popup` 和 icon 文件的校验。
- `tests/unit/build.test.ts` 断言 `popup.html`、manifest popup/icons、四个 PNG 存在。

## 12. 视觉系统：量子青 C

用户看过三个 popup mockup 后选择 C，并要求 popup、options、侧栏三个界面统一。视觉方向是「精密仪器面板」：深青底、HUD 边角、点阵/网格、青色辉光，克制为主，不堆装饰。

### 12.1 设计 token

- 页面底：`#04060c`；面板底：`#061513` / `#071615`；玻璃面板：`rgba(7, 22, 21, .92)`。
- 主色：`#2dd4bf`；辅助色：`#67e8f9`；正文：`#dffcf7`；次级文字：`#6e9f99`。
- 边框：`rgba(45, 212, 191, .30)`；输入框边框：`rgba(45, 212, 191, .18)`；输入框底：`rgba(4, 14, 14, .80)`。
- 按钮：主按钮 `linear-gradient(135deg, #2dd4bf, #67e8f9)` + 深色字；次按钮深青透明底 + 青色边框。
- 字体：中文用系统 sans；英文、数字、微标签用 `ui-monospace`；微标签大写、加 letter-spacing。
- 装饰：HUD 边角线、点阵/网格、细扫描线、状态脉冲；装饰不能盖住文字，不能降低对比度。
- 动效：150–250ms；`prefers-reduced-motion: reduce` 时关闭脉冲/扫描/位移动效。
- 可读性：正文和按钮文字对比度 ≥ 4.5:1；focus ring 用主色，清晰可见；不依赖颜色单独传达状态。
- 不使用远程字体、远程图片或运行时 CSS；全部本地 CSS。

### 12.2 应用范围

- **popup**：完整 C 主题，深青玻璃面板 + HUD 边角 + 青色焦点环。
- **options**：页面背景、卡片、表单、按钮全部换 C；保留现有布局、DOM 结构和 class，只改 CSS token/样式。
- **侧栏聊天**：背景、消息气泡、引用块、输入区、provider 栏换 C；不改聊天结构，只改样式和 thinking 开关。
- **实现方式**：popup 新建 `src/styles/popup.css`；options 和 panel 在现有 CSS 上替换颜色/边框/阴影，优先用 CSS 变量，避免大改 DOM。
- `color-scheme: dark`；滚动条、select、input 的暗色原生控件也要统一，避免出现白底控件。

## 13. 图标：X1 字母 X

- 源文件：`public/icons/icon.svg`，128×128。
- 设计：深青圆角方块（`#0b2b28` → `#04100f`），细 HUD 圆环，居中青色字母 X（`#7ff7e6`），青色辉光；16px 版本可省略或加粗圆环，保证 X 清楚。
- 导出：`sips -s format png` 生成 128，再缩放到 32/48/16；PNG 提交到 `public/icons/`。
- manifest 引用 PNG；SVG 只作为源文件保留，不依赖运行时渲染。
- 已知取舍：X 可能被读成关闭按钮；用深青底色、HUD 圆环和青色辉光区分，不使用红色/白色关闭样式。若上线后仍被误读，回退 X2 交叉准星，不改代码结构。

## 14. 测试计划

- `tests/unit/popup-dom.test.ts`
  - 无 provider 时默认展示 DeepSeek 表单，baseURL/`/v1` 不出现。
  - 选择自定义时显示 baseURL/`/v1`。
  - DeepSeek 保存后 `kind: "deepseek"`、baseURL 为预设、`appendV1: false`。
  - 已有 provider 加载、留空 Key 不覆盖、掩码显示正确。
  - 「拉取模型」成功填充 datalist，失败显示可手填提示且不阻塞保存。
  - 「测试连接」成功/失败文案，不泄露 Key。
  - 「打开侧栏」调用 `chrome.sidePanel.open` 并关闭 popup。
  - 「高级设置」调用 `chrome.runtime.openOptionsPage`。
- `tests/unit/options-dom.test.ts`
  - 编辑 DeepSeek provider 保留 `kind` 和预设 baseURL。
  - 类型选择切到 DeepSeek/自定义时字段显示和保存值正确。
- `tests/unit/options-providers.test.ts`
  - DeepSeek 预设常量、校验规则（只要求 Key + 模型）。
- `tests/unit/openai.test.ts`
  - DeepSeek 默认请求体包含 `thinking: { type: "disabled" }`。
  - `thinking: true` 时省略 `thinking` 字段，使用 DeepSeek 默认 thinking。
  - custom 请求体不包含该字段。
  - DeepSeek `/models` URL 不带 `/v1`。
- `tests/unit/panel-dom.test.ts`
  - active provider 为 DeepSeek 时显示「思考模式」，默认关闭；custom 时隐藏。
  - 默认聊天消息带 `thinking: false`；勾选后带 `thinking: true`。
- `tests/unit/dispatch.test.ts`（如现有测试结构适用）
  - 聊天的 `thinking` 字段从消息传到 `streamCompletion`；翻译不传该字段。
- `tests/unit/build.test.ts`
  - `dist/popup.html`、manifest `action.default_popup`、`icons`、四个 PNG 存在。
- `tests/unit/background-index.test.ts`
  - 移除对 `setPanelBehavior` 的期望；保留侧栏命令/`open-chat` 的测试。
- 现有 UI 测试继续通过：视觉主题只换 CSS；panel 除新增 thinking 开关外，其他 DOM 结构和 class 不变；如有个别选择器依赖颜色，改成不依赖颜色。
- 手动视觉检查：
  - popup、options、侧栏三个界面都呈 C 主题，没有残留白底控件。
  - 正文、按钮、输入框在深色背景下清晰；键盘 Tab 的 focus ring 可见。
  - 16px 图标在浅色和深色工具栏都能认出 X；128px 图标不糊。
  - `prefers-reduced-motion` 下没有脉冲/扫描动画。
- 手动功能检查：点扩展按钮弹 popup；DeepSeek 填 Key、拉取模型、保存；点「打开侧栏」；`Alt+S` 仍能开侧栏；旧 custom 配置仍可编辑；侧栏 thinking 开关默认关闭、可打开。

## 15. 已做的决定

- popup 只放模型配置，全局设置继续留在 `options.html`。
- 按钮点击归 popup；侧栏用 popup 按钮和 `Alt+S`。
- DeepSeek 是 OpenAI 兼容预设，不是独立 adapter。
- DeepSeek 默认全部关闭 thinking；侧栏聊天提供手动开关，只影响聊天。
- 新 provider 不自动抢占已有 active provider；只有当前没有 active 时才自动设为 active。
- 视觉方向 C 量子青，应用到 popup、options、侧栏三个界面。
- 图标 X1 字母 X；已知可能像关闭按钮，用深青 + HUD 圆环 + 青色辉光区分。
- 视觉主题除 thinking 开关外只改 CSS/token，不改 options/panel 的 DOM 结构和交互。

## 16. 留给实现者

- 具体 CSS token 命名、间距、圆角、HUD 边角的精确画法。
- popup 的滚动区域、按钮顺序、中文文案和错误提示措辞。
- 三个界面的对比度实测与微调；暗色原生 select/input/scrollbar 的样式。
- X1 SVG 的渐变角度、圆环粗细、字重，以及 16px PNG 的单独检查。
- 测试 fixture 的具体 DOM 结构和 chrome mock 方式。

