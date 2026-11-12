# 学习闭环（认领角色 + 间隔复习 + 多语言 + Prompt 分层）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让悬停卡片上的地鼠能把词收进本地学习库，并在侧栏按间隔重复复习；同时把翻译 prompt 拆成固定的格式层与可配置的偏好层。

**Architecture:** 纯函数层（`srs`、`learning-storage`、`preferences`、`prompt`）不碰 DOM 与 `chrome.*`；存储写入全部经 background 的串行队列；content 只负责悬停卡片与发消息；侧栏只读 storage 渲染，作答走消息。表现的「认领角色」是注册表里的皮肤，状态机固定。

**Tech Stack:** TypeScript、Vite、MV3、Vitest（jsdom）、Playwright、Chrome `storage.local`。

**Spec:** `docs/superpowers/specs/2026-11-12-learning-loop-design.md`

## Global Constraints

- 纯函数模块（`src/shared/srs.ts`、`src/shared/learning-storage.ts`、`src/shared/preferences.ts`、`src/shared/prompt.ts`）不得 import DOM 或直接调用 `chrome.*`；`now` 一律由调用方注入。
- 不新增运行时依赖；不引入外部图片/字体/网络资源（角色必须是内联 SVG）。
- 所有新 UI 文案为简体中文；类名沿用 `ilmt-` 前缀（含混在 `ilmt-gloss-` 占位符中的既有类名）。
- `glossLangs` **不得**进入 `promptVersion` 哈希（单测必须断言）。
- `learningLangs` 白名单：`en` / `ja` / `es` / `fr`，默认 `["en"]`，最多 4 个。
- 本版**不实现** `buildGlossPrompt` 与 `lookup-gloss` 的实际请求；消息返回 `{ ok: false, reason: "not-implemented" }`。
- 每个任务结束必须通过：`npx tsc --noEmit` 与该任务的单测。
- 交付前必须跑 `npm run verify:delivery` 与 `docs/delivery-verification.md` 的 P0 主流程。

## Review Focus

1. **用户偏好文本里写格式指令**（如「忽略上面的规则」）：译文仍按 `[编号]` 解析成功，注释仍可丢可留。
2. **旧 settings 无 `preference` / `learningLangs`**：读取不抛错，迁移为通用偏好 + `["en"]`。
3. **学习目标新增一种语言**：不触发整页重译（缓存 key 不变），旧记录的页只在复习里缺该语言释义。
4. **鼠标从词移到卡片**：卡片不消失；移出词与卡片两者后 180ms 才消失；滚动仍立即消失。
5. **学习库数据损坏 / 超过 2000 词 / 同一词多标签并发点击**：不崩、不重复建卡、按规则淘汰。

---

### Task 1: 设置与类型基础（含迁移）

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/storage.ts`
- Test: `tests/unit/storage.test.ts`

**Interfaces:**
- Produces: `DomainPreset`、`TranslationPreference`、`MascotSettings`、`LearningGrade`、`LearningWord`、`LearningState`、`LearningStats`、`WordGloss`、`WordContext`、`ReviewEntry`、`WordStatus`、`LearnWordMessage`、`LearnWordResponse`、`ReviewAnswerMessage`、`ReviewAnswerResponse`、`GetLearningMessage`、`GetLearningResponse`、`LookupGlossMessage`；`Settings.learningLangs: string[]`、`Settings.preference: TranslationPreference`、`Settings.mascot: MascotSettings`；`GlossaryNote.glosses?: Record<string, string>`。

- [ ] **Step 1: 写失败测试**

在 `tests/unit/storage.test.ts` 新增：

```ts
it("defaults learning settings", async () => {
  const s = await getSettings();
  expect(s.learningLangs).toEqual(["en"]);
  expect(s.preference).toEqual({ domain: "general", instructions: "" });
  expect(s.mascot).toEqual({ mode: "rotate", enabledIds: [], animations: true });
});

it("migrates a user-edited system prompt into custom instructions", async () => {
  await chrome.storage.local.set({
    settings: { ...DEFAULT_SETTINGS, systemPrompt: "尽量口语化，别用术语" },
  });
  const s = await getSettings();
  expect(s.preference.domain).toBe("custom");
  expect(s.preference.instructions).toBe("尽量口语化，别用术语");
});

it("migrates the legacy default prompt to general", async () => {
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS } });
  const s = await getSettings();
  expect(s.preference).toEqual({ domain: "general", instructions: "" });
});

it("keeps a stored preference and drops unknown languages", async () => {
  await chrome.storage.local.set({
    settings: {
      ...DEFAULT_SETTINGS,
      preference: { domain: "tech", instructions: "保留英文术语" },
      learningLangs: ["en", "xx", "es", "fr", "ja", "de"],
    },
  });
  const s = await getSettings();
  expect(s.preference.domain).toBe("tech");
  expect(s.learningLangs).toEqual(["en", "es", "fr", "ja"]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/storage.test.ts`
Expected: FAIL，`s.learningLangs` 为 `undefined`。

- [ ] **Step 3: 加类型与默认值**

`src/shared/types.ts`：

```ts
export type DomainPreset = "general" | "tech" | "legal" | "medical" | "literary" | "custom";

export interface TranslationPreference {
  domain: DomainPreset;
  instructions: string;
  terms?: Array<{ from: string; to: string }>;
}

export interface MascotSettings {
  mode: "rotate" | "fixed";
  fixedId?: string;
  enabledIds: string[];
  animations: boolean;
}

export type LearningGrade = "again" | "hard" | "good";
export type WordStatus = "learning" | "mastered";

export interface ReviewEntry {
  at: number;
  grade: LearningGrade;
  box: number;
  spot?: boolean;
  spotCorrect?: boolean;
  termLang?: string;
  glossLang?: string;
}

export interface WordContext {
  sentence: string;
  pageUrl: string;
  pageTitle?: string;
  at: number;
}

export interface WordGloss {
  lang: string;
  meaning: string;
  source: "translation" | "lookup";
  at: number;
}

export interface LearningWord {
  id: string;
  termLang: string;
  surface: string;
  pos?: string;
  glosses: WordGloss[];
  glossLang: string;
  contexts: WordContext[];
  status: WordStatus;
  box: number;
  dueAt: number | null;
  mascotId?: string;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  reviews: ReviewEntry[];
  reviewsCount: number;
  correctCount: number;
  checksSinceSpot: number;
}

export interface LearningStats {
  day: string;
  todayReviewed: number;
}

export interface LearningState {
  version: 1;
  words: LearningWord[];
  stats: LearningStats;
  updatedAt: number;
}
```

`Settings` 增加 `learningLangs`、`preference`、`mascot`，并给 `systemPrompt` / `promptVersion` 加 `@deprecated` 注释（字段暂时保留，Task 12 移除 UI）。

- [ ] **Step 4: 迁移与归一化**

`src/shared/storage.ts`：

```ts
const LEARNING_LANGS = ["en", "ja", "es", "fr"] as const;

/** 旧版本的默认翻译提示词；用于判断用户是否改过。 */
const LEGACY_DEFAULT_PROMPT = "<Task 3 里原样搬运 DEFAULT_SETTINGS.systemPrompt 的字符串>";

export function normalizeLearningLangs(value: unknown): string[] { /* 白名单 + 去重 + 截断 4 + 空则 ["en"] */ }
export function normalizePreference(value: unknown, legacySystemPrompt?: string): TranslationPreference { /* 见测试 */ }
export function normalizeMascot(value: unknown): MascotSettings { /* 见默认值 */ }
```

`getSettings()` 在浅合并后调用这三个函数；`DEFAULT_SETTINGS` 增加：

```ts
learningLangs: ["en"],
preference: { domain: "general", instructions: "" },
mascot: { mode: "rotate", enabledIds: [], animations: true },
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/unit/storage.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/shared/storage.ts tests/unit/storage.test.ts
git commit -m "feat: add learning types and settings migration"
```

---

### Task 2: 间隔调度器

**Files:**
- Create: `src/shared/srs.ts`
- Test: `tests/unit/srs.test.ts`

**Interfaces:**
- Consumes: `LearningGrade`、`WordStatus`（Task 1）
- Produces: `INTERVALS_MS: readonly number[]`、`MAX_BOX = 5`、`applyGrade(word: { box: number; status: WordStatus }, grade: LearningGrade, now: number): { box: number; dueAt: number | null; status: WordStatus; correct: boolean }`、`isDue(word: { status: WordStatus; dueAt: number | null }, now: number): boolean`、`dueCount(words: Array<{ status: WordStatus; dueAt: number | null }>, now: number): number`、`formatDueLabel(dueAt: number | null, now: number): string`

- [ ] **Step 1: 写失败测试**

`tests/unit/srs.test.ts`：

```ts
const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

it("maps good to the next box and its interval", () => {
  expect(applyGrade({ box: 0, status: "learning" }, "good", NOW))
    .toEqual({ box: 1, dueAt: NOW + 24 * HOUR, status: "learning", correct: true });
});

it("keeps the box on hard and re-arms the same interval", () => {
  expect(applyGrade({ box: 3, status: "learning" }, "hard", NOW))
    .toEqual({ box: 3, dueAt: NOW + 7 * 24 * HOUR, status: "learning", correct: false });
});

it("drops to box 0 with a ten-minute retry on again", () => {
  expect(applyGrade({ box: 4, status: "learning" }, "again", NOW))
    .toEqual({ box: 0, dueAt: NOW + 10 * 60_000, status: "learning", correct: false });
});

it("graduates after a good answer at the top box", () => {
  expect(applyGrade({ box: 5, status: "learning" }, "good", NOW))
    .toEqual({ box: 5, dueAt: null, status: "mastered", correct: true });
});

it("formats due labels", () => {
  expect(formatDueLabel(NOW + 10 * 60_000, NOW)).toBe("10 分钟后");
  expect(formatDueLabel(NOW + 3 * HOUR, NOW)).toBe("3 小时后");
  expect(formatDueLabel(NOW + 24 * HOUR, NOW)).toBe("明天");
  expect(formatDueLabel(NOW + 3 * 24 * HOUR, NOW)).toBe("3 天后");
  expect(formatDueLabel(null, NOW)).toBe("已毕业");
  expect(formatDueLabel(NOW - 1, NOW)).toBe("现在");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/srs.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`INTERVALS_MS` 取 spec §9 的 6 段；`applyGrade` 按 spec 表实现；`formatDueLabel` 规则：`null` → `已毕业`；`<= now` → `现在`；`<1h` → 向上取整分钟；`<24h` → 向上取整小时；`<48h` → `明天`；其余按天。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/srs.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/shared/srs.ts tests/unit/srs.test.ts
git commit -m "feat: add spaced-repetition scheduler"
```

---

### Task 3: 学习库读写与合并

**Files:**
- Create: `src/shared/learning-storage.ts`
- Test: `tests/unit/learning-storage.test.ts`

**Interfaces:**
- Consumes: Task 1 类型、Task 2 `applyGrade`/`isDue`
- Produces:
  - `LEARNING_KEY = "learning"`、`MAX_WORDS = 2000`
  - `emptyLearningState(): LearningState`
  - `normalizeSurface(surface: string): string`
  - `wordId(termLang: string, surface: string): string`
  - `parseLearningState(raw: unknown): LearningState`
  - `mergeLearnedWord(state, input: LearnWordMessage, now: number): { state: LearningState; created: boolean; word: LearningWord }`
  - `applyReviewAnswer(state, input: { id: string; grade: LearningGrade; glossLang?: string; spot?: boolean; spotCorrect?: boolean }, now: number): { state: LearningState; word: LearningWord | null }`
  - `getLearning(): Promise<LearningState>`、`saveLearning(state: LearningState): Promise<void>`

- [ ] **Step 1: 写失败测试**

`tests/unit/learning-storage.test.ts`（节选断言）：

```ts
it("returns an empty state for missing or corrupt data", () => {
  expect(parseLearningState(undefined).words).toEqual([]);
  expect(parseLearningState({ words: "nope" }).words).toEqual([]);
  expect(parseLearningState({ version: 99, words: [] }).version).toBe(1);
});

it("keeps one card per language and surface", () => {
  const s0 = emptyLearningState();
  const a = mergeLearnedWord(s0, { type: "learn-word", surface: "Actual", termLang: "en", glossLang: "zh", meaning: "实际的", sentence: "x" }, NOW);
  const b = mergeLearnedWord(a.state, { type: "learn-word", surface: "actual", termLang: "es", glossLang: "zh", meaning: "当前的", sentence: "y" }, NOW);
  expect(b.state.words.map(w => w.id)).toEqual(["en:actual", "es:actual"]);
});

it("does not reset scheduling when a word is seen again", () => {
  const first = mergeLearnedWord(emptyLearningState(), { type: "learn-word", surface: "outlive", termLang: "en", glossLang: "zh", meaning: "比…久", sentence: "s1" }, NOW);
  const reviewed = applyReviewAnswer(first.state, { id: "en:outlive", grade: "good" }, NOW).state;
  const again = mergeLearnedWord(reviewed, { type: "learn-word", surface: "outlive", termLang: "en", glossLang: "zh", meaning: "比…活得久", sentence: "s2", glosses: { es: "sobrevivir" } }, NOW + 1000).state;
  const w = again.words[0];
  expect(w.box).toBe(1);
  expect(w.glosses.map(g => g.lang)).toEqual(["zh", "es"]);
  expect(w.contexts.map(c => c.sentence)).toEqual(["s1", "s2"]);
});

it("keeps at most three contexts and ten reviews", () => { /* 4 条语境 / 11 次复习后断言长度 */ });

it("prunes the oldest mastered word first", () => { /* 造 MAX_WORDS+1 词，断言被删的是最早 mastered */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/learning-storage.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

要点：

- `normalizeSurface`：`trim` → `replace(/\s+/g, " ")` → `toLocaleLowerCase()`。
- `wordId`：`` `${termLang}:${normalizeSurface(surface)}` ``。
- `mergeLearnedWord`：
  - 新词：`box: 0`、`dueAt: now + INTERVALS_MS[0]`、`status: "learning"`、`glosses: [{ lang: glossLang, meaning, source: "translation", at: now }]`、`checksSinceSpot: 0`。
  - 已存在：只合并 `glosses`（同 lang 覆盖）、`contexts`（按 sentence 去重，最多 3，FIFO）、`lastSeenAt`、`surface`/`pos`（有则更新）；**不动** `box`/`dueAt`/`status`/`mascotId`。
  - 返回新 state（不原地改）。
- `applyReviewAnswer`：找不到返回 `word: null` 且 state 不变；否则 `applyGrade` + push `ReviewEntry`（保留最近 10）+ 计数 + `checksSinceSpot`（`spot` 为真时归零，否则 +1）+ `stats.todayReviewed`（本地日期变化时归零）。
- `pruneWords`：超过 `MAX_WORDS` 时，先按 `updatedAt` 升序删 `mastered`，不够再删最早的 `learning`。
- `parseLearningState`：任何字段类型不符 → 回退该字段默认值，绝不抛错。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/learning-storage.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/shared/learning-storage.ts tests/unit/learning-storage.test.ts
git commit -m "feat: add learning store merge and pruning"
```

---

### Task 4: Prompt 格式层与 `glosses` 解析

**Files:**
- Modify: `src/shared/prompt.ts`
- Test: `tests/unit/prompt.test.ts`

**Interfaces:**
- Produces:
  - `FORMAT_VERSION = 2`
  - `interface FormatOptions { targetLang: string; glossaryEnabled: boolean; glossLangs: string[] }`
  - `buildFormatPrompt(options: FormatOptions): string`
  - `parseGlossaryNotes(raw: string, items: Segment[], glossLangs?: string[]): Map<string, GlossaryNote[]>`
  - `parseAnnotatedResponse(raw: string, items: Segment[], glossLangs?: string[]): { translations: Map<string, string>; glossary: Map<string, GlossaryNote[]> }`

- [ ] **Step 1: 写失败测试**

在 `tests/unit/prompt.test.ts` 新增：

```ts
it("always carries the format contract", () => {
  const p = buildFormatPrompt({ targetLang: "zh-CN", glossaryEnabled: false, glossLangs: [] });
  expect(p).toContain("[编号]");
  expect(p).toContain("{{targetLang}}");
  expect(p).not.toContain(GLOSSARY_MARKER);
});

it("lists extra gloss languages in the format layer", () => {
  const p = buildFormatPrompt({ targetLang: "zh-CN", glossaryEnabled: true, glossLangs: ["es", "ja"] });
  expect(p).toContain(GLOSSARY_MARKER);
  expect(p).toContain("es");
  expect(p).toContain("ja");
});

it("keeps only whitelisted gloss languages", () => {
  const items = [{ id: "p_1", text: "Small tools often outlive their rivals." }];
  const raw = `[1] 小工具往往比对手活得久\n${GLOSSARY_MARKER}\n{"1":[{"surface":"outlive","meaning":"比…活得久","glosses":{"es":"sobrevivir","xx":"bad"}}]}`;
  expect(parseAnnotatedResponse(raw, items, ["es"]).glossary.get("p_1")?.[0].glosses).toEqual({ es: "sobrevivir" });
});

it("drops a malformed glosses object without losing the note", () => {
  const items = [{ id: "p_1", text: "Small tools often outlive their rivals." }];
  const raw = `[1] 小工具往往比对手活得久\n${GLOSSARY_MARKER}\n{"1":[{"surface":"outlive","meaning":"比…活得久","glosses":"nope"}]}`;
  const note = parseAnnotatedResponse(raw, items, ["es"]).glossary.get("p_1")?.[0];
  expect(note?.meaning).toBe("比…活得久");
  expect(note?.glosses).toBeUndefined();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/prompt.test.ts`
Expected: FAIL，`buildFormatPrompt` 未导出。

- [ ] **Step 3: 实现**

- `buildFormatPrompt` 输出 spec §4.2 的三条格式规则；`glossaryEnabled` 时追加注释协议（复用现有 `GLOSSARY_MARKER` 与 JSON 形状），并追加 `额外释义语言：<以 ", " 连接>`；`glossLangs` 为空时不出现该行。
- `parseGlossaryNotes` 增加第三个参数（默认 `[]`）：读 `note.glosses`，只保留键在 `glossLangs` 内、值为非空字符串且 ≤12 字符的项；任一项不合格只丢该项，全部不合格则 `glosses` 不设字段。
- `parseAnnotatedResponse` 透传 `glossLangs`。
- 保留 `buildEffectiveSystemPrompt` 与 `promptVersionFor` 直到 Task 5 删除（避免本任务破坏编译）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/prompt.test.ts && npx tsc --noEmit`
Expected: PASS（既有 prompt 测试必须全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/shared/prompt.ts tests/unit/prompt.test.ts
git commit -m "feat: add layered format prompt and gloss parsing"
```

---

### Task 5: 偏好层、版本哈希与 dispatch 接线

**Files:**
- Create: `src/shared/preferences.ts`
- Modify: `src/shared/prompt.ts`
- Modify: `src/background/dispatch.ts`
- Modify: `src/settings/settings-view.ts`
- Modify: `src/settings/provider-form.ts`
- Test: `tests/unit/preferences.test.ts`、`tests/unit/prompt.test.ts`、`tests/unit/dispatch.test.ts`

**Interfaces:**
- Consumes: Task 1 `TranslationPreference`、Task 4 `buildFormatPrompt`
- Produces:
  - `DOMAIN_PRESETS: Record<DomainPreset, { label: string; text: string }>`
  - `buildPreferencePrompt(pref: TranslationPreference): string`
  - `buildSystemPrompt(options: FormatOptions & { preference?: TranslationPreference; providerOverride?: string }): string`
  - `buildPromptVersion(options: { glossaryEnabled: boolean; preferenceText: string }): Promise<string>`

- [ ] **Step 1: 写失败测试**

`tests/unit/preferences.test.ts`：

```ts
it("omits the preference layer for general with no instructions", () => {
  expect(buildPreferencePrompt({ domain: "general", instructions: "" })).toBe("");
});

it("puts the format guard first in the preference layer", () => {
  const text = buildPreferencePrompt({ domain: "tech", instructions: "保留英文术语" });
  expect(text.indexOf("不得改变")).toBeLessThan(text.indexOf("保留英文术语"));
  expect(text).toContain("计算机");
});

it("lets a provider override replace only the preference layer", () => {
  const p = buildSystemPrompt({
    targetLang: "zh-CN", glossaryEnabled: false, glossLangs: [],
    preference: { domain: "tech", instructions: "inner" },
    providerOverride: "只输出英文",
  });
  expect(p).toContain("[编号]");
  expect(p).toContain("只输出英文");
  expect(p).not.toContain("inner");
  expect(p.indexOf("[编号]")).toBeLessThan(p.indexOf("只输出英文"));
});
```

`tests/unit/dispatch.test.ts`：

```ts
it("does not invalidate the page cache when a learning language is added", async () => {
  /* 同一个 mock provider、同一段文本：
     1. settings.learningLangs = ["en"] → handleTranslate 一次，provider 被调用 1 次
     2. settings.learningLangs = ["en", "es"] → 再 handleTranslate 同一段
     3. 断言 provider 仍只被调用 1 次（命中缓存），且 promptVersion 相同
     这一条固定住「glossLangs 不参与 version」这个决定。 */
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/preferences.test.ts tests/unit/prompt.test.ts`
Expected: FAIL，`preferences.ts` 不存在。

- [ ] **Step 3: 实现**

- `DOMAIN_PRESETS` 写通用 / 计算机 / 法律 / 医学 / 文学五段文案（spec §4.3 表；后三者本版不接 UI，但常量先有）。
- `buildPreferencePrompt`：`custom` 只用 `instructions`；`general` 且无 `instructions` 返回 `""`；输出以「【翻译偏好】以下偏好只影响……以输出格式为准。」开头。
- `buildSystemPrompt` = `[buildFormatPrompt(opts), providerOverride?.trim() || buildPreferencePrompt(pref)]` 过滤空串后用 `\n\n` 连接。
- `buildPromptVersion` = `sha256(\`v${FORMAT_VERSION}\u0000${glossaryEnabled ? "g" : ""}\u0000${preferenceText}\`)`。
- `dispatch.ts`：
  - `glossLangs` = `settings.learningLangs.filter((l) => languagePrefix(l) !== languagePrefix(settings.targetLang))`（只去掉与译文语言相同的项；这是**唯一**的额外释义语言来源）。
  - `systemPrompt = buildSystemPrompt({ targetLang: settings.targetLang, glossaryEnabled, glossLangs, preference: settings.preference, providerOverride: provider.overrides?.systemPrompt })`。
  - `promptVersion = await buildPromptVersion({ glossaryEnabled, preferenceText: buildPreferencePrompt(settings.preference) })` —— 注意此处**不传** `glossLangs`。
- 删除 `buildEffectiveSystemPrompt` 与 `promptVersionFor` 及其全部调用（`dispatch.ts`、`settings-view.ts`、`provider-form.ts` 的再导出）；`settings-view.savePatch` 不再计算 `promptVersion`。
- `parseAnnotatedResponse` 调用处传入 `glossLangs`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/preferences.test.ts tests/unit/prompt.test.ts tests/unit/dispatch.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/shared/preferences.ts src/shared/prompt.ts src/background/dispatch.ts src/settings/settings-view.ts tests/unit/preferences.test.ts tests/unit/prompt.test.ts tests/unit/dispatch.test.ts
git commit -m "feat: split prompt into format and preference layers"
```

---

### Task 6: Background 学习消息与串行写队列

**Files:**
- Create: `src/background/storage-queue.ts`
- Create: `src/background/learning.ts`
- Modify: `src/background/index.ts`
- Test: `tests/unit/learning-messages.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `getLearning`/`saveLearning`/`mergeLearnedWord`/`applyReviewAnswer`；Task 1 消息类型
- Produces:
  - `runLearningUpdate<T>(fn: (state: LearningState) => { state: LearningState; result: T }): Promise<T>`
  - `handleLearningMessage(message: unknown): Promise<unknown>`（内部用 `runLearningUpdate`）
  - `registerLearningHandlers(): void`

- [ ] **Step 1: 写失败测试**

`tests/unit/learning-messages.test.ts`：

```ts
it("records a word once and reports created:false on repeat", async () => {
  await chrome.storage.local.clear();
  const first = await handleLearningMessage({ type: "learn-word", surface: "outlive", termLang: "en", glossLang: "zh", meaning: "比…久", sentence: "s1" });
  const second = await handleLearningMessage({ type: "learn-word", surface: "Outlive", termLang: "en", glossLang: "zh", meaning: "比…活得久", sentence: "s2" });
  expect(first).toMatchObject({ ok: true, created: true });
  expect(second).toMatchObject({ ok: true, created: false });
  const state = await getLearning();
  expect(state.words).toHaveLength(1);
  expect(state.words[0].box).toBe(0);
  expect(state.words[0].contexts).toHaveLength(2);
});

it("does not lose writes when reviews arrive concurrently", async () => {
  await chrome.storage.local.clear();
  await handleLearningMessage({ type: "learn-word", surface: "outlive", termLang: "en", glossLang: "zh", meaning: "m", sentence: "s" });
  await Promise.all([1, 2, 3, 4, 5].map(() => handleLearningMessage({ type: "review-answer", id: "en:outlive", grade: "good" })));
  const state = await getLearning();
  expect(state.words[0].reviewsCount).toBe(5);
});

it("returns not-implemented for lookup-gloss", async () => {
  expect(await handleLearningMessage({ type: "lookup-gloss", termLang: "en", glossLang: "es", surface: "x", sentence: "y" }))
    .toEqual({ ok: false, reason: "not-implemented" });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/learning-messages.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`storage-queue.ts`：模块级 `let chain: Promise<unknown> = Promise.resolve()`；`runLearningUpdate` 把一次 `getLearning → fn → saveLearning` 串到 `chain` 上，返回本任务结果，失败不污染后续。

`learning.ts`：`handleLearningMessage` 按 `type` 分支；`learn-word` 用 `mergeLearnedWord`；`review-answer` 用 `applyReviewAnswer` 并返回 `{ ok: true, word }`（找不到词返回 `{ ok: false }`）；`get-learning` 直接读；`lookup-gloss` 固定 `not-implemented`；未知类型返回 `null`。

`index.ts`：在 `chrome.runtime.onMessage` 监听器里，先于现有分支调用 `handleLearningMessage`，有结果就返回（注意返回 `true` 表示异步响应，沿用文件里已有的 `sendResponse` 模式）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/learning-messages.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/background/storage-queue.ts src/background/learning.ts src/background/index.ts tests/unit/learning-messages.test.ts
git commit -m "feat: add learning message handlers with serialized writes"
```

---

### Task 7: 徽标与定时刷新

**Files:**
- Create: `src/background/badge.ts`
- Modify: `public/manifest.json`
- Modify: `src/background/index.ts`
- Test: `tests/unit/badge.test.ts`

**Interfaces:**
- Consumes: Task 3 `getLearning`、Task 2 `dueCount`
- Produces: `badgeText(count: number): string`、`refreshBadge(now?: number): Promise<void>`

- [ ] **Step 1: 写失败测试**

```ts
it("formats badge text", () => {
  expect(badgeText(0)).toBe("");
  expect(badgeText(1)).toBe("1");
  expect(badgeText(120)).toBe("99+");
});

it("clears the badge when nothing is due", async () => {
  const setBadgeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("chrome", { ...chrome, action: { setBadgeText, setBadgeBackgroundColor: vi.fn() } });
  await refreshBadge(NOW);
  expect(setBadgeText).toHaveBeenCalledWith({ text: "" });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/badge.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`badge.ts`：`badgeText` 按 `0 → ""`、`>99 → "99+"`、否则字符串；`refreshBadge` 读学习库、`dueCount(words, now)`、`chrome.action.setBadgeBackgroundColor({ color: "#2dd4bf" })`，空时只清文本。

`manifest.json` 的 `permissions` 增加 `"alarms"`。`index.ts` 增加：`onInstalled` / `onStartup` 时 `chrome.alarms.create("ilmt-learning-tick", { periodInMinutes: 30 })`；`chrome.alarms.onAlarm` 触发 `refreshBadge()`；`chrome.storage.onChanged` 里 key 为 `learning` 时也刷新；`learn-word` / `review-answer` 处理后调用一次（在 `learning.ts` 内发起，不阻塞响应）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/badge.test.ts && node scripts/check-build.mjs`
Expected: PASS（先 `npm run build`）。

- [ ] **Step 5: Commit**

```bash
git add src/background/badge.ts src/background/index.ts public/manifest.json tests/unit/badge.test.ts
git commit -m "feat: show due-review count on the toolbar badge"
```

---

### Task 8: 认领角色契约与轮换算法

**Files:**
- Create: `src/content/mascots/types.ts`
- Create: `src/content/mascots/index.ts`
- Test: `tests/unit/mascots.test.ts`

**Interfaces:**
- Produces:
  - `MascotState = "idle" | "hit" | "caught" | "known"`
  - `interface MascotSkin { id: string; label: string; render(state: MascotState, theme: "light" | "dark"): SVGElement; verb: string; caughtLabel: string; knownLabel: string; weight: number; hitDurationMs: number }`
  - `registerMascot(skin: MascotSkin): void`、`getMascots(): MascotSkin[]`、`getMascot(id: string): MascotSkin | undefined`
  - `pickMascot(options: { enabledIds: string[]; lastPicks: string[]; seed?: number }): MascotSkin`

- [ ] **Step 1: 写失败测试**

```ts
function skin(id: string, weight = 1): MascotSkin { /* 用 document.createElementNS 生成空 svg */ }

it("never repeats the last two picks", () => {
  registerMascot(skin("a")); registerMascot(skin("b")); registerMascot(skin("c"));
  const picked = pickMascot({ enabledIds: ["a", "b", "c"], lastPicks: ["a", "b"], seed: 1 });
  expect(picked.id).toBe("c");
});

it("falls back when the only enabled skin was just used", () => {
  expect(pickMascot({ enabledIds: ["a"], lastPicks: ["a"], seed: 2 }).id).toBe("a");
});

it("returns the fixed skin in fixed mode", () => {
  expect(pickMascot({ enabledIds: ["b"], lastPicks: [], seed: 3 }).id).toBe("b");
});

it("spreads picks as misses accumulate", () => {
  /* 固定 seed 跑 10000 次，断言三个角色占比都在 25%–42% 之间 */
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/mascots.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

注册表模块级数组；`registerMascot` 同 id 覆盖；`pickMascot`：候选 = `enabledIds` 映射到已注册皮肤（`enabledIds` 为空视为全部），再减去 `lastPicks`；为空时回退；权重 `w_i = base_i × (1 + 0.5 × miss_i)`，`miss_i` 表示该 id 在 `lastPicks` 里没出现的次数（0/1/2）；用 `seed` 驱动的确定性 PRNG（`mulberry32`），缺省用 `Math.random`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/mascots.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/content/mascots/types.ts src/content/mascots/index.ts tests/unit/mascots.test.ts
git commit -m "feat: add mascot registry and fatigue-aware rotation"
```

---

### Task 9: 地鼠皮肤 + 悬停卡片改造 + 收录

**Files:**
- Create: `src/content/mascots/gopher.ts`
- Modify: `src/content/mascots/index.ts`
- Modify: `src/content/glossary.ts`
- Modify: `src/content/main.ts`
- Modify: `src/styles/inject.css`
- Test: `tests/unit/glossary.test.ts`

**Interfaces:**
- Consumes: Task 8 注册表、Task 6 `learn-word`
- Produces:
  - `GlossController.setParagraph(id: string, textNodes: Node[], notes: GlossaryNote[], termLang?: string): void`
  - `GlossControllerDeps = { now?: () => number; sendLearn?: (message: LearnWordMessage) => Promise<LearnWordResponse | null>; resolveMascot?: () => MascotSkin }`
  - `createGlossController(deps?: GlossControllerDeps)`

- [ ] **Step 1: 写失败测试**

在 `tests/unit/glossary.test.ts` 新增：

```ts
it("keeps the card open while the pointer is inside it", async () => {
  /* 悬停词 → 推进 120ms → 卡片出现；把 pointermove 指到卡片矩形内 → 推进 300ms → 卡片仍在 */
});

it("hides 180ms after leaving both the word and the card", async () => {
  /* 同上；pointermove 到空白 → 推进 179ms 仍在；再推进 1ms 消失 */
});

it("sends learn-word once when the mascot is clicked", async () => {
  const sendLearn = vi.fn().mockResolvedValue({ ok: true, created: true, dueAt: 123, nextDueLabel: "10 分钟后" });
  const controller = createGlossController({ sendLearn });
  controller.setParagraph("p_1", nodes, [note], "en");
  /* 悬停并点击 .ilmt-mascot-button */
  expect(sendLearn).toHaveBeenCalledTimes(1);
  expect(sendLearn.mock.calls[0][0]).toMatchObject({ type: "learn-word", termLang: "en", surface: "outlive" });
});

it("renders the known state without resending", async () => {
  /* created:false 的响应 → 再次悬停点击 → 文案含「已在学习中」，sendLearn 仍为 1 次 */
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/glossary.test.ts`
Expected: FAIL，`createGlossController` 不接受 deps。

- [ ] **Step 3: 实现**

`gopher.ts`：`render(state, theme)` 返回内联 SVG（洞 + 半身 + 眼；`hit` 加 `ilmt-gopher-hit` 类；`caught` 加 `+1` 标记）；`label: "地鼠"`、`verb: "打"`、`caughtLabel: "已抓住"`、`knownLabel: "已在学习中"`、`weight: 1`、`hitDurationMs: 180`；在 `mascots/index.ts` 里 `registerMascot(gopherSkin)`，并保留 `cat`/`frog` 的注释占位。

`glossary.ts`：

- `GlossEntry` 增加 `termLang?: string`。
- 卡片加一个 44×44 `<button class="ilmt-mascot">`，内含 `render("idle", theme)`；`click` 阻止冒泡并执行：`render("hit")` → `hitDurationMs` 后写 `caught` 或 `known` → 调 `sendLearn`。
- 悬停判定：新增 `hoverCard` 布尔；`pointermove` 命中卡片矩形时置真并取消隐藏计时；离开两者后 `scheduleHide()`（180ms）。`scroll` / `blur` 仍立即隐藏。
- `sessionStorage` 记录 `ilmt:mascot-history`（最近 2 个 id），每次开卡时 `pickMascot`。
- `setParagraph` 接收 `termLang`，写入 entry；点击时把 `note.glosses` 原样放进 `learn-word` 的 `glosses` 字段（额外释义只进库，不上卡片）。

`main.ts`：把 `prefs.learningLangs` 传入；用现有 `detectLang`/`langCache` 在注册注释前解析段落语言（命中缓存则同步），`termLang ∉ learningLangs` 时调用 `gloss.removeParagraph(id)` 而不是 `setParagraph`。

`inject.css`：卡片 `pointer-events: auto`；`.ilmt-mascot` 44×44 热区；`.ilmt-gopher-hit` 播放 180ms 压扁；`@media (prefers-reduced-motion: reduce)` 下关闭动画。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/glossary.test.ts tests/unit/main-ui.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/content/mascots src/content/glossary.ts src/content/main.ts src/styles/inject.css tests/unit/glossary.test.ts
git commit -m "feat: add clickable gopher that captures a word"
```

---

### Task 10: 侧栏复习视图（自评 + 语言筛选）

**Files:**
- Create: `src/panel/review.ts`
- Modify: `src/panel/main.ts`
- Modify: `src/styles/panel.css`
- Test: `tests/unit/panel-review.test.ts`

**Interfaces:**
- Consumes: Task 1 类型、Task 3 `getLearning`、Task 6 消息
- Produces:
  - `interface ReviewDeps { getState(): Promise<LearningState>; answer(message: ReviewAnswerMessage): Promise<ReviewAnswerResponse>; mascot(id?: string): MascotSkin; now(): number }`
  - `mountReview(root: HTMLElement, deps?: Partial<ReviewDeps>): { refresh(): Promise<void>; destroy(): void }`
  - `buildReviewQueue(state: LearningState, opts: { termLang: string | "all"; now: number }): LearningWord[]`

- [ ] **Step 1: 写失败测试**

```ts
it("queues only due words, filtered by term language", () => {
  const state = /* 2 张到期（en/es）+ 1 张未到期 */;
  expect(buildReviewQueue(state, { termLang: "es", now: NOW }).map(w => w.id)).toEqual(["es:actual"]);
});

it("renders the word with a blanked sentence and reveals the answer on demand", async () => {
  /* mountReview 后断言 .ilmt-review-word 文本、.ilmt-review-sentence 含 ____、
     答案区初始隐藏；点击「想不起来，看答案」后出现 meaning */
});

it("sends the chosen grade and advances to the next card", async () => {
  const answer = vi.fn().mockResolvedValue({ ok: true, word: { ...word, box: 1 } });
  /* 点「认识」→ 断言 answer 收到 { type:"review-answer", id, grade:"good" }，标题变为 2 / 2 */
});

it("shows the finish card when the queue is empty", async () => {
  /* 断言文案含「本轮」与「今天没有要复习的词」 */
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/panel-review.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`review.ts`：状态 `{ queue, index, revealed, answered, termLang, glossLang }`；`buildReviewQueue` 过滤 `status === "learning" && dueAt !== null && dueAt <= now`，按 `dueAt` 升序，`termLang !== "all"` 时再过滤。渲染：头部 `n / total` + 「结束」；词面 + 词性 + 语言；挖空句（用 `surface` 不区分大小写替换为 `____`）；「想不起来，看答案」；三按钮「忘了 / 模糊 / 认识」。答案区主行 `word.glosses.find(g => g.lang === glossLang)`，其余语言浅色小字并列。语言 chip 行只在词汇中出现 ≥2 种 `termLang` 时渲染；选择写 `sessionStorage` 的 `ilmt:review-lang`。

`panel/main.ts`：顶部插入分段控件 `对话 | 复习 (N)`；`N` 来自 `dueCount`，storage 变更时更新；切到复习时 `mountReview` 到独立容器，切回时隐藏（不销毁会话）。

`panel.css`：`ilmt-` 前缀的卡片、按钮、chip 样式，沿用现有深色主题变量。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/panel-review.test.ts tests/unit/panel.test.ts tests/unit/panel-dom.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/panel/review.ts src/panel/main.ts src/styles/panel.css tests/unit/panel-review.test.ts
git commit -m "feat: add side-panel review view with self-assessment"
```

---

### Task 11: 抽查（四选一）

**Files:**
- Create: `src/shared/spot.ts`
- Modify: `src/panel/review.ts`
- Test: `tests/unit/spot.test.ts`

**Interfaces:**
- Consumes: Task 1 `LearningWord`
- Produces:
  - `shouldSpotCheck(word: LearningWord): boolean`（`checksSinceSpot + 1 >= 3`）
  - `buildSpotQuestion(word: LearningWord, pool: LearningWord[], glossLang: string, seed?: number): { options: string[]; answer: number } | null`（干扰项不足 3 个时返回 `null`）

- [ ] **Step 1: 写失败测试**

```ts
it("asks on every third review", () => {
  expect(shouldSpotCheck({ ...word, checksSinceSpot: 2 })).toBe(true);
  expect(shouldSpotCheck({ ...word, checksSinceSpot: 1 })).toBe(false);
});

it("offers four distinct meanings including the answer", () => {
  const q = buildSpotQuestion(word, [w2, w3, w4], "zh", 7)!;
  expect(q.options).toHaveLength(4);
  expect(new Set(q.options).size).toBe(4);
  expect(q.options[q.answer]).toBe("比…活得久");
});

it("returns null when the pool is too small", () => {
  expect(buildSpotQuestion(word, [], "zh", 1)).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/spot.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

干扰项只取同 `glossLang` 且 `meaning` 与答案不同的词；`seed` 驱动确定性洗牌；`review.ts` 在 `shouldSpotCheck` 为真且 `buildSpotQuestion` 非空时改渲染四选一：答对按 `good`、答错按 `again`，并发送 `spot: true` / `spotCorrect`；答错后展示正确答案；`buildSpotQuestion` 返回 `null` 时退化为自评，发送 `spot: false`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/spot.test.ts tests/unit/panel-review.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/shared/spot.ts src/panel/review.ts tests/unit/spot.test.ts tests/unit/panel-review.test.ts
git commit -m "feat: add spot-check multiple choice every third review"
```

---

### Task 12: 设置 UI（翻译风格 / 学习目标 / 认领角色）

**Files:**
- Create: `src/settings/sections/learning.ts`
- Modify: `src/settings/sections/translation.ts`
- Modify: `src/settings/sections/advanced.ts`
- Modify: `src/settings/settings-view.ts`
- Modify: `src/settings/provider-manager.ts`

**Interfaces:**
- Consumes: Task 1 类型与 `ctx.savePatch`
- Produces: `SectionHandle`（`id: "learning"`）挂进 `settings-view.ts` 的分组列表。

- [ ] **Step 1: 写失败测试**

在 `tests/unit/settings-dom.test.ts` 新增：

```ts
it("saves a translation style and instructions", async () => {
  /* 渲染 popup → 选 .global-preference-domain = "tech" → 填 .global-preference-instructions
     → 点保存 → 断言 storage.local.settings.preference */
});

it("toggles learning languages within the whitelist", async () => {
  /* 勾选 es、取消 en → 断言 learningLangs 顺序与白名单 */
});

it("renders the learning section with mascot rotation", async () => {
  /* 断言 .global-mascot-mode 存在，选项含「随机轮换」/「固定为」 */
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/settings-dom.test.ts`
Expected: FAIL，选择器不存在。

- [ ] **Step 3: 实现**

- `translation.ts`：新增 `翻译风格` select（`general` / `tech` / `custom`）+ `追加说明` textarea（500 字截断），随既有保存按钮写 `preference`。
- 新增 `learning.ts`：`学习目标`（en 默认 + ja/es/fr 复选）、`认领角色`（`rotate` / `fixed` + 已注册角色下拉）、`复习答案语言`（跟随目标语言 / 指定）、`复习方向`（置灰，文案「即将支持」）。
- `advanced.ts`：删除「全局系统提示词」字段与 `systemPrompt` 写入；summary 不变。
- `provider-manager.ts`：标签改为「该提供商的翻译偏好（仍受格式约束）」，placeholder 改「留空继承全局翻译偏好」。
- `settings-view.ts`：注册 `createLearningSection`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/settings-dom.test.ts tests/unit/options-providers.test.ts tests/unit/storage.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/settings tests/unit/settings-dom.test.ts
git commit -m "feat: add translation style and learning settings"
```

---

### Task 13: popup 待复习入口

**Files:**
- Modify: `src/settings/settings-view.ts`
- Modify: `src/panel/main.ts`
- Test: `tests/unit/settings-dom.test.ts`

**Interfaces:**
- Consumes: Task 3 `getLearning`、Task 2 `dueCount`
- Produces: `chrome.storage.session` 键 `reviewPending`（布尔）。

- [ ] **Step 1: 写失败测试**

```ts
it("shows the due count and opens the side panel on click", async () => {
  /* 预置 3 个到期词 → 渲染 popup → 断言文案含「待复习 3」
     → 点击 → 断言 chrome.storage.session.set 收到 { reviewPending: true }
       且 chrome.sidePanel.open 被调用一次 */
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/settings-dom.test.ts`
Expected: FAIL，元素不存在。

- [ ] **Step 3: 实现**

- `settings-view.ts`：header 下方加一行 `.popup-review-entry`，文案 `待复习 N · 打开复习`；`N === 0` 时隐藏。点击处理**直接在这个 popup 页面里**执行：

```ts
await chrome.storage.session.set({ reviewPending: true });
await chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
```

  必须在 popup 的点击手势里调用 `sidePanel.open`，不能绕到 background（手势不会跨进程传递）。
- `panel/main.ts`：启动时读 `reviewPending`，为真则切到复习视图并清除。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/settings-dom.test.ts tests/unit/panel-dom.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/settings/settings-view.ts src/panel/main.ts tests/unit/settings-dom.test.ts
git commit -m "feat: add pending-review entry to the popup"
```

---

### Task 14: E2E、P0 回归与文档收尾

**Files:**
- Create: `tests/e2e/learning.spec.ts`
- Modify: `docs/superpowers/specs/2026-11-12-learning-loop-design.md`（状态改为「已实现」）
- Modify: `README.md`（若已有设置说明，补一段学习闭环）

- [ ] **Step 1: 写 E2E**

```ts
test("capture a hovered word and review it", async () => {
  /* 1. 载入 dist、打开 article.html、Alt+A 翻译（mock provider 固定返回注释 surface "outlive"）
     2. 用 Range 算出第一段里 "outlive" 的屏幕坐标，然后 page.mouse.move(x, y)：
        const { x, y } = await page.evaluate(() => {
          const p = document.querySelector("#article-p1")!;
          const text = p.firstChild as Text;
          const i = (text.textContent ?? "").indexOf("outlive");
          const r = document.createRange();
          r.setStart(text, i); r.setEnd(text, i + "outlive".length);
          const rect = r.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        });
     3. 等 .ilmt-mascot 出现 → 点它 → 等 400ms
     4. 读 chrome.storage.local.learning：1 词、box 0、dueAt ≈ now+10min、termLang "en"、mascotId "gopher"
     5. 打开侧栏页（chrome-extension://<id>/src/panel/index.html）→ 切到复习
     6. 断言卡片出现该词 → 点「认识」→ storage 里 box 1
     7. 断言扩展徽标文本为 ""（已无到期） */
});
```

- [ ] **Step 2: 跑 E2E 确认通过**

Run: `npx playwright test tests/e2e/learning.spec.ts`
Expected: PASS（若悬停定位不可行，改用 mock server 返回固定注释 + 直接触发 `pointermove` 坐标，并在测试里断言卡片出现）。

- [ ] **Step 3: 跑完整验证**

Run: `npm run verify:delivery`
Expected: 501+ 单测全绿、`tsc` 无错、build 成功、`check-build` 通过。

- [ ] **Step 4: 浏览器 P0**

按 `docs/delivery-verification.md` 逐项执行并记录：Alt+A 翻译、双语、再按还原、popup 显示 provider/model、划词解释、控制台无红色报错；外加：悬停出地鼠、点击后徽标变 1、侧栏复习可作答。

- [ ] **Step 5: 文档收尾并提交**

把 spec 状态改为「已实现（2026-11-12）」，在 README 补「学习闭环」一节（学习目标、认领角色、复习语言）。

```bash
git add docs README.md tests/e2e/learning.spec.ts
git commit -m "test: cover the learning loop end to end"
```

---

## Self-Review Notes

- Spec §2 目标全部有对应任务：地鼠（Task 9）、可扩展表现层（Task 8）、收录既有卡（Task 6）、SRS（Task 2/3）、侧栏复习（Task 10）、抽查（Task 11）、Prompt 分层（Task 4/5）、多语言（Task 1/4/5/10）、徽标（Task 7）、本地存储（Task 3）。
- 非目标未被偷偷实现：无术语表 UI、无 streak、无导出、无 `lookup-gloss` 实际请求。
- 类型一致性：`LearnWordMessage`（Task 1）与 `mergeLearnedWord`（Task 3）参数一致；`ReviewAnswerMessage` 在 Task 3/6/10/11 同名同形；`MascotSkin.render` 在 Task 8/9/10 一致。
- Review Focus 的 5 条各自落点：偏好注入（Task 5 单测）、旧设置迁移（Task 1）、加语言不改版本（Task 5 单测）、卡片悬停持久（Task 9 单测）、坏数据/超限/并发（Task 3/6 单测）。
- 有意偏离 spec 一处：不实现 `buildGlossPrompt` 死代码，补译时再加（已在 Global Constraints 说明）。
