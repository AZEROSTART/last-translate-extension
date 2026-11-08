# 文本节点级网页翻译 · 设计文档

- 日期：2026-11-08
- 状态：待批准
- 范围：重写内容脚本的「段落识别 + 译文插入」；不改后台、模型、侧栏聊天和右键菜单入口
- 参考：Immersive Translate（沉浸式翻译）已发布产物的静态逆向结果

---

## 1. 意图

现在这版翻译有三个明显问题：

1. **该翻的没翻全**：当前只认「元素自己直接包含文本、且子元素都是 inline」的节点。`<div>` 里混着文本和块级子元素、表格、卡片、列表里的文本经常漏掉。
2. **按钮里塞译文**：`<p>prefix <button>action</button> suffix</p>` 会被识别成按钮自己一段，译文插进按钮内部，按钮被撑变形。
3. **双语排版不好看**：译文有时挤在 flex 行里，和原文/按钮抢宽度；标题译文和正文一样大、一样重。

用户已经选定：

- 实现路线 **C：按文本节点切分，重写成文本节点级片段（piece）**，而不是继续在元素级打补丁。
- 视觉风格 **A：译文弱化 + 左侧细线；标题译文更小、常规字重**。
- 译文一律按**块级**渲染，不再做内联译文。UI 短文本（按钮、导航、表单）本来就会被跳过，块级不会造成「到处都是译文」的噪声。

本轮 scope 采用：**GitHub 主内容 + 仓库简介（首页左侧仓库列表 + 仓库页右侧 About 简介）**；顶部导航、右侧栏其余 UI（Releases / Packages / Contributors 等）、页脚、按钮保持英文。About 简介是仓库描述内容，用精确选择器单独收；右侧栏其他段落是 UI，不收集。通用网页只翻 `main` / `article` / `[role=main]`。整页除按钮留作后续开关，不在本轮做。

---

## 2. 目标 / 非目标 / 反目标

### 目标

- 按钮、导航、表单控件、代码块、隐藏内容里**永远不出现译文**。
- 文本和按钮混排的容器能正确翻译：只翻文本，按钮保持原样，译文不进入按钮。
- GitHub README、issue/PR 正文与评论、列表、表格、引用块、左侧仓库列表简介、仓库页 About 简介都能翻到。
- 译文一律是**新增节点**，原文文本节点一个字符都不改。
- 标题译文更小、更轻；正文译文弱化并有左侧细线；flex/grid 行不会把译文挤成一条窄缝。
- 动态内容（SPA 路由、评论加载、展开文件树）能增量翻译，不重复、不残留。

### 非目标

- 不翻译顶部导航、右侧栏其余 UI（About 简介除外）、页脚、按钮、表单标签、时间、代码。
- 不做富文本译文（译文里的链接、加粗、代码占位符不保留）。
- 不做「整页模式」开关。
- 不改翻译协议、后台缓存、模型 prompt、侧栏聊天。
- 不引入 React / 新的运行时依赖。

### 反目标（即使「能跑」也算失败）

- 为了覆盖全，把按钮/导航/表单文字也翻了。
- 译文插进 `<button>`、`<a role="button">`、`<summary>`、`<label>` 等交互元素内部。
- 为了排版去改页面原有 DOM 结构、给原元素加 `style` 或 class。
- 每次滚动/动态加载都对整页重新翻译，产生重复译文或重复计费。
- 把 `sr-only`、`aria-hidden`、`relative-time`、提交 SHA、日期当成正文翻译。

---

## 3. 约束

- Chrome MV3 content script，TypeScript + 原生 DOM，无 React。
- API Key 只在 background / storage，content script 不碰。
- 不发远程代码；样式走 manifest 注入的 `inject.css`，不往页面插 `<style>`。
- 所有用户可见 UI 文案保持中文。
- 原文文本节点只读；只新增带 `ilmt-tr` class 的节点和 `data-ilmt-p` 标记属性。
- 现有翻译协议、队列、批量、语言检测、错误提示保持不变。
- 单元测试、`npx tsc --noEmit`、`npm run build` 必须通过。

---

## 4. 方案对比（用户已选 C）

| 方案 | 做法 | 代价 | 结论 |
|------|------|------|------|
| A. 元素级 + 站点规则 | 保留现在的「最内层文本元素」识别，补 GitHub 选择器和排除列表 | 改动小，但「文本 + 按钮」混排仍然只能二选一：要么把按钮算进段落，要么整段不翻；flex 行仍然挤 | 否 |
| B. 整页元素级 | scope 放到 `body`，按元素翻 | 覆盖上去了，但导航/按钮/表单噪声大，仍然解决不了混排和排版 | 否 |
| **C. 文本节点级片段** | 在块级容器内按文本节点连续段切 piece，跳过排除子树，译文按块插在安全锚点后 | 要重写 `paragraphs.ts` / `render.ts` / 测试；但这是沉浸式翻译实际采用的做法，能同时解决覆盖、按钮、排版 | **选 C** |

C 的关键点来自对 Immersive Translate 产物的逆向：

- 它按文本节点收集，按块级边界切段，插入位置用 `afterend`，译文是兄弟节点而不是原元素的 child。
- 它有一套站点级 `selectors` / `excludeSelectors`，GitHub 规则明确包含 `.Layout-sidebar p`、`article p`、`h1`、`.markdown-body` 等，排除了 `a[data-hovercard-type]`、`.blob-code`、`.timeline-comment-header`、`.author`、`.assignee`、`a.anchor` 等。
- 它有短文本/URL/邮箱/纯数字/日期/handle/hash 过滤。
- 它的 `weakening` 主题是降低透明度，`dividingLine` 是左边线；本轮把它固化成风格 A。

---

## 5. 总体结构

新增/改动模块：

```
src/content/site-rules.ts     新增：通用 + GitHub 的 scope / 额外文本选择器 / 排除选择器
src/content/paragraphs.ts     重写：文本节点级 piece 收集、过滤、缓存、标记
src/content/render.ts         重写：按锚点插入块级译文；flex/grid/标题特殊处理
src/content/registry.ts       小改：记录 anchor + heading，prune 同时检查 anchor
src/content/main.ts           小改：传 anchor/heading 渲染；失效按 piece root 处理；重置缓存
src/styles/inject.css         改：风格 A + 标题 + flex/grid 断行 class
tests/unit/*                  更新/新增
```

数据流不变：

```
activate → collectParagraphs(body) → queueNodes → port translate
        → delta/result → renderTranslation(target, id, text) → inject.css
        → restore → restoreAll + resetPieceCache
```

---

## 6. 站点规则（site-rules.ts）

### 6.1 类型

```ts
export interface SiteRule {
  id: "generic" | "github";
  disabled?: boolean;
  scopeSelectors: string[];
  extraTextSelectors: string[];
  excludeSelectors: string[];
  /**
   * 只在 scope 遍历时跳过，不参与额外选择器的祖先检查。
   * 用来跳过右侧栏这类整块 UI，同时允许 extraTextSelectors 精确地把里面的 About 简介收回来。
   */
  scopeExcludeSelectors?: string[];
  /** Optional display overrides, kept for site rules that need them. Empty this round. */
  extraInlineSelectors?: string[];
  extraBlockSelectors?: string[];
}

export function getSiteRule(url: string): SiteRule;
```

`getSiteRule` 只按 hostname/path 判断，不读页面内容。

### 6.2 通用排除（BASE）

所有站点都跳过：

- 非内容标签：`script`, `style`, `noscript`, `template`, `pre`, `code`, `kbd`, `samp`
- 表单/交互：`textarea`, `input`, `select`, `option`, `optgroup`, `datalist`, `button`, `[role='button']`, `label`, `legend`, `summary`, `dialog`, `menu`
- 媒体/图形：`svg`, `canvas`, `video`, `audio`, `iframe`, `object`, `embed`, `math`
- 时间/代码引用：`time`, `relative-time`, `[datetime]`
- 隐藏/辅助：`[contenteditable]`, `[aria-hidden='true']`, `[hidden]`, `.sr-only`, `.visually-hidden`
- 不翻译标记：`[translate='no']`, `.notranslate`
- emoji/emoji 包装：`g-emoji`, `img.emoji`
- 自己的 UI：`.ilmt-tr`, `.ilmt-active-banner`, `.ilmt-error-banner`, `.ilmt-bubble`
- ARIA 控件：`[role='tab']`, `[role='menuitem']`, `[role='option']`, `[role='switch']`, `[role='checkbox']`, `[role='radio']`, `[role='slider']`, `[role='spinbutton']`, `[role='combobox']`, `[role='searchbox']`, `[role='textbox']`
- ruby 注音：`rt`, `rp`（保留汉字本体）

### 6.3 通用规则

```ts
{
  id: "generic",
  scopeSelectors: ["main", "article", "[role='main']"],
  extraTextSelectors: [],
  excludeSelectors: [
    ...BASE,
    "nav",
    "footer",
    "[role='navigation']",
    "[role='menu']",
    "[role='menubar']",
    "[role='toolbar']",
    "[role='tablist']",
    "[role='dialog']",
    "[aria-modal='true']",
  ],
}
```

注意：

- **不排除 `header`**：文章/issue 的标题常在 `<header>` 里，要翻。
- **不排除 `aside`**：正文里的提示框、pull quote 要翻；GitHub 左侧仓库列表和右侧 About 简介也要靠额外选择器收集。
- scope 找不到时回退到 `body`（`root` 是 Document 时用 `document.body`）。

### 6.4 GitHub 规则

```ts
{
  id: "github",
  scopeSelectors: [
    "main",
    "#repo-content-turbo-frame",
    "article",
    "feed-container",
  ],
  // 整个右侧栏在 scope 遍历时跳过；只把第一行 About 的简介 p 精确收回来。
  // GitHub 的右侧栏顺序是 About → Releases → Packages → Contributors → Languages；
  // About 是第一个 .BorderGrid-row。如果 GitHub 改 DOM 顺序，调整这个选择器即可。
  scopeExcludeSelectors: [".Layout-sidebar"],
  extraTextSelectors: [
    "h1",
    ".Layout-sidebar .BorderGrid-row:first-child .BorderGrid-cell > p",
    ".p-note",
    "li.repo-list-item p",
    "div.repo-description p",
    "#responsive-meta-container p",
    ".pinned-item-desc",
    ".topic-box > a > p:nth-of-type(2)",
    "main a[href^='/topics/'] > p",
    "article section[aria-label='card content'] p",
    ".js-notice h2",
    ".js-notice p",
  ],
  excludeSelectors: [
    ...BASE,
    "nav",
    "footer",
    "[role='navigation']",
    "[role='menu']",
    "[role='menubar']",
    "[role='toolbar']",
    "[role='tablist']",
    "a[data-hovercard-type]",
    ".blob-code",
    ".timeline-comment-header",
    ".review-thread-reply",
    ".author",
    ".assignee",
    "[data-testid^='breadcrumbs']",
    ".vcard-names-container",
    ".BorderGrid-cell a[role='link']",
    ".BorderGrid-cell .topic-tag-link",
    "[data-testid=list-row-repo-name-and-number]",
    "[title='Label: Private']",
    "a.anchor",
    "[data-test-selector='commit-tease-commit-message']",
    "[data-test-selector='create-branch.developmentForm']",
    ".js-repos-container .markdown-title",
    ".State",
    ".Label",
    ".Counter",
    ".branch-name",
    ".commit-ref",
    ".issue-number",
  ],
}
```

GitHub 路径排除（命中时 `disabled: true`，不翻）：

```
/settings, /login, /signup, /join, /marketplace, /pricing, /features,
/sponsors, /codespaces, /collections, /readme, /site, /about, /contact,
/security
```

只匹配 `github.com` / `www.github.com`；`gist.github.com` 走通用规则。GitHub Enterprise 走通用规则。

### 6.5 scope 解析

- 收集**所有**匹配 `scopeSelectors` 的元素，逐个收集，按锚点去重；不是只取第一个。这样 `main` 和 `#repo-content-turbo-frame` 同时存在时不会漏。
- scope 遍历时，`shouldSkip` 用 `excludeSelectors + scopeExcludeSelectors` 的并集。所以 GitHub 右侧栏 `.Layout-sidebar` 整块被跳过。
- `extraTextSelectors` 在**扫描根**（实际是 `document.body`）里查；每个匹配先 `closest(excludeSelectors)` **只查内容排除**，不查 `scopeExcludeSelectors`。这样 `.Layout-sidebar` 里的 About 简介可以被精确选择器重新收回来，而右侧栏其他 p 不会。
- 额外匹配自己的子树仍然用完整排除集（按钮、时间、代码等照样跳过）。
- 额外选择器可能和 scope 重叠，靠锚点去重。

---

## 7. 文本节点级 piece 收集（paragraphs.ts）

### 7.1 数据模型

```ts
export interface ParagraphNode {
  id: string;
  el: Element;      // piece root：最近的块级容器，用于标记、viewport 排序
  anchor: Node;     // piece 最后一个文本节点，译文插在它后面
  text: string;     // 归一化后的原文
  heading: boolean; // root 是否在标题里
}
```

不再有 `inline` 字段：本轮所有译文都是块级。

### 7.2 收集算法

从 scope（或额外选择器匹配元素）开始，按 childNodes 顺序递归：

```
walk(node, ctx):
  text node:
    非空 → 把文本加入 ctx.parts，ctx.lastText = node
  element:
    if shouldSkip(el):
      if isBlockBoundary(el): flush(ctx)   // 排除的块级元素要断开前后piece
      return
    if tag === "br":
      flush(ctx); return                    // <br> 是硬换行，前后各一段
    if isBlockBoundary(el):
      flush(ctx)
      childCtx = { root: el, heading: ctx.heading || isHeading(el), parts: [], lastText: null }
      walk children with childCtx
      flush(childCtx)
      return
    else: // inline
      walk children with same ctx
```

`flush(ctx)`：

- 没有文本 → 忽略。
- 用 `joinTextParts(ctx.parts)` 拼接、归一化；为空则忽略。
- 产出 `{ root: ctx.root, anchor: ctx.lastText, text, heading: ctx.heading }`。
- 清空 `parts` / `lastText`。

关键行为：

- `<p>prefix <button>action</button> suffix</p>` → 一个 piece，text `"prefix suffix"`，root 是 `<p>`，anchor 是 `" suffix"` 文本节点；按钮文本不进入 piece。
- `<p><button>action</button></p>` → 没有 piece。
- `<div>Text <div>Nested</div> more</div>` → 三个 piece：`"Text"`（root 外层 div）、`"Nested"`（root 内层 div）、`"more"`（root 外层 div）。
- `<p>Hello<br>world</p>` → 两个 piece。
- `<ul><li>Item 1</li><li>Item 2</li></ul>` → 两个 piece，root 分别是两个 `<li>`。
- `<div><p>A</p><p>B</p></div>` → 两个 piece，root 是两个 `<p>`。
- `<div><span>first part</span><span>second part</span></div>` → 一个 piece，text `"first part second part"`（两个 inline 元素之间没有空白时，拼接时补一个 ASCII 空格）。

### 7.3 块级边界判定

```ts
function isBlockBoundary(el: Element, rule: SiteRule): boolean {
  // 标题永远自成一段：即使它是 flex/grid 的直接子项（GitHub 标题栏就是这样），
  // 也要让它拿到 heading:true，译文才能按标题字号缩放进标题内部。
  if (isHeading(el)) return true;

  const parentDisplay = displayOf(el.parentElement);
  // flex/grid 子项会被浏览器 blockify，但它们只是这一行的 item；
  // 只要 item 内部没有块级子元素，就按 inline 对待，让整行归到 flex/grid 容器这一个 piece。
  // 标题已在上方提前返回，不受这条规则影响。
  if ((parentDisplay.includes("flex") || parentDisplay.includes("grid")) && !hasBlockChild(el, rule)) {
    return false;
  }
  return isBlockDisplay(el, rule);
}

function isBlockDisplay(el: Element, rule: SiteRule): boolean {
  if (matchesAny(el, rule.extraInlineSelectors)) return false;
  if (matchesAny(el, rule.extraBlockSelectors)) return true;
  const display = displayOf(el);
  if (!display) return BLOCK_TAGS.has(el.tagName.toLowerCase());
  if (display === "none") return false;
  return !isInlineDisplay(display);
}

function isInlineDisplay(display: string): boolean {
  return display === "inline"
    || display.startsWith("inline-")   // inline-block / inline-flex / inline-grid / inline-table
    || display === "contents"
    || display === "ruby"
    || display === "ruby-base"
    || display === "ruby-text"
    || display === "math";
}

function hasBlockChild(el: Element, rule: SiteRule): boolean {
  for (const child of el.children) {
    // <br> 让这个 flex/grid 子项内部出现硬换行，按“有块级子内容”处理，
    // 让它的每行各自成为 root=该子项的 piece，译文插在子项内部。
    if (child.tagName === "BR") return true;
    if (isBlockDisplay(child, rule)) return true;
  }
  return false;
}
```

`matchesAny(el, selectors)` 在 `selectors` 为空时直接返回 false；非空时包 try/catch 做 `el.matches(selectors.join(","))`。本轮通用/GitHub 规则都不填这两个字段，保留给后续站点规则。

`BLOCK_TAGS` 沿用现有的块级标签集合（`div`, `p`, `li`, `td`, `th`, `tr`, `ul`, `ol`, `section`, `article`, `h1`–`h6`, `blockquote`, `table`, `dd`, `dt`, `details`, `figure`, `figcaption`, `form`, `fieldset`, `header`, `footer`, `main`, `nav`, `aside`, `address`, `center`, `dialog`, `dir`, `dl`, `hgroup`, `hr`, `legend`, `menu`, `pre`, `summary`, `tbody`, `tfoot`, `thead`, `body`, `html`）。

`displayOf` 用 `getComputedStyle`；拿不到时按标签默认值。未知标签（自定义元素）默认 inline，与现有实现一致。

### 7.4 跳过判定

`shouldSkip(el, rule)` 命中任意一条即跳过子树：

- `el.matches([...rule.excludeSelectors, ...(rule.scopeExcludeSelectors ?? [])].join(","))`（选择器由代码控制，包一层 try/catch）。scope 遍历和额外匹配的子树都用这个并集；只有额外匹配的**祖先**检查用 `excludeSelectors`，见 §6.5。
- `computedStyle.display === "none"` 或 `visibility === "hidden"`。
- 有 `shadowRoot` 的元素（避免 light DOM 回退文本和 shadow 内容重复）。
- 我们自己已经插入的 `.ilmt-tr`。

**不再用 `data-ilmt-p` 判断是否跳过**。原因：同一个 root 可能对应多个 piece（文本 + 块级子元素 + 文本），而且动态扫描要能发现 root 内部新增的文本。去重靠锚点缓存（§8）。

### 7.5 文本归一化与过滤

`joinTextParts(parts)`：

- 逐段拼接。
- 如果上一段最后一个字符和下一段第一个字符都是 `[A-Za-z0-9]`，中间补一个空格；中文/标点不补。
- 保留原文本节点里的空白，最后统一 `\s+` → 一个空格，trim。

`normalizeText(text)`：

- 去掉 C0 控制字符（`\u0000-\u001f`）。
- 空白折叠、trim。
- 截断到 20,000 字符。
- 不改 DOM。

`isTranslatableText(text)` 拒绝：

- 少于 `minLength`（默认 4）。
- 没有任何 Unicode 字母（`\p{L}`）。
- URL / `www.` 开头。
- 邮箱。
- 纯路径（`/usr/bin`、`./src`）。
- 无空格的 repo/path 形式（`owner/repo`、`src/content/main.ts`、`owner/repo#123`），避免把仓库名、文件名翻坏。
- 纯 handle（`@foo`）。
- 纯 hash（`#123`、`#section`，中间没有空格）。
- 纯版本号（`v1.2.3`）。
- 纯日期 / 时间（`2026-11-08`、`12:34`）。
- 7–40 位十六进制提交 SHA。
- 带常见代码扩展名的文件名（`.ts`, `.js`, `.css`, `.html`, `.json`, `.md`, `.png`, `.svg`, `.go`, `.py`, `.rs`, `.java`, `.c`, `.cpp`, `.h`, `.sh`, `.yml`, `.yaml`, `.toml`）。

语言跳过沿用现有逻辑：`detectLang` 优先，失败回退 CJK 占比；命中目标语言则跳过。

### 7.6 标题

`heading` = `ctx.heading || /^h[1-6]$/i.test(el.tagName) || role="heading"`。

- 标题里的 piece 带 `heading: true`。
- 标题内的嵌套块（极少见）也继承 heading。
- 标题在 `isBlockBoundary` 里始终返回 true，所以在 flex/grid 标题栏里，`h1` 仍然会成为自己的 piece root，不会退化成整行一个正文 piece。

### 7.7 失效用的 root helper

```ts
export function pieceRootFor(node: Node, rule: SiteRule): Element | null {
  let el = node.parentElement;
  while (el) {
    if (isBlockBoundary(el, rule)) return el;
    el = el.parentElement;
  }
  return null;
}
```

`main.ts` 的 `characterData` 失效用它，保证和 walker 的 root 判定一致：flex 行里的文本找到 flex 行，标题里的文本找到标题，普通段落找到 `<p>`。这个 helper 也让「被跳过的短文本/目标语言 piece」能在文本变化后被重新收集（§8.3）。

---

## 8. piece 缓存与失效

### 8.1 缓存

`paragraphs.ts` 模块级：

```ts
const anchorCache = new Map<Node, { id: string; text: string; root: Element }>();
```

- 用 `Map` 而不是 `WeakMap`，因为失效时要按 root 遍历删除；Map 的强引用通过 `resetPieceCache` 和扫描末尾的「断开锚点清理」控制。
- 缓存同时记录该 piece 的 root。`forgetPiecesInRoot(root)` 只删除缓存 root **正好等于** `root` 的项，不按 DOM 子树删除；这样失效祖先 piece 时，嵌套 block piece 的缓存、record、标记和译文都保留，不会重复收集。
- 只缓存**已经处理过**的锚点：
  - 已排队/已翻译：`id` 是真实 id。
  - 因太短、纯符号、目标语言而跳过：`id === ""`，避免每次动态扫描都重新做语言检测。
- 被跳过的 piece **不打** `data-ilmt-p`（它没有译文，不需要还原）。它的缓存失效靠 `pieceRootFor` + `forgetPiecesInRoot`，见 §8.3；否则「Loading」这类短文本永远不会重试。
- 收集时：
  - 先看 `anchorCache.has(anchor)`，命中就跳过（包括 `id === ""`）。
  - 同一次扫描内用局部 `Set<Node>` 去重，防止 scope + 额外选择器重复收集同一锚点。
  - 新 piece 分配 `p_${++counter}`，写缓存，给 root 追加 `data-ilmt-p`。
- 每次扫描结束，清理 `!anchor.isConnected` 的缓存项，避免 SPA 删节点后泄漏。

### 8.2 标记

`data-ilmt-p` 打在 **piece root** 上，可能包含多个 id：

```html
<p data-ilmt-p="p_12 p_13">...</p>
```

- 新 id 追加，用空格分隔。
- `unmarkPiece(root, id)` 只移除指定 id；没有剩余 id 时删属性。
- `restoreAll` 删掉 root 及子孙上的所有 `data-ilmt-p`。

### 8.3 失效

- `restore()` / `rescan()`：`restoreAll(body)` 后调用 `resetPieceCache()`（清空整个 Map）。
- 扫描被取消（generation 变了、observer 暂停、动态配额不足）：`unmarkNodes(nodes)` 对每个节点 `unmarkPiece(node.el, node.id)` + `forgetPiece(node.anchor)`，让它们下次还能被收集。
- 超过 `MAX_PARAGRAPHS` 的 overflow：同样 `unmarkPiece` + `forgetPiece`，避免缓存住但永远不翻。
- `characterData` 变更：
  - 跳过 `.ilmt-tr` 内部的变更。
  - 用 `pieceRootFor(node, rule)` 找到最近的块级 root。它和 walker 用同一套 `isBlockBoundary`，所以 flex 行里的文本会找到 flex 行，而不是 span。
  - 如果 root 有 `data-ilmt-p`：`invalidatePieceRoot(root)`：
    - 读出 root 上所有 id；
    - 按 id 删对应 `.ilmt-tr`；
    - 删 registry 记录和 `deltaBuffers`；
    - `forgetPiece(anchor)`（从记录里拿 anchor）；
    - `forgetPiecesInRoot(root)`（只删缓存 root 正好等于 `root` 的项，包括这个 root 自己被跳过的短文本/目标语言 piece；嵌套 block piece 的缓存、record、标记和 `.ilmt-tr` 保持不变）；
    - 删除 root 的 `data-ilmt-p`。
  - 如果 root 没有 `data-ilmt-p`（只有被跳过的 piece）：只调 `forgetPiecesInRoot(root)`。这样 `"Loading"` 变成一句完整英文后，dynamic scan 会重新收集并翻译；同 root 下已被标记的嵌套 piece 不受影响。
  - 250ms 防抖后的 dynamic scan 重新收集。嵌套 marked piece 的锚点仍命中缓存，不会被重新分配 id 或重复插入译文。
- `childList` 变更：dynamic scan；新锚点收集，旧锚点命中缓存跳过。
- `registry.prune()` 同时检查 `el.isConnected` 和 `anchor.isConnected`；`pump()` 里 prune 后调用 `pruneOrphanTranslations()`，删掉 registry 里已经没有记录的 `.ilmt-tr`。

---

## 9. 渲染（render.ts）

### 9.1 接口

```ts
export interface TranslationTarget {
  root: Element;
  anchor: Node;
  heading?: boolean;
}

export function renderTranslation(
  target: TranslationTarget,
  id: string,
  text: string,
  targetLang?: string,
): HTMLElement;
```

- 已存在 `[data-ilmt-for=id]`：原地更新 `textContent` 和 `lang`，不重复插。
- 不存在：创建 `<span class="ilmt-tr ilmt-block">`，设 `data-ilmt-for`、`lang`，需要时加 `data-ilmt-heading="1"` / `ilmt-flex-break` / `ilmt-grid-break`。

### 9.2 插入位置

**普通块（p / li / td / blockquote / div / 标题等）：插在 root 内部、安全锚点之后。**

安全锚点算法：

```
node = anchor (text node)
parent = node.parentNode
while (parent && parent !== root):
  parentEl = parent as Element
  if (parentEl.parentNode === root && root 是 flex/grid):
    // 浏览器会把 flex/grid 子项 blockify，这里按 item 处理
    node = parentEl; parent = parentEl.parentNode; continue
  if (isBlockDisplay(parentEl, rule)) break
  node = parentEl; parent = parentEl.parentNode

ref = node.nextSibling
while (ref && isSkippedInlineNode(ref)): ref = ref.nextSibling
parent.insertBefore(translation, ref)   // parent 为 null 时 append 到 root
```

效果：

- `<p><a>title</a></p>` → 译文插在 `<a>` 之后、`<p>` 内部，不会进链接。
- `<p>prefix <button>action</button></p>` → 跳过 trailing 的按钮，译文插在按钮之后、`<p>` 内部；按钮不被撑变形。
- `<p>Hello</p>` → 译文直接插在文本节点之后，仍是 `<p>` 的最后一个 child。

`isSkippedInlineNode(ref)`：

- 空白文本节点 → true（跳过）。
- 被 `shouldSkip` 命中且不是块级显示的 element → true（按钮、时间、`relative-time`、隐藏 inline 等）。
- 其他 → false（遇到就停，插在它前面）。

**flex 行（非标题、非 scope 级、row 方向）：插在 root 之后（兄弟节点）。**

```ts
const display = displayOf(root);
const isFlex = display.includes("flex");
const isGrid = display.includes("grid");
const isRow = isFlex && (flexDirection(root) || "row").startsWith("row");
const scopeLike = root.matches(
  "body, main, article, [role='main'], #repo-content-turbo-frame, feed-container",
);
const canAfter = !root.matches(
  "td, th, tr, tbody, thead, tfoot, table, caption, colgroup, col, option, optgroup, select, textarea",
);
const afterRoot = !target.heading && isRow && !scopeLike && canAfter && root.parentElement !== null;
```

- `afterRoot`：`root.parentElement.insertBefore(translation, root.nextSibling)`。断行 class 由**父级**的布局决定（见下方 `breakClassFor`），不是无脑加 flex。
  - 典型：`<div class="d-flex"><h2>Title</h2><a>View all</a></div>` → 译文在整行下方，标题和链接不被挤。
  - `<li style="display:flex">...<button>...</button></li>` → 译文在 `<li>` 后（浏览器能渲染，视觉在列表项下方）。
  - 表格结构元素（td/th/tr/table…）不允许插到后面，走「内部插入」。
- 其他 flex/grid（column、scope 级、heading、表格结构）→ 内部插入，断行 class 由 **root** 的布局决定。
- 标题永远内部插入，`data-ilmt-heading="1"`，这样 `font-size: 0.68em` 相对标题字号生效。

断行 class 的统一规则：

```ts
function breakClassFor(el: Element | null): string | null {
  if (!el) return null;
  const display = displayOf(el);
  if (display.includes("grid")) return "ilmt-grid-break";
  if (display.includes("flex")) {
    const dir = flexDirection(el) || "row";
    // row flex 才需要占满一行；column flex 的块级子节点本来就纵向堆叠，
    // 再套 flex:0 0 100% 会变成“高度 100%”，反而坏事。
    return dir.startsWith("row") ? "ilmt-flex-break" : null;
  }
  return null;
}
```

- `afterRoot`：`addClass(node, breakClassFor(root.parentElement))`。
- 内部插入：`addClass(node, breakClassFor(root))`。
- 普通块：不加 class。

### 9.3 断行 class 的取舍

- flex row 插到 root 后面是最稳的：不改行内布局，不挤压按钮。
- 只有在「scope 级 flex / column flex / grid / 表格结构 / 标题」才用内部插入 + 断行 class。
- 断行 class 必须看方向：row flex 用 `ilmt-flex-break`；column flex 不加（块级自然纵向堆叠）；grid 用 `ilmt-grid-break`。不要只要看到 `flex` 就加。
- 内部插入的 row flex 容器如果是 `nowrap`，`flex-basis:100%` 仍可能挤压；这是少数情况（页面顶层 flex、表格里的 flex 行），接受，不再为了它去改页面 `flex-wrap`。

### 9.4 不碰按钮

- `button` / `[role='button']` / `summary` / `label` / `select` / `input` 等都在 BASE 排除里，walker 不会进入。
- 安全锚点循环会停在交互元素外；译文最多是它们的兄弟，不会是子节点。
- 测试必须断言 `button.contains(translation) === false`。

---

## 10. 注册表与主流程改动

### 10.1 registry.ts

```ts
export interface ParagraphRecord {
  id: string;
  el: WeakRef<Element>;
  anchor: WeakRef<Node>;
  heading: boolean;
  sourceText: string;
  status: ParagraphStatus;
  translation?: string;
}
```

- `add(p)` 存 `anchor: new WeakRef(p.anchor)`、`heading: p.heading`。
- `prune()` 同时检查 `el` 和 `anchor` 的 `isConnected`。
- 其他队列逻辑不变。

### 10.2 main.ts

- `handleDelta` / `handleResult`：

  ```ts
  const rec = registry.get(id);
  const root = rec?.el.deref();
  const anchor = rec?.anchor.deref();
  if (rec && root && anchor) {
    renderTranslation({ root, anchor, heading: rec.heading }, id, text, targetLang);
  }
  ```

- `unmarkNodes` / overflow：`unmarkPiece` + `forgetPiece`。
- `restore()` / `rescan()`：`restoreAll` 后 `resetPieceCache()`。
- `handleMutations`：`.ilmt-tr` 内跳过；`pieceRootFor(target, getSiteRule(location.href))` 找 root；有 `data-ilmt-p` → `invalidatePieceRoot`，没有 → `forgetPiecesInRoot`（覆盖被跳过的 piece，§8.3）。
- `pump()`：`registry.prune()` 后 `pruneOrphanTranslations()`。
- `startPruneTimer` 不变。
- 其余队列、限流、错误提示、语言检测缓存不变。

---

## 11. 样式（inject.css，风格 A）

```css
/* 译文基座：继承页面字体和颜色 */
.ilmt-tr {
  font: inherit;
  color: inherit;
}

/* 正文译文：弱化 + 左侧细线 */
.ilmt-block {
  display: block !important;
  margin: 0.28em 0 0.42em !important;
  padding-left: 0.6em !important;
  border-left: 2px solid rgba(89, 99, 110, 0.38) !important;
  border-left-color: color-mix(in srgb, currentColor 28%, transparent) !important;
  opacity: 0.78 !important;
  font-size: 0.92em;
  font-weight: 400;
  line-height: 1.55;
}

/* 标题译文：更小、常规字重 */
.ilmt-block[data-ilmt-heading="1"] {
  font-size: 0.68em;
  font-weight: 400;
  line-height: 1.45;
  margin-top: 0.18em !important;
  margin-bottom: 0.2em !important;
  opacity: 0.74 !important;
}

/* flex 容器内部插入时占满一行 */
.ilmt-flex-break {
  flex: 0 0 100% !important;
  width: 100% !important;
  max-width: 100% !important;
}

/* grid 容器内部插入时横跨所有列 */
.ilmt-grid-break {
  grid-column: 1 / -1 !important;
}

/* 待翻译状态 */
.ilmt-tr[data-loading="1"] {
  opacity: 0.4 !important;
}
```

- 去掉旧的 `.ilmt-inline`（本轮不再产生内联译文）。
- `color-mix` 不支持的浏览器会忽略该行，保留 `rgba` 回退。
- 深色模式下 `currentColor` 参与混色；回退灰色也可见。
- 标题译文插在标题内部，`0.68em` 相对标题字号；H1/H2/H3 都会自动缩放。

---

## 12. 测试计划

### 12.1 新增/重写 `tests/unit/paragraphs.test.ts`

`beforeEach` 调 `resetPieceCache()`；每个用例 `.innerHTML` 重建 DOM。

必须覆盖：

- 块容器拆分：两个 `<p>` → 2 个 piece，root 是各自 `<p>`。
- 嵌套 inline（`a > span > em`）→ 1 个 piece，文本正确。
- `prefix <button>action</button> suffix` → 1 个 piece，text `"prefix suffix"`，root 是 `<p>`，anchor 是最后一个文本节点，按钮不是 root。
- 纯按钮块 → 0 个 piece。
- flex 行 `div.flex > span + button` → 1 个 piece，root 是 flex div，按钮文本不进 piece；在 jsdom 用内联 `style="display:flex"` 模拟。
- flex 行里放标题：`div[style=display:flex] > h1 + button` → 标题是自己的 piece，`heading === true`，root 是 `h1`；按钮跳过。
- `Hello<br>world` → 2 个 piece。
- `div > text + div + text` → 3 个 piece。
- 列表 / 表格：每个 `li` / `td` 独立 piece。
- 跳过：`pre`, `code`, `input`, `contenteditable`, `aria-hidden`, `hidden`, `.sr-only`, `translate=no`, `.notranslate`, `relative-time`, `time`。
- 文本过滤：URL、邮箱、纯数字、日期、SHA、`@handle`、`#hash`、版本号。
- 最小长度、目标语言跳过、CJK 回退、非中文目标不套 CJK 启发。
- 20,000 字符截断，DOM 原文不变。
- C0 控制字符清理，DOM 原文保留控制字符。
- `<main>` 优先：只收集 main 内；main 外不收集。
- 额外选择器：GitHub URL + `.Layout-sidebar .BorderGrid-row:first-child .BorderGrid-cell > p`（About 简介）能收集，即使 `.Layout-sidebar` 在 scope 遍历时被跳过；通用 URL 不收集。
- 额外选择器不会把右侧栏第二行以后（Releases/Packages/Contributors）的 `p` 收进来；主 scope 也不会收，因为 `.Layout-sidebar` 在 `scopeExcludeSelectors` 里。
- 首页左栏 `li.repo-list-item p` 即使位于 `.Layout-sidebar` 内、且在 main 外，也能通过额外选择器收集（祖先检查不查 `scopeExcludeSelectors`）。
- 缓存：第二次扫描返回 0；`resetPieceCache()` 后可重新收集。
- 被跳过的短文本也会进缓存；改长后 `forgetPiecesInRoot(root)` + 再次扫描能收集到。
- `data-ilmt-p` 标记在 root 上；多 piece 共享 root 时属性包含多个 id。
- 标题 piece 的 `heading === true`。

需要改掉的旧断言：

- 「最内层文本元素是 `<a>`」→ 现在是 root `<p>`、anchor 在 `<a>` 内。
- 「兄弟 inline 不合并」→ 现在合并成一个 piece。
- 「文本+按钮时收集按钮」→ 现在收集 `<p>`，按钮跳过。
- 手动 `markParagraph` 让扫描返回 0 → 不再适用；改为测缓存/`resetPieceCache`。

### 12.2 新增 `tests/unit/site-rules.test.ts`

- `https://github.com/owner/repo` → `id === "github"`，scope 含 `main`，`scopeExcludeSelectors` 含 `.Layout-sidebar`，额外选择器含 `.Layout-sidebar .BorderGrid-row:first-child .BorderGrid-cell > p`。
- `https://example.com/article` → `id === "generic"`。
- `https://github.com/settings/profile` → `disabled === true`，`collectParagraphs` 返回 0。
- `https://gist.github.com/...` → generic。

### 12.3 重写 `tests/unit/render.test.ts`

- 普通 `<p>`：译文是 `<p>` 的最后一个 child，class `ilmt-block`。
- `<p><a>Hello</a></p>`：译文在 `<a>` 之后、`<p>` 内，不在 `<a>` 内。
- `<p>prefix <button>action</button></p>`：`button.contains(node) === false`，译文在按钮之后。
- flex row：译文是 flex root 的 next sibling；父级是 row flex 时带 `ilmt-flex-break`。
- afterRoot 的父级是 column flex 时**不带** `ilmt-flex-break`（否则高度被拉满）；父级是 grid 时带 `ilmt-grid-break`。
- 内部插入：row flex root 带 `ilmt-flex-break`，column flex root 不带，grid root 带 `ilmt-grid-break`。
- 标题（包括 flex 行里的标题）：`data-ilmt-heading="1"`，译文在标题内部；标题自身是 row flex 时再带 `ilmt-flex-break`。
- 表格单元格：译文在 `<td>` 内部，不插到 `<tr>` 里。
- 更新原地、restore 还原、`extractSourceText` 去掉译文。

### 12.4 更新 `tests/unit/registry.test.ts`

- `add` helper 传 `anchor`、`heading`。
- prune 在 root 还在但 anchor 断开时也删除记录。

### 12.5 现有主流程测试

- `main-ui.test.ts` 的 characterData 失效测试必须继续通过：编辑 `<p>` 文本后，旧译文被删、不残留。
- `main.test.ts` 的 2000 段上限、`main-messages.test.ts` 的 restore 后无 `data-ilmt-p`、`main-startup` / `main-language` 等继续通过。
- 如有断言依赖旧的 `ParagraphNode` 形状，按新接口更新，不降低覆盖。

### 12.6 构建与手工验证

- `npm test`
- `npx tsc --noEmit`
- `npm run build`
- 手工：GitHub 仓库页右键「翻译当前页面」，检查：
  - README 标题/段落/列表/表格/引用块有译文；
  - issue/PR 标题和评论正文有译文；
  - 左侧仓库列表简介、右侧 About 简介有译文；
  - Watch / Fork / Star / Code / Comment 等按钮无译文、无译文节点；
  - 右侧 Releases/Packages/Contributors 等 UI 段落保持英文；
  - 顶部导航、页脚保持英文；
  - 标题译文明显更小、常规字重；
  - 正文译文左侧有细线，整体比原文淡；
  - 动态展开/切换页面不重复、不残留。

---

## 13. 验收标准

1. GitHub 仓库页/issue 页：正文、标题、列表、表格、引用、左侧仓库列表简介、右侧 About 简介都有译文；按钮/顶部导航/右侧栏其余 UI/页脚没有。
2. 任意页面：`button.contains(.ilmt-tr)` 永远为 false。
3. 标题译文 `data-ilmt-heading="1"`，视觉上比原标题小且不粗；正文译文有左侧细线和弱化透明度。
4. flex 行译文在整行下方，不挤在行内；grid 译文横跨整行；表格译文在单元格内。
5. 同一页面重复扫描不产生重复译文；SPA 切换/动态加载只翻新增内容。
6. 原文 DOM 文本节点未被修改（除 `data-ilmt-p` 属性和新增译文节点）。
7. `npm test`、`npx tsc --noEmit`、`npm run build` 全部通过。

---

## 14. 留给实现者的决定

- GitHub 排除选择器可以按真实页面继续补充，但不得改变「文本节点级 + 排除子树」的模型；补充时优先加选择器，不要在 walker 里写站点特判。
- inline `<code>` 本轮跳过：含 inline code 的段落只翻 code 以外的文本。若翻译质量明显受损，后续用占位符方案，不在本轮做。
- flex/grid 在 jsdom 里无法完全模拟浏览器 blockify；以 Chrome 手工验证为准，单元测试用内联 style 覆盖主要分支。
- 整页模式、内联译文、富文本保留都是后续能力，不在本轮加开关。

---

## 15. 需要用户确认的一件事

实现路线 C 已定；本轮 scope 我按 **GitHub 主内容 + 仓库简介（首页左侧仓库列表 + 仓库页右侧 About 简介），顶部导航/右侧栏其余 UI/按钮不翻** 来写。仓库页 About 是仓库描述内容：`.Layout-sidebar` 在 scope 遍历时整块跳过，再用 `.Layout-sidebar .BorderGrid-row:first-child .BorderGrid-cell > p` 精确收回 About 简介；Releases/Packages/Contributors 等 UI 不收。如果你要「右侧栏一个字都不翻」或「整页除按钮」，在批准时直接说，我改选择器后再开工。
