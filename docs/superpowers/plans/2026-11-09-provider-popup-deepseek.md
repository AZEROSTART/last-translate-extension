# 模型配置 popup + 原生 DeepSeek + 新图标 · 实施计划

- 日期：2026-11-09
- 设计源：`docs/superpowers/specs/2026-11-09-provider-popup-deepseek-design.md`（已批准）
- 目标：工具栏 popup 完成模型配置；新增 DeepSeek 预设；三界面量子青主题；X1 图标；保留现有 custom provider、翻译、侧栏聊天行为。
- 技术约束：MV3、TypeScript、原生 DOM、无框架、无远程代码、无内联脚本；所有用户可见文案中文；API Key 只存 `chrome.storage.local`，UI 只显示掩码。

## 执行约定

- 每个任务都先写失败测试，再实现，再跑该任务的测试和 `npx tsc --noEmit`，最后提交。
- 测试命令示例：`npx vitest run tests/unit/options-providers.test.ts`。
- 全量验证：`npm test`、`npx tsc --noEmit`、`npm run build`、`node scripts/check-build.mjs`。
- 不要改翻译提示词、队列、并发/重试、content script DOM 规则。
- 视觉任务只改 CSS/主题激活代码；侧栏除 thinking 开关外不改 DOM 结构和交互。
- 每个任务一个 commit；提交信息见各任务末尾。

---

## Task 0：提交已批准的设计文档和本计划

**文件**
- `docs/superpowers/specs/2026-11-09-provider-popup-deepseek-design.md`
- `docs/superpowers/plans/2026-11-09-provider-popup-deepseek.md`

**步骤**
1. 把设计文档第 4 行状态从 `待批准` 改为 `已批准`。
2. 运行：
   ```bash
   git add docs/superpowers/specs/2026-11-09-provider-popup-deepseek-design.md \
           docs/superpowers/plans/2026-11-09-provider-popup-deepseek.md
   git commit -m "docs: approve provider popup and DeepSeek design"
   ```

**验收**
- `git status` 中不再有这两个未跟踪文档。

---

## Task 1：Provider kind、DeepSeek 预设、存储归一化、校验

**目标**
- `ProviderConfig.kind` 从固定 `"custom"` 变为 `"custom" | "deepseek"`。
- 新增集中式 DeepSeek 预设模块。
- 旧数据缺失/未知 kind 读取时归一为 `"custom"`，已有 `"deepseek"` 保留。
- DeepSeek 校验只要求 API Key 和模型；custom 继续要求 baseURL、API Key、模型。

**文件**
- `src/shared/types.ts`
- `src/shared/providers.ts`（新建）
- `src/shared/storage.ts`
- `src/options/providers.ts`
- `tests/unit/options-providers.test.ts`
- `tests/unit/storage.test.ts`

### 1.1 先写失败测试

在 `tests/unit/options-providers.test.ts` 增加：

```ts
import { DEEPSEEK_PRESET } from "../../src/shared/providers";

it("exposes the DeepSeek preset values", () => {
  expect(DEEPSEEK_PRESET).toEqual({
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com",
    appendV1: false,
    defaultModel: "deepseek-flash",
    fallbackModels: ["deepseek-flash", "deepseek-v4-pro"],
  });
});

it("requires only apiKey and model for DeepSeek", () => {
  const deepseek: ProviderConfig = {
    ...base,
    kind: "deepseek",
    baseURL: "",
    apiKey: "",
    model: "",
  };
  expect(validateProvider(deepseek)).toEqual(["apiKey", "model"]);
  expect(validateProvider({ ...deepseek, apiKey: "k", model: "m" })).toEqual([]);
});
```

在 `tests/unit/storage.test.ts` 增加：

```ts
it("normalizes missing and unknown provider kinds to custom", async () => {
  await chrome.storage.local.set({
    settings: {
      ...DEFAULT_SETTINGS,
      providers: [
        { id: "a", name: "A", baseURL: "u", apiKey: "k", model: "m", createdAt: 1 },
        { id: "b", name: "B", kind: "legacy", baseURL: "u", apiKey: "k", model: "m", createdAt: 2 },
        { id: "c", name: "C", kind: "deepseek", baseURL: "https://api.deepseek.com", apiKey: "k", model: "deepseek-flash", createdAt: 3 },
      ],
    },
  });

  const s = await getSettings();
  expect(s.providers.map((p) => p.kind)).toEqual(["custom", "custom", "deepseek"]);
});
```

运行并确认失败：
```bash
npx vitest run tests/unit/options-providers.test.ts tests/unit/storage.test.ts
```

### 1.2 实现

`src/shared/types.ts`：

```ts
export type ProviderKind = "custom" | "deepseek";

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseURL: string;
  apiKey: string;
  model: string;
  appendV1?: boolean;
  extraHeaders?: Record<string, string>;
  overrides?: {
    concurrency?: number;
    maxRPS?: number;
    temperature?: number;
    systemPrompt?: string;
  };
  createdAt: number;
  lastUsedAt?: number;
}
```

新建 `src/shared/providers.ts`：

```ts
import type { ProviderKind } from "./types";

export const DEEPSEEK_PRESET = {
  name: "DeepSeek",
  baseURL: "https://api.deepseek.com",
  appendV1: false,
  defaultModel: "deepseek-flash",
  fallbackModels: ["deepseek-flash", "deepseek-v4-pro"],
} as const;

export const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
  deepseek: "DeepSeek",
  custom: "自定义 OpenAI 兼容",
};

/** Missing or unknown stored values are legacy custom providers. */
export function normalizeProviderKind(value: unknown): ProviderKind {
  return value === "deepseek" ? "deepseek" : "custom";
}
```

`src/shared/storage.ts` 在 `merged` 构造后、触发模式迁移前加入：

```ts
import { normalizeProviderKind } from "./providers";

// ...
merged.providers = merged.providers.map((provider) => ({
  ...provider,
  kind: normalizeProviderKind((provider as { kind?: unknown }).kind),
}));
```

`src/options/providers.ts` 的 `validateProvider`：

```ts
export function validateProvider(provider: ProviderConfig): string[] {
  const missing: string[] = [];
  if (provider.kind !== "deepseek" && !provider.baseURL.trim()) missing.push("baseURL");
  if (!provider.apiKey.trim()) missing.push("apiKey");
  if (!provider.model.trim()) missing.push("model");
  return missing;
}
```

### 1.3 验证

```bash
npx vitest run tests/unit/options-providers.test.ts tests/unit/storage.test.ts
npx tsc --noEmit
```

**提交**
```bash
git add src/shared/types.ts src/shared/providers.ts src/shared/storage.ts \
        src/options/providers.ts tests/unit/options-providers.test.ts tests/unit/storage.test.ts
git commit -m "feat: add provider kind and DeepSeek preset"
```

---

## Task 2：DeepSeek thinking 请求行为与聊天透传

**目标**
- DeepSeek 默认请求体带 `"thinking": { "type": "disabled" }`。
- `CompletionRequest.thinking === true` 时 DeepSeek 请求体省略 thinking 字段（使用 DeepSeek 默认 thinking）。
- custom provider 永不发送 thinking 字段。
- 侧栏聊天消息的 `thinking` 从 `ChatClientToBackground` 透传到 `runChat` → `streamCompletion`。
- 翻译和测试连接不传 `thinking`，因此 DeepSeek 默认关闭。

**文件**
- `src/providers/types.ts`
- `src/providers/openai.ts`
- `src/shared/types.ts`
- `src/background/dispatch.ts`
- `tests/unit/openai.test.ts`
- `tests/unit/dispatch.test.ts`

### 2.1 先写失败测试

在 `tests/unit/openai.test.ts` 的 `describe("complete")` 增加：

```ts
it("sends thinking disabled for DeepSeek by default", async () => {
  const fn = mockFetch(
    async () => new Response(JSON.stringify({ choices: [{ message: { content: "甲" } }] }), { status: 200 }),
  );
  const deepseek = {
    ...cfg,
    kind: "deepseek" as const,
    baseURL: "https://api.deepseek.com",
    appendV1: false,
  };
  await complete(deepseek, req());
  const body = JSON.parse(String((fn.mock.calls[0][1] as RequestInit).body));
  expect(body.thinking).toEqual({ type: "disabled" });
});

it("omits thinking for DeepSeek when thinking is explicitly enabled", async () => {
  const fn = mockFetch(
    async () => new Response(JSON.stringify({ choices: [{ message: { content: "甲" } }] }), { status: 200 }),
  );
  await complete(
    { ...cfg, kind: "deepseek", baseURL: "https://api.deepseek.com", appendV1: false },
    req({ thinking: true }),
  );
  const body = JSON.parse(String((fn.mock.calls[0][1] as RequestInit).body));
  expect(body).not.toHaveProperty("thinking");
});

it("never sends thinking for a custom provider", async () => {
  const fn = mockFetch(
    async () => new Response(JSON.stringify({ choices: [{ message: { content: "甲" } }] }), { status: 200 }),
  );
  await complete(cfg, req({ thinking: true }));
  const body = JSON.parse(String((fn.mock.calls[0][1] as RequestInit).body));
  expect(body).not.toHaveProperty("thinking");
});
```

在 `describe("listModels")` 增加：

```ts
it("uses the DeepSeek preset URL without /v1", async () => {
  const fn = mockFetch(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  await listModels({ ...cfg, kind: "deepseek", baseURL: "https://api.deepseek.com", appendV1: false });
  expect(fn.mock.calls[0][0]).toBe("https://api.deepseek.com/models");
});
```

在 `tests/unit/dispatch.test.ts` 增加两个测试（放在现有 chat 总超时测试附近）：

```ts
it("threads the chat thinking flag into the provider request", async () => {
  const chatStream = vi.fn<(cfg: ProviderConfig, req: CompletionRequest) => AsyncGenerator<string>>(
    async function* () {},
  );
  const { d, send } = deps({ adapter: fakeAdapter({ streamCompletion: chatStream }) });

  await handleChat(
    d,
    {
      type: "chat",
      requestId: "ct1",
      sessionId: "s1",
      messages: [{ role: "user", content: "你好" }],
      context: { pageUrl: "https://x", title: "T", quotes: [], recentParagraphs: [] },
      thinking: true,
    },
    send,
    1,
  );

  expect(chatStream.mock.calls[0][1].thinking).toBe(true);
});

it("leaves thinking unset for translation requests", async () => {
  const complete = vi.fn<(cfg: ProviderConfig, req: CompletionRequest) => Promise<CompletionResult>>(
    async () => ({ text: "[1] 甲\n[2] 乙" }),
  );
  const { d } = deps({ adapter: fakeAdapter({ complete }) });

  await handleTranslate(d, { type: "translate", requestId: "tt1", tabId: 1, items: items(2) }, () => {});
  expect(complete.mock.calls[0][1].thinking).toBeUndefined();
});
```

运行并确认失败：
```bash
npx vitest run tests/unit/openai.test.ts tests/unit/dispatch.test.ts
```

### 2.2 实现

`src/providers/types.ts` 的 `CompletionRequest` 增加：

```ts
/** DeepSeek only: true omits the thinking field, false/undefined disables it. */
thinking?: boolean;
```

`src/providers/openai.ts` 的 `buildBody`，在 `max_tokens` 之后加：

```ts
if (cfg.kind === "deepseek" && req.thinking !== true) {
  body.thinking = { type: "disabled" };
}
```

`src/shared/types.ts` 的 `ChatClientToBackground` 改为：

```ts
export type ChatClientToBackground =
  | {
      type: "chat";
      requestId: string;
      sessionId: string;
      messages: ChatMessage[];
      context: ChatContext;
      /** DeepSeek only; true omits the thinking field. */
      thinking?: boolean;
    }
  | { type: "abort"; requestId: string };
```

`src/background/dispatch.ts`：
- `handleChat` 的 enqueue 调用改为：
  ```ts
  run: (signal) =>
    runChat(deps, provider, messages, temperature, msg.thinking, requestId, signal, send),
  ```
- `runChat` 签名在 `temperature` 后增加 `thinking: boolean | undefined`，并在 `streamCompletion` 请求对象中增加 `thinking`：
  ```ts
  async function runChat(
    deps: Deps,
    provider: ProviderConfig,
    messages: ChatMessage[],
    temperature: number,
    thinking: boolean | undefined,
    requestId: string,
    signal: AbortSignal,
    send: (m: ChatBackgroundToClient) => void,
  ): Promise<void> {
    // ...
    deps.adapter.streamCompletion(provider, {
      messages,
      temperature,
      thinking,
      signal,
      totalTimeoutMs: null,
    })
  }
  ```
- 翻译的 `runGroup` 不传 thinking。

### 2.3 验证

```bash
npx vitest run tests/unit/openai.test.ts tests/unit/dispatch.test.ts
npx tsc --noEmit
```

**提交**
```bash
git add src/providers/types.ts src/providers/openai.ts src/shared/types.ts \
        src/background/dispatch.ts tests/unit/openai.test.ts tests/unit/dispatch.test.ts
git commit -m "feat: send DeepSeek thinking flag with chat"
```

---

## Task 3：Options 页类型选择与 DeepSeek 字段

**目标**
- options 新增配置默认类型仍是 custom。
- 新配置可在 DeepSeek / 自定义之间切换；编辑已保存配置时类型锁定并显示标签。
- 选择 DeepSeek 时自动填 `baseURL`、`appendV1: false`，隐藏名称、baseURL、`/v1` 字段。
- 选择自定义时恢复这些字段。
- 保存时 DeepSeek 使用预设 baseURL 和 `appendV1: false`；不会隐式改已有配置的 kind。
- `extraHeaders`、`overrides`、`createdAt`、`lastUsedAt` 保留。

**文件**
- `src/options/main.ts`
- `src/styles/options.css`
- `tests/unit/options-dom.test.ts`

### 3.1 先写失败测试

在 `tests/unit/options-dom.test.ts` 增加：

```ts
const deepseek: ProviderConfig = {
  id: "ds",
  name: "DeepSeek",
  kind: "deepseek",
  baseURL: "https://api.deepseek.com",
  apiKey: "sk-deepseek-1234",
  appendV1: false,
  model: "deepseek-flash",
  createdAt: 3,
};

it("defaults a new options provider to custom", async () => {
  await seed();
  await boot();
  click(".provider-add");
  expect((document.querySelector(".pf-kind") as HTMLSelectElement).value).toBe("custom");
  expect((document.querySelector(".pf-baseURL-field") as HTMLElement).hidden).toBe(false);
});

it("edits a DeepSeek provider with the type and preset locked", async () => {
  await seed({ providers: [deepseek], activeProviderId: deepseek.id });
  await boot();

  click(".provider-edit");
  expect(document.querySelector(".pf-kind")).toBeNull();
  expect(document.querySelector(".pf-kind-readonly")?.textContent).toBe("DeepSeek");
  expect((document.querySelector(".pf-baseURL-field") as HTMLElement).hidden).toBe(true);
  expect((document.querySelector(".pf-name-field") as HTMLElement).hidden).toBe(true);

  setValue(".pf-model", "deepseek-v4-pro");
  click(".pf-save");

  await vi.waitFor(async () => {
    const s = await getSettings();
    expect(s.providers[0]?.model).toBe("deepseek-v4-pro");
  });

  const saved = (await getSettings()).providers[0];
  expect(saved).toMatchObject({
    kind: "deepseek",
    baseURL: "https://api.deepseek.com",
    appendV1: false,
    name: "DeepSeek",
    apiKey: "sk-deepseek-1234",
  });
});

it("creates a DeepSeek provider from the type selector", async () => {
  await seed();
  await boot();

  click(".provider-add");
  const kind = document.querySelector(".pf-kind") as HTMLSelectElement;
  kind.value = "deepseek";
  kind.dispatchEvent(new Event("change"));

  expect((document.querySelector(".pf-baseURL-field") as HTMLElement).hidden).toBe(true);
  expect((document.querySelector(".pf-name-field") as HTMLElement).hidden).toBe(true);
  expect((document.querySelector(".pf-appendV1-row") as HTMLElement).hidden).toBe(true);

  setValue(".pf-apiKey", "sk-new-1234");
  setValue(".pf-model", "deepseek-flash");
  click(".pf-save");

  await vi.waitFor(async () => {
    const s = await getSettings();
    expect(s.providers).toHaveLength(1);
  });

  const saved = (await getSettings()).providers[0];
  expect(saved).toMatchObject({
    kind: "deepseek",
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com",
    appendV1: false,
    apiKey: "sk-new-1234",
    model: "deepseek-flash",
  });
});

it("reveals custom fields when switching back from DeepSeek", async () => {
  await seed();
  await boot();
  click(".provider-add");

  const kind = document.querySelector(".pf-kind") as HTMLSelectElement;
  kind.value = "deepseek";
  kind.dispatchEvent(new Event("change"));
  kind.value = "custom";
  kind.dispatchEvent(new Event("change"));

  expect((document.querySelector(".pf-baseURL-field") as HTMLElement).hidden).toBe(false);
  expect((document.querySelector(".pf-name-field") as HTMLElement).hidden).toBe(false);
  expect((document.querySelector(".pf-baseURL") as HTMLInputElement).value).toBe("https://api.openai.com");
  expect((document.querySelector(".pf-appendV1") as HTMLInputElement).checked).toBe(true);
});
```

运行并确认失败：
```bash
npx vitest run tests/unit/options-dom.test.ts
```

### 3.2 实现

`src/options/main.ts`：

1. 导入：
   ```ts
   import { DEEPSEEK_PRESET, PROVIDER_KIND_LABELS } from "../shared/providers";
   import type { ErrorCode, ProviderConfig, ProviderKind, Settings } from "../shared/types";
   ```
2. `ProviderFormControls` 增加：
   ```ts
   kind: HTMLSelectElement | null;
   nameField: HTMLElement;
   baseURLField: HTMLElement;
   appendV1Row: HTMLElement;
   ```
3. `openForm` 在名称字段之前插入类型字段。先在分支外声明：
   ```ts
   let kindSelect: HTMLSelectElement | null = null;
   ```
   - 编辑已有 provider：
     ```ts
     const kindLabel = el("div", "pf-kind-readonly", PROVIDER_KIND_LABELS[base.kind]);
     kindLabel.dataset.kind = base.kind;
     form.appendChild(field("类型", kindLabel));
     ```
   - 新增：
     ```ts
     kindSelect = el("select", "pf-kind");
     const customOption = el("option", undefined, PROVIDER_KIND_LABELS.custom);
     customOption.value = "custom";
     const deepseekOption = el("option", undefined, PROVIDER_KIND_LABELS.deepseek);
     deepseekOption.value = "deepseek";
     kindSelect.append(customOption, deepseekOption);
     kindSelect.value = base.kind; // 新增时 base.kind 仍是 custom
     form.appendChild(field("类型", kindSelect));
     ```
   - `base` 新增分支保持 `kind: "custom"`，名称保持 `自定义 N`，baseURL 保持 `https://api.openai.com`。
4. 给名称字段和 baseURL 字段加稳定 class：
   ```ts
   const nameField = field("名称", nameInput);
   nameField.classList.add("pf-name-field");
   form.appendChild(nameField);

   const baseURLField = field("接口地址", baseURLInput, "可省略 /v1，发送请求时会按需自动补全。");
   baseURLField.classList.add("pf-baseURL-field");
   form.appendChild(baseURLField);
   ```
   `appendV1Row` 已有 `pf-appendV1-row` class。
5. 增加同步函数并在 `currentForm` 赋值前调用：
   ```ts
   const syncKindFields = (): void => {
     const kind: ProviderKind = kindSelect?.value === "deepseek" ? "deepseek" : base.kind;
     const isDeepSeek = kind === "deepseek";

     nameField.hidden = isDeepSeek;
     baseURLField.hidden = isDeepSeek;
     appendV1Row.hidden = isDeepSeek;

     if (isDeepSeek) {
       baseURLInput.value = DEEPSEEK_PRESET.baseURL;
       appendV1Input.checked = false;
       if (!provider && (nameInput.value.trim() === "" || nameInput.value.startsWith("自定义 "))) {
         nameInput.value = DEEPSEEK_PRESET.name;
       }
       return;
     }

     if (!provider && nameInput.value === DEEPSEEK_PRESET.name) {
       nameInput.value = `自定义 ${settings!.providers.length + 1}`;
     }
     if (!provider && baseURLInput.value === DEEPSEEK_PRESET.baseURL) {
       baseURLInput.value = "https://api.openai.com";
     }
     if (!provider) {
       appendV1Input.checked = true;
     }
   };

   kindSelect?.addEventListener("change", syncKindFields);
   syncKindFields();
   ```
6. `controls` 增加 `kind: kindSelect, nameField, baseURLField, appendV1Row`。
7. `readForm` 改为：
   ```ts
   const kind: ProviderKind =
     controls.kind?.value === "deepseek" ? "deepseek" : controls.base.kind;
   const isDeepSeek = kind === "deepseek";
   // ...
   return {
     id: controls.base.id,
     name: controls.name.value.trim() || (isDeepSeek ? DEEPSEEK_PRESET.name : controls.base.name),
     kind,
     baseURL: isDeepSeek ? DEEPSEEK_PRESET.baseURL : controls.baseURL.value.trim(),
     appendV1: isDeepSeek ? false : controls.appendV1.checked ? undefined : false,
     apiKey: typedKey === "" ? controls.base.apiKey : typedKey,
     model: controls.model.value.trim(),
     extraHeaders: headerCount > 0 ? headers : undefined,
     overrides: {
       concurrency: numericOrBlank(controls.concurrency.value),
       maxRPS: numericOrBlank(controls.maxRPS.value),
       temperature: numericOrBlank(controls.temperature.value),
       systemPrompt: controls.systemPrompt.value,
     },
     createdAt: controls.base.createdAt,
     lastUsedAt: controls.base.lastUsedAt,
   };
   ```
8. 字段错误显示仍用 `fieldInputs`；DeepSeek 的 baseURL 错误不会出现，因为校验跳过。
9. `src/styles/options.css` 增加显式隐藏规则，因为 `.field` / `.checkbox-row` 的 `display` 会覆盖浏览器默认的 `[hidden]`：
   ```css
   .field[hidden],
   .checkbox-row[hidden] {
     display: none;
   }
   ```

### 3.3 验证

```bash
npx vitest run tests/unit/options-dom.test.ts
npx vitest run tests/unit/options-providers.test.ts
npx tsc --noEmit
```

**提交**
```bash
git add src/options/main.ts src/styles/options.css tests/unit/options-dom.test.ts
git commit -m "feat: add DeepSeek type selector to options"
```

---

## Task 4：量子青 token 层与 options / 侧栏主题

**目标**
- 新建共享主题 token 文件。
- options 和侧栏在启动时设置 `document.documentElement.dataset.theme = "quantum"`，并先注入主题 CSS。
- options 现有布局和 class 不变，只替换深色分支为 C 主题。
- 侧栏只改 CSS，不改 DOM。
- `prefers-reduced-motion` 下关闭动画。
- 聚焦环、输入框、select、滚动条保持深色可读。

**文件**
- `src/styles/theme.css`（新建）
- `src/styles/options.css`
- `src/styles/panel.css`
- `src/options/main.ts`
- `src/panel/main.ts`
- `tests/unit/theme.test.ts`（新建）
- `tests/unit/options-dom.test.ts`
- `tests/unit/panel-dom.test.ts`

### 4.1 先写失败测试

新建 `tests/unit/theme.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import themeCss from "../../src/styles/theme.css?inline";

describe("quantum theme", () => {
  it("defines the C palette tokens", () => {
    for (const token of [
      "--ilmt-bg",
      "--ilmt-panel",
      "--ilmt-panel-2",
      "--ilmt-glass",
      "--ilmt-accent",
      "--ilmt-accent-2",
      "--ilmt-text",
      "--ilmt-muted",
      "--ilmt-border",
      "--ilmt-border-soft",
      "--ilmt-input",
    ]) {
      expect(themeCss).toContain(token);
    }
    expect(themeCss).toContain("#04060c");
    expect(themeCss).toContain("#2dd4bf");
    expect(themeCss).toContain("#67e8f9");
    expect(themeCss).toContain("#dffcf7");
  });

  it("disables motion under prefers-reduced-motion", () => {
    expect(themeCss).toContain("prefers-reduced-motion: reduce");
  });
});
```

在 `tests/unit/options-dom.test.ts` 增加：

```ts
it("activates the quantum teal theme", async () => {
  await seed();
  await boot();
  expect(document.documentElement.dataset.theme).toBe("quantum");
});
```

在 `tests/unit/panel-dom.test.ts` 增加：

```ts
it("activates the quantum teal theme", async () => {
  installChrome();
  await boot();
  expect(document.documentElement.dataset.theme).toBe("quantum");
});
```

在 options / panel 测试的 `afterEach` 增加 `delete document.documentElement.dataset.theme;`。

运行并确认失败：
```bash
npx vitest run tests/unit/theme.test.ts tests/unit/options-dom.test.ts tests/unit/panel-dom.test.ts
```

### 4.2 实现主题 token

新建 `src/styles/theme.css`：

```css
:root[data-theme="quantum"] {
  color-scheme: dark;
  --ilmt-bg: #04060c;
  --ilmt-panel: #061513;
  --ilmt-panel-2: #071615;
  --ilmt-glass: rgba(7, 22, 21, 0.92);
  --ilmt-accent: #2dd4bf;
  --ilmt-accent-2: #67e8f9;
  --ilmt-text: #dffcf7;
  --ilmt-muted: #6e9f99;
  --ilmt-border: rgba(45, 212, 191, 0.3);
  --ilmt-border-soft: rgba(45, 212, 191, 0.18);
  --ilmt-input: rgba(4, 14, 14, 0.8);
  --ilmt-danger: #fb7185;
  --ilmt-success: #5eead4;
  --ilmt-glow: 0 0 18px rgba(45, 212, 191, 0.35);
  --ilmt-radius: 10px;
  --ilmt-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}

:root[data-theme="quantum"] body {
  background: var(--ilmt-bg);
  color: var(--ilmt-text);
}

:root[data-theme="quantum"] ::selection {
  background: var(--ilmt-accent);
  color: #04100f;
}

@media (prefers-reduced-motion: reduce) {
  :root[data-theme="quantum"] *,
  :root[data-theme="quantum"] *::before,
  :root[data-theme="quantum"] *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

### 4.3 接入 options

`src/options/main.ts`：
- 导入：
  ```ts
  import themeCss from "../styles/theme.css?inline";
  ```
- `start()` 开头设置：
  ```ts
  document.documentElement.dataset.theme = "quantum";
  ```
- `injectStyles()` 改为：
  ```ts
  style.textContent = themeCss + cssText;
  ```

`src/styles/options.css`：
- 删除文件末尾的 `@media (prefers-color-scheme: dark) { ... }` 块（第 411–463 行）。
- 在其位置追加 C 主题覆盖块。至少覆盖以下选择器：
  `body`、`.card`、`.provider-card`、`.provider-form`、`.empty`、`button`、`.provider-add` / `.pf-save` / `.global-save` / `.pf-test-connection`、`.provider-delete` / `.pf-header-remove`、`input[type="text"]` / `input[type="password"]` / `input[type="number"]` / `select` / `textarea`、`.field-group`、`.page-subtitle`、`.meta-label`、`.field-hint`、`.provider-overrides`、`.badge`、`.success` / `.pf-models-status.success`、`.error` / `.pf-models-status.error`、`.field-error`、`.pf-kind-readonly`。
- 关键值：
  - 页面底 `var(--ilmt-bg)`，卡片 `var(--ilmt-panel)`，表单 `var(--ilmt-glass)`。
  - 主按钮 `linear-gradient(135deg, var(--ilmt-accent), var(--ilmt-accent-2))` + `#04100f` 文字。
  - 次按钮透明深青底 + `var(--ilmt-border)` 边框 + `var(--ilmt-text)` 文字。
  - 输入框 `var(--ilmt-input)` 底 + `var(--ilmt-border-soft)` 边框 + `var(--ilmt-text)` 文字。
  - focus visible `outline: 2px solid var(--ilmt-accent); outline-offset: 2px;`。
  - `.card` 使用细点阵背景：
    ```css
    background:
      radial-gradient(circle at 1px 1px, rgba(103, 232, 249, 0.1) 1px, transparent 0) 0 0 / 18px 18px,
      linear-gradient(160deg, rgba(7, 22, 21, 0.98), rgba(4, 10, 12, 0.98));
    ```
  - `.pf-kind-readonly` 使用 `var(--ilmt-border-soft)` 边框、`var(--ilmt-muted)` 文字、等宽字体。
- 保留上述之外的所有布局规则。

### 4.4 接入侧栏

`src/panel/main.ts`：
- 导入 `themeCss from "../styles/theme.css?inline"`。
- `start()` 开头设置 `document.documentElement.dataset.theme = "quantum";`。
- `injectStyles()` 的 `style.textContent = themeCss + cssText;`。

`src/styles/panel.css`：
- 直接把颜色替换为 token（保留布局、尺寸、选择器）：
  - `#root` 背景：深青渐变 + 点阵，文字 `var(--ilmt-text)`。
  - `.context-note`：`var(--ilmt-panel-2)` 底，`var(--ilmt-muted)` 文字。
  - `.provider-bar`：`var(--ilmt-border-soft)` 下边框。
  - `.provider-select`：`var(--ilmt-input)` 底，`var(--ilmt-border-soft)` 边框，`var(--ilmt-text)` 文字。
  - `.provider-model`、`.quote-chip-remove`：`var(--ilmt-muted)`。
  - `.provider-settings`：`var(--ilmt-accent-2)`。
  - `.banner`：`var(--ilmt-border)` 边框，`rgba(45, 212, 191, 0.08)` 底，`var(--ilmt-accent-2)` 文字。
  - `.banner button`：主按钮渐变 + `#04100f` 文字。
  - `.quote-chip`：`3px solid var(--ilmt-accent)` 左边框，`rgba(45, 212, 191, 0.06)` 底。
  - `.msg--user`：主按钮渐变 + `#04100f` 文字。
  - `.msg--assistant`：`var(--ilmt-panel-2)` 底 + `var(--ilmt-border-soft)` 边框。
  - `.error-block`：`rgba(251, 113, 133, 0.1)` 底，`var(--ilmt-danger)` 文字；按钮 `var(--ilmt-danger)` 底 + `#1b0509` 文字。
  - `.composer-input`：`var(--ilmt-input)` 底，`var(--ilmt-border-soft)` 边框，`var(--ilmt-text)` 文字。
  - `.composer-send`：主按钮渐变 + `#04100f` 文字。
  - `.composer-stop`：`var(--ilmt-danger)` 底 + `#1b0509` 文字。
  - `select`/`input`/`textarea`/`button` 的 `focus-visible`：`outline: 2px solid var(--ilmt-accent); outline-offset: 2px;`。
  - `scrollbar-color: var(--ilmt-border) var(--ilmt-bg);`。
- 不改任何布局属性（`display`、`flex`、`height`、`padding` 等除外仅可微调颜色相关值）。

### 4.5 验证

```bash
npx vitest run tests/unit/theme.test.ts tests/unit/options-dom.test.ts tests/unit/panel-dom.test.ts
npx tsc --noEmit
```

**提交**
```bash
git add src/styles/theme.css src/styles/options.css src/styles/panel.css \
        src/options/main.ts src/panel/main.ts tests/unit/theme.test.ts \
        tests/unit/options-dom.test.ts tests/unit/panel-dom.test.ts
git commit -m "style: apply quantum teal theme to options and panel"
```

---

## Task 5：Popup 模型配置 UI

**目标**
- 新建 `src/popup/index.html`、`src/popup/main.ts`、`src/styles/popup.css`。
- popup 无 provider 时默认展示 DeepSeek 表单；有 provider 时默认加载 active provider（无 active 则第一个）。
- 支持新增/选择 provider、类型切换（新配置默认 DeepSeek）、保存、设为当前、拉取模型、测试连接。
- 编辑已有 provider 时留空 API Key 保留原值；`extraHeaders`、`overrides`、`createdAt`、`lastUsedAt` 原样保留。
- 打开 popup 不发网络请求；只有点「拉取模型」才调用 `listModels`。
- 本任务先完成配置 UI 和 jsdom 测试；工具栏入口在 Task 6 接线。

**文件**
- `src/popup/index.html`（新建）
- `src/popup/main.ts`（新建）
- `src/styles/popup.css`（新建）
- `tests/unit/popup-dom.test.ts`（新建）

### 5.1 DOM 契约

`src/popup/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>翻译设置</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

`src/popup/main.ts` 暴露测试钩子：

```ts
const scope = globalThis as typeof globalThis & {
  __ilmtPopup?: {
    ready: Promise<void>;
    get settings(): Settings | null;
  };
};
```

启动方式与 options/panel 一致：`export function runPopup()`, `void runPopup();`。

必须使用以下 class / selector：

- 顶部：`.popup-header`、`.popup-title`、`.popup-logo`、`.popup-open-options`（「高级设置」）。
- provider 选择：`.popup-provider-select`、`.popup-add`、`.popup-set-active`。
- 表单：`.popup-form`、`.popup-kind`（新增时）、`.popup-kind-readonly`（已有 provider）、`.popup-name`、`.popup-baseURL`、`.popup-appendV1`、`.popup-apiKey`、`.popup-model`、`.popup-model-options`（datalist）、`.popup-fetch-models`、`.popup-test`、`.popup-save`。
- 状态：`.popup-models-status`、`.popup-test-result`、`.popup-form-message`、`.popup-save-status`。
- 底部：`.popup-open-sidepanel`、`.popup-hint`。

字段显示规则：
- 新增且 kind 为 `deepseek`：不渲染 `.popup-name`、`.popup-baseURL`、`.popup-appendV1`；名称固定 `DeepSeek`，baseURL 固定预设，appendV1 固定 false。
- 新增且 kind 为 `custom`：渲染名称、baseURL、`/v1`、API Key、模型。
- 已有 provider：`.popup-kind-readonly` 显示 `PROVIDER_KIND_LABELS[provider.kind]`；DeepSeek 不渲染名称/baseURL/`/v1`，custom 渲染。
- 新增 DeepSeek 的模型输入默认 `deepseek-flash`；datalist 预置 `fallbackModels`。
- API Key 输入：已有 provider 时 `value=""`，placeholder 为 `已保存（${maskKey(key)}），留空表示不修改`。

### 5.2 先写失败测试

新建 `tests/unit/popup-dom.test.ts`，结构参考 `tests/unit/options-dom.test.ts` 与 `tests/unit/panel-dom.test.ts`：

```ts
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { ProviderConfig, Settings } from "../../src/shared/types";
import { DEFAULT_SETTINGS, getSettings } from "../../src/shared/storage";
import { ProviderError } from "../../src/shared/errors";
import { DEEPSEEK_PRESET } from "../../src/shared/providers";

vi.mock("../../src/providers", () => ({
  listModels: vi.fn(),
  complete: vi.fn(),
}));

interface ProvidersMock {
  listModels: Mock;
  complete: Mock;
}
```

测试 chrome 面需要：
- `chrome.storage.local`（可复用全局 setup 的 storage；每个用例前 clear）。
- `chrome.runtime.getURL`、`chrome.runtime.openOptionsPage`（Task 6 用）。
- `chrome.sidePanel.open`（Task 6 用）。
- `chrome.windows.WINDOW_ID_CURRENT = -2`（Task 6 用）。
- `chrome.tabs.query` / `chrome.tabs.create`（Task 6 用）。
- `window.close` 用 `vi.spyOn(window, "close").mockImplementation(() => {})`。
- `installChrome()` 返回 `{ sidePanelOpen, tabsQuery, openOptionsPage, tabsCreate }`，供 Task 6 的测试直接使用。
- 增加 `flush` 辅助函数：
  ```ts
  const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  ```

`beforeEach`：
```ts
vi.resetModules();
vi.clearAllMocks();
document.body.innerHTML = `<div id="root"></div>`;
delete (globalThis as any).__ilmtPopup;
await chrome.storage.local.clear();
```

`afterEach` 删除 `__ilmtPopup`、`document.documentElement.dataset.theme`，移除 `style[data-ilmt-popup]`，恢复 `window.close`。

`boot()`：
```ts
async function boot(): Promise<ProvidersMock> {
  const providers = (await import("../../src/providers")) as unknown as ProvidersMock;
  await import("../../src/popup/main");
  await (globalThis as any).__ilmtPopup.ready;
  return providers;
}
```

测试用例（名称和关键断言）：

1. `it("opens with the DeepSeek form when there are no providers")`
   - seed empty；boot。
   - `.popup-kind` 存在且 value 为 `deepseek`。
   - `.popup-model` value 为 `deepseek-flash`。
   - `.popup-name`、`.popup-baseURL`、`.popup-appendV1` 均为 `null`。
   - `.popup-apiKey` 存在。
   - `document.documentElement.dataset.theme === "quantum"`。

2. `it("shows custom fields after choosing the custom type")`
   - seed empty；boot；把 `.popup-kind` 设为 `custom` 并 dispatch `change`。
   - `.popup-name`、`.popup-baseURL`、`.popup-appendV1` 存在。
   - `.popup-baseURL` value 为 `https://api.openai.com`，`.popup-appendV1` checked 为 true。

3. `it("saves a DeepSeek provider with the preset and makes it active")`
   - seed empty；boot；set `.popup-apiKey` = `sk-ds-1234`，`.popup-model` = `deepseek-v4-pro`；click `.popup-save`。
   - `await vi.waitFor(async () => { const s = await getSettings(); expect(s.providers).toHaveLength(1); })`。
   - 断言 provider `{ kind:"deepseek", name:"DeepSeek", baseURL:DEEPSEEK_PRESET.baseURL, appendV1:false, apiKey:"sk-ds-1234", model:"deepseek-v4-pro" }`。
   - `s.activeProviderId === s.providers[0].id`。
   - `.popup-save-status` text 为 `已保存`。

4. `it("loads an existing provider, masks the key, and preserves hidden fields")`
   - seed 一个 custom provider：`extraHeaders: { "X-Token": "{{apiKey}}" }`、`overrides: { concurrency: 2 }`、key `sk-old-1234`。
   - boot；`.popup-apiKey.value === ""`，placeholder 包含 `已保存（` 和 `****`，且不包含完整 key。
   - 改 `.popup-model` 为 `m2`，click `.popup-save`；等待保存。
   - 断言 `kind:"custom"`、`apiKey:"sk-old-1234"`、`baseURL` 不变、`extraHeaders` 和 `overrides` 保留、model 为 `m2`。

5. `it("edits an existing DeepSeek provider without exposing or replacing the key")`
   - seed DeepSeek provider；boot；无 `.popup-baseURL`、`.popup-name`。
   - 留空 Key，改 model，save；断言 kind/baseURL/appendV1/key 不变。

6. `it("fetches models on demand and fills the datalist")`
   - `providers.listModels.mockResolvedValue([{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }, { id: "deepseek-extra" }])`。
   - seed empty；boot；click `.popup-fetch-models`；等待 `.popup-models-status` 为 `已获取 3 个模型`。
   - `.popup-model-options option` 的 value 包含 `deepseek-extra`。

7. `it("keeps the DeepSeek fallback and allows manual save when fetching fails")`
   - `providers.listModels.mockRejectedValue(new Error("boom"))`。
   - boot；click fetch；等待 `拉取失败，可直接手填`。
   - `.popup-model-options option` 仍包含 `deepseek-flash` 和 `deepseek-v4-pro`。
   - 填 Key/model 后 save 仍成功。

8. `it("tests the connection without leaking the key")`
   - `providers.complete.mockResolvedValue({ text: "ok" })`；填 Key；click `.popup-test`；等待 `/^连接成功（\d+ ms）$/`；`document.body.textContent` 不含 Key。
   - `providers.complete.mockRejectedValue(new ProviderError("auth", "bad sk-ds-1234"))`；再次 click；等待 `连接失败：认证失败`；不含 Key。

9. `it("sets a non-active provider as current")`
   - seed 两个 custom provider，active 为第一个；boot；把 `.popup-provider-select` 设为第二个 id 并 dispatch `change`；click `.popup-set-active`；等待 storage 的 `activeProviderId` 变为第二个 id。

10. `it("activates the quantum teal theme")`
    - boot；`document.documentElement.dataset.theme === "quantum"`。

运行并确认失败：
```bash
npx vitest run tests/unit/popup-dom.test.ts
```

### 5.3 实现

`src/popup/main.ts` 结构：
- 导入：
  ```ts
  import { getSettings, saveSettings, upsertProvider } from "../shared/storage";
  import type { ProviderConfig, ProviderKind, Settings } from "../shared/types";
  import { complete, listModels } from "../providers";
  import { DEEPSEEK_PRESET, PROVIDER_KIND_LABELS } from "../shared/providers";
  import {
    applyProviderForm,
    errorLabel,
    maskKey,
    validateProvider,
    type ProviderFormState,
  } from "../options/providers";
  import { ProviderError } from "../shared/errors";
  import themeCss from "../styles/theme.css?inline";
  import cssText from "../styles/popup.css?inline";
  ```
- 状态：
  ```ts
  let settings: Settings | null = null;
  let current: ProviderConfig | null = null; // 已保存 provider；null = 新增草稿
  let isNew = false;
  let draft: ProviderFormState; // 新增草稿；kind 默认 deepseek
  let started = false;
  ```
- `start()`：
  1. `document.documentElement.dataset.theme = "quantum";`
  2. `settings = await getSettings()`（失败则 `settings = null`，显示读取失败，不禁用表单）。
  3. `buildShell()`、`injectStyles()`。
  4. 选择初始 provider：有 provider 时取 active 或第一个；没有时 `isNew=true`，`draft` 为 DeepSeek 草稿。
  5. `render()`，`resolveReady()`。
- `newDeepSeekDraft()`：
  ```ts
  {
    id: newProviderId(),
    name: DEEPSEEK_PRESET.name,
    kind: "deepseek",
    baseURL: DEEPSEEK_PRESET.baseURL,
    appendV1: false,
    apiKey: "",
    model: DEEPSEEK_PRESET.defaultModel,
    createdAt: Date.now(),
  }
  ```
- `newCustomDraft()`：
  ```ts
  {
    ...newDeepSeekDraft(),
    name: `自定义 ${(settings?.providers.length ?? 0) + 1}`,
    kind: "custom",
    baseURL: "https://api.openai.com",
    appendV1: undefined,
    model: "",
  }
  ```
  注意运算符优先级：`${(settings?.providers.length ?? 0) + 1}`。
- `render()`：
  - 更新 `.popup-provider-select` options：`textContent = provider.name + (active ? "（当前）" : "")`，value id。无 provider 时隐藏 select，显示 `新增`。
  - `renderForm()` 重建表单。
- `renderForm()`：
  - 基础值：`const base = isNew ? draft : current!;`
  - kind：`const kind = base.kind;`
  - 顶部类型：
    - 新增：`<select class="popup-kind">`，选项 DeepSeek / 自定义；change 时读取当前可见值，切 kind，更新 `draft.kind/name/baseURL/appendV1`，重新 renderForm。
    - 已有：`<div class="popup-kind-readonly">${PROVIDER_KIND_LABELS[kind]}</div>`。
  - 字段：
    - custom：名称、baseURL、`/v1` 复选框。
    - DeepSeek：不渲染名称/baseURL/`/v1`。
    - 始终：API Key、模型（input + datalist + 拉取按钮）。
  - DeepSeek 的模型 datalist 预置 `fallbackModels`；custom 空。
  - 表单底部：`.popup-form-message`、`.popup-models-status`、`.popup-test-result`、`.popup-save-status`、保存/测试按钮。
  - 非 active 的已保存 provider：`.popup-set-active` 按钮。
  - 恢复输入值：新增时取 `draft`；已有取 `current`，但 API Key 输入始终空，placeholder 带掩码。
- `readPatch()`：
  - `kind = kindSelect?.value === "deepseek" ? "deepseek" : base.kind`
  - custom：name/baseURL/appendV1 从输入读；DeepSeek：name `DEEPSEEK_PRESET.name`、baseURL 预设、appendV1 false。
  - API Key：`typed === "" ? base.apiKey : typed`。
  - model：trim。
  - 返回 `Partial<ProviderFormState>`。
- `buildConfig()`：
  ```ts
  const base: ProviderFormState = isNew ? draft : current!;
  return applyProviderForm(base, readPatch());
  ```
- `save()`：
  - `const cfg = buildConfig(); const errors = validateProvider(cfg);`
  - 有错误：`.popup-form-message` 显示 `FIELD_ERROR_LABELS[errors[0]] ?? "请检查填写内容"`，不写 storage。
  - `await upsertProvider(cfg); settings = await getSettings();`
  - `current = settings.providers.find(p => p.id === cfg.id) ?? cfg; isNew = false;`
  - `render();` 显示 `.popup-save-status` = `已保存`。
- `fetchModels()`：
  - `const cfg = buildConfig();`
  - 禁用按钮，文字 `拉取中…`；状态清空。
  - `const models = await listModels(cfg);`
  - 成功：datalist 替换为返回 id；状态 `已获取 ${models.length} 个模型`，class success。
  - 失败：状态 `拉取失败，可直接手填`，class error；DeepSeek 保持 fallback datalist。
  - 不阻塞后续保存。
- `testConnection()`：
  - `const cfg = buildConfig();`
  - `const startedAt = performance.now();`
  - `await complete(cfg, { messages: [{ role:"user", content:"ping" }], maxTokens: 1 });`
  - 成功：`连接成功（${Math.max(0, Math.round(performance.now() - startedAt))} ms）`，class success。
  - `catch (error)`：`error instanceof ProviderError ? errorLabel(error.code) : "未知错误"`；文字 `连接失败：...`，class error。绝不拼接原始 message。
- `setActive()`：
  - 仅当 `current && settings`；`await saveSettings({ ...settings, activeProviderId: current.id }); settings = await getSettings(); render();`
- 新增按钮：`current=null; isNew=true; draft = newDeepSeekDraft(); render();`
- provider select change：`current = settings.providers.find(...)`; `isNew=false`; `render();`
- 主题注入：
  ```ts
  function injectStyles(): void {
    if (document.querySelector("style[data-ilmt-popup]")) return;
    const style = document.createElement("style");
    style.setAttribute("data-ilmt-popup", "");
    style.textContent = themeCss + cssText;
    (document.head ?? document.documentElement).appendChild(style);
  }
  ```
- 所有错误提示中文；API Key 只出现在输入框和 storage，不进入状态文本。

`src/styles/popup.css`：
- 固定宽度约 400px；`#root` 最小高度 420px、最大高度 600px、内部滚动。
- 使用 Task 4 的 token；深青玻璃面板、点阵背景、HUD 边角（`.popup-form::before/::after` 画两个角）。
- 主按钮渐变；次按钮透明深青 + 青色边框；focus ring 用 `var(--ilmt-accent)`。
- `.popup-open-sidepanel` 为主按钮；`.popup-open-options` 为文字按钮；`.popup-hint` 显示 `Alt+S`。
- 动态 class `.success` / `.error` 用 `var(--ilmt-success)` / `var(--ilmt-danger)`。

### 5.4 验证

```bash
npx vitest run tests/unit/popup-dom.test.ts
npx tsc --noEmit
```

**提交**
```bash
git add src/popup/index.html src/popup/main.ts src/styles/popup.css tests/unit/popup-dom.test.ts
git commit -m "feat: add toolbar popup model configuration"
```

---

## Task 6：Popup 打开侧栏 / 高级设置 + 工具栏接线

**目标**
- popup「打开侧栏」在用户手势内调用 `chrome.sidePanel.open`，成功后 `window.close()`。
- 优先 `{ windowId: chrome.windows.WINDOW_ID_CURRENT }`；失败回退到当前 tab `{ tabId }`。
- 「高级设置」调用 `chrome.runtime.openOptionsPage()`；失败回退 `chrome.tabs.create({ url: chrome.runtime.getURL("options.html") })`。
- manifest `action.default_popup = "popup.html"`、`default_title = "翻译设置"`。
- 删除背景的 `setPanelBehavior({ openPanelOnActionClick: true })`。
- Vite 增加 popup 入口；check-build 校验 popup。
- `Alt+S`、`open-chat`、现有侧栏打开路径保持不变。

**文件**
- `src/popup/main.ts`
- `public/manifest.json`
- `src/background/index.ts`
- `vite.config.ts`
- `scripts/check-build.mjs`
- `tests/unit/popup-dom.test.ts`
- `tests/unit/background-index.test.ts`
- `tests/unit/build.test.ts`

### 6.1 先写失败测试

在 `tests/unit/popup-dom.test.ts` 增加：

```ts
it("opens the side panel in the current window and closes the popup", async () => {
  const { sidePanelOpen } = installChrome();
  sidePanelOpen.mockResolvedValue(undefined);
  await boot();

  (document.querySelector(".popup-open-sidepanel") as HTMLButtonElement).click();
  await flush();

  expect(sidePanelOpen).toHaveBeenCalledWith({ windowId: -2 });
  expect(window.close).toHaveBeenCalled();
});

it("falls back to the active tab when opening the side panel by window fails", async () => {
  const { sidePanelOpen, tabsQuery } = installChrome();
  sidePanelOpen
    .mockRejectedValueOnce(new Error("no window"))
    .mockResolvedValueOnce(undefined);
  tabsQuery.mockResolvedValue([{ id: 7 }]);
  await boot();

  (document.querySelector(".popup-open-sidepanel") as HTMLButtonElement).click();
  await flush();

  expect(sidePanelOpen).toHaveBeenNthCalledWith(1, { windowId: -2 });
  expect(sidePanelOpen).toHaveBeenNthCalledWith(2, { tabId: 7 });
  expect(window.close).toHaveBeenCalled();
});

it("opens the options page and falls back to a tab", async () => {
  const { openOptionsPage, tabsCreate } = installChrome();
  openOptionsPage.mockResolvedValue(undefined);
  await boot();

  (document.querySelector(".popup-open-options") as HTMLButtonElement).click();
  await flush();
  expect(openOptionsPage).toHaveBeenCalled();

  openOptionsPage.mockRejectedValue(new Error("no options page"));
  (document.querySelector(".popup-open-options") as HTMLButtonElement).click();
  await flush();
  expect(tabsCreate).toHaveBeenCalledWith({
    url: "chrome-extension://test-extension-id/options.html",
  });
});
```

`installChrome` 需要返回 `sidePanelOpen`、`tabsQuery`、`openOptionsPage`、`tabsCreate`；`chrome.windows.WINDOW_ID_CURRENT = -2`；`window.close` spy。

在 `tests/unit/background-index.test.ts` 把原来的 `setPanelBehavior` 期望改为：

```ts
it("does not install openPanelOnActionClick because the popup owns action clicks", () => {
  const { setPanelBehavior } = installChrome();
  void import("../../src/background/index");
  expect(setPanelBehavior).not.toHaveBeenCalled();
});
```

在 `tests/unit/build.test.ts`：
- `emits every entry file` 列表加入 `"popup.html"`。
- 增加：

```ts
it("wires the toolbar popup", () => {
  const m = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
  expect(m.action.default_popup).toBe("popup.html");
  expect(m.action.default_title).toBe("翻译设置");
  expect(existsSync("dist/popup.html")).toBe(true);
});
```

运行并确认失败：
```bash
npx vitest run tests/unit/popup-dom.test.ts tests/unit/background-index.test.ts tests/unit/build.test.ts
```

### 6.2 实现 popup 动作

`src/popup/main.ts`：

```ts
function openSidePanel(): void {
  const close = (): void => window.close();

  try {
    void chrome.sidePanel
      .open({ windowId: chrome.windows.WINDOW_ID_CURRENT })
      .then(close)
      .catch(() => openSidePanelForActiveTab(close));
  } catch {
    openSidePanelForActiveTab(close);
  }
}

function openSidePanelForActiveTab(close: () => void): void {
  void chrome.tabs
    .query({ active: true, currentWindow: true })
    .then(([tab]) => {
      if (tab?.id === undefined) return;
      return chrome.sidePanel.open({ tabId: tab.id }).then(close);
    })
    .catch(() => {
      // 静默失败，不把 Chrome 内部错误显示给用户。
    });
}

function openOptions(): void {
  try {
    const pending = chrome.runtime.openOptionsPage();
    void Promise.resolve(pending).catch(openOptionsInTab);
  } catch {
    openOptionsInTab();
  }
}

function openOptionsInTab(): void {
  try {
    void chrome.tabs
      .create({ url: chrome.runtime.getURL("options.html") })
      .catch(() => {});
  } catch {
    // 静默失败。
  }
}
```

按钮：
- `.popup-open-sidepanel` 点击 `openSidePanel()`。
- `.popup-open-options` 点击 `openOptions()`。
- `.popup-hint` 文案 `Alt+S`（或 `Alt+S 也能打开侧栏`）。

### 6.3 manifest / vite / background

`public/manifest.json`：

```json
{
  "action": {
    "default_popup": "popup.html",
    "default_title": "翻译设置"
  }
}
```

保留其余字段。图标字段在 Task 8 加。

`vite.config.ts` 的 input 增加：

```ts
popup: resolve(import.meta.dirname, "src/popup/index.html"),
```

`src/background/index.ts`：
- 删除顶部第 26–39 行的 `chrome.sidePanel.setPanelBehavior(...)` try/catch 整块。
- 保留 `openSidePanelForTab`、`openSidePanelForCommandTab`、`toggle-side-panel` 命令和 `open-chat` 处理。

`scripts/check-build.mjs` 在 manifest 校验中加入：

```js
if (!manifest.action?.default_popup) {
  problems.push("missing action.default_popup");
} else {
  requireFile(manifest.action.default_popup, "action.default_popup");
}
```

### 6.4 验证

```bash
npx vitest run tests/unit/popup-dom.test.ts tests/unit/background-index.test.ts tests/unit/build.test.ts
npx tsc --noEmit
node scripts/check-build.mjs
```

**提交**
```bash
git add src/popup/main.ts public/manifest.json src/background/index.ts vite.config.ts \
        scripts/check-build.mjs tests/unit/popup-dom.test.ts \
        tests/unit/background-index.test.ts tests/unit/build.test.ts
git commit -m "feat: wire toolbar popup and side panel entry"
```

---

## Task 7：侧栏「思考模式」开关

**目标**
- active provider 为 DeepSeek 时，provider 栏显示「思考模式」复选框，默认关闭。
- custom provider 隐藏该控件。
- 开关只保存在当前侧栏模块状态内，不写入 settings；重新打开侧栏恢复关闭。
- 切换 provider 时保留用户当前选择；只对 DeepSeek 生效。
- 聊天消息带 `thinking: false`（默认）或 `thinking: true`（勾选）。
- 翻译和测试连接不传 thinking。

**文件**
- `src/panel/main.ts`
- `src/styles/panel.css`
- `tests/unit/panel-dom.test.ts`

### 7.1 先写失败测试

在 `tests/unit/panel-dom.test.ts` 增加：

```ts
const deepseekProvider = {
  id: "ds",
  name: "DeepSeek",
  kind: "deepseek",
  baseURL: "https://api.deepseek.com",
  apiKey: "secret",
  appendV1: false,
  model: "deepseek-flash",
  createdAt: 3,
};

it("shows the thinking toggle for DeepSeek and hides it for custom", async () => {
  installChrome({
    settings: settingsFixture({
      providers: [deepseekProvider],
      activeProviderId: "ds",
    }),
  });
  await boot();

  const toggle = document.querySelector(".thinking-toggle") as HTMLElement;
  const input = document.querySelector(".thinking-input") as HTMLInputElement;
  expect(toggle.hidden).toBe(false);
  expect(input.checked).toBe(false);

  await chrome.storage.local.set({
    settings: settingsFixture({
      providers: [settingsFixture().providers[0]],
      activeProviderId: "p1",
    }),
  });
  await flush();

  expect(toggle.hidden).toBe(true);
});

it("sends thinking false by default and true after enabling it", async () => {
  const { sent, messageListeners } = installChrome({
    settings: settingsFixture({
      providers: [deepseekProvider],
      activeProviderId: "ds",
    }),
  });
  await boot();

  const input = document.querySelector("textarea") as HTMLTextAreaElement;
  input.value = "第一个问题";
  (document.querySelector(".composer-send") as HTMLButtonElement).click();
  await flush();

  const first = sent.find((m) => (m as { type?: string }).type === "chat") as {
    requestId: string;
    thinking: boolean;
  };
  expect(first.thinking).toBe(false);

  messageListeners[0]({ type: "finish", requestId: first.requestId });

  (document.querySelector(".thinking-input") as HTMLInputElement).click();
  input.value = "第二个问题";
  (document.querySelector(".composer-send") as HTMLButtonElement).click();
  await flush();

  const chats = sent.filter((m) => (m as { type?: string }).type === "chat") as Array<{
    thinking: boolean;
  }>;
  expect(chats.at(-1)!.thinking).toBe(true);
});
```

注意：`settingsFixture().providers[0]` 在现有 fixture 中是 custom provider；这样可以切到 custom。也可复制 JSON 到临时变量，避免类型问题。

运行并确认失败：
```bash
npx vitest run tests/unit/panel-dom.test.ts
```

### 7.2 实现

`src/panel/main.ts`：
- 模块状态增加：
  ```ts
  let thinkingEnabled = false;
  ```
- DOM refs 增加：
  ```ts
  let thinkingToggle: HTMLLabelElement;
  let thinkingInput: HTMLInputElement;
  ```
- `buildDom()` 在 `providerModel` 之后、`providerSettingsBtn` 之前创建：
  ```ts
  thinkingToggle = document.createElement("label");
  thinkingToggle.className = "thinking-toggle";
  thinkingToggle.hidden = true;
  thinkingToggle.title = "仅影响聊天；默认关闭";

  thinkingInput = document.createElement("input");
  thinkingInput.type = "checkbox";
  thinkingInput.className = "thinking-input";
  thinkingInput.checked = false;
  thinkingInput.addEventListener("change", () => {
    thinkingEnabled = thinkingInput.checked;
  });

  const thinkingText = document.createElement("span");
  thinkingText.textContent = "思考模式";
  thinkingToggle.append(thinkingInput, thinkingText);

  providerBar.append(providerSelect, providerModel, thinkingToggle, providerSettingsBtn);
  ```
- `renderProviderBar()`：
  - 无 provider：`thinkingToggle.hidden = true;`
  - 有 provider：找到 active 后：
    ```ts
    thinkingToggle.hidden = active?.kind !== "deepseek";
    thinkingInput.checked = thinkingEnabled;
    ```
  - 不重置 `thinkingEnabled`。
- `sendRequest()` 的 `send({ type:"chat", ... })` 增加：
  ```ts
  thinking: thinkingEnabled,
  ```
- `src/styles/panel.css` 增加：
  ```css
  .thinking-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 44px;
    padding: 0 8px;
    border: 1px solid var(--ilmt-border-soft);
    border-radius: 8px;
    color: var(--ilmt-muted);
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
  }

  .thinking-toggle[hidden] {
    display: none;
  }

  .thinking-input {
    width: 15px;
    height: 15px;
    margin: 0;
    accent-color: var(--ilmt-accent);
  }

  .thinking-input:focus-visible {
    outline: 2px solid var(--ilmt-accent);
    outline-offset: 2px;
  }
  ```

### 7.3 验证

```bash
npx vitest run tests/unit/panel-dom.test.ts tests/unit/dispatch.test.ts
npx tsc --noEmit
```

**提交**
```bash
git add src/panel/main.ts src/styles/panel.css tests/unit/panel-dom.test.ts
git commit -m "feat: add side panel thinking toggle"
```

---

## Task 8：X1 图标与 manifest 图标

**目标**
- 新增 `public/icons/icon.svg`（X1 字母 X，128×128）。
- 生成并提交 `icon16.png`、`icon32.png`、`icon48.png`、`icon128.png`。
- manifest 的 `action.default_icon` 和顶层 `icons` 指向四个 PNG。
- check-build 和 build 测试校验图标存在。

**文件**
- `public/icons/icon.svg`（新建）
- `public/icons/icon16.png`（新建）
- `public/icons/icon32.png`（新建）
- `public/icons/icon48.png`（新建）
- `public/icons/icon128.png`（新建）
- `public/manifest.json`
- `scripts/check-build.mjs`
- `tests/unit/build.test.ts`

### 8.1 先写失败测试

`tests/unit/build.test.ts`：
- `emits every entry file` 列表加入：
  ```ts
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
  ```
- 增加：
  ```ts
  it("wires the X1 extension icons", () => {
    const m = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
    const expected = {
      "16": "icons/icon16.png",
      "32": "icons/icon32.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png",
    };
    expect(m.icons).toEqual(expected);
    expect(m.action.default_icon).toEqual(expected);
  });
  ```

`scripts/check-build.mjs` 增加：
```js
for (const [size, path] of Object.entries(manifest.icons ?? {})) {
  requireFile(path, `icons.${size}`);
}
for (const [size, path] of Object.entries(manifest.action?.default_icon ?? {})) {
  requireFile(path, `action.default_icon.${size}`);
}
```

运行并确认失败：
```bash
npx vitest run tests/unit/build.test.ts
```

### 8.2 创建 SVG

`public/icons/icon.svg`：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>
    <linearGradient id="bg" x1="16" y1="8" x2="112" y2="120" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0b2b28"/>
      <stop offset="1" stop-color="#04100f"/>
    </linearGradient>
    <radialGradient id="glow" cx="64" cy="64" r="52" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2dd4bf" stop-opacity=".35"/>
      <stop offset="1" stop-color="#2dd4bf" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="4"/>
    </filter>
  </defs>
  <rect x="4" y="4" width="120" height="120" rx="28" fill="url(#bg)" stroke="#2dd4bf" stroke-opacity=".55" stroke-width="2"/>
  <circle cx="64" cy="64" r="44" fill="none" stroke="#2dd4bf" stroke-opacity=".35" stroke-width="2"/>
  <circle cx="64" cy="64" r="50" fill="url(#glow)"/>
  <path d="M40 38 L88 90 M88 38 L40 90" stroke="#7ff7e6" stroke-width="12" stroke-linecap="round" filter="url(#soft)" opacity=".65"/>
  <path d="M40 38 L88 90 M88 38 L40 90" stroke="#7ff7e6" stroke-width="9" stroke-linecap="round"/>
</svg>
```

### 8.3 生成 PNG

```bash
cd public/icons
sips -s format png icon.svg --out icon128.png
sips -z 48 48 icon128.png --out icon48.png
sips -z 32 32 icon128.png --out icon32.png
sips -z 16 16 icon128.png --out icon16.png
cd ../..
```

检查生成尺寸：
```bash
sips -g pixelWidth -g pixelHeight public/icons/icon16.png public/icons/icon32.png public/icons/icon48.png public/icons/icon128.png
```

### 8.4 manifest

`public/manifest.json` 增加：

```json
"icons": {
  "16": "icons/icon16.png",
  "32": "icons/icon32.png",
  "48": "icons/icon48.png",
  "128": "icons/icon128.png"
},
"action": {
  "default_popup": "popup.html",
  "default_title": "翻译设置",
  "default_icon": {
    "16": "icons/icon16.png",
    "32": "icons/icon32.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

### 8.5 验证

```bash
npx vitest run tests/unit/build.test.ts
node scripts/check-build.mjs
npx tsc --noEmit
```

**提交**
```bash
git add public/icons public/manifest.json scripts/check-build.mjs tests/unit/build.test.ts
git commit -m "feat: add X1 extension icons"
```

---

## Task 9：全量验证与手动检查

**目标**
- 确认所有单元测试、类型检查、构建、dist 校验通过。
- 手动检查 popup、options、侧栏、图标和 DeepSeek 流程。

### 9.1 自动验证

```bash
npm test
npx tsc --noEmit
npm run build
node scripts/check-build.mjs
```

如果全量测试失败，按失败任务回到对应 Task 修复；不要用跳过测试的方式收尾。

### 9.2 手动功能检查

1. 在 `chrome://extensions` 重新加载 `dist/`。
2. 点工具栏扩展按钮：应弹出 `popup.html`，不再直接开侧栏。
3. popup 无 provider 时：默认 DeepSeek 表单，只看到 API Key 和模型；模型默认 `deepseek-flash`。
4. 填 DeepSeek Key，点「拉取模型」：成功显示数量；失败显示「拉取失败，可直接手填」，仍可保存。
5. 保存后：storage 中 `kind: "deepseek"`、`baseURL: "https://api.deepseek.com"`、`appendV1: false`；active provider 正确。
6. popup 选择已有 custom provider：名称/baseURL/`/v1` 出现；Key 留空保存后原 Key、额外请求头、覆盖项不丢。
7. popup「测试连接」：成功显示耗时；失败显示分类中文；任何位置不出现完整 Key。
8. popup「打开侧栏」：侧栏打开，popup 关闭。
9. `Alt+S` 仍能打开侧栏。
10. popup「高级设置」打开 `options.html`。
11. options 编辑 DeepSeek：类型锁定，baseURL/`/v1` 隐藏，保存后 kind/baseURL 不变。
12. options 新增默认 custom；切到 DeepSeek 再切回 custom，字段正确恢复。
13. 侧栏 active provider 为 DeepSeek 时显示「思考模式」，默认关闭；勾选后聊天请求带 `thinking: true`；切到 custom 控件隐藏；重新打开侧栏恢复默认关闭。
14. 翻译流程正常；翻译请求默认关闭 thinking（DeepSeek 请求体含 `thinking: { type: "disabled" }`）。
15. popup、options、侧栏均为深青量子青主题；无白底 input/select/textarea；Tab 键盘焦点环可见。
16. 16px 图标在浅色和深色工具栏都能认出 X；128px 不糊。
17. 系统开启「减少动态效果」后，popup/options/侧栏没有脉冲/扫描/位移动画。

### 9.3 最终提交

如手动检查发现 CSS/文案微调：

```bash
git add -A
git commit -m "chore: polish popup, DeepSeek, theme, and icons"
```

---

## 覆盖对照（设计 §14）

- popup 无 provider 默认 DeepSeek、custom 字段、DeepSeek 保存、已有 provider 掩码、拉取模型、测试连接、打开侧栏、高级设置：Task 5 / 6。
- options 编辑 DeepSeek 保留 kind/baseURL、类型切换：Task 3。
- DeepSeek 预设/校验：Task 1。
- DeepSeek 默认 thinking disabled、显式 true 省略、custom 不发送、`/models` 无 `/v1`：Task 2。
- 侧栏 thinking 开关默认关闭/custom 隐藏、消息 thinking false/true：Task 7；透传：Task 2。
- build popup/manifest/icons：Task 6 / 8。
- 移除 `setPanelBehavior`：Task 6。
- 三界面量子青主题与 reduced motion：Task 4 / 5。
- 手动视觉与功能检查：Task 9。
