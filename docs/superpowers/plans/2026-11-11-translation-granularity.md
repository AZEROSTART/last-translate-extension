# 翻译粒度（最小长度 + 只翻译正文）实施计划

- 日期：2026-11-11
- 设计：`docs/superpowers/specs/2026-11-11-translation-granularity-design.md`
- 目标：新增 `minParagraphLength`（默认 10）和 `contentOnly`（默认 true），减少小字、标签、元信息被翻译。
- 原则：TDD；每个任务先写失败测试，再实现，再跑测试；小步提交。

## Task 1: 设置类型、默认值与校验

**文件**

- `src/shared/types.ts`
- `src/shared/storage.ts`
- `tests/unit/storage.test.ts`

**第 1 步：写失败测试**

在 `tests/unit/storage.test.ts` 增加：

```ts
it("defaults to a 10-character minimum and content-only translation", async () => {
  const s = await getSettings();
  expect(s.minParagraphLength).toBe(10);
  expect(s.contentOnly).toBe(true);
});

it("preserves valid granularity settings", async () => {
  await chrome.storage.local.set({
    settings: { ...DEFAULT_SETTINGS, minParagraphLength: 4, contentOnly: false },
  });
  const s = await getSettings();
  expect(s.minParagraphLength).toBe(4);
  expect(s.contentOnly).toBe(false);
});

it("normalizes invalid granularity settings", async () => {
  await chrome.storage.local.set({
    settings: { ...DEFAULT_SETTINGS, minParagraphLength: "20", contentOnly: "yes" },
  });
  let s = await getSettings();
  expect(s.minParagraphLength).toBe(10);
  expect(s.contentOnly).toBe(true);

  await chrome.storage.local.set({
    settings: { ...DEFAULT_SETTINGS, minParagraphLength: 0, contentOnly: false },
  });
  s = await getSettings();
  expect(s.minParagraphLength).toBe(1);

  await chrome.storage.local.set({
    settings: { ...DEFAULT_SETTINGS, minParagraphLength: 250 },
  });
  s = await getSettings();
  expect(s.minParagraphLength).toBe(100);
});
```

运行：

```bash
npx vitest run tests/unit/storage.test.ts
```

预期：失败，`minParagraphLength` / `contentOnly` 不存在。

**第 2 步：实现**

`src/shared/types.ts` 的 `Settings` 增加：

```ts
  /** Minimum trimmed paragraph length; shorter pieces are skipped. */
  minParagraphLength: number;
  /** Skip secondary page regions (asides, captions, metadata, breadcrumbs). */
  contentOnly: boolean;
```

`src/shared/storage.ts` 的 `DEFAULT_SETTINGS` 增加：

```ts
  minParagraphLength: 10,
  contentOnly: true,
```

`getSettings()` 在 `glossaryEnabled` 校验后增加：

```ts
  // Granularity is on by default. Malformed stored values must not turn all
  // page text back on, and a missing min length should use the same default
  // users see in the options page.
  if (
    typeof merged.minParagraphLength !== "number" ||
    !Number.isFinite(merged.minParagraphLength)
  ) {
    merged.minParagraphLength = 10;
  } else {
    merged.minParagraphLength = Math.min(100, Math.max(1, Math.trunc(merged.minParagraphLength)));
  }
  if (typeof merged.contentOnly !== "boolean") {
    merged.contentOnly = true;
  }
```

**第 3 步：跑测试**

```bash
npx vitest run tests/unit/storage.test.ts
```

预期：通过。

**第 4 步：提交**

```bash
git add src/shared/types.ts src/shared/storage.ts tests/unit/storage.test.ts
git commit -m "feat: add translation granularity settings"
```

## Task 2: 段落收集支持 contentOnly 和可配置最小长度

**文件**

- `src/content/paragraphs.ts`
- `tests/unit/paragraphs.test.ts`
- `tests/unit/paragraphs-filter.test.ts`

**第 1 步：写失败测试**

在 `tests/unit/paragraphs.test.ts` 增加：

```ts
it("honors a larger minLength and caches short pieces", async () => {
  const root = html(`<p>short</p><p>This paragraph is long enough.</p>`);
  const detect = vi.fn(async () => "en");
  expect(await collectParagraphs(root, { minLength: 10, detectLang: detect })).toHaveLength(1);
  expect(detect).toHaveBeenCalledTimes(1);
});

it("skips secondary regions when contentOnly is on", async () => {
  const root = html(`
    <main>
      <h1>Article title here</h1>
      <p>This is the main article paragraph.</p>
      <ul><li>This is a list item.</li></ul>
      <table><tr><td>This is a table cell.</td></tr></table>
      <aside><p>This aside should not be translated.</p></aside>
      <small>This small print should not be translated.</small>
      <figcaption>This caption should not be translated.</figcaption>
      <div class="breadcrumb">Home / Docs / Guide</div>
      <div class="post-meta">By someone, published today</div>
    </main>`);

  const ps = await collectParagraphs(root, { contentOnly: true, minLength: 4 });
  expect(texts(ps)).toEqual([
    "Article title here",
    "This is the main article paragraph.",
    "This is a list item.",
    "This is a table cell.",
  ]);
});

it("keeps old behavior when contentOnly is off", async () => {
  const root = html(`
    <main>
      <p>This is the main article paragraph.</p>
      <aside><p>This aside is still translated.</p></aside>
      <figcaption>This caption is still translated.</figcaption>
    </main>`);

  const ps = await collectParagraphs(root, { contentOnly: false });
  expect(texts(ps)).toContain("This aside is still translated.");
  expect(texts(ps)).toContain("This caption is still translated.");
});
```

在 `tests/unit/paragraphs-filter.test.ts` 可追加最小长度/正文模式与过滤器的组合测试；如果上面的用例已覆盖，可跳过。

运行：

```bash
npx vitest run tests/unit/paragraphs.test.ts tests/unit/paragraphs-filter.test.ts
```

预期：失败，`contentOnly` 未定义或小字仍被收集。

**第 2 步：实现**

`src/content/paragraphs.ts`：

1. `CollectOptions` 增加：

```ts
  /** Skip asides, captions, small print, breadcrumbs and common metadata. */
  contentOnly?: boolean;
```

2. 在默认常量附近增加：

```ts
/** Extra exclusions applied when the user enables "只翻译正文". */
const CONTENT_ONLY_EXCLUDES: string[] = [
  "aside",
  "small",
  "figcaption",
  "[role='complementary']",
  "[role='contentinfo']",
  "[role='banner']",
  "[aria-label*='breadcrumb' i]",
  "[class*='breadcrumb' i]",
  "[class*='byline' i]",
  "[class*='post-meta' i]",
  "[class*='article-meta' i]",
];
```

3. `collectParagraphs` 解构：

```ts
  const {
    minLength = DEFAULT_MIN_LENGTH,
    contentOnly = false,
    langSkipRatio = DEFAULT_LANG_SKIP_RATIO,
    detectLang,
    targetLang = DEFAULT_TARGET_LANG,
    url,
  } = opts;
```

4. `compileRule` 改为：

```ts
function compileRule(rule: SiteRule, contentOnly = false): RuleMatchers {
  const excludes = contentOnly
    ? [...rule.excludeSelectors, ...CONTENT_ONLY_EXCLUDES]
    : rule.excludeSelectors;
  return {
    allExcludes: [...excludes, ...(rule.scopeExcludeSelectors ?? [])].join(","),
    contentExcludes: excludes.join(","),
    extraInline: (rule.extraInlineSelectors ?? []).join(","),
    extraBlock: (rule.extraBlockSelectors ?? []).join(","),
  };
}
```

5. `collectParagraphs` 中：

```ts
  const matchers = compileRule(rule, contentOnly);
```

6. `pieceRootFor` 保持 `compileRule(rule)`（默认 `false`），因为它只用于找编辑根节点，不负责收集过滤。

注意：`contentOnly` 只影响收集，不改变 `scopeSelectors` 的 `main`/`article` 优先逻辑，也不改变 `body` 回退。

**第 3 步：跑测试**

```bash
npx vitest run tests/unit/paragraphs.test.ts tests/unit/paragraphs-filter.test.ts
```

预期：通过。

**第 4 步：提交**

```bash
git add src/content/paragraphs.ts tests/unit/paragraphs.test.ts tests/unit/paragraphs-filter.test.ts
git commit -m "feat: filter secondary content during paragraph collection"
```

## Task 3: 内容脚本把设置传给全量和动态扫描

**文件**

- `src/content/main.ts`
- `tests/unit/main.test.ts`

**第 1 步：写失败测试**

在 `tests/unit/main.test.ts` 增加两个测试（放在现有 translate 测试附近）：

```ts
it("applies the saved minimum length during a full scan", async () => {
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ settings: { minParagraphLength: 30, contentOnly: false } });
  document.body.innerHTML = `<p>Short label</p><p>This paragraph is long enough to translate.</p>`;

  const { runContentMain } = await import("../../src/content/main");
  runContentMain();
  const sent: any[] = [];
  (globalThis as any).__ilmtTestPort = { send: (m: any) => sent.push(m) };
  await (globalThis as any).__ilmtMain.translatePage();

  const translate = sent.find((m) => m.type === "translate");
  expect(translate.items.map((item: any) => item.text)).toEqual([
    "This paragraph is long enough to translate.",
  ]);
});

it("keeps secondary content out of dynamic scans when contentOnly is on", async () => {
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ settings: { minParagraphLength: 10, contentOnly: true } });
  document.body.innerHTML = `<main><p>This is the first long paragraph.</p></main>`;

  const { runContentMain } = await import("../../src/content/main");
  const { sent, messageListeners, connect } = captureConnectPort();
  (globalThis as any).chrome.runtime.connect = connect;
  runContentMain();
  await (globalThis as any).__ilmtMain.translatePage();

  const first = sent.find((m) => m.type === "translate");
  expect(first).toBeTruthy();

  document.querySelector("main")!.insertAdjacentHTML(
    "beforeend",
    `<aside>This aside is long enough but should stay untranslated.</aside>`,
  );
  await new Promise((resolve) => setTimeout(resolve, 350));

  messageListeners[0]({ type: "finish", requestId: first.requestId });
  expect(sent.filter((m) => m.type === "translate")).toHaveLength(1);
});
```

运行：

```bash
npx vitest run tests/unit/main.test.ts
```

预期：第一个测试会因仍使用默认 4 字符而失败；第二个测试如果 aside 被动态收集则失败。

**第 2 步：实现**

`src/content/main.ts`：

1. 增加导入：

```ts
import { DEFAULT_SETTINGS, getSettings } from "../shared/storage";
```

2. 在 `let targetLang = DEFAULT_TARGET_LANG;` 附近增加：

```ts
let minParagraphLength = DEFAULT_SETTINGS.minParagraphLength;
let contentOnly = DEFAULT_SETTINGS.contentOnly;
```

3. 用下面的函数替换 `readTargetLang()`：

```ts
interface CollectPrefs {
  targetLang: string;
  minParagraphLength: number;
  contentOnly: boolean;
}

async function readCollectPrefs(): Promise<CollectPrefs> {
  try {
    const s = await getSettings();
    return {
      targetLang:
        typeof s.targetLang === "string" && s.targetLang.length > 0
          ? s.targetLang
          : DEFAULT_TARGET_LANG,
      minParagraphLength: s.minParagraphLength,
      contentOnly: s.contentOnly,
    };
  } catch {
    // Missing or unreadable storage: keep the documented defaults.
    return {
      targetLang: DEFAULT_TARGET_LANG,
      minParagraphLength: DEFAULT_SETTINGS.minParagraphLength,
      contentOnly: DEFAULT_SETTINGS.contentOnly,
    };
  }
}
```

4. `collectAndQueue` 中把：

```ts
  const lang = await readTargetLang();
  if (!active || generation !== scanGeneration) return;
  targetLang = lang;

  const nodes = await collectParagraphs(body, {
    targetLang: lang,
    detectLang: detectLang,
    url: document.location.href,
  });
```

改为：

```ts
  const prefs = await readCollectPrefs();
  if (!active || generation !== scanGeneration) return;
  targetLang = prefs.targetLang;
  minParagraphLength = prefs.minParagraphLength;
  contentOnly = prefs.contentOnly;

  const nodes = await collectParagraphs(body, {
    targetLang,
    minLength: minParagraphLength,
    contentOnly,
    detectLang: detectLang,
    url: document.location.href,
  });
```

5. `enqueueNewParagraphs` 中把：

```ts
  const nodes = await collectParagraphs(body, {
    targetLang,
    detectLang: detectLang,
    url: document.location.href,
  });
```

改为：

```ts
  const nodes = await collectParagraphs(body, {
    targetLang,
    minLength: minParagraphLength,
    contentOnly,
    detectLang: detectLang,
    url: document.location.href,
  });
```

注意：动态扫描复用全量扫描读到的值；设置修改后，下一次全量扫描/重新激活生效。不要在每次动态扫描时重新读 storage，避免同一轮扫描规则漂移。

**第 3 步：跑测试**

```bash
npx vitest run tests/unit/main.test.ts tests/unit/main-language.test.ts
```

预期：通过。

**第 4 步：提交**

```bash
git add src/content/main.ts tests/unit/main.test.ts
git commit -m "feat: apply granularity settings to page scans"
```

## Task 4: 设置页字段与保存

**文件**

- `src/options/main.ts`
- `tests/unit/options-dom.test.ts`

**第 1 步：写失败测试**

在 `tests/unit/options-dom.test.ts` 的 `describe("global settings")` 中增加：

```ts
it("renders and saves granularity settings", async () => {
  await seed();
  await boot();

  const minLength = document.querySelector(".global-minParagraphLength") as HTMLInputElement;
  const contentOnly = document.querySelector(".global-contentOnly") as HTMLInputElement;
  expect(minLength.value).toBe("10");
  expect(contentOnly.checked).toBe(true);

  setValue(".global-minParagraphLength", "50");
  contentOnly.checked = false;
  click(".global-save");

  await vi.waitFor(async () => {
    const s = await getSettings();
    expect(s.minParagraphLength).toBe(50);
  });

  const s = await getSettings();
  expect(s.contentOnly).toBe(false);
});

it("clamps out-of-range minimum length on save", async () => {
  await seed();
  await boot();

  setValue(".global-minParagraphLength", "2");
  click(".global-save");

  await vi.waitFor(async () => {
    expect((await getSettings()).minParagraphLength).toBe(4);
  });
});
```

运行：

```bash
npx vitest run tests/unit/options-dom.test.ts
```

预期：失败，找不到 `.global-minParagraphLength` / `.global-contentOnly`。

**第 2 步：实现**

`src/options/main.ts`：

1. `GlobalFields` 增加：

```ts
  minParagraphLength: HTMLInputElement;
  contentOnly: HTMLInputElement;
```

2. 在 `renderGlobal()` 的目标语言字段之后、数字网格之前增加：

```ts
  const scopeField = el("fieldset", "field-group");
  scopeField.appendChild(el("legend", undefined, "翻译范围"));
  const minParagraphLength = makeNumberControl(
    "最小翻译长度",
    "global-minParagraphLength",
    s.minParagraphLength,
    4,
    100,
    1,
    "少于这个字符数的文本不翻译",
  );
  const contentOnlyRow = el("label", "checkbox-row");
  const contentOnly = el("input", "global-contentOnly");
  contentOnly.type = "checkbox";
  contentOnly.checked = s.contentOnly !== false;
  contentOnlyRow.append(contentOnly, document.createTextNode("只翻译正文"));
  scopeField.append(
    minParagraphLength.wrap,
    contentOnlyRow,
    el("span", "field-hint", "跳过侧栏、小字、图注、面包屑和常见元信息。"),
  );
  globalEl.appendChild(scopeField);
```

3. `globalFields = { ... }` 增加：

```ts
    minParagraphLength: minParagraphLength.input,
    contentOnly,
```

4. `saveGlobal()` 增加：

```ts
  const minParagraphLength = clampInt(
    readNumberOr(fields.minParagraphLength.value, settings.minParagraphLength),
    4,
    100,
  );
  const contentOnly = fields.contentOnly.checked;
```

5. `const next: Settings = { ...settings, ... }` 增加：

```ts
    minParagraphLength,
    contentOnly,
```

6. 保存成功后回写输入框：

```ts
    fields.minParagraphLength.value = String(minParagraphLength);
```

**第 3 步：跑测试**

```bash
npx vitest run tests/unit/options-dom.test.ts
```

预期：通过。

**第 4 步：提交**

```bash
git add src/options/main.ts tests/unit/options-dom.test.ts
git commit -m "feat: expose granularity controls in options"
```

## Task 5: 完整验证

**第 1 步：全量单测、类型检查、构建**

```bash
npm run verify:delivery
```

预期：单测、`tsc`、build、`check-build` 全部通过。

**第 2 步：E2E 回归**

```bash
npm run test:e2e
```

预期：现有用例通过；默认最小长度 10 不应影响测试 fixture 中的长段落。

**第 3 步：浏览器 P0 验证**

按 `docs/delivery-verification.md` 的 P0 主流程验证：

- `Opt+A` 开始翻译。
- 原文保留，译文在原文下方。
- 再按 `Opt+A` 恢复原文。
- 点击扩展图标，popup 正常显示 provider/model。
- 划词「解释」，侧栏打开并自动发送、返回回答。
- 页面、侧栏、控制台无红色报错。

额外检查本次功能：

- 设置页能看到“最小翻译长度”和“只翻译正文”。
- 默认值为 10 / 开启。
- 包含 `aside`/`small`/`figcaption` 的测试页不翻译这些区域。
- 标题、正文段落、列表、表格仍翻译。

**第 4 步：提交设计/计划（如尚未提交）**

```bash
git add docs/superpowers/specs/2026-11-11-translation-granularity-design.md docs/superpowers/plans/2026-11-11-translation-granularity.md
git commit -m "docs: plan translation granularity controls"
```
