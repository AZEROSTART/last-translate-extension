# 翻译粒度控制（最小长度 + 只翻译正文）设计

- 日期：2026-11-11
- 状态：待确认，未实现
- 目标：减少小字、标签、元信息被翻译；保留正文标题、段落、列表和表格。

## 1. 背景与现状

当前段落收集规则：

- 优先扫描 `main`、`article`、`[role="main"]`；没有这些语义标签时扫描整个 `body`。
- 每个块级元素（`p`、`li`、`td`、`div`、`h1`～`h6` 等）内的连续文本算一个“段落”。
- 最小长度写死为 4 个字符。
- 已排除 `nav`、`footer`、菜单、工具栏、按钮、表单、隐藏元素、`code/pre`、时间等。
- 没有排除 `aside`、`small`、`figcaption`、面包屑、byline/post-meta 等小字区域。
- 没有任何面向用户的粒度设置。

结果是：主内容区里的小标签、元信息、说明文字，只要不少于 4 个字符，也会被翻译。

## 2. 目标与非目标

### 目标

- 设置里提供“最小翻译长度”，默认 10 个字符。
- 设置里提供“只翻译正文”开关，默认开启。
- 正文模式额外排开常见的小字/次要区域，同时保留标题、正文段落、列表、表格。
- 两个设置都是全局设置，保存后下一次扫描生效。
- 现有用户升级后立即使用新默认值，不需要手动迁移。

### 非目标（第一版不做）

- 不做按站点自定义选择器。
- 不做基于字体大小的自动判断。
- 不做选中区域翻译、只翻译当前可视区域。
- 不改变现有“块级文本块”的切分单位。
- 不改变 `main`/`article` 优先、缺失时回退 `body` 的扫描策略。

## 3. 已考虑方案

1. **只加最小长度**
   - 简单，能过滤 “Read more” 一类短标签。
   - 过滤不了较长的元信息，也不能处理 `aside` 里的说明文字。
2. **最小长度 + 正文排除规则（采用）**
   - 在现有排除列表上增加 `aside`、`small`、`figcaption`、`[role="complementary"]`、面包屑、常见 byline/post-meta 区域。
   - 成本低，和现有 `excludeSelectors` 机制一致，可单元测试。
   - 对语义化好的页面效果最好；对纯 `div` 页面仍有漏网，但明显减少小字。
3. **字体大小阈值**
   - 直接针对“小字”，但需要读取计算样式，容易误伤图注、脚注，也更容易受站点样式影响。
   - 留作后续增强。

采用方案 2。

## 4. 设置模型

`Settings` 新增：

```ts
minParagraphLength: number; // 默认 10，范围 1～100
contentOnly: boolean;       // 默认 true
```

`DEFAULT_SETTINGS`：

```ts
minParagraphLength: 10,
contentOnly: true,
```

`getSettings()` 校验：

- `minParagraphLength` 必须是有限数字；缺失或非法时回退 10，并夹在 1～100。
- `contentOnly` 必须是布尔值；缺失或非法时回退 `true`。

## 5. 收集规则

`collectParagraphs` 新增 `contentOnly` 选项，并把 `minLength` 从设置传入。

正文模式额外排除：

```text
aside
small
figcaption
[role="complementary"]
[role="contentinfo"]
[role="banner"]
[aria-label*="breadcrumb" i]
[class*="breadcrumb" i]
[class*="byline" i]
[class*="post-meta" i]
[class*="article-meta" i]
```

说明：

- 不排除 `header` 本身，避免误删文章标题区；只排除 byline/meta 类区域。
- `nav`、`footer` 已在基础排除列表中。
- 正文模式仍保留当前 `main`/`article` 优先策略；没有语义主内容时继续扫 `body`，但应用额外排除。
- 动态页面扫描复用同一组 `minLength`/`contentOnly`，避免首次扫描和后续新增内容规则不一致。

## 6. 设置界面

在全局设置区域新增：

- “最小翻译长度”：数字输入，范围 4～100，默认 10，提示“少于这个字符数的文本不翻译”。
- “只翻译正文”：复选框，默认勾选，提示“跳过侧栏、小字、图注、面包屑和常见元信息”。

保存时写入 `Settings`，下一次翻译生效。

## 7. 测试

- 存储：缺失/非法值回退默认；合法值保留。
- 段落收集：
  - `minLength` 生效，短文本不收集。
  - `contentOnly: true` 排除 `aside`、`small`、`figcaption`、面包屑/byline 区域。
  - 标题、正文段落、列表、表格仍被收集。
  - `contentOnly: false` 保持旧行为。
- 设置页：新字段渲染、保存后写入设置。
- 主流程：全量扫描和动态扫描都把设置传给 `collectParagraphs`。

## 8. 风险与取舍

- 默认开启会改变现有用户行为；这是本次需求明确选择。
- `[class*="..."]` 依赖命名，可能漏掉或误伤；第一版只使用较窄的 byline/meta/breadcrumb 关键词。
- 正文模式可能跳过有意义的图注；如果用户需要，可后续加“翻译图注”子开关。
