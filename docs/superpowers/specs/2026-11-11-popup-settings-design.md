# Popup 设置整合设计（2026-11-11）

## 1. 背景与目标

现在设置分成两个入口：

- `popup.html`：只负责模型配置的常用字段。
- `options.html`：独立设置页，包含完整的模型 CRUD、请求头、覆盖项、全局翻译设置、性能参数、提示词和缓存清理。

用户希望所有设置都回到 toolbar popup，用折叠分组组织；模型设置和翻译设置各自独立；复杂内容进入二级视图。以后新增设置项时，可以沿用现有的分组结构拆分、移动或合并，而不是继续堆在一个页面里。

**目标**

- 所有用户可改的设置都能在 popup 内完成。
- 顶层只放分组、摘要、常用开关和入口；复杂表单进入二级视图。
- 删除独立的设置页和重复的设置实现。
- 保留现有设置数据、API Key 掩码、提示词版本和缓存逻辑。

**非目标**

- 不重做主题、不引入前端框架。
- 不改翻译、队列、缓存、provider 请求协议。
- 不增加新的设置项，只重新组织已有设置。
- 不做设置页的响应式多栏布局；popup 仍是窄屏单列。

**反目标**

- 不保留两套并行的设置 UI。
- 不把完整模型编辑表单平铺在 popup 首屏。
- 不让 popup 打开时发网络请求。
- 不把完整 API Key 渲染到 DOM。
- 不要求用户迁移或重新填写已有配置。

## 2. 用户已确认的决定

- 设置全部放进 popup，不再有独立的设置页。
- 用折叠方式分组。
- 模型设置单独成组，翻译设置单独成组。
- 复杂项进入二级视图。
- 采用方案 A：折叠区 + 二级页。

## 3. 现状与约束

- popup 当前宽度 400px，`#root` 最大高度 600px，整体滚动。
- options 页有 1063 行逻辑和 547 行样式，包含完整 provider 表单和全局设置。
- 现有 provider 表单已有单元测试覆盖：新增、编辑、复制、删除、测试连接、请求头、覆盖项、DeepSeek 预设、API Key 保留。
- `options.html` 被以下位置引用：
  - manifest 的 `options_page`；
  - background 的 `open-options` 消息处理；
  - 内容脚本错误横幅的「设置」按钮；
  - 侧栏的「设置」按钮；
  - popup 头部的「高级设置」按钮。
- 现有设置存储结构不变，不需要数据迁移。
- Chrome 扩展 popup 在点击外部时会关闭；二级视图中的未保存内容有丢失风险，这是本设计的已知限制。

## 4. 方案比较

### A. 折叠区 + 二级页（选中）

顶层四个折叠区；模型管理进入同一 popup 内的二级页，带返回按钮。复杂表单只存在于二级页。

优点：符合“模型/翻译分开”和“复杂项二级”；顶层短；以后新增设置项只需注册到某个折叠区。  
代价：popup 内需要视图栈和二级页样式；popup 关闭会丢失未保存编辑。

### B. 顶部 Tab + 折叠区

模型 / 翻译 / 高级三个 Tab，每个 Tab 内再折叠。

优点：分组更硬，适合设置很多的情况。  
代价：多一层导航，和用户要求的“折叠”不一致；在 400px 宽度下 Tab 也更挤。

### C. 全部折叠，复杂项内联展开

所有内容都在一层，用折叠控制长度。

优点：实现最简单。  
代价：模型编辑会把其他设置推到很下面；不是真正的二级结构，以后拆分困难。

选择 A。

## 5. 信息架构

### 5.1 顶层 popup

```text
┌ 翻译设置 ─────────────────────────┐
│ ▸ 模型设置   DeepSeek · deepseek-flash │
│ ▾ 翻译设置   简体中文 · 快捷键触发     │
│   目标语言 [简体中文 ▾]               │
│   翻译范围 ...                        │
│   触发方式 ...                        │
│   学习注释 [x]                        │
│   [保存翻译设置]  已保存              │
│ ▸ 性能与提示词   并发 3 · RPS 5       │
│ ▸ 缓存维护       清理本地翻译缓存      │
│                                     │
│ [打开翻译侧栏]                       │
└─────────────────────────────────────┘
```

- 四个顶层折叠区：
  1. **模型设置**
  2. **翻译设置**
  3. **性能与提示词**
  4. **缓存维护**
- 同一时间只展开一个折叠区（accordion），避免 popup 变成一条长列表。
- 默认展开「模型设置」；没有模型配置时也展开「模型设置」，直接显示添加入口。
- 每个折叠区的 summary 显示标题和一行摘要，例如当前模型、目标语言、并发/RPS、缓存说明。
- 每个折叠区内部可以有自己的保存按钮和状态文字，互不干扰。
- 底部保留「打开翻译侧栏」和快捷键提示。

### 5.2 模型设置（顶层）

- 有配置且有当前配置时：
  - “当前模型”下拉选择，切换即保存 `activeProviderId`。
  - 当前配置摘要：provider 名称、模型、接口地址、脱敏 Key。
  - 「测试连接」快捷按钮，直接测试当前配置。
  - 「管理模型」按钮，进入二级页。
- 有配置但没有当前配置（`activeProviderId === ""`，例如刚删掉当前项）：
  - 下拉框显示“请选择模型”占位项，不自动把第一项当成当前模型。
  - 摘要显示“未选择当前模型”。
  - 「测试连接」禁用，直到用户选择或把某个配置设为当前。
  - 「管理模型」仍可用；二级页每张非当前卡片提供“设为当前”。
- 没有配置时：
  - 显示“还没有模型配置”。
  - 「添加模型」按钮，进入二级页并直接打开新增表单。

### 5.3 模型管理（二级页）

```text
← 模型管理
[新增配置]
┌ 官方配置  当前使用 ┐
│ 接口地址 / 模型 / 脱敏 Key │
│ [编辑] [复制] [测试] [删除] │
└──────────────────┘
┌ 备用配置 ┐
│ ...      │
└──────────┘

（点击新增/编辑后，在列表下方展开完整表单）
```

- 顶部有返回按钮，返回顶层 popup。
- 顶部有「新增配置」按钮。
- 列表复用现有 provider card 的信息层级：名称、当前标记、接口地址、模型、脱敏 Key、覆盖项摘要。
- 每个卡片提供：编辑、复制、测试连接、删除；非当前配置额外提供“设为当前”。
- 编辑/新增表单在同一个二级页内展开，不进入第三层。表单字段与现有 options 页一致：
  - 类型（仅新增可选；已有配置只读）
  - 名称、接口地址、自动补 `/v1`
  - API Key（已有配置留空表示不修改）
  - 模型 + 拉取模型
  - 自定义请求头（最多 5 条）
  - 并发 / RPS / 温度覆盖项
  - 系统提示词覆盖项
  - 保存配置 / 取消 / 测试连接
- 保存后关闭表单、刷新列表和顶层摘要，并显示“已保存”。
- 所有顶层折叠区始终挂载在 DOM 中，accordion 只做显示/隐藏，不重新创建字段；切换折叠区不会丢掉已输入但未保存的值。
- provider 表单有独立的脏状态检查：返回顶层、关闭表单、编辑另一张卡片、新增另一张卡片或删除当前卡片前，如果有未保存修改，先在表单内显示“放弃未保存的修改？”和“放弃 / 继续编辑”两个按钮；不使用原生 `confirm()`，避免 popup 被系统弹窗打断。
- 删除配置和清空缓存也使用表单内/分组内的两步确认（第一次点击变成“确认删除/确认清空”，再点一次执行），不使用原生 `confirm()`。
- 打开二级页不发起网络请求；只有「拉取模型」「测试连接」会请求。
- 新增配置默认沿用当前 popup 的行为：类型为 DeepSeek，名称为 `DeepSeek`，接口地址为 DeepSeek 预设，模型为默认 DeepSeek 模型；用户可以切换到 custom。新增表单的 id/createdAt 在类型切换时保留。

### 5.4 翻译设置（顶层折叠区）

- 目标语言下拉（沿用现有语言列表和自定义值兜底）。
- 最小翻译长度。
- 只翻译正文。
- 翻译触发方式（快捷键 / 自动当前站点）。
- 学习注释开关。
- 「保存翻译设置」按钮 + “已保存/保存失败”状态。

### 5.5 性能与提示词（顶层折叠区）

- 并发上限。
- 每秒请求上限。
- 温度。
- 全局系统提示词。
- 「保存高级设置」按钮 + 状态。

### 5.6 缓存维护（顶层折叠区）

- 清空翻译缓存按钮。
- 确认对话框。
- 成功/失败状态。
- 说明这是本地缓存，不清除模型配置。

## 6. 技术设计

### 6.1 模块拆分

新增 `src/settings/`，把设置 UI 从 options 页迁移出来：

```text
src/settings/
  components.ts        # el、field、number control、折叠区、状态等 DOM helpers
  settings-view.ts     # 视图栈、顶层渲染、保存协调、摘要刷新
  sections/
    model.ts           # 顶层模型摘要 + 二级模型管理
    translation.ts     # 翻译设置
    advanced.ts        # 性能与提示词
    maintenance.ts     # 缓存维护
  provider-form.ts     # 原 options/providers.ts 的表单纯函数
```

- `src/popup/main.ts` 保留 popup 外壳：主题注入、header、滚动容器、footer、侧栏打开逻辑；设置内容交给 `createSettingsView`。
- `src/popup/index.html` 继续作为唯一设置入口。
- 删除 `src/options/index.html`、`src/options/main.ts`、`src/styles/options.css`。
- `src/options/providers.ts` 移到 `src/settings/provider-form.ts`；所有引用和测试同步更新。
- 新增 `src/styles/settings.css`，从 `options.css` 提取可复用的表单/卡片/折叠区样式，并改成 popup 的 quantum 深色变量；`popup.css` 只保留外壳和滚动布局。

### 6.2 分组注册表

为了以后能拆分/合并设置项，顶层折叠区用描述对象驱动：

```ts
interface SettingsSection {
  id: "model" | "translation" | "advanced" | "maintenance";
  title: string;
  summary(settings: Settings): string;
  render(ctx: SettingsSectionContext): HTMLElement;
  defaultOpen?: boolean;
}
```

- `settings-view.ts` 维护 `SettingsSection[]`。
- 新增设置项时，在对应 section 的 `render` 里加字段；需要移动时改注册表顺序或归属，不重写 popup 外壳。
- 二级视图用简单视图栈表示：
  ```ts
  type SettingsView = { kind: "home" } | { kind: "models" };
  ```
  以后需要更多二级页时扩展 union，不引入路由库。

### 6.3 状态与保存

- `settings-view` 持有当前 `Settings`，启动时 `getSettings()`。
- 顶层模型选择、provider 保存、全局保存后都重新 `getSettings()`，再刷新摘要和列表。
- 通用保存函数：
  ```ts
  async function savePatch(patch: Partial<Settings>): Promise<void>
  ```
  - 合并到当前 settings；
  - 如果 `systemPrompt` 或 `glossaryEnabled` 变化，重新计算 `promptVersion`（复用 `buildEffectiveSystemPrompt` 和 `promptVersionFor`）；
  - `saveSettings` 后刷新内存状态。
- 模型保存继续使用 `upsertProvider` / `removeProvider`。
- 清缓存继续使用 `TranslationCache("ilmt").clear()`。
- 网络调用只在点击「拉取模型」「测试连接」时发生。

### 6.4 视图与滚动

- popup 的 `#root` 改为 flex 纵向布局：
  - header 固定；
  - `.popup-scroll` 负责滚动；
  - footer 固定。
- 这样二级页的返回按钮和底部「打开翻译侧栏」始终可见。
- 顶层使用 `<details>` / `<summary>` 实现折叠，键盘可操作；accordion 行为由 `toggle` 事件维护（打开一个时关闭其他）。
- 切换视图时把焦点移到返回按钮或页面标题，方便键盘用户。

### 6.5 删除独立设置页后的入口

- manifest 删除 `options_page`。
- `vite.config.ts` 删除 `options` 入口。
- popup 头部删除「高级设置」按钮。
- background 的 `open-options` 消息保留原消息名，但行为改为：
  1. 优先 `chrome.action.openPopup()`；
  2. 不可用或失败时，打开 `popup.html?mode=page` 标签页。
- `popup.html?mode=page` 复用同一个设置组件，只加 `body.page-mode`：
  - 宽度放宽到约 560px；
  - `#root` 取消 600px 高度限制；
  - 页面自身滚动，内容不丢。
  - 「打开翻译侧栏」按钮保留；成功打开侧栏后，page mode 不关闭当前标签页，只有真正的 popup 才调用 `window.close()`。
- 保留 `chrome.action.openPopup()` 尝试，但不提高 `minimum_chrome_version`（仍为 120）。该分支在测试中覆盖成功和失败；真实环境中如果因为版本或无用户手势失败，就落到 `popup.html?mode=page`，功能不受影响。
- 内容脚本错误横幅和侧栏的「设置」按钮继续发 `open-options`，不需要改用户可见的行为。
- 这样不存在第二套设置实现；`popup.html` 是唯一设置文档。

### 6.6 样式

- 继续使用 `theme.css` 的 quantum 深色变量。
- 折叠区：细边框、transparent 背景、summary hover；展开时显示分组内容。
- provider card、表单、按钮、状态色从 options.css 迁移并改用 `var(--ilmt-*)`。
- 不保留 options 页的浅色页面背景和 980px 居中布局。
- popup 宽度保持 400px；`mode=page` 时最大宽度约 560px，居中。

## 7. 迁移与兼容

- `Settings` 结构不变；已有 provider、promptVersion、缓存都不迁移。
- 删除 `options.html` 后，旧书签或外部链接会 404；这是可接受的，因为设置入口统一到 popup。README 和文档同步更新。
- `open-options` 消息名保留，避免同时改 content、panel、background 三处协议；只是处理函数改名为 `openSettings`。
- 如果 `chrome.action.openPopup()` 在用户当前 Chrome 版本不可用，`popup.html?mode=page` 兜底保证设置仍可打开。
- 构建产物检查从“必须存在 options.html”改为“必须不存在 options.html，且存在 popup.html”。

## 8. 错误与边界

- 读取设置失败：popup 显示“读取设置失败，请重试”，不崩溃。
- 保存失败：分组内显示“保存失败”，保留用户当前输入。
- 保存 provider 失败：表单不关闭，显示状态，保留输入。
- API Key 永远只显示掩码或空输入框；错误信息不得包含 Key。
- 没有 provider 时：模型设置显示添加入口；其他分组仍可打开。
- 有 provider 但 `activeProviderId === ""`：显示“未选择当前模型”，不自动选第一项；用户可在下拉框或二级页选择。
- 删除当前 provider：background/storage 会清空 activeProviderId；popup 刷新后进入“未选择当前模型”状态。
- 删除配置、清空缓存、放弃未保存表单都使用内联两步确认，不调用原生 `confirm()`，避免 popup 被系统弹窗关闭。
- popup 在二级编辑时被关闭：未保存内容丢失，这是已知限制；不做草稿持久化。
- `chrome.action.openPopup()` 在无用户手势时可能失败：走 `popup.html?mode=page` 兜底，不向页面抛错；不提高最低 Chrome 版本。

## 9. 测试计划

### 单元测试

- 新增 `tests/unit/settings-dom.test.ts`：
  - 顶层渲染四个折叠区和摘要；
  - 默认展开模型设置；accordion 一次只开一个；
  - 切换折叠区不重新创建字段，未保存输入仍在；
  - 无 provider 时显示添加入口；有 provider 但 activeProviderId 为空时显示“未选择当前模型”，测试连接禁用；
  - 模型二级页：返回、添加、编辑、复制、删除、测试、请求头、覆盖项、Key 掩码；
  - 新增配置默认 DeepSeek，切换 custom 后已输入的 Key/model 不丢；
  - provider 脏表单的“放弃 / 继续编辑”内联确认，以及删除配置的两步确认；
  - 翻译设置保存目标语言、范围、触发方式、学习注释；
  - 高级设置保存并发/RPS/温度/提示词，并正确重算 promptVersion；
  - 清缓存的两步确认和状态；
  - 保存失败状态；
  - `mode=page` 类名，以及 page mode 打开侧栏后不关闭标签页。
- `tests/unit/popup-dom.test.ts`：
  - popup 外壳、主题、侧栏打开逻辑；
  - 不再有“高级设置”按钮；
  - 设置入口可用。
- `tests/unit/background-index.test.ts`：
  - `open-options` 优先调用 `chrome.action.openPopup()`；
  - API 不可用/失败时打开 `popup.html?mode=page`；
  - 既有 trusted sender 规则不变。
- `tests/unit/build.test.ts`：
  - manifest 不再有 `options_page`；
  - 不生成 `dist/options.html`；
  - 仍生成 `popup.html`。
- `tests/unit/options-providers.test.ts`：更新 import 路径，保留纯函数覆盖；删除 `options-dom.test.ts`，覆盖迁移到 settings-dom。

### E2E

- 更新现有 `shows granularity defaults...`：
  - 打开 `popup.html`；
  - 验证折叠区、默认值、当前 provider；
  - 打开模型管理二级页并返回；
  - 不打开 `options.html`。
- 保持现有翻译/还原/划词/E2E 用例不变。

### 手动验证

- 点击扩展图标，popup 正常打开，四个折叠区可见。
- 模型管理进入二级页，返回不丢失当前设置。
- 修改翻译设置并保存，刷新 popup 后仍生效。
- 内容脚本错误横幅和侧栏的「设置」入口能打开 popup 或 `popup.html?mode=page`。
- 页面、popup、侧栏无红色报错。

## 10. 由 builder 决定的部分

- 折叠区内部各字段的具体 DOM 结构和 class 命名。
- provider card 和表单的具体视觉细节（间距、按钮排列）。
- 是否需要把 provider 表单的脏检查做成通用 helper。
- 具体测试拆分粒度；只要覆盖上述行为即可。

## 11. 验收标准

- `options.html` 不再出现在 manifest、构建产物和用户入口中。
- popup 顶层有四个可折叠分组，模型和翻译各自独立。
- 复杂模型编辑只在二级页出现，带返回。
- 所有现有设置项都能在 popup 内修改并持久化。
- 设置页不再有第二套实现或重复的 provider 表单。
- `npm run verify:delivery`、无头 E2E 和 `check-build` 通过。
- 真实 Chrome 的 popup、二级页、错误横幅设置入口可正常使用。
