# 悬停释义（翻译时附带学习注释）设计

- 日期：2026-11-11
- 状态：待确认，未实现
- 目标：翻译时让模型顺手标出 0～3 个值得看的词/短语，鼠标悬停原文即可看释义；不增加额外模型请求，不打断阅读。

## 1. 目标与非目标

### 目标

- 一次翻译请求同时返回：
  - 每段译文；
  - 每段 0～3 个值得看的词/短语及本句语境下的释义。
- 原文中被标出的词/短语有很轻的虚线下划线。
- 悬停显示小卡片：词/短语、词性、释义、可选的原句片段。
- 悬停只用本地已返回的数据，不再请求模型。
- 注释是附加产物：解析失败、格式不符、找不到原文位置时，只丢注释，翻译照常显示。
- 译文与注释一起写入本地缓存；缓存命中时悬停立即可用。
- 默认开启；设置里可关闭，关闭后恢复纯翻译。

### 非目标（第一版不做）

- 不做游戏、宠物、积分、打卡、复习队列。
- 不做全页词典：只有模型标出的词/短语可悬停。
- 不做音标。模型生成 IPA 容易错，后续接词典数据再加。
- 不做独立“学习库”页面。第一版只把注释和译文一起缓存；接触记录以后再加。
- 不改原文 DOM 文本节点，不用包裹 `<span>`。高亮用 CSS Custom Highlight API。
- 不要求点击、弹窗、跳转；悬停移开即消失。

## 2. 用户体验

1. 按 `Opt+A` 翻译页面，译文照常出现在原文下方。
2. 原文里少数词/短语带浅色虚线。
3. 鼠标停在该词上约 120ms，出现小卡片：

   ```
   outlive  v.
   比……存在得更久
   Small tools often outlive their larger competitors.
   ```

4. 鼠标移开，卡片消失；原文、译文、页面布局都不变。
5. 再按 `Opt+A` 还原，译文、下划线、卡片全部清除。

卡片只读，不可点击；不抢焦点；不遮挡当前词（优先显示在词上方，空间不够时显示在下方）。

## 3. 数据模型

`src/shared/types.ts`：

```ts
export interface GlossaryNote {
  /** 原文中的确切词形，例如 "outlived"；必须是原文连续子串。 */
  surface: string;
  /** 词性，例如 "v." / "n." / "phr."，可省略。 */
  pos?: string;
  /** 本句语境下的简明释义，语言与 targetLang 一致。 */
  meaning: string;
  /** 原文中的短句或短片段，可省略。 */
  example?: string;
}
```

翻译结果消息扩展：

```ts
| {
    type: "result";
    requestId: string;
    items: Array<{
      id: string;
      text: string;
      /** 没有注释时省略，保持旧消息形状。 */
      glossary?: GlossaryNote[];
    }>;
  }
```

`TranslateItem` 不变。注释开关是全局设置，不需要每个段落单独传。

缓存值：

```ts
export interface CachedTranslation {
  text: string;
  glossary: GlossaryNote[];
}
```

`CacheRecord` 增加可选 `glossary?: GlossaryNote[]`。旧记录没有该字段时按 `[]` 处理，不需要升 DB 版本；缓存 key 里的 `promptVersion` 会因为提示词变化而自然失效。

## 4. 提示词与响应协议

### 4.1 拼装

新增：

```ts
export const GLOSSARY_MARKER = "<<<ILMT_GLOSSARY>>>";
export const GLOSSARY_INSTRUCTIONS = `...`;
export function buildEffectiveSystemPrompt(base: string, glossaryEnabled: boolean): string;
```

- `glossaryEnabled` 为 true 时，在用户/默认系统提示词后追加固定注释协议。
- 追加发生在 `promptVersionFor()` 之前，因此缓存版本包含注释协议；关闭开关后版本不同，不会读到带注释的旧缓存。
- 用户自定义系统提示词也追加，保证格式一致；如果提示词里已经包含 `<<<ILMT_GLOSSARY>>>`，不重复追加。
- `{{targetLang}}` 仍由 `buildTranslateMessages` 替换。

### 4.2 输出格式

译文仍然在前，注释块在最后：

```text
[1] 第一段译文
[2] 第二段译文
<<<ILMT_GLOSSARY>>>
{"1":[{"surface":"outlive","pos":"v.","meaning":"比……存在得更久","example":"Small tools often outlive their larger competitors."}]}
```

规则：

- `<<<ILMT_GLOSSARY>>>` 单独一行。
- 后面只输出一个单行 JSON 对象；键是批内段落编号（从 1 开始），值是数组。
- 每段最多 3 个；宁少勿多；没有合适的段落不要出现在对象里。全部没有时可以不输出注释块，或输出 `{}`。
- `surface` 必须是原文中的连续子串，保留原词形和大小写；不要输出还原后的原形。
- `meaning` 用 `{{targetLang}}` 写，简洁，只给本句意思，不给词典式多义项。
- 选词标准：熟词僻义、固定搭配、短语动词、习语、上下文义变化、文化背景词；不选专有名词、数字、URL、代码、过于基础的虚词。
- 示例只示意格式；释义语言必须是 `{{targetLang}}`。

### 4.3 解析与降级

新增纯函数：

```ts
export interface AnnotatedParseResult {
  translations: Map<string, string>;
  glossary: Map<string, GlossaryNote[]>;
}

export function parseAnnotatedResponse(
  raw: string,
  items: Segment[],
): AnnotatedParseResult;
```

行为：

1. 找到 `GLOSSARY_MARKER` 第一次出现的位置。
2. 前半段用现有 `parseNumberedResponse` 解析译文。
3. 后半段用 `JSON.parse` 解析注释；去掉 Markdown 代码围栏。
4. 注释结构逐项校验：
   - 段落编号在 1..N；
   - 值是数组；
   - 每项 `surface`、`meaning` 非空字符串；
   - `surface` 在该段原文中出现（忽略大小写、空白归一化）；
   - 每段截断到 3 条；
   - 同一段重复 `surface` 去重；
   - 所有字段做长度截断（`surface` ≤ 120、`pos` ≤ 20、`meaning` ≤ 120、`example` ≤ 240）。
5. 任何注释错误都只返回空注释，不抛错。
6. 如果前半段译文解析失败，尝试用整段 raw 再解析一次；成功则只保留译文、丢弃注释。仍失败才按现有翻译错误处理。
7. 如果模型漏了标记，但末尾有一个可解析成注释对象的 JSON 单行，尝试把它当注释并从前半段剥离；识别不可靠时保持原文，不冒险截断译文。

单段流式：

- 新增 `createAnnotatedStreamFilter()`，组合现有 `[1]` 前缀剥离逻辑。
- 流式输出只转发译文；检测到 `<<<ILMT_GLOSSARY>>>` 后停止转发，后续内容只收集为注释。
- 标记可能被拆到多个 chunk，过滤器要保留尾部候选字符。
- 流结束时返回 `{ text, notesRaw }`；`text` 作为译文，`notesRaw` 解析注释。
- 模型漏标记时允许最终结果用第 6 条兜底修正；极端情况下流式阶段可能短暂出现 JSON，最终结果会替换掉。

## 5. 背景层与缓存

`src/background/dispatch.ts`：

- 读取 `settings.glossaryEnabled`。
- `effectivePrompt = buildEffectiveSystemPrompt(systemPrompt, glossaryEnabled)`。
- `promptVersion = promptVersionFor(effectivePrompt)`。
- 单段：走 `createAnnotatedStreamFilter()`；多段：`complete()` 后走 `parseAnnotatedResponse()`。
- `GroupOutcome` 的 map 值改为 `{ text, glossary }`。
- 写缓存时保存 `{ text, glossary }`。
- `result` 消息只在 `glossary.length > 0` 时带 `glossary` 字段，保持旧测试/消息形状。
- 注释解析失败不影响译文；只有译文为空才报错。

`src/background/cache.ts`：

- `get(key): Promise<CachedTranslation | undefined>`。
- `put(key, value: CachedTranslation, meta)`。
- 旧记录 `glossary` 缺失时返回 `[]`。
- `stats()` / 淘汰字节数把注释 JSON 也算进去，避免缓存上限被低估。

## 6. 内容脚本：高亮与悬停

### 6.1 段落文本节点

`paragraphs.ts` 的 `WalkContext` 记录本段实际用到的文本节点；`ParagraphNode` 增加可选 `textNodes?: Node[]`。`registry.ts` 的 `ParagraphRecord` 存 `WeakRef<Node>[]`。

这样注释只在“这一段真正包含的文本节点”里找，不会误标到嵌套块或其他段落的译文里。旧测试构造的 `ParagraphNode` 不传该字段也能工作。

### 6.2 查找位置

新增 `src/content/glossary.ts`，核心是纯函数：

```ts
export function findSurfaceRange(
  textNodes: Node[],
  surface: string,
): Range | undefined;
```

- 按顺序在每个文本节点里做大小写不敏感搜索。
- 如果 `surface` 首/尾是字母或数字，检查词边界，避免 `art` 命中 `article`。
- 只取第一次出现。
- 跳过 `code`、`pre`、`kbd`、`samp`、`.ilmt-tr` 下的文本。
- 第一版要求 `surface` 落在同一个文本节点内；跨多个内联节点的短语直接跳过（不影响翻译）。
- 同一段内与已存在注释范围重叠时，保留先到的，丢弃重叠项。
- 全页注释范围上限 500 个，超出忽略，避免极端页面拖慢悬停。

### 6.3 高亮

使用 CSS Custom Highlight API（Chrome 120 已支持）：

```ts
const highlight = new Highlight(...ranges);
CSS.highlights.set("ilmt-gloss", highlight);
```

- 不包裹文本节点，不改页面 DOM；还原只需删除 highlight。
- 如果 `CSS.highlights` / `Highlight` 不存在，功能降级为“不显示下划线、不挂悬停”，翻译不受影响。
- `restore()`、SPA `rescan()`、段落失效时清除对应范围；全页还原时 `CSS.highlights.delete("ilmt-gloss")`。
- 页面滚动/尺寸变化时不清高亮，只隐藏卡片。

样式加到 `src/styles/inject.css`：

```css
::highlight(ilmt-gloss) {
  text-decoration: underline dotted !important;
  text-decoration-color: rgba(37, 99, 235, 0.55) !important;
  text-underline-offset: 2px !important;
  background-color: rgba(37, 99, 235, 0.07) !important;
}
```

如果某版本 Chrome 不支持 `::highlight` 的 `text-decoration`，背景色仍能提供可见提示。

### 6.4 悬停命中

- 翻译激活时在 `document` 上挂一个 `pointermove` 监听（passive），`restore()` 时移除。
- 用 `requestAnimationFrame` 节流。
- 用 `document.caretPositionFromPoint(x, y)`（回退 `caretRangeFromPoint`）拿到指针下的文本节点和偏移。
- 维护 `Map<Text, Array<{ range, note, paragraphId }>>`；单文本节点范围直接 O(1) 查找。
- 如果指针在注释范围内：
  - 同一范围保持；
  - 新范围延迟约 120ms 显示卡片；
  - 指针移出、页面滚动、窗口失焦、用户开始选择文本时隐藏。
- 卡片是单个 `div.ilmt-gloss-card`，`position: fixed`，`z-index: 2147483647`，`pointer-events: none`，`role="tooltip"`。
- 位置优先在范围上方；上方空间不足时放下方；左右 clamp 到视口内。
- 内容全部用 `textContent` 写入，禁止 `innerHTML`。模型输出视为不可信文本。
- 卡片结构：

  ```html
  <div class="ilmt-gloss-card" role="tooltip">
    <div class="ilmt-gloss-word">outlive <span class="ilmt-gloss-pos">v.</span></div>
    <div class="ilmt-gloss-meaning">比……存在得更久</div>
    <div class="ilmt-gloss-example">Small tools often outlive their larger competitors.</div>
  </div>
  ```

- 第一版只支持鼠标/触控笔悬停；不做键盘焦点遍历。这是已知限制。

### 6.5 与现有流程的接线

`src/content/main.ts`：

- `handleResult` 渲染译文后，把 `item.glossary` 交给 gloss controller。
- `restore()`：清空 gloss controller、移除卡片、删除 highlight。
- `rescan()`：先清空旧范围，再重新翻译。
- `invalidatePieceRoot()` / prune：按段落 id 移除对应范围。
- 流式 delta 不涉及注释；注释在最终 result 到达时出现。

## 7. 设置

`Settings` 增加：

```ts
glossaryEnabled: boolean;
```

- `DEFAULT_SETTINGS.glossaryEnabled = true`。
- `getSettings()` 对旧数据缺失/非布尔值归一为 `true`。
- 选项页“全局设置”增加复选框：
  - 标签：`翻译时标出值得学的词`
  - 提示：`每段最多 3 个；悬停查看释义。关闭后只翻译。`
- `saveGlobal()` 保存该字段，并用 `buildEffectiveSystemPrompt()` + `promptVersionFor()` 更新 `promptVersion`。

## 8. 测试与验收

### 8.1 单元测试

- `prompt.test.ts`
  - 有标记 + 合法 JSON：译文与注释都解析。
  - JSON 非法/缺字段/越界编号/超过 3 条：只丢注释，译文正常。
  - `surface` 不在原文：丢该条。
  - 漏标记但末尾有 JSON：兜底剥离。
  - 标记拆到多个流 chunk：过滤器不泄露标记。
- `dispatch.test.ts`
  - 单段流式：delta 只有译文；result 带注释。
  - 多段：result 每项带各自注释。
  - 注释格式错误：result 仍返回译文，无注释。
  - 缓存命中：返回译文 + 注释，不再请求 provider。
  - 关闭注释：提示词不含注释协议，缓存 key 与开启时不同。
- `cache.test.ts`
  - 存/取 `{ text, glossary }`。
  - 旧记录无 `glossary` 时返回空数组。
  - 淘汰字节统计包含注释。
- `glossary.test.ts`
  - 单词、短语、大小写、词边界、找不到、跨文本节点跳过、重叠跳过。
- `glossary-ui.test.ts`
  - `caretPositionFromPoint` 命中时显示卡片，移出隐藏。
  - 卡片用 textContent，不解析 HTML。
  - 没有 Highlight API 时不抛错。
  - `clear()` 删除高亮和卡片。
- `options-dom.test.ts`
  - 默认勾选；保存关闭后 `glossaryEnabled` 为 false。
- `registry.test.ts` / `main-ui.test.ts`
  - 注释随 result 进入记录；restore 清除。

### 8.2 E2E（Playwright + mock provider）

扩展 `tests/mock-server.ts`，支持在译文后追加固定注释块。新增用例：

1. mock 返回第一段 `surface: "outlive"`。
2. 翻译后，用页面主世界找到首段 `outlive` 的 `Range` 矩形。
3. `page.mouse.move()` 到该矩形中心。
4. 断言 `.ilmt-gloss-card` 出现，包含 `outlive` 和中文释义。
5. 移开鼠标，卡片消失。
6. 还原后，卡片和 `CSS.highlights.get("ilmt-gloss")` 都清除。

这条用例覆盖真实 DOM、高亮、悬停命中、还原，不依赖真实模型的输出稳定性。

### 8.3 P0 与真实 provider

- P0 主流程不变，仍按 `docs/delivery-verification.md` 执行。
- 默认开启注释后，额外确认：
  - 翻译 10/10，无红色报错；
  - 若真实模型返回了注释，`CSS.highlights.get("ilmt-gloss")?.size > 0`，悬停卡片可显示；
  - 还原后 highlight 和卡片都消失。
- 真实模型偶尔返回 0 条注释不算失败，但必须确认翻译链路正常；注释格式稳定性由单元测试和 mock E2E 覆盖。
- 交付文档的 P0 步骤不改；悬停功能作为“非 P0 回归”单独记录。

## 9. 安全与性能

- 模型输出不可信：卡片只用 `textContent`；注释字段限长；不执行任何模型返回的 HTML/JS。
- 页面文本仍只在 user message；系统提示词不混入页面内容。
- 不新增权限，不引入远程代码；注释与译文一样只存本地 IndexedDB。
- 提示词增加约 100～200 tokens；每段 0～3 条注释，控制输出增长。
- 悬停命中 O(1)；高亮范围上限 500；全页 2000 段仍可控。
- `pointermove` 只在翻译激活期间存在，rAF 节流。

## 10. 已知限制

- 跨多个内联节点的短语第一版不高亮；单词和单文本节点内的短语正常。
- 不做音标、键盘悬停、移动端长按。
- 模型偶尔不遵守格式时，只丢注释；如果连标记都漏了，流式阶段可能短暂显示 JSON，最终结果会修正。
- 注释质量取决于模型；关闭开关即可回到纯翻译。
- 高亮依赖 CSS Custom Highlight API；Chrome 120+ 已支持，低版本自动降级。

## 11. 实施顺序

1. 共享类型、提示词协议、解析器、纯函数测试。
2. 缓存改为存 `{ text, glossary }`，dispatch 接线，流式过滤器。
3. 内容脚本：段落文本节点、范围查找、CSS Highlight、悬停卡片。
4. 设置项与选项页。
5. E2E mock 用例、浏览器真实 provider 冒烟、P0 全跑。
6. README / 交付文档补一句功能说明。
