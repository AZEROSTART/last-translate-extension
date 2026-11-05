# 双语网页翻译与 LLM 问答扩展 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 MV3 Chrome 扩展：快捷键把当前页翻译成中文并插在原文下方，支持多套自定义 OpenAI 兼容配置，以及划词/侧栏问答。

**Architecture:** 内容脚本只做段落识别与渲染；后台 Service Worker 持有 provider 配置、密钥、并发队列、缓存与流式请求；两者通过 `ilmt-translate` 端口通信，侧栏通过 `ilmt-chat` 端口通信。译文以新节点插入，绝不修改页面原有文本节点。

**Tech Stack:** TypeScript、Vite（多入口构建）、Vitest + jsdom、fake-indexeddb、Playwright（E2E）。

**Spec:** `docs/superpowers/specs/2026-11-04-bilingual-translate-extension-design.md`

## Global Constraints

- Manifest V3；Chrome 120+；`chrome.sidePanel` 需 114+。
- 不加载远程代码；扩展页 CSP `script-src 'self'`，禁止内联脚本与 `eval`。
- `content_guard.js` ≤ 5 KB (gzip)，且**不得有静态 import**（它是 classic content script）。
- `content_main.js` 是 ESM，由 guard 通过 `import(chrome.runtime.getURL("content_main.js"))` 动态加载。
- 并发默认 3（可配 1–10）；速率默认 5 RPS（可配 1–20）。
- 分组预算：`maxInputTokens = 1500`，`maxItems = 20`。
- 超时：连接 15s、首 token 45s、空闲 60s、总时长 180s（chat 不设总时长上限）。
- 重试：仅 429 / 5xx / 网络错误，最多 2 次，退避 1s、3s。
- 缓存：TTL 30 天；上限 20,000 条或 50 MB，LRU 淘汰。
- MutationObserver 去抖 250ms；每分钟最多新增 200 段；单页段落上限 2000。
- 段落最小长度 4 字符；目标语言占比 ≥ 0.8 的段落跳过。
- 端口名：`ilmt-translate`、`ilmt-chat`。健康检查退避 `[500, 1000, 2000, 4000, 5000]` ms。
- 所有 `runtime.onMessage` / 端口消息处理前校验 `sender.id === chrome.runtime.id`。
- API key 只出现在后台上下文与 `chrome.storage.local`；日志中一律脱敏。

## Review Focus

这些是规格里没有逐条写、但最可能让用户当场弃用的情况。每条都在对应任务里落到一个测试。

1. **同一段文本被嵌套行内元素包了三层**（`<p><a><span>…</span></a></p>`）——必须只翻译一次，不能出三条译文。
2. **SPA 重渲染把注入节点冲掉**——再次触发时不能叠加译文，也不能因为注册表持有旧节点而泄漏。
3. **模型返回的编号与请求不符**（少一段、多一段、编号错位）——必须整组失败，绝不能把译文安到别的段落上。
4. **用户在流式进行中再按一次快捷键 / 关闭翻译**——不能重复发请求，不能留下半边译文，abort 必须真的中止。
5. **页面本来就是中文**——不能发出任何翻译请求。

---

## 文件结构

```
manifest.json                  # 源在 public/，构建时复制
package.json
tsconfig.json
vite.config.ts
public/
  manifest.json
  rules/dnr.json
src/
  shared/
    types.ts                   # 所有跨上下文类型
    storage.ts                 # chrome.storage.local 读写与默认值
    prompt.ts                  # 分组、prompt 构建、编号解析
    token-estimate.ts          # token 估算
    errors.ts                  # ProviderError 归一化
  providers/
    types.ts
    openai.ts                  # OpenAI 兼容 adapter
    index.ts                   # adapter 注册表
  background/
    index.ts                   # SW 入口：端口、路由、生命周期
    queue.ts                   # 并发 + 速率 + 轮转 + 取消
    cache.ts                   # IndexedDB 缓存
    dispatch.ts                # 翻译分发：缓存 → 队列 → adapter
  content/
    guard.ts                   # document_start，动态 import
    main.ts                    # 导出 runContentMain()
    paragraphs.ts              # 识别 + 标记
    render.ts                  # 插入 / 还原 / 二次翻译防护
    registry.ts                # WeakRef 注册表 + 状态机
    port.ts                    # 端口客户端 + 健康检查
    selection.ts               # 划词气泡
  panel/
    index.html
    main.ts
  options/
    index.html
    main.ts
  styles/
    inject.css
    panel.css
    options.css
tests/
  unit/
  e2e/
  fixtures/
  mock-server.ts
```

---

### Task 1: 脚手架与可加载构建

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `scripts/check-build.mjs`
- Create: `public/manifest.json`, `public/rules/dnr.json`
- Create: `src/background/index.ts`（占位，`export {}`）
- Create: `src/content/guard.ts`（占位，无 import）
- Create: `src/content/main.ts`（占位，`export function runContentMain() {}`）
- Create: `src/panel/index.html`, `src/options/index.html`
- Test: `tests/unit/build.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `npm run build` 产出 `dist/`，其中含 `manifest.json`、`background.js`、`content_guard.js`、`content_main.js`、`panel.html`、`options.html`、`rules/dnr.json`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/build.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

describe("build output", () => {
  beforeAll(() => { execSync("npm run build", { stdio: "ignore" }); }, 120_000);

  it("emits a valid MV3 manifest", () => {
    const m = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
    expect(m.manifest_version).toBe(3);
    expect(m.background.service_worker).toBe("background.js");
    expect(m.permissions).toContain("storage");
    expect(m.permissions).toContain("sidePanel");
    expect(m.content_scripts[0].js).toEqual(["content_guard.js"]);
    expect(m.content_scripts[0].run_at).toBe("document_start");
    expect(m.web_accessible_resources[0].resources).toContain("content_main.js");
  });

  it("emits every entry file", () => {
    for (const f of ["background.js", "content_guard.js", "content_main.js", "panel.html", "options.html", "rules/dnr.json"]) {
      expect(existsSync(`dist/${f}`), f).toBe(true);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/build.test.ts`
Expected: FAIL（`package.json` 不存在 / `dist` 不存在）。

- [ ] **Step 3: 建脚手架**

`package.json` scripts：

```json
{
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite build --watch",
    "test": "vitest run",
    "test:e2e": "playwright test"
  }
}
```

`vite.config.ts` 关键配置：`publicDir: "public"`；`build.rollupOptions.input` 指向 `src/background/index.ts`、`src/content/guard.ts`、`src/content/main.ts`、`src/panel/index.html`、`src/options/index.html`；`output.entryFileNames` 固定为 `[name].js`；`output.chunkFileNames` 用 `chunks/[name]-[hash].js`；`build.target: "chrome120"`。

`public/manifest.json`：照抄规格 §10 的清单（permissions、host_permissions、content_scripts、web_accessible_resources 含 `content_main.js`、`commands`、`side_panel.default_path = "panel.html"`、`options_page = "options.html"`、`declarative_net_request` 指向 `rules/dnr.json`）。

`public/rules/dnr.json`：照抄规格 §10 的两条规则（11434 / 1234 设 Origin）。

`src/content/guard.ts` 占位必须是经典脚本：

```ts
export {}; // 不能有静态 import
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/build.test.ts`
Expected: PASS，2 个测试。

- [ ] **Step 5: 提交**

```bash
git add package.json tsconfig.json vite.config.ts public src tests
git commit -m "chore: scaffold MV3 build with multi-entry targets"
```

---

### Task 2: 共享类型与配置存储

**Files:**
- Create: `src/shared/types.ts`, `src/shared/storage.ts`
- Test: `tests/unit/storage.test.ts`
- Create: `tests/setup/chrome-mock.ts`（Vitest setup，提供 `chrome.storage.local` 内存实现）

**Interfaces:**
- Consumes: 无
- Produces:
  - `types.ts`：`Settings`、`ProviderConfig`、`ParagraphStatus`、`TranslateItem`、`ClientToBackground`、`BackgroundToClient`、`ChatClientToBackground`、`ChatBackgroundToClient`、`ErrorCode`、`ModelInfo`、`ChatMessage`、`ChatContext`
  - `storage.ts`：`getSettings(): Promise<Settings>`、`saveSettings(s: Settings): Promise<void>`、`upsertProvider(p: ProviderConfig): Promise<void>`、`removeProvider(id: string): Promise<void>`、`getActiveProvider(s: Settings): ProviderConfig | undefined`、`DEFAULT_SETTINGS`

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/storage.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { getSettings, saveSettings, upsertProvider, removeProvider, getActiveProvider, DEFAULT_SETTINGS } from "../../src/shared/storage";

beforeEach(() => chrome.storage.local.clear());

describe("settings storage", () => {
  it("returns defaults when empty", async () => {
    const s = await getSettings();
    expect(s.targetLang).toBe("zh-CN");
    expect(s.concurrency).toBe(3);
    expect(s.maxRPS).toBe(5);
    expect(s.providers).toEqual([]);
    expect(s.triggerMode).toBe("shortcut");
  });

  it("round-trips providers and keeps the active one", async () => {
    await saveSettings(DEFAULT_SETTINGS);
    await upsertProvider({ id: "a", name: "网关", kind: "custom", baseURL: "https://x.test", apiKey: "k", model: "m", createdAt: 1 });
    const s = await getSettings();
    expect(s.providers).toHaveLength(1);
    expect(getActiveProvider(s)?.id).toBe("a");
  });

  it("removes a provider and clears active when it was active", async () => {
    await saveSettings(DEFAULT_SETTINGS);
    await upsertProvider({ id: "a", name: "A", kind: "custom", baseURL: "u", apiKey: "k", model: "m", createdAt: 1 });
    await removeProvider("a");
    const s = await getSettings();
    expect(s.providers).toEqual([]);
    expect(s.activeProviderId).toBe("");
  });

  it("fills missing fields from defaults instead of returning undefined", async () => {
    await chrome.storage.local.set({ settings: { targetLang: "ja" } });
    const s = await getSettings();
    expect(s.targetLang).toBe("ja");
    expect(s.maxRPS).toBe(5);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/storage.test.ts`
Expected: FAIL，`Cannot find module '../../src/shared/storage'`。

- [ ] **Step 3: 实现**

`types.ts` 按规格 §9 定义；`DEFAULT_SETTINGS` 取：

```ts
export const DEFAULT_SETTINGS: Settings = {
  providers: [], activeProviderId: "",
  targetLang: "zh-CN", concurrency: 3, maxRPS: 5, temperature: 0,
  systemPrompt: "你是一个翻译引擎。把用户给出的编号段落翻译成{{targetLang}}。只输出 [编号] 译文，逐行对应，不解释、不合并、不遗漏。保留原文的专有名词、代码、URL。",
  promptVersion: "", triggerMode: "shortcut", siteRules: {}, theme: "system",
};
```

`storage.ts`：`getSettings` = `DEFAULT_SETTINGS` 与 `chrome.storage.local.get("settings")` 做浅合并；`upsertProvider` 按 id 覆盖或追加，`providers` 为空时把 `activeProviderId` 设为该 id；`removeProvider` 删除后若活动配置被删则清空。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/storage.test.ts`
Expected: PASS，4 个测试。

- [ ] **Step 5: 提交**

```bash
git add src/shared tests/unit/storage.test.ts tests/setup
git commit -m "feat: shared types and settings storage"
```

---

### Task 3: Token 估算、分组、prompt 与编号解析

**Files:**
- Create: `src/shared/token-estimate.ts`, `src/shared/prompt.ts`
- Test: `tests/unit/prompt.test.ts`

**Interfaces:**
- Consumes: `ChatMessage`（Task 2）
- Produces:
  - `estimateTokens(text: string): number`
  - `groupSegments<T extends { id: string; text: string }>(items: T[], opts: { maxInputTokens: number; maxItems: number }): T[][]`
  - `buildTranslateMessages(items: Array<{ id: string; text: string }>, targetLang: string, systemPrompt: string): ChatMessage[]`
  - `parseNumberedResponse(raw: string, expectedIds: string[]): Map<string, string>`
  - `class PromptParseError extends Error`

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/prompt.test.ts
import { describe, it, expect } from "vitest";
import { estimateTokens } from "../../src/shared/token-estimate";
import { groupSegments, buildTranslateMessages, parseNumberedResponse, PromptParseError } from "../../src/shared/prompt";

describe("estimateTokens", () => {
  it("counts CJK denser than latin", () => {
    expect(estimateTokens("你好世界你好世界")).toBeGreaterThan(estimateTokens("hello"));
    expect(estimateTokens("")).toBe(0);
  });
});

describe("groupSegments", () => {
  it("respects maxItems", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ id: `p_${i}`, text: "hello world" }));
    const groups = groupSegments(items, { maxInputTokens: 10_000, maxItems: 20 });
    expect(groups.map(g => g.length)).toEqual([20, 5]);
  });

  it("respects the token budget", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `p_${i}`, text: "x".repeat(400) }));
    const groups = groupSegments(items, { maxInputTokens: 1500, maxItems: 20 });
    expect(groups.every(g => g.reduce((n, it) => n + estimateTokens(it.text), 0) <= 1500 || g.length === 1)).toBe(true);
    expect(groups.length).toBeGreaterThan(1);
  });

  it("never drops an item", () => {
    const items = Array.from({ length: 37 }, (_, i) => ({ id: `p_${i}`, text: "字".repeat(50) }));
    expect(groupSegments(items, { maxInputTokens: 300, maxItems: 5 }).flat()).toHaveLength(37);
  });
});

describe("buildTranslateMessages", () => {
  it("numbers segments and keeps page text out of the system prompt", () => {
    const [sys, user] = buildTranslateMessages([{ id: "p_1", text: "Hello" }], "zh-CN", "SYS");
    expect(sys.role).toBe("system");
    expect(sys.content).toBe("SYS");
    expect(user.role).toBe("user");
    expect(user.content).toContain("[1] Hello");
  });
});

describe("parseNumberedResponse", () => {
  it("maps numbered lines back to ids", () => {
    const m = parseNumberedResponse("[1] 甲\n[2] 乙", ["p_1", "p_2"]);
    expect(m.get("p_1")).toBe("甲");
    expect(m.get("p_2")).toBe("乙");
  });

  it("strips markdown fences", () => {
    const m = parseNumberedResponse("```\n[1] 甲\n```", ["p_1"]);
    expect(m.get("p_1")).toBe("甲");
  });

  it("throws when the model returns fewer segments than requested", () => {
    expect(() => parseNumberedResponse("[1] 甲", ["p_1", "p_2"])).toThrow(PromptParseError);
  });

  it("throws instead of misassigning when an index is out of range", () => {
    expect(() => parseNumberedResponse("[1] 甲\n[3] 丙", ["p_1", "p_2"])).toThrow(PromptParseError);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/prompt.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

- `estimateTokens`：CJK 字符数 / 1.5，其余字符数 / 4，取 `Math.ceil`，最小 0。
- `groupSegments`：顺序累加，超过任一线即封组；单条超预算时自成一组（不能丢）。
- `buildTranslateMessages`：system 用传入的 systemPrompt（`{{targetLang}}` 替换为目标语言）；user 把每段拼成 `[n] text`，用 `\n` 连接。**段落文本只进 user 消息。**
- `parseNumberedResponse`：先去 ``` 围栏；用 `/^\[(\d+)\]\s*([\s\S]*?)(?=^\[\d+\]|$)/gm` 提取；把编号 1..N 映射到 `expectedIds[编号-1]`；**编号超出 `expectedIds.length`、缺号、重复号一律抛 `PromptParseError`**。返回的 Map 只有在恰好覆盖全部 expectedIds 时才算成功。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/prompt.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/shared tests/unit/prompt.test.ts
git commit -m "feat: token budgeting, prompt builder and numbered response parser"
```

---

### Task 4: OpenAI 兼容 Provider Adapter

**Files:**
- Create: `src/providers/types.ts`, `src/providers/openai.ts`, `src/providers/index.ts`, `src/shared/errors.ts`
- Test: `tests/unit/openai.test.ts`

**Interfaces:**
- Consumes: `ProviderConfig`、`ChatMessage`、`ModelInfo`、`ErrorCode`（Task 2）
- Produces:
  - `normalizeBaseURL(raw: string, opts?: { appendV1?: boolean }): string`
  - `buildHeaders(cfg: ProviderConfig): Record<string, string>`
  - `class ProviderError extends Error { code: ErrorCode; retryable: boolean; status?: number }`
  - `listModels(cfg: ProviderConfig, signal?: AbortSignal): Promise<ModelInfo[]>`
  - `complete(cfg: ProviderConfig, req: CompletionRequest): Promise<CompletionResult>`
  - `streamCompletion(cfg: ProviderConfig, req: CompletionRequest): AsyncGenerator<string>`
  - `getAdapter(kind: "custom"): ProviderAdapter`

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/openai.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { normalizeBaseURL, buildHeaders, listModels, complete, streamCompletion } from "../../src/providers/openai";
import { ProviderError } from "../../src/shared/errors";

const cfg = { id: "a", name: "A", kind: "custom" as const, baseURL: "https://api.test", apiKey: "sk-1", model: "m", createdAt: 1 };
afterEach(() => vi.restoreAllMocks());

describe("normalizeBaseURL", () => {
  it("appends /v1 by default", () => expect(normalizeBaseURL("https://api.test")).toBe("https://api.test/v1"));
  it("keeps an existing /v1", () => expect(normalizeBaseURL("https://api.test/v1/")).toBe("https://api.test/v1"));
  it("can be disabled", () => expect(normalizeBaseURL("https://api.test", { appendV1: false })).toBe("https://api.test"));
});

describe("buildHeaders", () => {
  it("merges extra headers and substitutes the key", () => {
    const h = buildHeaders({ ...cfg, extraHeaders: { "HTTP-Referer": "https://app.test", "X-Token": "{{apiKey}}" } });
    expect(h["Authorization"]).toBe("Bearer sk-1");
    expect(h["HTTP-Referer"]).toBe("https://app.test");
    expect(h["X-Token"]).toBe("sk-1");
  });
});

describe("listModels", () => {
  it("returns ids", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), { status: 200 })));
    expect((await listModels(cfg)).map(m => m.id)).toEqual(["m1", "m2"]);
  });

  it("maps 401 to a non-retryable auth error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    await expect(listModels(cfg)).rejects.toMatchObject({ code: "auth", retryable: false });
  });
});

describe("complete", () => {
  it("returns message content", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "甲" } }] }), { status: 200 })));
    await expect(complete(cfg, { model: "m", messages: [{ role: "user", content: "[1] a" }], temperature: 0, signal: new AbortController().signal })).resolves.toEqual({ text: "甲" });
  });
});

describe("streamCompletion", () => {
  it("parses SSE split across chunk boundaries", async () => {
    const enc = new TextEncoder();
    const parts = ['data: {"choices":[{"delta":{"content":"你"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"好"}}]}\n\n', "data: [DONE]\n\n"];
    let i = 0;
    const body = new ReadableStream({
      pull(c) {
        if (i < parts.length) c.enqueue(enc.encode(parts[i++]));
        else c.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })));
    const out: string[] = [];
    for await (const d of streamCompletion(cfg, { model: "m", messages: [], temperature: 0, signal: new AbortController().signal })) out.push(d);
    expect(out.join("")).toBe("你好");
  });

  it("classifies 429 as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 429 })));
    const gen = streamCompletion(cfg, { model: "m", messages: [], temperature: 0, signal: new AbortController().signal });
    await expect(gen.next()).rejects.toMatchObject({ code: "rate_limit", retryable: true });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/openai.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

- `normalizeBaseURL`：去尾部 `/`；若 `appendV1 !== false` 且路径不以 `/v1` 结尾则补 `/v1`。
- `buildHeaders`：`Authorization: Bearer <apiKey>`；合并 `extraHeaders`（同名覆盖），值中 `{{apiKey}}` 替换；`Content-Type: application/json`（仅 POST 时加）。
- `classify(status)`：401/403 → `auth`（不可重试）；429 → `rate_limit`（可重试）；5xx → `network`（可重试）；其他 4xx → `bad_response`（不可重试）。
- `streamCompletion`：读 `response.body.getReader()`，用 `TextDecoder` **保留未完成的行缓冲**；按 `\n\n` 切事件；取 `data:` 行；`[DONE]` 结束；取 `choices[0].delta.content`。**必须处理一个 SSE 事件被拆到两个 chunk 的情况**（Review Focus 1 的延伸）。
- 超时用 `AbortSignal.timeout` 与调用方 signal 合并（`AbortSignal.any`），首 token 45s、空闲 60s 通过一个手动计时器实现，超时抛 `ProviderError("timeout", true)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/openai.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/providers src/shared/errors.ts tests/unit/openai.test.ts
git commit -m "feat: OpenAI-compatible provider adapter with SSE and error classification"
```

---

### Task 5: 请求队列（并发 / 速率 / 轮转 / 取消）

**Files:**
- Create: `src/background/queue.ts`
- Test: `tests/unit/queue.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type QueuePriority = "chat" | "translate"`
  - `interface QueueTask<T> { tabId: number; priority: QueuePriority; run(signal: AbortSignal): Promise<T> }`
  - `class RequestQueue { constructor(opts: { maxConcurrent: number; maxRPS: number }); setLimits(maxConcurrent: number, maxRPS: number): void; enqueue<T>(t: QueueTask<T>): Promise<T>; cancelTab(tabId: number): void; get inflight(): number; get pending(): number }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/queue.test.ts
import { describe, it, expect, vi } from "vitest";
import { RequestQueue } from "../../src/background/queue";

const tick = () => new Promise(r => setTimeout(r, 0));

it("never exceeds maxConcurrent", async () => {
  const q = new RequestQueue({ maxConcurrent: 2, maxRPS: 100 });
  let peak = 0, live = 0;
  const job = () => q.enqueue({ tabId: 1, priority: "translate", run: async () => { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 10)); live--; } });
  await Promise.all(Array.from({ length: 6 }, job));
  expect(peak).toBe(2);
});

it("enforces the RPS window", async () => {
  vi.useFakeTimers();
  const q = new RequestQueue({ maxConcurrent: 10, maxRPS: 2 });
  let started = 0;
  const tasks = Array.from({ length: 4 }, () => q.enqueue({ tabId: 1, priority: "translate", run: async () => { started++; } }));
  await vi.advanceTimersByTimeAsync(0);
  expect(started).toBe(2);
  await vi.advanceTimersByTimeAsync(500);
  expect(started).toBe(4);
  await Promise.all(tasks);
  vi.useRealTimers();
});

it("round-robins between tabs", async () => {
  const q = new RequestQueue({ maxConcurrent: 1, maxRPS: 100 });
  const order: number[] = [];
  await Promise.all([
    q.enqueue({ tabId: 1, priority: "translate", run: async () => { order.push(1); } }),
    q.enqueue({ tabId: 1, priority: "translate", run: async () => { order.push(1); } }),
    q.enqueue({ tabId: 2, priority: "translate", run: async () => { order.push(2); } }),
    q.enqueue({ tabId: 2, priority: "translate", run: async () => { order.push(2); } }),
  ]);
  expect(order.slice(0, 2).sort()).toEqual([1, 2]);
});

it("chat runs before translate", async () => {
  const q = new RequestQueue({ maxConcurrent: 1, maxRPS: 100 });
  const order: string[] = [];
  await Promise.all([
    q.enqueue({ tabId: 1, priority: "translate", run: async () => { order.push("t"); } }),
    q.enqueue({ tabId: 1, priority: "chat", run: async () => { order.push("c"); } }),
  ]);
  expect(order[0]).toBe("c");
});

it("cancelTab rejects pending and aborts inflight", async () => {
  const q = new RequestQueue({ maxConcurrent: 1, maxRPS: 100 });
  let aborted = false;
  const inflight = q.enqueue({ tabId: 7, priority: "translate", run: s => new Promise((_, rej) => { s.addEventListener("abort", () => { aborted = true; rej(new Error("aborted")); }); }) });
  const pending = q.enqueue({ tabId: 7, priority: "translate", run: async () => {} });
  q.cancelTab(7);
  await expect(pending).rejects.toThrow("aborted");
  await expect(inflight).rejects.toThrow("aborted");
  expect(aborted).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/queue.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

内部三个结构：`pendingByTab: Map<number, QueueTask[]>`（translate）、`chatQueue: QueueTask[]`、`inflight: Map<number, AbortController>`（按 `queueId`）。调度循环：先 `chatQueue`，再按 tabId 轮转取 translate；检查 `inflight.size < maxConcurrent` 且当前秒窗口内启动数 `< maxRPS`。`cancelTab` 中止该 tab 所有 inflight 并 reject 其 pending（错误消息固定 `"aborted"`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/queue.test.ts`
Expected: PASS，5 个测试。

- [ ] **Step 5: 提交**

```bash
git add src/background/queue.ts tests/unit/queue.test.ts
git commit -m "feat: global request queue with concurrency, rate limit and tab fairness"
```

---

### Task 6: 翻译缓存

**Files:**
- Create: `src/background/cache.ts`
- Test: `tests/unit/cache.test.ts`
- Modify: `package.json`（加 `fake-indexeddb` devDependency）

**Interfaces:**
- Consumes: 无
- Produces:
  - `buildCacheKey(i: { sourceText: string; targetLang: string; providerConfigId: string; modelId: string; promptVersion: string }): Promise<string>`
  - `class TranslationCache { constructor(dbName?: string); get(key: string): Promise<string | undefined>; put(key: string, text: string, meta: { modelId: string }): Promise<void>; clear(): Promise<void>; stats(): Promise<{ count: number; bytes: number }> }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/cache.test.ts
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { TranslationCache, buildCacheKey } from "../../src/background/cache";

const key = (over = {}) => buildCacheKey({ sourceText: "hello", targetLang: "zh-CN", providerConfigId: "a", modelId: "m", promptVersion: "v1", ...over });

beforeEach(async () => { await indexedDB.deleteDatabase("ilmt-cache"); });

it("is stable and sensitive to every field", async () => {
  expect(await key()).toBe(await key());
  expect(await key({ modelId: "other" })).not.toBe(await key());
  expect(await key({ providerConfigId: "b" })).not.toBe(await key());
});

it("round-trips values", async () => {
  const c = new TranslationCache("ilmt-cache");
  await c.put(await key(), "你好", { modelId: "m" });
  expect(await c.get(await key())).toBe("你好");
});

it("expires entries older than 30 days", async () => {
  const c = new TranslationCache("ilmt-cache");
  const k = await key();
  await c.put(k, "旧", { modelId: "m" });
  await c._setCreatedAtForTest(k, Date.now() - 31 * 24 * 3600 * 1000);
  expect(await c.get(k)).toBeUndefined();
});

it("evicts least-recently-used beyond the entry cap", async () => {
  const c = new TranslationCache("ilmt-cache", { maxEntries: 2 });
  const k1 = await key({ sourceText: "a" }), k2 = await key({ sourceText: "b" }), k3 = await key({ sourceText: "c" });
  await c.put(k1, "1", { modelId: "m" }); await c.put(k2, "2", { modelId: "m" });
  await c.get(k2);
  await c.put(k3, "3", { modelId: "m" });
  expect(await c.get(k1)).toBeUndefined();
  expect(await c.get(k2)).toBe("2");
  expect(await c.get(k3)).toBe("3");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/cache.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`buildCacheKey` 用 Web Crypto：`crypto.subtle.digest("SHA-256", new TextEncoder().encode(join))`，输出 hex；字段用 `\u0000` 连接。`TranslationCache` 打开 IndexedDB `ilmt-cache` 的 `translations` store（`keyPath: "key"`），记录 `{ key, text, modelId, createdAt, lastUsedAt }`；`get` 时刷 `lastUsedAt`，过期则删并返回 `undefined`；`put` 后若 `count > maxEntries` 按 `lastUsedAt` 升序删到上限。`_setCreatedAtForTest` 仅供测试。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/cache.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/background/cache.ts tests/unit/cache.test.ts package.json
git commit -m "feat: translation cache with TTL and LRU eviction"
```

---

### Task 7: 后台路由与翻译分发

**Files:**
- Create: `src/background/dispatch.ts`, `src/background/index.ts`（实现）
- Test: `tests/unit/dispatch.test.ts`

**Interfaces:**
- Consumes: `RequestQueue`（Task 5）、`TranslationCache`（Task 6）、`groupSegments`/`buildTranslateMessages`/`parseNumberedResponse`（Task 3）、`streamCompletion`/`complete`（Task 4）、`getSettings`/`getActiveProvider`（Task 2）
- Produces:
  - `handleTranslate(deps, msg: Extract<ClientToBackground, { type: "translate" }>, send: (m: BackgroundToClient) => void): Promise<void>`
  - `handleChat(deps, msg: Extract<ChatClientToBackground, { type: "chat" }>, send: (m: ChatBackgroundToClient) => void): Promise<void>`
  - `createDeps(overrides?): Deps`（测试可注入 fake adapter / queue / cache）

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/dispatch.test.ts
import { describe, it, expect, vi } from "vitest";
import { handleTranslate, createDeps } from "../../src/background/dispatch";

const settings = {
  providers: [{ id: "a", name: "A", kind: "custom", baseURL: "https://x", apiKey: "k", model: "m", createdAt: 1 }],
  activeProviderId: "a", targetLang: "zh-CN", concurrency: 2, maxRPS: 100, temperature: 0,
  systemPrompt: "SYS", promptVersion: "v1", triggerMode: "shortcut", siteRules: {}, theme: "system",
};

function deps(over = {}) {
  const sent: any[] = [];
  const d = createDeps({
    getSettings: async () => settings,
    cache: { get: vi.fn(async () => undefined), put: vi.fn(async () => {}) },
    adapter: { complete: vi.fn(async () => ({ text: "[1] 你好" })), streamCompletion: vi.fn() },
    ...over,
  });
  return { d, sent, send: (m: any) => sent.push(m) };
}

it("returns cached results without calling the provider", async () => {
  const { d, sent, send } = deps({ cache: { get: async () => "缓存的译文", put: async () => {} } });
  await handleTranslate(d, { type: "translate", requestId: "r1", tabId: 1, items: [{ id: "p_1", text: "hello", hash: "h" }] }, send);
  expect(d.adapter.complete).not.toHaveBeenCalled();
  expect(sent).toContainEqual({ type: "result", requestId: "r1", items: [{ id: "p_1", text: "缓存的译文" }] });
});

it("translates a miss and emits result + finish", async () => {
  const { d, sent, send } = deps();
  await handleTranslate(d, { type: "translate", requestId: "r2", tabId: 1, items: [{ id: "p_1", text: "hello", hash: "h" }] }, send);
  expect(sent.map(m => m.type)).toEqual(["result", "finish"]);
});

it("emits error with the affected ids when the model returns a bad shape", async () => {
  const { d, sent, send } = deps({ adapter: { complete: async () => ({ text: "garbage" }), streamCompletion: vi.fn() } });
  await handleTranslate(d, { type: "translate", requestId: "r3", tabId: 1, items: [{ id: "p_1", text: "a", hash: "h1" }, { id: "p_2", text: "b", hash: "h2" }] }, send);
  const err = sent.find(m => m.type === "error");
  expect(err.ids).toEqual(["p_1", "p_2"]);
  expect(err.retryable).toBe(false);
});

it("rejects messages whose sender is not this extension", async () => {
  const { d } = deps();
  const ok = d.isTrustedSender({ id: "someone-else" } as any);
  expect(ok).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/dispatch.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`dispatch.ts` 流程：

1. 逐项查缓存，命中的直接进 `results`。
2. 未命中的按 `groupSegments` 分组。
3. 单段组走 `streamCompletion`，每片发 `delta`；多段组走 `complete` + `parseNumberedResponse`。
4. 成功项写缓存并汇总为一次 `result`，最后发 `finish`。
5. 任一组失败：该组所有 id 进 `error`（`ids` 字段），其他组继续；全部结束后仍发 `finish`。

`createDeps` 返回 `{ settings, cache, queue, adapter, isTrustedSender }`，默认值取真实实现，测试可覆盖。`isTrustedSender(sender)` = `sender?.id === chrome.runtime.id`。

`index.ts`：`chrome.runtime.onConnect` 处理 `ilmt-translate` / `ilmt-chat`；`chrome.webNavigation.onHistoryStateUpdated` 向对应 tab 发 `{ type: "page-navigated" }`；`chrome.tabs.onRemoved` 调 `queue.cancelTab`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/dispatch.test.ts`
Expected: PASS，4 个测试。

- [ ] **Step 5: 提交**

```bash
git add src/background tests/unit/dispatch.test.ts
git commit -m "feat: background routing and translate dispatch with cache and grouping"
```

---

### Task 8: 内容脚本守卫

**Files:**
- Create: `src/content/guard.ts`（实现）
- Test: `tests/unit/guard.test.ts`

**Interfaces:**
- Consumes: 无（**不得有静态 import**）
- Produces: 全局副作用——注册 `chrome.runtime.onMessage`，收到 `{ type: "activate" }` 时动态 import 主包并调用 `runContentMain()`，只执行一次。

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/guard.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const runContentMain = vi.fn();
vi.mock("../../src/content/main.ts", () => ({ runContentMain }));

beforeEach(() => { vi.resetModules(); runContentMain.mockClear(); });

it("initializes the main bundle only once even if activated twice", async () => {
  await import("../../src/content/guard.ts");
  const listener = (chrome.runtime.onMessage.addListener as any).mock.calls.at(-1)[0];
  await listener({ type: "activate" }, { id: chrome.runtime.id, tab: { id: 1 } }, () => {});
  await listener({ type: "activate" }, { id: chrome.runtime.id, tab: { id: 1 } }, () => {});
  expect(runContentMain).toHaveBeenCalledTimes(1);
});

it("ignores messages from another extension", async () => {
  await import("../../src/content/guard.ts");
  const listener = (chrome.runtime.onMessage.addListener as any).mock.calls.at(-1)[0];
  await listener({ type: "activate" }, { id: "other" }, () => {});
  expect(runContentMain).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/guard.test.ts`
Expected: FAIL（guard 里还没有监听器）。

- [ ] **Step 3: 实现**

用 `globalThis.__ilmtGuard` 做单例标记；监听器里先校验 `sender.id === chrome.runtime.id`，再 `import(chrome.runtime.getURL("content_main.js")).then(m => m.runContentMain())`。文件内**不写任何 `import` 语句**（这是构建约束，测试通过 `vi.mock` 仍然有效，因为 Vitest 走模块图）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/guard.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/content/guard.ts tests/unit/guard.test.ts
git commit -m "feat: document_start guard with single-shot dynamic import"
```

---

### Task 9: 段落识别

**Files:**
- Create: `src/content/paragraphs.ts`
- Test: `tests/unit/paragraphs.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface ParagraphNode { id: string; el: Element; text: string }`
  - `collectParagraphs(root: ParentNode, opts?: { minLength?: number; langSkipRatio?: number; detectLang?: (t: string) => Promise<string | null> }): Promise<ParagraphNode[]>`
  - `markParagraph(el: Element, id: string): void`、`isMarked(el: Element): boolean`、`clearMarks(root: ParentNode): void`

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/paragraphs.test.ts
import { describe, it, expect } from "vitest";
import { collectParagraphs } from "../../src/content/paragraphs";

const html = (s: string) => { document.body.innerHTML = s; return document.body; };

it("splits block containers into separate paragraphs", async () => {
  const root = html(`<div><p>First paragraph here.</p><p>Second paragraph here.</p></div>`);
  const ps = await collectParagraphs(root);
  expect(ps).toHaveLength(2);
});

it("treats nested inline markup as one paragraph", async () => {
  const root = html(`<p><a href="#"><span><em>Hello world this is nested</em></span></a></p>`);
  const ps = await collectParagraphs(root);
  expect(ps).toHaveLength(1);
  expect(ps[0].text.trim()).toBe("Hello world this is nested");
});

it("skips code, inputs, editable and hidden content", async () => {
  const root = html(`<pre>code here</pre><p contenteditable="true">editable text</p>
    <p aria-hidden="true">hidden text</p><p>visible paragraph</p>`);
  const ps = await collectParagraphs(root);
  expect(ps.map(p => p.text.trim())).toEqual(["visible paragraph"]);
});

it("skips text shorter than the minimum length", async () => {
  const root = html(`<p>abc</p><p>abcdef</p>`);
  const ps = await collectParagraphs(root, { minLength: 4 });
  expect(ps.map(p => p.text.trim())).toEqual(["abcdef"]);
});

it("skips paragraphs already in the target language", async () => {
  const root = html(`<p>这是一段中文内容，不需要翻译。</p><p>This is English content.</p>`);
  const ps = await collectParagraphs(root, { langSkipRatio: 0.8, detectLang: async t => (/[\u4e00-\u9fa5]/.test(t) ? "zh" : "en") });
  expect(ps.map(p => p.text.trim())).toEqual(["This is English content."]);
});

it("does not collect the same element twice", async () => {
  const root = html(`<p>Only one paragraph here.</p>`);
  await collectParagraphs(root);
  const second = await collectParagraphs(root);
  expect(second).toHaveLength(0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/paragraphs.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

深度优先；候选条件：至少一个非空文本子节点，且所有元素子节点都是行内级（`getComputedStyle(child).display` 以 `inline` 或 `contents` 开头）。命中后 `markParagraph(el, "p_" + counter)` 并把 `el.textContent` 去空白后返回。跳过列表与规则照抄规格 §8.2。语言检测：`detectLang` 缺省时用 CJK 占比（目标为 `zh-*` 且 CJK 占比 ≥ 0.6 即跳过）；传入 `detectLang` 时按返回语言与 `targetLang` 前缀比较，命中率 ≥ `langSkipRatio` 即跳过。已带 `data-ilmt-p` 的元素直接跳过。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/paragraphs.test.ts`
Expected: PASS，6 个测试。

- [ ] **Step 5: 提交**

```bash
git add src/content/paragraphs.ts tests/unit/paragraphs.test.ts
git commit -m "feat: paragraph detection with inline nesting, skip rules and language filter"
```

---

### Task 10: 渲染与还原

**Files:**
- Create: `src/content/render.ts`, `src/styles/inject.css`
- Test: `tests/unit/render.test.ts`

**Interfaces:**
- Consumes: `ParagraphNode`（Task 9）
- Produces:
  - `renderTranslation(el: Element, id: string, text: string): HTMLElement`
  - `updateTranslation(id: string, text: string): void`
  - `restoreAll(root?: ParentNode): void`
  - `extractSourceText(el: Element): string`（会剔除已有译文）
  - `setInlineLoader(id: string): void`、`clearInlineLoader(id: string): void`

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/render.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { renderTranslation, updateTranslation, restoreAll, extractSourceText } from "../../src/content/render";

beforeEach(() => { document.body.innerHTML = ""; });

it("appends a block translation as the last child", () => {
  document.body.innerHTML = `<p data-ilmt-p="p_1">Hello</p>`;
  const el = document.querySelector("p")!;
  const node = renderTranslation(el, "p_1", "你好");
  expect(node.classList.contains("ilmt-block")).toBe(true);
  expect(el.lastElementChild).toBe(node);
});

it("inserts an inline translation as a following sibling, not a child", () => {
  document.body.innerHTML = `<p><a href="#" data-ilmt-p="p_2">Hello</a></p>`;
  const el = document.querySelector("a")!;
  const node = renderTranslation(el, "p_2", "你好");
  expect(node.classList.contains("ilmt-inline")).toBe(true);
  expect(el.contains(node)).toBe(false);
  expect(el.nextElementSibling).toBe(node);
});

it("updates in place without creating a second node", () => {
  document.body.innerHTML = `<p data-ilmt-p="p_1">Hello</p>`;
  const el = document.querySelector("p")!;
  renderTranslation(el, "p_1", "你");
  updateTranslation("p_1", "你好");
  expect(el.querySelectorAll(".ilmt-tr")).toHaveLength(1);
  expect(el.querySelector(".ilmt-tr")!.textContent).toBe("你好");
});

it("restores the DOM exactly", () => {
  document.body.innerHTML = `<p data-ilmt-p="p_1">Hello</p>`;
  const before = document.body.innerHTML;
  renderTranslation(document.querySelector("p")!, "p_1", "你好");
  restoreAll(document.body);
  expect(document.body.innerHTML).toBe(before);
});

it("extracts source text without the existing translation", () => {
  document.body.innerHTML = `<p data-ilmt-p="p_1">Hello</p>`;
  const el = document.querySelector("p")!;
  renderTranslation(el, "p_1", "你好");
  expect(extractSourceText(el)).toBe("Hello");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/render.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

- 判断行内：`getComputedStyle(el).display` 以 `inline` 开头 → 生成 `<span class="ilmt-tr ilmt-inline">` 插到 `el` 之后；否则生成 `<span class="ilmt-tr ilmt-block">` 追加为最后一个子节点。两者都带 `data-ilmt-for` 与 `lang`。
- 先查 `[data-ilmt-for="<id>"]`，存在则更新文本，不新建。
- `restoreAll`：移除所有 `.ilmt-tr`，移除所有 `data-ilmt-p`，删除空壳。
- `extractSourceText`：`cloneNode(true)`，移除克隆里的 `.ilmt-tr`，再取 `textContent`。
- `inject.css`：`.ilmt-block{display:block;margin-top:.35em}`、`.ilmt-inline{display:inline}`、`.ilmt-tr{font:inherit;color:inherit;opacity:.82}`、`.ilmt-tr[data-loading="1"]{opacity:.4}`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/render.test.ts`
Expected: PASS，5 个测试。

- [ ] **Step 5: 提交**

```bash
git add src/content/render.ts src/styles/inject.css tests/unit/render.test.ts
git commit -m "feat: inline/block translation rendering, in-place update and exact restore"
```

---

### Task 11: 段落注册表与端口客户端

**Files:**
- Create: `src/content/registry.ts`, `src/content/port.ts`
- Test: `tests/unit/registry.test.ts`, `tests/unit/port.test.ts`

**Interfaces:**
- Consumes: `ParagraphStatus`（Task 2）、`ParagraphNode`（Task 9）
- Produces:
  - `class ParagraphRegistry { add(p: ParagraphNode): void; get(id: string): ParagraphRecord | undefined; setStatus(id, s: ParagraphStatus): void; setTranslation(id, t: string): void; takeQueued(limit: number): ParagraphRecord[]; requeueInflight(): string[]; prune(): number; all(): ParagraphRecord[] }`
  - `createTranslatePort(opts: { onDelta, onResult, onError, onFinish, connect?: (name: string) => Port }): { send(msg: ClientToBackground): void; close(): void; readonly state: "healthy" | "reconnecting" | "degraded" }`（`connect` 仅用于测试注入，默认 `chrome.runtime.connect`）

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/registry.test.ts
import { describe, it, expect } from "vitest";
import { ParagraphRegistry } from "../../src/content/registry";

function add(r: ParagraphRegistry, id: string, el: Element) {
  r.add({ id, el, text: "hello" });
}

it("transitions through queued → inflight → done", () => {
  const r = new ParagraphRegistry();
  document.body.innerHTML = `<p></p>`;
  add(r, "p_1", document.querySelector("p")!);
  r.setStatus("p_1", "queued"); expect(r.get("p_1")!.status).toBe("queued");
  r.setStatus("p_1", "inflight"); r.setStatus("p_1", "done");
  expect(r.get("p_1")!.status).toBe("done");
});

it("requeues inflight items on disconnect", () => {
  const r = new ParagraphRegistry();
  document.body.innerHTML = `<p></p><p></p>`;
  const [a, b] = Array.from(document.querySelectorAll("p"));
  add(r, "p_1", a); add(r, "p_2", b);
  r.setStatus("p_1", "inflight"); r.setStatus("p_2", "inflight");
  expect(r.requeueInflight().sort()).toEqual(["p_1", "p_2"]);
  expect(r.get("p_1")!.status).toBe("queued");
});

it("prunes records whose element left the document", () => {
  const r = new ParagraphRegistry();
  document.body.innerHTML = `<p></p>`;
  const el = document.querySelector("p")!;
  add(r, "p_1", el);
  el.remove();
  expect(r.prune()).toBe(1);
  expect(r.get("p_1")).toBeUndefined();
});
```

```ts
// tests/unit/port.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTranslatePort } from "../../src/content/port";

beforeEach(() => { vi.useFakeTimers(); });

it("reconnects with the documented backoff and retries once", async () => {
  const connect = vi.fn()
    .mockImplementationOnce(() => { throw new Error("Extension context invalidated"); })
    .mockImplementation(() => fakePort());
  const p = createTranslatePort({ connect, onDelta: vi.fn(), onResult: vi.fn(), onError: vi.fn(), onFinish: vi.fn() });
  p.send({ type: "ping" });
  expect(connect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(500);
  expect(connect).toHaveBeenCalledTimes(2);
});

function fakePort() { return { postMessage: vi.fn(), onMessage: { addListener: vi.fn() }, onDisconnect: { addListener: vi.fn() }, disconnect: vi.fn() }; }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/registry.test.ts tests/unit/port.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

注册表内部 `Map<string, ParagraphRecord>`，`el` 存 `WeakRef`；`prune()` 删掉 `deref()` 为空或 `!isConnected` 的记录并返回删除数量。`takeQueued(limit)` 按加入顺序取 `queued` 并置为 `inflight`。

端口客户端：`send` 捕获「端口不存在 / Extension context invalidated」类错误 → 进入 `reconnecting` → 按 `[500, 1000, 2000, 4000, 5000]` 重连 → 重试一次 → 仍失败进 `degraded` 并调用 `onError` 把所有 inflight 退回。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/registry.test.ts tests/unit/port.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/content/registry.ts src/content/port.ts tests/unit
git commit -m "feat: paragraph registry with WeakRef pruning and resilient port client"
```

---

### Task 12: 内容主流程

**Files:**
- Create: `src/content/main.ts`（实现）
- Test: `tests/unit/main.test.ts`

**Interfaces:**
- Consumes: `collectParagraphs`（Task 9）、`renderTranslation`/`updateTranslation`/`restoreAll`（Task 10）、`ParagraphRegistry`/`createTranslatePort`（Task 11）
- Produces: `runContentMain(): void`，以及 `globalThis.__ilmtMain` 上的 `{ translatePage(), restore(), isActive() }` 供测试与调试调用。测试钩子：若 `globalThis.__ilmtTestPort` 存在，则用它替代真实端口（实现里端口读取必须延迟到首次 `send`，不能在 `runContentMain` 时固化）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/main.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

beforeEach(() => { vi.resetModules(); document.body.innerHTML = ""; });

it("translates only paragraphs near the viewport on first trigger", async () => {
  document.body.innerHTML = `<p>First paragraph here.</p><p>Second paragraph here.</p>`;
  const { runContentMain } = await import("../../src/content/main");
  runContentMain();
  const sent: any[] = [];
  (globalThis as any).__ilmtTestPort = { send: (m: any) => sent.push(m) };
  await (globalThis as any).__ilmtMain.translatePage();
  expect(sent.some(m => m.type === "translate")).toBe(true);
});

it("does not send a second translate request when triggered twice in a row", async () => {
  document.body.innerHTML = `<p>First paragraph here.</p>`;
  const { runContentMain } = await import("../../src/content/main");
  runContentMain();
  const sent: any[] = [];
  (globalThis as any).__ilmtTestPort = { send: (m: any) => sent.push(m) };
  await (globalThis as any).__ilmtMain.translatePage();
  await (globalThis as any).__ilmtMain.translatePage();
  expect(sent.filter(m => m.type === "translate")).toHaveLength(1);
});

it("restores the page and aborts in-flight work when toggled off", async () => {
  document.body.innerHTML = `<p>First paragraph here.</p>`;
  const { runContentMain } = await import("../../src/content/main");
  runContentMain();
  (globalThis as any).__ilmtTestPort = { send: vi.fn() };
  await (globalThis as any).__ilmtMain.translatePage();
  (globalThis as any).__ilmtMain.restore();
  expect(document.querySelectorAll(".ilmt-tr")).toHaveLength(0);
  expect(document.querySelectorAll("[data-ilmt-p]")).toHaveLength(0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/main.test.ts`
Expected: FAIL，`runContentMain` 还是占位。

- [ ] **Step 3: 实现**

`runContentMain`：单例标记；注入 `inject.css`（`chrome.scripting.insertCSS` 或构建时以 `web_accessible_resources` + `<link>` 方式）；建立端口；注册 `page-navigated` 监听。

`translatePage()`：
- 若已激活则直接返回（Review Focus 4：重复触发不重复发请求）。
- `collectParagraphs(document.body)` → `registry.add` → `takeQueued(20)` → 发 `{ type: "translate", items }`。
- 收 `delta` 直接 `updateTranslation`；收 `result` 逐条渲染并写注册表；收 `error` 把 `ids` 标 `failed`。
- `finish` 后若还有 `queued` 继续下一批。
- 上限 2000 段，超出停止并提示。

`restore()`：`restoreAll(document.body)`、清空注册表、发 `abort`、取消 MutationObserver。

MutationObserver：见规格 §8.4；每分钟 200 段上限。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/main.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/content/main.ts tests/unit/main.test.ts
git commit -m "feat: content orchestration with batching, dedupe and restore"
```

---

### Task 13: 划词气泡

**Files:**
- Create: `src/content/selection.ts`, `src/styles/inject.css`（追加气泡样式）
- Test: `tests/unit/selection.test.ts`

**Interfaces:**
- Consumes: `ChatMessage`（Task 2）
- Produces: `initSelectionBubble(opts: { onExplain(text: string): void; onFollowUp(text: string): void }): void`

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/selection.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { initSelectionBubble } from "../../src/content/selection";

const select = (node: Node) => { const r = document.createRange(); r.selectNodeContents(node); const s = getSelection()!; s.removeAllRanges(); s.addRange(r); };

beforeEach(() => { document.body.innerHTML = ""; initSelectionBubble({ onExplain: vi.fn(), onFollowUp: vi.fn() }); });

it("shows the bubble for a selection of two or more characters", () => {
  document.body.innerHTML = `<p>Hello world</p>`;
  select(document.querySelector("p")!);
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(document.querySelector(".ilmt-bubble")).not.toBeNull();
});

it("does not show the bubble for a single character", () => {
  document.body.innerHTML = `<p>H</p>`;
  select(document.querySelector("p")!.firstChild!);
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(document.querySelector(".ilmt-bubble")).toBeNull();
});

it("does not show the bubble when the selection is inside an input", () => {
  document.body.innerHTML = `<input value="hello" />`;
  const input = document.querySelector("input")!;
  input.setSelectionRange(0, 5);
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(document.querySelector(".ilmt-bubble")).toBeNull();
});

it("hides on Escape", () => {
  document.body.innerHTML = `<p>Hello world</p>`;
  select(document.querySelector("p")!);
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(document.querySelector(".ilmt-bubble")).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/selection.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`mouseup` 去抖 50ms；取 `getSelection()`，`toString().trim().length >= 2`；若 `anchorNode` 在 `input/textarea/[contenteditable]` 内则忽略。气泡是一个 `div.ilmt-bubble`，内含两个按钮；定位：`rect.top >= 48 ? "above" : "below"`，`left = clamp(rect.left, 8, innerWidth - width - 8)`。`scroll`、`mousedown` 在气泡外、`Escape` 时移除。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/selection.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/content/selection.ts src/styles/inject.css tests/unit/selection.test.ts
git commit -m "feat: selection bubble with positioning and input guards"
```

---

### Task 14: 侧栏会话

**Files:**
- Create: `src/panel/index.html`, `src/panel/main.ts`, `src/panel/session.ts`, `src/styles/panel.css`
- Modify: `src/background/index.ts`（接 `ilmt-chat`）
- Test: `tests/unit/panel.test.ts`

**Interfaces:**
- Consumes: `ChatClientToBackground`、`ChatBackgroundToClient`、`Session`（Task 2）
- Produces: `createSession(pageUrl, pageTitle, tabId): Session`、`appendMessage(s, m): Session`、`buildChatContext(s, quotes, recentParagraphs): ChatContext`

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/panel.test.ts
import { describe, it, expect } from "vitest";
import { createSession, appendMessage, buildChatContext } from "../../src/panel/session";

it("pins the session to the page where it started", () => {
  const s = createSession("https://a.test/x", "A", 1);
  expect(s.pageUrl).toBe("https://a.test/x");
  expect(s.tabId).toBe(1);
});

it("keeps at most 50 messages", () => {
  let s = createSession("u", "t", 1);
  for (let i = 0; i < 60; i++) s = appendMessage(s, { role: "user", content: String(i), ts: i });
  expect(s.messages).toHaveLength(50);
  expect(s.messages.at(-1)!.content).toBe("59");
});

it("puts only the last five paragraphs into the context", () => {
  const paragraphs = Array.from({ length: 9 }, (_, i) => ({ source: `s${i}`, translation: `t${i}` }));
  const ctx = buildChatContext(createSession("u", "t", 1), ["quote"], paragraphs);
  expect(ctx.recentParagraphs).toHaveLength(5);
  expect(ctx.recentParagraphs[0].source).toBe("s4");
  expect(ctx.quotes).toEqual(["quote"]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/panel.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`src/panel/session.ts` 放纯函数（便于测试）；`main.ts` 负责渲染：消息列表、输入框、发送/停止按钮、页面切换提示条、上下文说明「只参考已翻译的段落」。streaming 时把 `delta` 追加到最后一条 assistant 消息；`error` 时在消息下方显示错误与「重新发送」。

后台 `ilmt-chat`：把 `messages` 与 `context` 拼成 system 消息（上下文 JSON 放 system，用户历史放 user/assistant），走同一队列（`priority: "chat"`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/panel.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/panel src/styles/panel.css tests/unit/panel.test.ts src/background/index.ts
git commit -m "feat: side panel chat with page-pinned sessions and bounded context"
```

---

### Task 15: 设置页

**Files:**
- Create: `src/options/index.html`, `src/options/main.ts`, `src/options/providers.ts`, `src/styles/options.css`
- Test: `tests/unit/options-providers.test.ts`

**Interfaces:**
- Consumes: `storage.ts`（Task 2）、`listModels`/`complete`（Task 4）
- Produces:
  - `validateProvider(p: ProviderConfig): string[]`
  - `maskKey(k: string): string`
  - `applyProviderForm(state, patch): ProviderConfig`

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/options-providers.test.ts
import { describe, it, expect } from "vitest";
import { validateProvider, maskKey, applyProviderForm } from "../../src/options/providers";

const base = { id: "a", name: "A", kind: "custom" as const, baseURL: "https://x", apiKey: "sk-1234567890", model: "m", createdAt: 1 };

it("requires baseURL, apiKey and model", () => {
  expect(validateProvider({ ...base, baseURL: "" })).toContain("baseURL");
  expect(validateProvider({ ...base, apiKey: "" })).toContain("apiKey");
  expect(validateProvider({ ...base, model: "" })).toContain("model");
  expect(validateProvider(base)).toEqual([]);
});

it("masks keys to the last four characters", () => {
  expect(maskKey("sk-1234567890")).toBe("sk-****7890");
  expect(maskKey("")).toBe("");
  expect(maskKey("abc")).toBe("****");
});

it("keeps existing values when the form patch omits them", () => {
  expect(applyProviderForm(base, { model: "m2" })).toMatchObject({ baseURL: "https://x", apiKey: "sk-1234567890", model: "m2" });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/options-providers.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

三个纯函数如上。`main.ts` 渲染两块区域（自定义模型列表 / 全局设置），支持新增、编辑、复制、删除、测试连接、拉取模型；拉取失败时在模型输入框下方显示「拉取失败，可直接手填」并且不阻止保存。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/options-providers.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/options src/styles/options.css tests/unit/options-providers.test.ts
git commit -m "feat: options page with multi-provider CRUD and validation"
```

---

### Task 16: E2E 与收尾

**Files:**
- Create: `playwright.config.ts`, `tests/mock-server.ts`, `tests/fixtures/article.html`, `tests/fixtures/chinese.html`, `tests/fixtures/spa.html`
- Test: `tests/e2e/translate.spec.ts`
- Modify: `public/manifest.json`（确认 `key` 固定扩展 ID，便于 E2E 定位）

**Interfaces:**
- Consumes: 全部
- Produces: 可重复的端到端验证。

- [ ] **Step 1: 写失败测试**

```ts
// tests/e2e/translate.spec.ts
import { test, expect, chromium } from "@playwright/test";
import { startMockServer } from "../mock-server";
import path from "node:path";

test("translates an English article and restores it", async () => {
  const server = await startMockServer({ reply: (n) => `[${n}] 译文` });
  const ctx = await chromium.launchPersistentContext("", {
    headless: false,
    args: [`--disable-extensions-except=${path.resolve("dist")}`, `--load-extension=${path.resolve("dist")}`],
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/article.html`);
  await page.evaluate(() => (globalThis as any).__ilmtMain.translatePage());
  await expect(page.locator(".ilmt-tr").first()).toContainText("译文");
  await page.evaluate(() => (globalThis as any).__ilmtMain.restore());
  await expect(page.locator(".ilmt-tr")).toHaveCount(0);
  await ctx.close(); await server.close();
});

test("sends no requests on an already-Chinese page", async () => {
  const server = await startMockServer({});
  const ctx = await chromium.launchPersistentContext("", {
    headless: false,
    args: [`--disable-extensions-except=${path.resolve("dist")}`, `--load-extension=${path.resolve("dist")}`],
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/chinese.html`);
  await page.evaluate(() => (globalThis as any).__ilmtMain.translatePage());
  await page.waitForTimeout(500);
  expect(server.requests).toHaveLength(0);
  await ctx.close(); await server.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test`
Expected: FAIL（mock server / fixtures 不存在）。

- [ ] **Step 3: 实现**

`mock-server.ts`：`node:http` 起服务，`/v1/models` 返回两个模型，`/v1/chat/completions` 支持 `stream: true/false`；记录 `requests`。fixtures：`article.html`（10 段英文）、`chinese.html`（全中文）、`spa.html`（按钮切换内容）。

E2E 里扩展的「首屏翻译」通过 `globalThis.__ilmtMain` 暴露的测试钩子触发；同时验证快捷键路径（`chrome.commands` 在 E2E 中不可直接按，改为发消息触发）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test`
Expected: PASS，2 个用例。

- [ ] **Step 5: 提交**

```bash
git add playwright.config.ts tests/e2e tests/fixtures tests/mock-server.ts
git commit -m "test: end-to-end translation, restore and language-skip coverage"
```

---

## Self-Review

**1. 规格覆盖**

| 规格章节 | 落点 |
|---|---|
| §8.1 注入与引导 | Task 1、8 |
| §8.2 段落识别 | Task 9 |
| §8.3 渲染与还原 | Task 10 |
| §8.4 状态机与动态内容 | Task 11、12 |
| §8.5 分组与 prompt | Task 3 |
| §8.6 Provider / 多套配置 | Task 2、4、15 |
| §8.7 队列 | Task 5 |
| §8.8 缓存 | Task 6 |
| §8.9 划词与侧栏 | Task 13、14 |
| §8.10 设置页 | Task 15 |
| §8.11 消息协议 | Task 7、11、14 |
| §9 数据模型 | Task 2、14 |
| §10 权限与 DNR | Task 1 |
| §11 错误处理 | Task 4、7、12 |
| §12 安全与隐私 | Task 2、7（sender 校验）、15（脱敏） |
| §13 性能预算 | Task 1（体积断言留待 CI）、12（批量与上限） |
| §15 测试 | 每个任务的单测 + Task 16 |
| §16 分期 | v1 覆盖到 Task 16；v2 不在本计划 |

**2. 步骤扫描**：没有 TBD / "处理边界情况" 这类空步骤；每个实现步骤都给了签名或判定规则。

**3. 类型一致性**：`ProviderConfig` / `Settings` / `TranslateItem` / `ParagraphRecord` 在 Task 2 定义，后续任务只引用；`streamCompletion` 在 Task 4 定义、Task 7 使用；`ParagraphRegistry` 方法名在 Task 11 定义、Task 12 使用，一致。

**4. Review Focus**：5 条分别落到 Task 4（SSE 分片）、Task 9（嵌套行内只翻一次）、Task 10（二次翻译剥离、精确还原）、Task 12（重复触发不重复请求）、Task 16（中文页零请求）。

**5. 比例**：计划约 900 行，规格 525 行；代码块以测试断言为主，实现只给签名与判定规则，没有转写函数体。

---

## Execution Handoff

计划已保存到 `docs/superpowers/plans/2026-11-05-bilingual-translate-extension.md`。

**执行方式二选一：**

- **Subagent-driven**：每个任务由独立 subagent 实现，再由独立 reviewer 检查后才进下一个；最后整体 review。最稳，成本是每个任务多一份上下文。
- **Native**：我在当前会话里按任务顺序自己实现，最后统一由独立 reviewer 检查整条分支。最快最省，但中途没有独立把关。

**我推荐 Subagent-driven**：这个计划有 16 个任务，任务之间的接口耦合很密（端口协议、注册表、队列签名），错一个后面全歪；独立 reviewer 能在每个任务边界拦住这类错误。
