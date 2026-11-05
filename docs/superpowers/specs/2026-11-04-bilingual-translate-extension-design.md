# 双语网页翻译与 LLM 问答扩展 · 设计文档

- 日期：2026-11-04
- 状态：待批准
- 范围：v1（整页翻译 + 侧栏问答），v2 的 console 能力只作预留

---

## 1. 意图

一个 Chrome 扩展：用户按快捷键，把当前页面里非中文的内容翻译成中文，**译文插在原文下方**；翻译由用户自己配置的 LLM（OpenAI 兼容接口）完成；用户遇到看不懂的内容时，可以划词提问，也可以在侧栏里连续追问。

作者要的是：**读外文网页时，不用切换到另一个翻译工具，也不用在阅读和提问之间来回跳。**

## 2. 目标

1. 一个快捷键把当前页翻成中文，译文和原文并存，可一键还原。
2. 段落级渐进翻译：先翻视口内的，滚动时继续，不阻塞页面。
3. 一切模型接入都走"自定义"：用户自己填 baseURL、API key、模型名，可以保存**多套**配置并随时切换；支持从服务端拉取模型列表、设置并发上限、覆盖 prompt。
4. 划词后能就选中的内容提问；侧栏可以脱离选区独立对话。
5. 单页翻译的请求可取消、可重试、断流可恢复。

## 3. 非目标（v1 明确不做）

- console 日志抓取与过滤（v2）
- PDF、EPUB、图片/OCR、视频字幕、输入框翻译
- 术语表、双语对照导出、分享卡片
- Firefox / Safari / 移动端
- 云端账号、同步、计费

## 4. 反目标（技术上能做到，但会让这个产品失败）

- 为了"翻得快"把整页文本一次性塞给模型，导致长页面超 token、失败一次全页重来。
- 修改页面原有文本节点（innerHTML 替换），导致还原不回去、SPA 重渲染后残留。
- 把 API key 传进内容脚本。
- 请求失败时静默吞掉，用户只看到"没反应"。
- 每个标签页各自限流，多个标签页把接口打爆。

## 5. 约束

- Manifest V3，Chrome 120+（`chrome.sidePanel` 需要 114+）。
- 不加载远程代码，所有 JS 随扩展打包。
- 扩展页 CSP：`script-src 'self'`，禁止内联脚本和 `eval`。
- Service Worker 空闲 30 秒会被回收，单次事件最长约 5 分钟。
- 内容脚本从 Chrome 85 起受页面 CORS 约束，不能直接请求第三方 API。
- 页面可以通过自己的 CSS 影响我们注入的节点。

## 6. 已定方案

### 6.1 请求放在后台 Service Worker（方案 B）

内容脚本只发**语义请求**（"翻译这几段"），后台负责选 provider、拼 prompt、持有密钥、限流、缓存、解析流。

理由：本扩展没有 userscript / 移动端形态，方案 A（调用方拼请求）带来的可复用性用不上，却要付出"密钥进内容脚本"和"逻辑重复"的代价。

### 6.2 侧栏用 `chrome.sidePanel`，划词用小气泡

侧栏是原生面板，不受页面 CSS 影响，切换标签页不消失。划词后只弹一个气泡（"解释 / 追问"），点击把选中文本带进侧栏。

### 6.3 Provider 以"自定义"为唯一入口

**不内置任何服务商目录。** 第一版只有一种 provider 类型：`custom`（OpenAI 兼容）。用户填 baseURL、API key、模型名，保存成一套具名配置；可以保存多套，随时切换。

- 请求：`POST {baseURL}/chat/completions`（支持 SSE）
- 模型列表：`GET {baseURL}/models`；失败时允许手填模型名
- 可选自定义请求头：某些网关要求 `HTTP-Referer` / `X-Title` 之类的字段，允许用户自己加 2–3 条

典型的自定义场景：OpenAI、DeepSeek、通义、硅基流动、OpenRouter、自建 one-api / new-api 网关、Ollama、LM Studio——对扩展来说全都是"一个 baseURL + 一个 key"。

以后要加 Anthropic / Gemini，是新增 adapter 类型，不是改这套配置模型。

## 7. 架构

```
┌──────────────────────────── 页面（每个 tab 一份） ────────────────────────────┐
│ content_guard.js  (document_start，约 3KB)                                     │
│   └─ 按需 import(content_main.js)  ← ESM，web_accessible_resources             │
│                                                                               │
│ content_main.js                                                               │
│   ├─ 段落识别 / 标记 / 渲染 / 状态机                                            │
│   ├─ 划词监听 → 气泡                                                            │
│   └─ 端口客户端（含健康检查与退避重连）                                           │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    │ port "ilmt-translate"
                                    │ C→B: translate / abort / ping
                                    │ B→C: delta / result / error / finish / pong
┌───────────────────────────────────▼───────────────────────────────────────────┐
│ background service worker                                                      │
│   ├─ 请求队列（全局并发 + 每秒速率 + 按 tab 轮转）                                 │
│   ├─ Provider 适配层（自定义 / OpenAI 兼容，多套配置）                            │
│   ├─ Prompt 构建 + 分组（按 token 预算）                                          │
│   ├─ 缓存（IndexedDB）                                                          │
│   └─ 配置（chrome.storage.local）                                               │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    │ fetch (SSE)
                                    ▼
                              LLM /api 服务

┌──────────────┐   ┌──────────────┐
│ side panel   │   │ options page │   （扩展页，可读 storage）
└──────┬───────┘   └──────────────┘
       │ port "ilmt-chat"
       ▼
  （同样连后台，不直接发请求）
```

**侧栏的对话不直接发请求**：它和内容脚本一样连后台端口（`ilmt-chat`），共用同一个并发队列和速率限制。这样 chat 和翻译不会互相打爆接口，密钥也只在一个地方。

## 8. 模块设计

### 8.1 注入与引导

- `content_scripts`: 只声明 `content_guard.js`，`run_at: document_start`，`all_frames: false`（v1 只处理主框架）。
- guard 的职责：注册快捷键消息监听、划词监听（仅监听 `mouseup`，不做重活）、页面卸载时清理。**不到 3KB。**
- 首次需要翻译或提问时，guard 执行：

```js
const mod = await import(chrome.runtime.getURL("content_main.js"));
mod.runContentMain();
```

- 单例：在 `globalThis` 上打标记，重复 import 不重复初始化。

理由：4MB 级的核心包不能在每个页面启动时都解析；但 guard 必须 `document_start` 才能拿到最早的上下文。

### 8.2 段落识别

扫描顺序：

1. 根节点：`<main>` → `<article>` → `[role=main]` → `document.body`。
2. 深度优先遍历元素；对每个元素判断是否"段落候选"：
   - 自身至少有一个非空文本子节点；
   - **所有元素子节点都是行内级**（`display` 以 `inline`、`contents` 开头，且不是 `block/flex/grid/table/list-item`）。
3. 命中后标记 `data-ilmt-p="p_<n>"`，记录源文本。
4. 不命中的块继续向下遍历（这样 `<div><p>…</p><p>…</p></div>` 只会在 `<p>` 上命中）。

跳过规则（命中即整棵子树跳过）：

- 标签：`script style noscript pre code kbd samp textarea input select option svg canvas video audio iframe object`
- 属性：`[contenteditable]`、`[aria-hidden="true"]`、`[translate="no"]`、`.notranslate`、`[data-ilmt-p]`、我们的 `.ilmt-tr`
- 计算样式：`display:none`、`visibility:hidden`
- 字符数：去空白后 `< 4` 个字符
- **语言**：已经主要是目标语言的段落跳过。用 `chrome.i18n.detectLanguage()`（后台可用，内容脚本通过端口问一次或本地缓存结果）；判断规则：目标语言占比 ≥ 0.8 则跳过。检测失败时回退到字符集启发式（目标为 `zh-*` 时，CJK 字符占比 ≥ 0.6 即跳过）。跳过时状态记为 `skipped`，不显示任何东西。

同一段落只处理一次：已带 `data-ilmt-p` 的节点直接跳过。

### 8.3 渲染

**不改动任何原有文本节点。** 译文一律作为新节点插入。

- **块级候选**（`p/li/h1-h6/blockquote/td/figcaption` 或 `display` 为块）：

```html
<span class="ilmt-tr ilmt-block" data-ilmt-for="p_3" lang="zh-CN">译文……</span>
```

作为该元素的最后一个子节点，`display:block`，`margin-top:.35em`。

- **行内候选**（`a/span/em/strong` 等）：

```html
<span class="ilmt-tr ilmt-inline" data-ilmt-for="p_7" lang="zh-CN">（译文）</span>
```

作为该元素的**下一个兄弟节点**插入，不插进元素内部——避免破坏链接、按钮的命中区域。

- 样式：通过 `chrome.scripting.insertCSS` 注入，不受页面 CSP 限制。类名全部带 `ilmt-` 前缀；布局关键属性用 `!important` 只作用于 `.ilmt-tr` 自身。
- 字体：`font: inherit; color: inherit;`，默认继承原文排版；可选"译文淡化"（`opacity: .82`）。

**还原**：删除所有 `.ilmt-tr`、移除所有 `data-ilmt-p`、清空段落注册表。因为没动原文，还原是 O(n) 且绝对干净。

**二次翻译**：提取源文本前先克隆节点并移除其中的 `.ilmt-tr`，避免把译文再喂给模型。

### 8.4 状态机

每个段落一条记录：

```ts
type ParagraphStatus = "unseen" | "queued" | "inflight" | "done" | "failed" | "skipped";

interface ParagraphRecord {
  id: string;                  // p_<n>
  el: WeakRef<Element>;        // 必须 WeakRef，否则 SPA 重渲染会累积泄漏
  sourceText: string;
  hash: string;
  status: ParagraphStatus;
  translation?: string;
  attempts: number;
  error?: { code: string; message: string; retryable: boolean };
}
```

- 注册表：`Map<string, ParagraphRecord>`；每 30 秒清理一次 `el.deref()` 为 `undefined` 或 `!isConnected` 的记录。
- 状态转换：`unseen → queued`（进入视口或用户点了"翻译整页"）→ `inflight`（发出请求）→ `done | failed`。
- `failed`：自动重试最多 2 次，退避 1s / 3s；仍失败则保持 `failed`，段落旁显示"重试"。
- 断流：端口 `onDisconnect` 时，所有 `inflight` 记录退回 `queued`，按当前视口优先级重新入队。

**动态内容**

- 观察 `document.body` 的 `childList` + `characterData`，去抖 250 ms。
- 只扫描新增的子树；忽略变更发生在 `.ilmt-tr` 内部的情况。
- **只有当前页面处于"翻译中"状态时才观察**；未激活时完全不观察。
- 限流：每分钟最多新增 200 段入队，超出暂停并显示"继续翻译"按钮，防止无限滚动页面造成失控调用。
- SPA 路由变化由后台 `webNavigation.onHistoryStateUpdated` 通知内容脚本：重置注册表、重新扫描，已命中缓存的段落直接出结果。

### 8.5 分组与请求

段落不会一段一个请求，也不会整页一个请求。

- 入队顺序：视口内 → 视口下方 300px（`IntersectionObserver` 的 `rootMargin`）→ 页面其余部分（仅当用户选"翻译整页"）。
- 分组：按顺序累加，满足任一条件即封组：
  - 估算 token 数 ≥ `maxInputTokens`（默认 1500）
  - 段落数 ≥ 20
- token 估算：CJK 按 `字符数 / 1.5`，拉丁按 `字符数 / 4`，不加 tokenizer 依赖。
- 单段组：`stream: true`，边收边渲染。
- 多段组：`stream: false`，一次返回后按编号切分。**这是刻意简化**——多段流式解析的复杂度和收益不成比例。

提示词约定：

```
system: 你是一个翻译引擎。把用户给出的编号段落翻译成<目标语言>。
        只输出 [编号] 译文，逐行对应，不解释、不合并、不遗漏。
        保留原文的专有名词、代码、URL。
user:   [1] <段落一>
        [2] <段落二>
```

解析：按 `^\[(\d+)\]\s*([\s\S]*?)(?=^\[\d+\]|$)` 多行匹配。

### 8.6 Provider 层

配置模型（多套并存）：

```ts
interface ProviderConfig {
  id: string;                 // uuid
  name: string;               // 用户命名，如 "DeepSeek 官方" / "公司网关"
  kind: "custom";             // v1 只有这一种
  baseURL: string;
  apiKey: string;
  model: string;
  extraHeaders?: Record<string, string>;  // 最多 5 条，值里可用 {{apiKey}}
  overrides?: {               // 留空则继承全局
    concurrency?: number;
    maxRPS?: number;
    temperature?: number;
    systemPrompt?: string;
  };
  createdAt: number;
  lastUsedAt?: number;
}
```

适配器接口：

```ts
interface ProviderAdapter {
  id: string;
  listModels(): Promise<ModelInfo[]>;                 // GET {baseURL}/models
  complete(req: CompletionRequest, signal: AbortSignal): Promise<CompletionResult>;
  stream(req: CompletionRequest, signal: AbortSignal): AsyncGenerator<string>;
}
```

OpenAI 兼容 adapter 的细节：

- baseURL 归一化：去掉尾部 `/`；若不含 `/v1` 且不以 `/v1` 结尾，默认补 `/v1`（允许用户在设置里关闭）。
- 鉴权：`Authorization: Bearer <key>`。
- 自定义头：先放 `Authorization`，再按顺序合并 `extraHeaders`（同名覆盖）；值里的 `{{apiKey}}` 在发送前替换。
- SSE：按 `\n\n` 切事件，取 `data:` 行，`[DONE]` 结束，取 `choices[0].delta.content`。
- 超时：连接 15s、首 token 45s、空闲 60s、总时长 180s。
- 重试：仅对 429 / 5xx / 网络错误重试 2 次，退避 1s、3s；4xx（除 429）不重试。
- 错误归一化：`{code: "auth" | "rate_limit" | "timeout" | "network" | "bad_response" | "unknown", message, retryable}`。
- 列表拉取失败不阻塞设置页：模型输入框始终可手填。

### 8.7 队列与限流

后台只有一个队列，全局生效（跨标签页）。

- 默认并发 `maxConcurrent = 3`（可配 1–10）。
- 默认速率 `maxRPS = 5`（可配 1–20）。
- 调度：按 tab 轮转（round-robin），避免一个长页面饿死其他标签页。
- 取消：标签页导航、用户关闭翻译、端口断开 → `AbortController.abort()` 该 tab 所有在途请求。

### 8.8 缓存

- DB：IndexedDB `ilmt`，store `translations`。
- key：`sha256(sourceText + "\u0000" + targetLang + "\u0000" + providerConfigId + "\u0000" + modelId + "\u0000" + promptVersion)`。
- value：`{ text, createdAt, modelId }`。
- 过期：30 天；容量：最多 20,000 条或 50 MB，超出按 LRU 淘汰。
- 命中缓存不消耗并发名额。

### 8.9 划词与侧栏

**划词（模式 A）**

1. `mouseup` 后取 `window.getSelection()`，若长度 ≥ 2 且不在输入框内，显示气泡。
2. 气泡定位：选区 `getBoundingClientRect()` 上方 8px；越界则翻到下方。
3. 气泡两个动作："解释"（直接问"这是什么意思"）、"追问"（打开侧栏并把选区作为引用插入输入框）。
4. 气泡在滚动 / 点击空白 / `Esc` 时消失。

**侧栏（模式 B）**

- `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`；快捷键 `Alt+S` 打开。
- **会话绑定到发起时的页面**（记录 `tabId` + `pageUrl`）。用户切到别的标签页，侧栏显示的仍是原来那段对话，顶部有一条提示"当前页面已切换"，并提供"针对新页面开新会话"。
- 页面发生导航：不自动清空对话，但停止注入旧的页面上下文；用户发下一条消息时提示"上下文已失效"。
- 上下文**只包含三样**，且在 UI 里明说：
  - 当前页面标题与 URL
  - 最近 5 段已翻译的段落（原文 + 译文）
  - 用户引用的选区（如有）
  超出这个范围的内容（未翻译的正文、整页摘要）v1 不读取。输入框上方有一行固定说明："只参考已翻译的段落"，避免用户误以为模型读完了整页。
- 消息以流式渲染；单条回答的超时是"空闲 60 秒"，**不设总时长上限**（会话类回答可能很长）。端口断开时保留已收到的部分，并显示"已中断，重新发送"。
- 历史存在 `chrome.storage.local`，最多保留 10 个会话、每会话 50 条，按时间淘汰。
- 侧栏可切换 provider 与模型（复用全局配置，不做独立配置）。

### 8.10 设置页

设置页分两块：**自定义模型配置**（可多套）和**全局设置**。

**自定义模型配置**（列表 + 新增 / 编辑 / 复制 / 删除 / 测试）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| name | text | `自定义 1` | 用户命名，显示在切换器里 |
| baseURL | text | `https://api.openai.com` | 自动补 `/v1`，可在高级里关 |
| apiKey | password | — | 仅存 `storage.local`，回显为 `sk-****1234` |
| model | 可搜索下拉 + 手填 | — | "拉取模型"调 `listModels()`，失败不阻塞手填 |
| extraHeaders | key-value 列表 | 空 | 最多 5 条 |
| concurrency | number | 继承全局 | 1–10 |
| maxRPS | number | 继承全局 | 1–20 |
| temperature | number | 继承全局 | |
| systemPrompt | textarea | 继承全局 | 留空表示继承 |

**全局设置**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| activeProviderId | 单选 | 第一套 | 翻译与问答默认用哪套 |
| targetLang | select | `zh-CN` | |
| concurrency | number | 3 | 1–10，全局上限 |
| maxRPS | number | 5 | 1–20，全局上限 |
| temperature | number | 0 | |
| systemPrompt | textarea | 见 8.5 | 改动会重算 `promptVersion` |
| triggerMode | radio | `shortcut` | `shortcut` / `auto-current-site` |
| siteRules | list | 空 | **v1.1 才做 UI**；v1 仅在 storage 里预留字段 |

"测试连接"按钮：发一条 1 token 的请求，展示延迟、模型是否可用、错误分类。每个配置各自测试。

prompt 生效顺序：配置自己的 `systemPrompt` → 全局 `systemPrompt` → 内置默认。缓存 key 里的 `promptVersion` 取最终生效的那一份。

### 8.11 消息协议

端口名：`ilmt-translate`

```
C→B  { type: "translate", requestId, tabId, items: [{ id, text, hash }] }
C→B  { type: "abort", requestId }
C→B  { type: "ping" }

B→C  { type: "delta",   requestId, id, text }        // 仅单段流式
B→C  { type: "result",  requestId, items: [{ id, text }] }
B→C  { type: "error",   requestId, code, message, retryable, ids: [] }
B→C  { type: "finish",  requestId }
B→C  { type: "pong" }
```

端口名：`ilmt-chat`（侧栏 ↔ 后台）：

```
C→B  { type: "chat", requestId, sessionId,
       messages: [{ role, content }],
       context: { pageUrl, title, quotes: [], recentParagraphs: [] } }
C→B  { type: "abort", requestId }

B→C  { type: "delta",  requestId, text }
B→C  { type: "finish", requestId, usage }
B→C  { type: "error",  requestId, code, message, retryable }
```

两个端口共用同一个队列（§8.7）：chat 和翻译都在 `maxConcurrent` / `maxRPS` 之内，但 chat 在队列里优先一级，避免用户提问时排在整页翻译后面。

内容脚本侧的 `sendWithHealth()`：

- 捕获 `port` 断开类错误 → 退避重连 `[500, 1000, 2000, 4000, 5000]ms` → 重试一次 → 仍失败则进入 `degraded` 并把段落退回 `queued`。
- 在 `visibilitychange`（变为可见）时主动 ping 一次，因为标签页在后台时后台脚本极可能已被回收。

## 9. 数据模型

```ts
// chrome.storage.local
interface Settings {
  providers: ProviderConfig[];   // 见 §8.6，可多套
  activeProviderId: string;
  targetLang: string;
  concurrency: number;
  maxRPS: number;
  temperature: number;
  systemPrompt: string;
  promptVersion: string;      // sha256(systemPrompt)
  triggerMode: "shortcut" | "auto";
  siteRules: Record<string, "auto" | "never">;
  theme: "system" | "light" | "dark";
}

interface Session {
  id: string;
  tabId: number;              // 会话发起时所在的标签页
  pageUrl: string;            // 发起时的 URL，用于判断上下文是否失效
  pageTitle: string;
  createdAt: number;
  messages: Array<{ role: "user" | "assistant"; content: string; quote?: string; ts: number }>;
}
```

存储位置：`settings`、`chat.history` 在 `chrome.storage.local`；翻译缓存在 IndexedDB。

**API key 安全说明**：`storage.local` 是明文落盘的（浏览器 profile 目录内）。扩展无法做得更好；文档和 UI 都要如实说明，不要暗示"加密保存"。

## 10. 权限与 DNR

```json
{
  "permissions": [
    "storage",
    "sidePanel",
    "contextMenus",
    "webNavigation",
    "declarativeNetRequestWithHostAccess"
  ],
  "host_permissions": ["<all_urls>"],
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content_guard.js"],
    "run_at": "document_start",
    "all_frames": false
  }],
  "commands": {
    "translate-page": { "suggested_key": { "default": "Alt+A" } },
    "ask-selection":  { "suggested_key": { "default": "Alt+Q" } },
    "toggle-side-panel": { "suggested_key": { "default": "Alt+S" } }
  }
}
```

**DNR 规则（必须）**：本地模型对 `Origin: chrome-extension://…` 处理不一致，会导致请求被拒。

```json
[
  { "id": 1, "priority": 1,
    "action": { "type": "modifyHeaders",
      "requestHeaders": [{ "header": "Origin", "operation": "set", "value": "http://localhost" }] },
    "condition": { "urlFilter": "http://*:11434/*", "resourceTypes": ["xmlhttprequest"] } },
  { "id": 2, "priority": 1,
    "action": { "type": "modifyHeaders",
      "requestHeaders": [{ "header": "Origin", "operation": "set", "value": "http://localhost" }] },
    "condition": { "urlFilter": "http://*:1234/*", "resourceTypes": ["xmlhttprequest"] } }
]
```

`webNavigation` 用于在 SPA 路由变化时通知内容脚本重新扫描（`onHistoryStateUpdated`）。

## 11. 错误处理

| 场景 | 行为 |
|---|---|
| 未配置 key | 首次触发时打开设置页，并在页面上显示一条一次性提示 |
| 401/403 | 段落标记 failed，页面顶部横幅："API key 无效或权限不足"，点开设置 |
| 429 | 自动重试 2 次（退避），仍失败则降速并把该批退回队列 |
| 超时 | 该段 failed，可重试；不影响其他段 |
| 上下文超长 | 拆成更小的组重发一次；仍失败则该段标 failed |
| 端口断开 | 退避重连，inflight 段退回 queued |
| 页面 CSP 阻止注入 | 理论上不会（用 insertCSS），若出现则记录并在控制台提示 |
| 模型返回格式不符 | 丢弃该组、标 failed，不显示半截错误文本 |

## 12. 安全与隐私

- API key 只在后台 SW 内存和 `storage.local` 出现，**不发给内容脚本**。
- 日志中 key 一律替换为 `sk-***`。
- 所有 `runtime.onMessage` 处理前校验 `sender.id === chrome.runtime.id`；来自 tab 的消息再校验 `sender.frameId === 0`。
- 页面文本作为 **user 消息**内容，永不拼进 system prompt；对 `\u0000`–`\u001f` 控制字符做剥离；单段上限 20,000 字符。
- 不做遥测、不上报 URL、不发分析请求。
- 缓存只存翻译结果与 hash，不存完整 URL；设置页提供"清空缓存"。

## 13. 性能预算

| 指标 | 预算 |
|---|---|
| guard 体积 | ≤ 5 KB（gzip） |
| 主包体积 | ≤ 300 KB（gzip） |
| 注入到首个段落标记完成 | ≤ 150 ms（1 万字符页面） |
| 首个译文出现 | 取决于模型；本地 mock 下 ≤ 1.5 s |
| DOM 写入 | 每帧 ≤ 8 ms，超出则用 `requestIdleCallback` 分片 |
| MutationObserver 去抖 | 250 ms；忽略 `.ilmt-tr` 内部的变更 |
| 单页段落上限 | 2000，超出提示"只翻译当前视口" |

## 14. 目录结构

```
manifest.json
src/
  background/
    index.ts            # 端口、消息路由、生命周期
    queue.ts            # 并发 + 速率 + tab 轮转
    cache.ts            # IndexedDB 读写与 LRU
    dispatch.ts         # 分组 → adapter → 结果回发
  providers/
    types.ts
    openai.ts
    index.ts
  content/
    guard.ts            # document_start，动态 import 主包
    main.ts             # 导出 runContentMain()
    paragraphs.ts       # 识别 + 标记
    render.ts           # 插入 / 还原 / 二次翻译防护
    registry.ts         # WeakRef 注册表 + 清理
    selection.ts        # 划词 → 气泡
    port.ts             # 端口客户端 + sendWithHealth
  panel/                # 侧栏
  options/              # 设置页
  shared/
    storage.ts
    prompt.ts
    types.ts
    token-estimate.ts
  styles/
    inject.css          # 注入页面的样式
    panel.css
    options.css
rules/dnr.json
tests/
  fixtures/             # 5 个测试页面
  unit/
  e2e/
```

## 15. 测试

- **单元（Vitest + jsdom）**：段落识别（嵌套块、行内、跳过规则）、编号解析、SSE 解析、token 估算、缓存 key、状态机转换。
- **集成（Playwright + `--load-extension`）**：5 个 fixture 页面（长文章、文档表格、SPA、代码密集、中英混排），配一个本地 mock OpenAI 服务（含 SSE 与错误注入）。
  - 断言：译文出现在原文下方、数量正确、还原后 DOM 与初始一致、断流后能恢复。
  - 注意：扩展在 old headless 下不可用；用 `headless: false` 或新版 headless。
- **手动**：3 个真实站点（一个新闻站、一个文档站、一个 SPA）。

## 16. 分期

**v1**：翻译主链路（含 MutationObserver 动态内容）+ 侧栏问答 + 设置页 + 缓存 + 重试。
**v1.1**：站点规则 UI、只翻当前视口、译文淡化/字号设置、整页上下文摘要。
**v2**：console 抓取（`chrome.debugger`，需单独评估与 DevTools 的冲突）、术语表、PDF、图片翻译。

## 17. 留给构建者的决定

- 具体 UI 视觉（配色、字号、侧栏布局）：按作者审美，不阻塞实现。
- 是否用 TypeScript 严格模式、构建工具选 Vite 还是 esbuild：按仓库现状，仓库为空则选 Vite + TS。
- 单元测试框架的具体配置。
- 缓存 DB 名称、字段名的细节。

## 18. 已决事项

作者授权按推荐决定，不再阻塞。

**发布形态：个人使用优先，但保持"随时能上商店"的结构。**

具体含义：

- 不装任何遥测、不上报 URL、不发分析请求（这条与发布无关，纯属产品立场）。
- 权限清单保持可解释：`<all_urls>` 有明确用途说明；`declarativeNetRequestWithHostAccess` 只用于本地模型的 Origin 规则。
- 预留 `_locales/` 目录，UI 文案走 i18n key，但 v1 只提供 `zh_CN` 和 `en` 两份。
- 设置页按"给别人用"的标准做错误引导（未配置 key、401、429、超时都有明确文案和跳转）。

若以后决定只给自己用，唯一需要删的是 i18n 和商店说明，不影响架构。

以下按默认决定写进文档：

- 目标语言：默认 `zh-CN`，设置页可选（§8.10）。
- 本地模型：v1 支持，保留 Ollama（11434）与 LM Studio（1234）的 DNR 规则（§10）。
- 划词气泡：保留"解释 / 追问"两个动作（§8.9）。
- 侧栏上下文范围：只读已翻译段落 + 选区 + 标题/URL，UI 明示（§8.9）。
- 请求归属：后台负责 provider、prompt、密钥、队列（方案 B，§6.1）。
