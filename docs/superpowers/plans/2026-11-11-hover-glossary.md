# 悬停释义（翻译时附带学习注释）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在一次翻译请求里同时拿到译文和每段 0～3 条学习注释，原文用 CSS Highlight 显示虚线下划线，悬停显示释义小卡片，不额外请求模型，也不破坏现有翻译主链路。

**Architecture:** 共享层定义 `GlossaryNote`、注释协议和容错解析；背景层把 `{ text, glossary }` 随译文一起返回并缓存；内容脚本用段落真实文本节点生成 `Range`，通过 CSS Custom Highlight API 高亮，用 `caretPositionFromPoint` 命中并显示卡片。注释永远是可丢弃的附加物。

**Tech Stack:** TypeScript, Vite, Vitest, jsdom, Playwright, Chrome MV3, CSS Custom Highlight API, IndexedDB.

**Spec:** `docs/superpowers/specs/2026-11-11-hover-glossary-design.md`

## Global Constraints

- 同一次翻译请求返回译文 + 注释；悬停不得再请求模型。
- 每段最多 3 条注释；宁少勿多；短段落可以为 0 条。
- 注释解析失败、JSON 非法、`surface` 找不到时，只丢注释，译文必须照常显示。
- 不包裹原文文本节点；高亮只用 CSS Custom Highlight API，还原时删除 highlight。
- 第一版不做音标、游戏、宠物、独立学习库、复习队列。
- 注释和译文一起存本地 IndexedDB；不新增权限，不引入远程代码。
- 所有 UI 文案用中文；模型输出按不可信文本处理，卡片只用 `textContent`。
- P0 主流程步骤和判定标准不改；功能验证用 E2E/非 P0 回归补充。
- 现有测试默认可以关闭注释（`glossaryEnabled: false`）以保持旧断言；新功能测试显式开启。

## Review Focus

- 模型返回标记但 JSON 损坏：用户仍看到完整译文，不出现红色报错或 JSON 文本。
- 模型返回的 `surface` 不在原文、跨多个文本节点、或落在代码块：该条静默丢弃，其他注释和译文不受影响。
- 浏览器没有 `CSS.highlights` / `Highlight`：译文照常渲染，不抛异常，不出现半截 hover 行为。
- 缓存命中的注释：不请求 provider，悬停仍能显示卡片。
- 翻译过程中 restore/rescan：高亮、卡片、pending timer 全部清除，不留下悬停命中。
- 模型返回超过 3 条、重复 `surface`、未知段落编号：截断/去重/丢弃，不报错。

---

### Task 1: Shared types, settings default, prompt protocol and parser

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/storage.ts`
- Modify: `src/shared/prompt.ts`
- Test: `tests/unit/prompt.test.ts`
- Test: `tests/unit/storage.test.ts`

**Interfaces:**
- Produces:
  - `interface GlossaryNote { surface: string; pos?: string; meaning: string; example?: string }`
  - `BackgroundToClient` result items gain `glossary?: GlossaryNote[]`
  - `Settings.glossaryEnabled: boolean`
  - `const GLOSSARY_MARKER = "<<<ILMT_GLOSSARY>>>"`
  - `const GLOSSARY_INSTRUCTIONS: string`
  - `function buildEffectiveSystemPrompt(systemPrompt: string, glossaryEnabled: boolean): string`
  - `function parseGlossaryNotes(raw: string, items: Segment[]): Map<string, GlossaryNote[]>`
  - `interface AnnotatedParseResult { translations: Map<string, string>; glossary: Map<string, GlossaryNote[]> }`
  - `function parseAnnotatedResponse(raw: string, items: Segment[]): AnnotatedParseResult`

- [ ] **Step 1: Write the failing prompt tests**

Add tests to `tests/unit/prompt.test.ts` covering:

```ts
it("appends the glossary protocol only when enabled", () => {
  expect(buildEffectiveSystemPrompt("SYS", false)).toBe("SYS");
  const on = buildEffectiveSystemPrompt("SYS", true);
  expect(on).toContain("SYS");
  expect(on).toContain("<<<ILMT_GLOSSARY>>>");
  expect(on).toContain("0～3");
});

it("does not append the glossary protocol twice", () => {
  const once = buildEffectiveSystemPrompt("SYS", true);
  expect(buildEffectiveSystemPrompt(once, true)).toBe(once);
});

it("parses translations and glossary from one response", () => {
  const items = [{ id: "p_1", text: "Small tools often outlive their makers." }];
  const raw = [
    "[1] 小工具常常比制造者存在得更久。",
    "<<<ILMT_GLOSSARY>>>",
    '{"1":[{"surface":"outlive","pos":"v.","meaning":"比……存在得更久","example":"Small tools often outlive their makers."}]}',
  ].join("\n");
  const result = parseAnnotatedResponse(raw, items);
  expect(result.translations.get("p_1")).toContain("小工具");
  expect(result.glossary.get("p_1")).toEqual([
    {
      surface: "outlive",
      pos: "v.",
      meaning: "比……存在得更久",
      example: "Small tools often outlive their makers.",
    },
  ]);
});

it("drops broken glossary JSON but keeps translations", () => {
  const items = [{ id: "p_1", text: "Hello world." }];
  const result = parseAnnotatedResponse("[1] 你好世界。\n<<<ILMT_GLOSSARY>>>\n{broken", items);
  expect(result.translations.get("p_1")).toBe("你好世界。");
  expect(result.glossary.size).toBe(0);
});

it("truncates to three notes and drops unknown or missing surfaces", () => {
  const items = [{ id: "p_1", text: "Outlive the noise." }];
  const raw = [
    "[1] 比噪音存在得更久。",
    "<<<ILMT_GLOSSARY>>>",
    JSON.stringify({
      "1": [
        { surface: "Outlive", meaning: "一" },
        { surface: "Outlive", meaning: "重复" },
        { surface: "noise", meaning: "二" },
        { surface: "missing", meaning: "三" },
        { surface: "the", meaning: "四" },
      ],
      "2": [{ surface: "Outlive", meaning: "未知段" }],
    }),
  ].join("\n");
  const notes = parseAnnotatedResponse(raw, items).glossary.get("p_1")!;
  expect(notes).toHaveLength(2);
  expect(notes.map((n) => n.meaning)).toEqual(["一", "二"]);
});

it("recovers a trailing glossary JSON object when the marker is missing", () => {
  const items = [{ id: "p_1", text: "Outlive the noise." }];
  const raw = [
    "[1] 比噪音存在得更久。",
    '{"1":[{"surface":"Outlive","meaning":"比……存在得更久"}]}',
  ].join("\n");
  const result = parseAnnotatedResponse(raw, items);
  expect(result.translations.get("p_1")).toBe("比噪音存在得更久。");
  expect(result.glossary.get("p_1")?.[0].surface).toBe("Outlive");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/prompt.test.ts`
Expected: FAIL because `buildEffectiveSystemPrompt`, `parseAnnotatedResponse`, `parseGlossaryNotes` are not exported.

- [ ] **Step 3: Add the shared types and settings default**

In `src/shared/types.ts` add `GlossaryNote`, `Settings.glossaryEnabled`, and the optional `glossary` field on the `result` message items.

In `src/shared/storage.ts`:
- `DEFAULT_SETTINGS.glossaryEnabled = true`.
- In `getSettings()`, normalize `merged.glossaryEnabled` to `true` when it is not a boolean.

Add storage tests:

```ts
it("defaults glossaryEnabled to true", async () => {
  expect((await getSettings()).glossaryEnabled).toBe(true);
});

it("preserves an explicit glossaryEnabled false", async () => {
  await chrome.storage.local.set({ settings: { glossaryEnabled: false } });
  expect((await getSettings()).glossaryEnabled).toBe(false);
});
```

- [ ] **Step 4: Implement the prompt protocol and parser**

In `src/shared/prompt.ts`:

- Copy the marker and instructions from spec §4.2. The instructions must include:
  - 译文全部结束后再输出 `<<<ILMT_GLOSSARY>>>`；
  - 单行 JSON，键是批内段落编号；
  - 每段 0～3 条，宁少勿多；
  - `surface` 必须是原文连续子串，保留原词形；
  - `meaning` 用 `{{targetLang}}`；
  - 不选专有名词、数字、URL、代码、过于基础的虚词。
- `buildEffectiveSystemPrompt` appends `\n\n${GLOSSARY_INSTRUCTIONS}` only when enabled and `systemPrompt` does not already contain `GLOSSARY_MARKER`.
- `parseGlossaryNotes`:
  - Strip a surrounding Markdown fence.
  - `JSON.parse`; on error return an empty Map.
  - Accept only plain object, integer keys `1..items.length`, array values.
  - Truncate each array to 3.
  - Require non-empty `surface` and `meaning`; optional `pos`/`example` strings.
  - Normalize and cap lengths: `surface` 120, `pos` 20, `meaning` 120, `example` 240.
  - Deduplicate by lowercased `surface` within a segment.
  - Drop notes whose surface is not in `items[index - 1].text` (case-insensitive; collapse whitespace on both sides).
- `parseAnnotatedResponse`:
  - Split at the first `GLOSSARY_MARKER`.
  - Parse the left side with `parseNumberedResponse`.
  - If the left side fails, retry `parseNumberedResponse(raw, ids)` and return translations with empty glossary.
  - On success, parse the right side with `parseGlossaryNotes`.
  - If no marker, call a helper `splitTrailingGlossaryJson(raw)` that finds a trailing one-line JSON object containing only integer keys and array values; if found, remove it and parse notes, otherwise keep raw unchanged.

- [ ] **Step 5: Run the prompt and storage tests to verify they pass**

Run: `npx vitest run tests/unit/prompt.test.ts tests/unit/storage.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/shared/storage.ts src/shared/prompt.ts tests/unit/prompt.test.ts tests/unit/storage.test.ts
git commit -m "feat: add glossary prompt protocol and parser"
```

---

### Task 2: Cache stores translation together with glossary

**Files:**
- Modify: `src/background/cache.ts`
- Test: `tests/unit/cache.test.ts`

**Interfaces:**
- Produces:
  - `interface CachedTranslation { text: string; glossary: GlossaryNote[] }`
  - `TranslationCache.get(key: string): Promise<CachedTranslation | undefined>`
  - `TranslationCache.put(key: string, value: CachedTranslation, meta: { modelId: string }): Promise<void>`

- [ ] **Step 1: Write the failing cache tests**

Replace the existing round-trip/byte tests with object values, and update the cache setup in `tests/unit/options-dom.test.ts` (`cache.put(key, { text, glossary: [] }, ...)` / `cache.get(key)` object assertions):

```ts
it("round-trips translation and glossary", async () => {
  const c = new TranslationCache("ilmt-cache");
  const value = {
    text: "你好",
    glossary: [{ surface: "hello", pos: "int.", meaning: "你好" }],
  };
  await c.put(await key(), value, { modelId: "m" });
  expect(await c.get(await key())).toEqual(value);
});

it("returns an empty glossary for a legacy record without one", async () => {
  // open "ilmt-cache" directly and put { key, text: "旧", modelId: "m",
  // createdAt: Date.now(), lastUsedAt: Date.now() } without glossary
  // expect(await c.get(k)).toEqual({ text: "旧", glossary: [] });
});

it("counts glossary JSON bytes toward the byte cap", async () => {
  const c = new TranslationCache("ilmt-cache", { maxEntries: 10, maxBytes: 8 });
  // text "你好" is 6 UTF-8 bytes; a long glossary must make the entry exceed 8
  // and evict an earlier entry when a second entry is added.
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/cache.test.ts`
Expected: FAIL because `get` returns a string and `put` accepts a string.

- [ ] **Step 3: Implement `CachedTranslation` and cache changes**

In `src/background/cache.ts`:

- Add `CachedTranslation`.
- `CacheRecord.glossary?: GlossaryNote[]`.
- `get` returns `{ text: record.text, glossary: record.glossary ?? [] }`.
- `put(key, value, meta)` stores `text: value.text`, `glossary: value.glossary`.
- `textBytes` becomes `bytesOf(entry.text) + bytesOf(JSON.stringify(entry.glossary ?? []))`; `stats()` uses the same helper.
- Keep DB version unchanged; old records are valid.

- [ ] **Step 4: Run the cache tests to verify they pass**

Run: `npx vitest run tests/unit/cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/background/cache.ts tests/unit/cache.test.ts
git commit -m "feat: cache glossary notes with translations"
```

---

### Task 3: Dispatch returns and caches annotated translations

**Files:**
- Modify: `src/background/dispatch.ts`
- Test: `tests/unit/dispatch.test.ts`

**Interfaces:**
- Consumes: `GlossaryNote`, `CachedTranslation`, `buildEffectiveSystemPrompt`, `parseAnnotatedResponse`, `parseGlossaryNotes`, `GLOSSARY_MARKER`.
- Produces:
  - `interface TranslationOutput { text: string; glossary: GlossaryNote[] }`
  - `interface AnnotatedStreamFilter { push(chunk: string): string; finish(): { text: string; notesRaw: string } }`
  - `function createAnnotatedStreamFilter(): AnnotatedStreamFilter`

- [ ] **Step 1: Update the existing dispatch test fixture for the new setting**

In `tests/unit/dispatch.test.ts`:
- Add `glossaryEnabled: false` to the shared `settings` object so legacy assertions about `SYS` / cache keys stay valid.
- Change every fake cache `get` to return `{ text: "...", glossary: [] }` or `undefined`.
- Change expected `result.items` to the same shape; empty glossary is omitted from the message.

- [ ] **Step 2: Write the failing dispatch tests**

Add tests:

```ts
it("streams only translation text and returns glossary notes", async () => {
  const streamCompletion = vi.fn(async function* () {
    yield "[1] 小工具";
    yield "比制造者存在得更久。\n<<<ILMT_";
    yield 'GLOSSARY>>>\n{"1":[{"surface":"outlive","meaning":"比……存在得更久"}]}';
  });
  const settingsWithGlossary = { ...settings, glossaryEnabled: true };
  const { d, sent, send } = deps({
    getSettings: async () => settingsWithGlossary,
    adapter: fakeAdapter({ streamCompletion }),
    cache: { get: async () => undefined, put: vi.fn(async () => {}) },
  });
  await handleTranslate(
    d,
    { type: "translate", requestId: "rg1", tabId: 1, items: [{ id: "p_1", text: "Small tools outlive.", hash: "h" }] },
    send,
  );
  expect(sent.filter((m) => m.type === "delta").map((m) => m.text)).toEqual([
    "小工具",
    "比制造者存在得更久。\n",
  ]);
  expect(sent.find((m) => m.type === "result").items).toEqual([
    { id: "p_1", text: "小工具比制造者存在得更久。\n", glossary: [{ surface: "outlive", meaning: "比……存在得更久" }] },
  ]);
});

it("returns translation without notes when the glossary JSON is broken", async () => {
  const settingsWithGlossary = { ...settings, glossaryEnabled: true };
  const complete = vi.fn(async () => ({
    text: "[1] 甲\n[2] 乙\n<<<ILMT_GLOSSARY>>>\n{broken",
  }));
  const { d, sent, send } = deps({
    getSettings: async () => settingsWithGlossary,
    adapter: fakeAdapter({ complete }),
    cache: { get: async () => undefined, put: vi.fn(async () => {}) },
  });
  await handleTranslate(
    d,
    { type: "translate", requestId: "rg2", tabId: 1, items: items(2) },
    send,
  );
  expect(sent.find((m) => m.type === "result").items).toEqual([
    { id: "p_1", text: "甲" },
    { id: "p_2", text: "乙" },
  ]);
});

it("uses cached glossary without calling the provider", async () => {
  const cached = { text: "缓存的译文", glossary: [{ surface: "cache", meaning: "缓存" }] };
  const { d, sent, send } = deps({
    getSettings: async () => ({ ...settings, glossaryEnabled: true }),
    cache: { get: async () => cached, put: vi.fn(async () => {}) },
  });
  await handleTranslate(d, { type: "translate", requestId: "rg3", tabId: 1, items: items(1) }, send);
  expect(d.adapter.complete).not.toHaveBeenCalled();
  expect(d.adapter.streamCompletion).not.toHaveBeenCalled();
  expect(sent.find((m) => m.type === "result").items).toEqual([
    { id: "p_1", text: "缓存的译文", glossary: cached.glossary },
  ]);
});

it("changes the cache key when glossary is enabled", async () => {
  const keys: string[] = [];
  const cache = {
    get: async (key: string) => {
      keys.push(key);
      return undefined;
    },
    put: async () => {},
  };
  const off = deps({ getSettings: async () => ({ ...settings, glossaryEnabled: false }), cache });
  await handleTranslate(off.d, { type: "translate", requestId: "rg4", tabId: 1, items: items(1) }, off.send);
  const on = deps({ getSettings: async () => ({ ...settings, glossaryEnabled: true }), cache });
  await handleTranslate(on.d, { type: "translate", requestId: "rg5", tabId: 1, items: items(1) }, on.send);
  expect(keys[0]).not.toBe(keys[1]);
});

it("strips a glossary marker split across stream chunks", () => {
  const filter = createAnnotatedStreamFilter();
  expect(filter.push("[1] 你")).toBe("你");
  expect(filter.push("好\n<<<ILMT_")).toBe("好\n");
  expect(filter.push('GLOSSARY>>>\n{"1":[{"surface":"好","meaning":"good"}]}')).toBe("");
  expect(filter.finish()).toEqual({
    text: "你好\n",
    notesRaw: '{"1":[{"surface":"好","meaning":"good"}]}',
  });
});
```

- [ ] **Step 3: Run the dispatch tests to verify they fail**

Run: `npx vitest run tests/unit/dispatch.test.ts`
Expected: FAIL because annotated result fields and `createAnnotatedStreamFilter` do not exist.

- [ ] **Step 4: Implement the annotated dispatch path**

In `src/background/dispatch.ts`:

- Add `TranslationOutput` and use `Map<string, TranslationOutput>` in `GroupOutcome` / `enqueueTranslateGroup`.
- Thread `glossaryEnabled` from `handleTranslate` into `enqueueTranslateGroup` and `runGroup` (add a boolean parameter after `allowSplit`); both split halves inherit the same value.
- Compute:

```ts
const glossaryEnabled = settings.glossaryEnabled !== false;
const effectivePrompt = buildEffectiveSystemPrompt(systemPrompt, glossaryEnabled);
const promptVersion = await promptVersionFor(effectivePrompt);
```

- Cache hit: `resultMap.set(item.id, cached)` where cached is `CachedTranslation`.
- Cache write: `deps.cache.put(key, { text, glossary }, { modelId: provider.model })`.
- Result message: include `glossary` only when `glossary.length > 0`.
- Single-segment, glossary enabled: use `createAnnotatedStreamFilter()`; after finish, error if `text.trim() === ""`; parse notes with `parseGlossaryNotes(notesRaw, group)`.
- Single-segment, glossary disabled: keep existing `createSingleSegmentPrefixStripper()` path.
- Multi-segment, glossary enabled: `parseAnnotatedResponse(result.text, group)`; build outputs from translations + glossary.
- Multi-segment, glossary disabled: keep existing `parseNumberedResponse` behavior.
- `createAnnotatedStreamFilter`:
  - Use `createSingleSegmentPrefixStripper()` for `[1]`.
  - Hold back only the longest suffix of the pending text that is a prefix of `GLOSSARY_MARKER` (not the whole marker length), so ordinary text streams immediately and a marker split across chunks is still caught.
  - When the marker is found, return the text before it, set mode to notes, and collect the rest.
  - `finish()` flushes the prefix stripper and, if no marker, returns all held text as translation.

- [ ] **Step 5: Run the dispatch tests to verify they pass**

Run: `npx vitest run tests/unit/dispatch.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/background/dispatch.ts tests/unit/dispatch.test.ts
git commit -m "feat: return and cache glossary with translations"
```

---

### Task 4: Options toggle and prompt version

**Files:**
- Modify: `src/options/main.ts`
- Test: `tests/unit/options-dom.test.ts`

**Interfaces:**
- Consumes: `buildEffectiveSystemPrompt`.
- Produces: checkbox `.global-glossaryEnabled`; saved `Settings.glossaryEnabled`.

- [ ] **Step 1: Write the failing options tests**

Add:

```ts
it("renders glossary enabled by default and saves false", async () => {
  await seed({ glossaryEnabled: true });
  await boot();
  const checkbox = document.querySelector<HTMLInputElement>(".global-glossaryEnabled")!;
  expect(checkbox.checked).toBe(true);
  checkbox.checked = false;
  click(".global-save");
  await vi.waitFor(async () => {
    expect((await getSettings()).glossaryEnabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run the options test to verify it fails**

Run: `npx vitest run tests/unit/options-dom.test.ts`
Expected: FAIL because the checkbox does not exist.

- [ ] **Step 3: Implement the toggle**

In `src/options/main.ts`:

- Import `buildEffectiveSystemPrompt`.
- Add `glossaryEnabled` to `GlobalFields`.
- In `renderGlobal()`, after the prompt field, add a `fieldset.field-group` with legend `学习注释`, a `label.checkbox-row` containing `input.global-glossaryEnabled` (type checkbox), text `翻译时标出值得学的词`, and a hint `每段最多 3 个；悬停查看释义。关闭后只翻译。`
- `checked = s.glossaryEnabled !== false`.
- In `saveGlobal()`:
  - Read `const glossaryEnabled = fields.glossaryEnabled.checked;`
  - Compute `effectivePrompt = buildEffectiveSystemPrompt(systemPrompt.trim() ? systemPrompt : DEFAULT_SETTINGS.systemPrompt, glossaryEnabled);`
  - Recompute `promptVersion` when `systemPrompt`, `glossaryEnabled`, or empty version changed.
  - Persist `glossaryEnabled`.

- [ ] **Step 4: Run the options test to verify it passes**

Run: `npx vitest run tests/unit/options-dom.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/options/main.ts tests/unit/options-dom.test.ts
git commit -m "feat: add glossary settings toggle"
```

---

### Task 5: Paragraph text nodes and registry glossary state

**Files:**
- Modify: `src/content/paragraphs.ts`
- Modify: `src/content/registry.ts`
- Test: `tests/unit/paragraphs.test.ts`
- Test: `tests/unit/registry.test.ts`

**Interfaces:**
- Produces:
  - `ParagraphNode.textNodes?: Node[]`
  - `ParagraphRecord.textNodes: WeakRef<Node>[]`
  - `ParagraphRegistry.setGlossary(id: string, glossary: GlossaryNote[]): void`
  - `ParagraphRecord.glossary?: GlossaryNote[]`

- [ ] **Step 1: Write the failing tests**

In `paragraphs.test.ts`:

```ts
it("records the text nodes that make up a piece", async () => {
  document.body.innerHTML = `<p>Hello <em>world</em>.</p>`;
  const [piece] = await collectParagraphs(document.body);
  expect(piece.textNodes?.map((n) => n.textContent)).toEqual(["Hello ", "world", "."]);
});
```

In `registry.test.ts`:

```ts
it("stores text-node refs and glossary notes", () => {
  const r = new ParagraphRegistry();
  document.body.innerHTML = `<p>Hello world.</p>`;
  const p = document.querySelector("p")!;
  const text = p.firstChild!;
  r.add({ id: "p_1", el: p, anchor: text, text: "Hello world.", heading: false, textNodes: [text] });
  expect(r.get("p_1")!.textNodes.map((ref) => ref.deref())).toEqual([text]);
  r.setGlossary("p_1", [{ surface: "Hello", meaning: "你好" }]);
  expect(r.get("p_1")!.glossary).toEqual([{ surface: "Hello", meaning: "你好" }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/paragraphs.test.ts tests/unit/registry.test.ts`
Expected: FAIL because `textNodes` and `setGlossary` do not exist.

- [ ] **Step 3: Implement text-node collection and registry fields**

In `src/content/paragraphs.ts`:

- Add `textNodes: Node[]` to `WalkContext` and `RawPiece`.
- Initialize `textNodes: []` in both `walkScope` and the nested block context.
- When a text node has non-whitespace content, push it to `ctx.textNodes`.
- In `flush`, include `textNodes: ctx.textNodes` and reset it.
- Push `textNodes: piece.textNodes` into `ParagraphNode`.

In `src/content/registry.ts`:

- Add `textNodes: WeakRef<Node>[]` and `glossary?: GlossaryNote[]` to `ParagraphRecord`.
- `add()` maps `(p.textNodes ?? []).map((node) => new WeakRef(node))`.
- Add `setGlossary(id, glossary)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/paragraphs.test.ts tests/unit/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/content/paragraphs.ts src/content/registry.ts tests/unit/paragraphs.test.ts tests/unit/registry.test.ts
git commit -m "feat: track paragraph text nodes and glossary state"
```

---

### Task 6: Pure range finder for glossary surfaces

**Files:**
- Create: `src/content/glossary-range.ts`
- Test: `tests/unit/glossary-range.test.ts`

**Interfaces:**
- Produces: `function findSurfaceRange(textNodes: Node[], surface: string): Range | undefined`

- [ ] **Step 1: Write the failing tests**

```ts
it("finds a word inside one text node", () => {
  document.body.innerHTML = `<p>Small tools often outlive their makers.</p>`;
  const text = document.querySelector("p")!.firstChild!;
  const range = findSurfaceRange([text], "outlive")!;
  expect(range.toString()).toBe("outlive");
});

it("is case-insensitive and respects word boundaries", () => {
  document.body.innerHTML = `<p>Article and art.</p>`;
  const text = document.querySelector("p")!.firstChild!;
  expect(findSurfaceRange([text], "art")?.toString()).toBe("art");
  expect(findSurfaceRange([text], "missing")).toBeUndefined();
});

it("finds a phrase inside one text node", () => {
  document.body.innerHTML = `<p>We need to look up the word.</p>`;
  const text = document.querySelector("p")!.firstChild!;
  expect(findSurfaceRange([text], "look up")?.toString()).toBe("look up");
});

it("skips code, pre, kbd, samp and translation nodes", () => {
  document.body.innerHTML = `<p>Text <code>outlive</code> <span class="ilmt-tr">outlive</span></p>`;
  const p = document.querySelector("p")!;
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  const nodes: Node[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
  // The only "outlive" occurrences are inside <code> and .ilmt-tr.
  expect(findSurfaceRange(nodes, "outlive")).toBeUndefined();
});

it("skips a phrase split across text nodes in v1", () => {
  document.body.innerHTML = `<p>look <em>up</em></p>`;
  const p = document.querySelector("p")!;
  const nodes = [p.firstChild!, p.querySelector("em")!.firstChild!];
  expect(findSurfaceRange(nodes, "look up")).toBeUndefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/glossary-range.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement `findSurfaceRange`**

- Trim `surface`; return `undefined` if empty.
- For each node:
  - Only `Text` nodes.
  - Skip if `parentElement.closest("code, pre, kbd, samp, .ilmt-tr")`.
  - Lowercase `node.data` and `surface`.
  - Find the first index.
  - If `surface` starts with a letter/number, reject when the previous char is a letter/number.
  - If `surface` ends with a letter/number, reject when the next char is a letter/number.
  - Create a `Range` with `setStart(node, index)`, `setEnd(node, index + surface.length)`.
- Return `undefined` if none.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/glossary-range.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/content/glossary-range.ts tests/unit/glossary-range.test.ts
git commit -m "feat: locate glossary terms in paragraph text nodes"
```

---

### Task 7: Gloss controller: CSS highlight and hover card

**Files:**
- Create: `src/content/glossary.ts`
- Modify: `src/styles/inject.css`
- Test: `tests/unit/glossary.test.ts`

**Interfaces:**
- Consumes: `findSurfaceRange`, `GlossaryNote`.
- Produces:

```ts
export interface GlossController {
  start(): void;
  stop(): void;
  setParagraph(id: string, textNodes: Node[], notes: GlossaryNote[]): void;
  removeParagraph(id: string): void;
  prune(liveIds: Set<string>): void;
  clear(): void;
}

export function createGlossController(doc?: Document): GlossController;
```

- [ ] **Step 1: Write the failing controller tests**

Use jsdom plus stubs:

```ts
function stubHighlights() {
  const registry = new Map<string, unknown>();
  vi.stubGlobal("Highlight", class {
    ranges: Range[];
    constructor(...ranges: Range[]) {
      this.ranges = ranges;
    }
  });
  vi.stubGlobal("CSS", { highlights: registry });
  return registry;
}

it("adds a CSS highlight and shows a card on hover", () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  const registry = stubHighlights();
  document.body.innerHTML = `<p>Small tools often outlive their makers.</p>`;
  const text = document.querySelector("p")!.firstChild!;
  const controller = createGlossController(document);
  controller.start();
  controller.setParagraph("p_1", [text], [
    { surface: "outlive", pos: "v.", meaning: "比……存在得更久", example: "Small tools often outlive their makers." },
  ]);
  expect(registry.get("ilmt-gloss")).toBeTruthy();

  const rect = { left: 10, top: 20, width: 60, height: 16, bottom: 36, right: 70 };
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(rect as DOMRect);
  Object.defineProperty(document, "caretPositionFromPoint", {
    configurable: true,
    value: vi.fn(() => ({ offsetNode: text, offset: 20 })),
  });

  document.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 28, bubbles: true }));
  vi.advanceTimersByTime(150);

  const card = document.querySelector("[role=tooltip]")!;
  expect(card.textContent).toContain("outlive");
  expect(card.textContent).toContain("比……存在得更久");
  expect(card.querySelector("img")).toBeNull();
});
```

Add tests:
- Put a literal `<img src=x onerror=alert(1)>` in `meaning`: card textContent contains it and `card.querySelector("img")` is null.
- Move pointer to an offset outside the range -> card removed.
- `stop()` removes the card and deletes the highlight.
- Without `CSS.highlights` / `Highlight`, `setParagraph` and `start` do not throw.
- `prune(new Set())` removes the highlight.
- `setParagraph` with `notes: []` removes that paragraph's old highlight.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/glossary.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the controller**

- Internal state:
  - `entries: Array<{ paragraphId: string; range: Range; note: GlossaryNote }>`
  - `byNode: Map<Text, Array<{ start: number; end: number; entry: ... }>>`
  - `card: HTMLElement | null`
  - `pendingEntry`, `showTimer`, `currentEntry`, `raf`, `lastPoint`.
- `setParagraph(id, textNodes, notes)`:
  - `removeParagraph(id)`.
  - For each note, `findSurfaceRange(textNodes, note.surface)`.
  - Skip if it overlaps an existing range (`range.compareBoundaryPoints` or start/end checks).
  - Enforce 500 total entries.
  - Add entry; add to `byNode` for its text node.
  - `rebuildHighlight()`.
- `rebuildHighlight()`:
  - `const view = doc.defaultView as (Window & typeof globalThis) | null;`
  - `const css = view?.CSS ?? globalThis.CSS; const Ctor = view?.Highlight ?? globalThis.Highlight;`
  - If either missing, return.
  - If no ranges, `css.highlights.delete("ilmt-gloss")`; else `css.highlights.set("ilmt-gloss", new Ctor(...ranges))`.
- `start()`:
  - Attach `pointermove` on `doc`, `scroll` on `doc.defaultView` (capture), `blur` on `doc.defaultView`, `selectionchange` on `doc`.
  - Idempotent.
- `onPointerMove(event)`:
  - Ignore `event.pointerType === "touch"`.
  - If selection non-empty, `hideCard()`.
  - Store point; schedule `requestAnimationFrame`.
  - In frame, call `caretPositionFromPoint`; fallback `(doc as any).caretRangeFromPoint`.
  - If node is `Text`, look up `byNode`; find offset `>= start && < end`.
  - If hit: if same as `currentEntry`, do nothing; else clear timer, set pending, `setTimeout(120)` to show card.
  - If no hit: `hideCard()`.
- `showCard(entry)`:
  - Create if absent: `div.ilmt-gloss-card`, `role="tooltip"`, child divs.
  - Set textContent for word (+ pos), meaning, example. Omit empty pos/example.
  - Append to `doc.body`.
  - Measure card; position above range if `rect.top >= height + 8`, else below; clamp left to `[8, innerWidth - width - 8]`.
- `hideCard()`: clear timer, remove card, current = null.
- `stop()`: remove listeners, `clear()`.
- `clear()`: entries/maps, delete highlight, hide card.
- CSS in `inject.css`:
  - `::highlight(ilmt-gloss)` with dotted underline + subtle background.
  - `.ilmt-gloss-card` fixed, max-width, padding, border, shadow, font, z-index max, pointer-events none.
  - `.ilmt-gloss-word`, `.ilmt-gloss-pos`, `.ilmt-gloss-meaning`, `.ilmt-gloss-example`.

- [ ] **Step 4: Run the controller tests to verify they pass**

Run: `npx vitest run tests/unit/glossary.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/content/glossary.ts src/styles/inject.css tests/unit/glossary.test.ts
git commit -m "feat: add glossary highlight and hover card"
```

---

### Task 8: Wire glossary into content main lifecycle

**Files:**
- Modify: `src/content/main.ts`
- Test: `tests/unit/main-ui.test.ts`
- Test: `tests/unit/main-messages.test.ts`

**Interfaces:**
- Consumes: `createGlossController`, `ParagraphRecord.textNodes`, `item.glossary`.
- Produces: result rendering updates highlight; restore/rescan/invalidate remove it.

- [ ] **Step 1: Write the failing lifecycle tests**

In `main-ui.test.ts`, mock the controller module. Use `vi.hoisted` because `vi.mock` is hoisted above ordinary const declarations:

```ts
const mocks = vi.hoisted(() => ({
  gloss: {
    start: vi.fn(),
    stop: vi.fn(),
    setParagraph: vi.fn(),
    removeParagraph: vi.fn(),
    prune: vi.fn(),
    clear: vi.fn(),
  },
}));
vi.mock("../../src/content/glossary", () => ({
  createGlossController: () => mocks.gloss,
}));
```

Add tests:
- After delivering a `result` with `glossary`, `gloss.setParagraph` was called with the paragraph id and the note array.
- `globalThis.__ilmtMain.restore()` calls `gloss.stop()`.
- `page-navigated` rescan calls `gloss.clear()`.
- Invalidating an edited piece root calls `gloss.removeParagraph(id)`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/main-ui.test.ts tests/unit/main-messages.test.ts`
Expected: FAIL because main does not import or call the controller.

- [ ] **Step 3: Wire the controller**

In `src/content/main.ts`:

- Import `createGlossController`.
- Create `const gloss = createGlossController();`.
- `translatePage()`: call `gloss.start()` once active.
- `restore()`: call `gloss.stop()` (which clears).
- `rescan()`: call `gloss.clear()` before `restoreAll`.
- `handleResult()`:
  - Resolve `rec.textNodes` WeakRefs, filter connected `Node`s.
  - Call `gloss.setParagraph(item.id, textNodes, item.glossary ?? [])`.
  - Store `registry.setGlossary(item.id, item.glossary ?? [])`.
- `invalidatePieceRoot()`: call `gloss.removeParagraph(id)` for each id.
- In `pruneOrphanTranslations()` (called by `pump()` and the prune timer), after building `live`, call `gloss.prune(live)` so detached records lose their highlights too.

- [ ] **Step 4: Run the lifecycle tests to verify they pass**

Run: `npx vitest run tests/unit/main-ui.test.ts tests/unit/main-messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/content/main.ts tests/unit/main-ui.test.ts tests/unit/main-messages.test.ts
git commit -m "feat: wire glossary highlight into content lifecycle"
```

---

### Task 9: Deterministic Playwright coverage

**Files:**
- Modify: `tests/mock-server.ts`
- Modify: `tests/e2e/translate.spec.ts`

**Interfaces:**
- Consumes: glossary protocol marker.
- Produces: mock server `glossary?: (index: number, sourceText: string) => MockGlossaryNote[] | undefined`.

- [ ] **Step 1: Write the failing E2E test**

Add to `tests/e2e/translate.spec.ts`:

```ts
test("shows a glossary card on hover and clears it on restore", async () => {
  try {
    server = await startMockServer({
      glossary: (index) =>
        index === 1
          ? [{ surface: "outlive", pos: "v.", meaning: "比……存在得更久", example: "Small tools often outlive their larger competitors." }]
          : undefined,
    });
    extension = await launchExtension();
    await seedSettings(extension.worker, server.origin);

    const page = await extension.context.newPage();
    await page.goto(`${server.origin}/${ARTICLES.english}`);
    await activate(extension.worker, await activeTabId(extension.worker, page.url()));
    const content = await findContentMainContext(page);
    await evaluateInContent(content, "globalThis.__ilmtMain.translatePage()");
    await expect(page.locator(".ilmt-tr")).toHaveCount(10);
    expect(
      await evaluateInContent<number>(content, 'CSS.highlights?.get("ilmt-gloss")?.size ?? 0'),
    ).toBeGreaterThan(0);

    const rect = await page.evaluate(() => {
      const p = document.querySelector("#article-p1")!;
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text;
        const index = text.data.indexOf("outlive");
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(text, index);
        range.setEnd(text, index + "outlive".length);
        const box = range.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      }
      return null;
    });
    expect(rect).not.toBeNull();

    await page.mouse.move(rect!.x, rect!.y);
    await expect(page.locator("[role=tooltip]")).toContainText("outlive");
    await expect(page.locator("[role=tooltip]")).toContainText("比……存在得更久");

    await page.mouse.move(0, 0);
    await expect(page.locator("[role=tooltip]")).toHaveCount(0);

    await evaluateInContent(content, "globalThis.__ilmtMain.restore()");
    await expect(page.locator(".ilmt-tr")).toHaveCount(0);
    await expect(page.locator("[role=tooltip]")).toHaveCount(0);
    expect(
      await evaluateInContent<number>(content, 'CSS.highlights?.get("ilmt-gloss")?.size ?? 0'),
    ).toBe(0);
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 2: Run the E2E test to verify it fails**

Run: `npx playwright test tests/e2e/translate.spec.ts -g "glossary card"`
Expected: FAIL because the mock server does not append glossary notes and/or the card is absent.

- [ ] **Step 3: Extend the mock server**

In `tests/mock-server.ts`:

- Add `MockGlossaryNote` and `glossary?: (index: number, sourceText: string) => MockGlossaryNote[] | undefined` to `MockServerOptions`.
- In `buildTranslationReply`, collect notes per index while building lines.
- If any notes exist, append:

```ts
const marker = "<<<ILMT_GLOSSARY>>>";
return `${lines.join("\n")}\n${marker}\n${JSON.stringify(notes)}`;
```

- Also add `glossaryEnabled: true` to the e2e `seedSettings` settings object.

- [ ] **Step 4: Run the E2E test to verify it passes**

Run: `npx playwright test tests/e2e/translate.spec.ts -g "glossary card"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/mock-server.ts tests/e2e/translate.spec.ts
git commit -m "test: cover glossary hover in loaded extension"
```

---

### Task 10: Docs, full verification, P0

**Files:**
- Modify: `README.md`
- Modify: `docs/delivery-verification.md` (non-P0 section only)
- Test: full suite / build / browser

- [ ] **Step 1: Update README and non-P0 regression notes**

- README feature bullets: add “翻译时标出 0～3 个值得学的词/短语，悬停看本句释义；默认开启，可在设置关闭。”
- `docs/delivery-verification.md` §4 add:
  - `悬停释义：翻译后原文出现虚线下划线；悬停显示词/词性/释义；移开消失；还原后高亮和卡片清除。`
- Do not change §2 P0 steps or pass criteria.

- [ ] **Step 2: Run the automated delivery gate**

Run: `npm run verify:delivery`
Expected: PASS — all unit tests, `tsc --noEmit`, build, `check-build`.

- [ ] **Step 3: Run the Playwright glossary test**

Run: `npx playwright test tests/e2e/translate.spec.ts -g "glossary card"`
Expected: PASS.

- [ ] **Step 4: Run the browser P0**

Follow `docs/delivery-verification.md` §1–§2 exactly:
- reload `dist/` extension;
- refresh test page;
- `Opt+A` translation: 10/10, no error banner;
- bilingual below source;
- `Opt+A` restore: 0 translations, 10 sources;
- popup shows provider/model/masked key;
- selection explain opens side panel and answers;
- no red console errors.

Then run the glossary smoke in the same page:

```bash
opencli browser delivery eval '(() => {
  const h = CSS.highlights?.get("ilmt-gloss");
  return { ranges: h ? h.size : 0, card: document.querySelector(".ilmt-gloss-card")?.textContent ?? null };
})()'
```

If `ranges > 0`, dispatch a pointermove at the first range’s center and confirm `.ilmt-gloss-card` contains the word and meaning. Then move away and confirm the card is gone. If the real model returns 0 notes, record that and rely on the mock E2E for hover coverage; translation must still pass.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/delivery-verification.md docs/superpowers/specs/2026-11-11-hover-glossary-design.md docs/superpowers/plans/2026-11-11-hover-glossary.md
git commit -m "docs: document hover glossary"
```

---

## Self-Review

**Spec coverage:** Tasks 1–4 cover protocol, settings, cache, background. Tasks 5–8 cover text nodes, range lookup, highlight, hover, lifecycle. Task 9 covers deterministic browser behavior. Task 10 covers docs and P0.

**Type consistency:** `GlossaryNote`, `CachedTranslation`, `TranslationOutput`, `AnnotatedStreamFilter`, `GlossController` are defined once and referenced by the same names in later tasks. `parseGlossaryNotes` / `parseAnnotatedResponse` signatures match dispatch and tests.

**Review Focus coverage:**
- Broken JSON -> Task 1/3 tests.
- Missing/cross-node surfaces -> Task 1/6 tests.
- No Highlight API -> Task 7 test.
- Cached glossary -> Task 3 test.
- Restore/rescan cleanup -> Task 8 tests and Task 9 E2E.
- Over 3/duplicate/unknown -> Task 1 test.
