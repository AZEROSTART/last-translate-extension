# 翻译中的分段 loading 占位 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每批翻译请求发出时，为在途片段插入呼吸骨架占位，译文返回后原地替换，失败/还原时清理干净。

**Architecture:** 复用现有 `.ilmt-tr` 译文节点和锚点插入逻辑：`render.ts` 新增 `renderLoading` / `discardLoading`，`main.ts` 在 `pump()` 发送批次前为每条 `inflight` 记录插入占位，并在 result / delta / 失败时清除；`inject.css` 用 `::before` 画骨架。

**Tech Stack:** TypeScript、原生 DOM、Vitest、Chrome MV3 content script、manifest 注入的 CSS。

**Spec:** `docs/superpowers/specs/2026-11-09-inline-loading-placeholder-design.md`

## Global Constraints

- Chrome MV3 content script，TypeScript + 原生 DOM，无 React。
- 只新增 `.ilmt-tr` 节点和 `data-ilmt-p` 标记；绝不修改页面原有文本节点。
- 占位绝不插入 `<button>`、`<a role="button">`、`<summary>`、`<label>` 等交互元素内部。
- 所有用户可见/可读文案保持中文；骨架使用 `aria-label="翻译中"`。
- 样式只走 manifest 注入的 `inject.css`；CSP 安全，不插 `<style>`、不用内联样式。
- 只为当前批次（`BATCH_SIZE = 20`）插占位，不给整页 2000 段排队内容插。
- 保持 Style A：译文弱化 + 左侧细线；标题译文更小、常规字重。
- 不改后台、模型、队列、超时和取消语义。
- `npm test`、`npx tsc --noEmit`、`npm run build` 必须通过。

## Review Focus

- **快速/缓存结果**：骨架必须立刻被同一节点替换，不留下重复 `.ilmt-tr` 或永久骨架；由 Task 2 的 result 测试覆盖。
- **根或锚点已断开**：不得抛错或插入孤儿骨架；由 Task 1 的 detached-root 测试和 Task 2 的 `isConnected` 守卫覆盖。
- **失败/取消**：空的 loading 节点必须移除，已有部分译文的节点只清标记；由 Task 2 的 auth 错误测试覆盖。
- **429 重试/端口重连**：占位保留并复用，不重复插入；由 Task 2 的 rate-limit 测试补充断言。
- **还原/rescan 时仍在 loading**：所有骨架必须随现有 `restoreAll` 移除，DOM 回到翻译前；由 Task 1 的 restore 测试和 Task 2 的 restore 测试覆盖。

---

### Task 1: 渲染层 loading 节点与骨架样式

**Files:**
- Modify: `src/content/render.ts`
- Modify: `src/styles/inject.css`
- Test: `tests/unit/render.test.ts`
- Test: `tests/unit/build.test.ts`

**Interfaces:**
- Consumes: 现有 `TranslationTarget`、`findTranslation`、锚点插入逻辑、`setInlineLoader` / `clearInlineLoader`。
- Produces:
  - `renderLoading(target: TranslationTarget, id: string, targetLang?: string): HTMLElement`
  - `discardLoading(id: string): void`
  - `setInlineLoader(id: string): void` / `clearInlineLoader(id: string): void` 继续存在，并同时管理 `data-loading`、`aria-busy`、`aria-label`。
  - `renderTranslation` 复用已有节点时清除 loading 标记。

- [ ] **Step 1: 写失败的渲染测试**

在 `tests/unit/render.test.ts` 导入 `renderLoading`、`discardLoading`，新增：

```ts
it("renders a loading skeleton at the translation anchor", () => {
  document.body.innerHTML = `<p>Hello</p>`;
  const p = document.querySelector("p")!;
  const node = renderLoading({ root: p, anchor: p.firstChild! }, "p_load_1");
  expect(node.classList.contains("ilmt-block")).toBe(true);
  expect(node.getAttribute("data-loading")).toBe("1");
  expect(node.getAttribute("aria-busy")).toBe("true");
  expect(node.getAttribute("aria-label")).toBe("翻译中");
  expect(p.lastElementChild).toBe(node);
});

it("never renders a loading skeleton inside a trailing button", () => {
  document.body.innerHTML = `<p>prefix <button>action</button></p>`;
  const p = document.querySelector("p")!;
  const button = document.querySelector("button")!;
  const node = renderLoading({ root: p, anchor: p.firstChild! }, "p_load_2");
  expect(button.contains(node)).toBe(false);
  expect(p.lastElementChild).toBe(node);
});

it("marks a heading loading skeleton as a heading", () => {
  document.body.innerHTML = `<h1>Repository title</h1>`;
  const h1 = document.querySelector("h1")!;
  const node = renderLoading({ root: h1, anchor: h1.firstChild!, heading: true }, "p_load_3");
  expect(node.getAttribute("data-ilmt-heading")).toBe("1");
});

it("reuses the loading node and clears the skeleton when the translation arrives", () => {
  document.body.innerHTML = `<p>Hello</p>`;
  const p = document.querySelector("p")!;
  const loader = renderLoading({ root: p, anchor: p.firstChild! }, "p_load_4");
  const node = renderTranslation({ root: p, anchor: p.firstChild! }, "p_load_4", "你好");
  expect(node).toBe(loader);
  expect(node.textContent).toBe("你好");
  expect(node.hasAttribute("data-loading")).toBe(false);
  expect(node.hasAttribute("aria-busy")).toBe(false);
  expect(node.hasAttribute("aria-label")).toBe(false);
});

it("does not insert a loading node when the root is detached", () => {
  document.body.innerHTML = `<p id="root">Hello</p>`;
  const root = document.querySelector("#root")!;
  const anchor = root.firstChild!;
  root.remove();
  const node = renderLoading({ root, anchor }, "p_load_5");
  expect(document.querySelector(".ilmt-tr")).toBeNull();
  expect(node.isConnected).toBe(false);
});

it("discards an empty loading node but keeps a partial translation", () => {
  document.body.innerHTML = `<p>Hello</p>`;
  const p = document.querySelector("p")!;
  renderLoading({ root: p, anchor: p.firstChild! }, "p_load_6");
  discardLoading("p_load_6");
  expect(document.querySelector('[data-ilmt-for="p_load_6"]')).toBeNull();

  renderLoading({ root: p, anchor: p.firstChild! }, "p_load_7");
  renderTranslation({ root: p, anchor: p.firstChild! }, "p_load_7", "你");
  setInlineLoader("p_load_7");
  discardLoading("p_load_7");
  const node = document.querySelector('[data-ilmt-for="p_load_7"]') as HTMLElement;
  expect(node.textContent).toBe("你");
  expect(node.hasAttribute("data-loading")).toBe(false);
});

it("removes loading placeholders on restore", () => {
  document.body.innerHTML = `<p>Hello</p>`;
  const before = document.body.innerHTML;
  const p = document.querySelector("p")!;
  p.setAttribute("data-ilmt-p", "p_load_8");
  renderLoading({ root: p, anchor: p.firstChild! }, "p_load_8");
  restoreAll(document.body);
  expect(document.body.innerHTML).toBe(before);
});
```

同时把 `setInlineLoader` 加入 `tests/unit/render.test.ts` 的导入。

- [ ] **Step 2: 跑渲染测试确认失败**

Run: `npx vitest run tests/unit/render.test.ts`
Expected: FAIL，`renderLoading` / `discardLoading` 未导出。

- [ ] **Step 3: 实现渲染层**

在 `src/content/render.ts`：

1. 从 `renderTranslation` 抽出节点创建和插入逻辑为：

```ts
function createTranslationNode(
  target: TranslationTarget,
  id: string,
  text: string,
  targetLang: string,
  loading: boolean,
): HTMLElement
```

`loading` 为 true 时在节点上设置 `data-loading="1"`、`aria-busy="true"`、`aria-label="翻译中"`；其余 class、`lang`、`data-ilmt-for`、标题属性和锚点插入逻辑完全沿用现有代码。

2. `renderTranslation` 命中已有节点时写入文本、设置 `lang`、调用 `clearLoading(existing)`。

3. 新增：

```ts
export function renderLoading(
  target: TranslationTarget,
  id: string,
  targetLang: string = DEFAULT_TARGET_LANG,
): HTMLElement
```

已有同 id 节点则直接 `markLoading(existing)` 并返回；否则 `createTranslationNode(..., true)`。

4. 新增：

```ts
export function discardLoading(id: string): void
```

找到节点后：若 `data-loading="1"` 且 `textContent.trim() === ""` 则 `node.remove()`；否则只清除 loading 标记，保留已有部分译文。

5. 把 `setInlineLoader` / `clearInlineLoader` 内部改为共用的 `markLoading(node)` / `clearLoading(node)`；`clearLoading` 同时移除 `data-loading`、`aria-busy`、`aria-label`。

- [ ] **Step 4: 跑渲染测试确认通过**

Run: `npx vitest run tests/unit/render.test.ts`
Expected: PASS。

- [ ] **Step 5: 写失败的构建样式测试**

在 `tests/unit/build.test.ts` 新增：

```ts
it("ships the loading skeleton styles", () => {
  const css = readFileSync("dist/inject.css", "utf8");
  expect(css).toContain('[data-loading="1"]');
  expect(css).toContain("@keyframes ilmt-loading-pulse");
  expect(css).toContain("prefers-reduced-motion");
});
```

- [ ] **Step 6: 跑构建测试确认失败**

Run: `npx vitest run tests/unit/build.test.ts`
Expected: FAIL，`inject.css` 还没有骨架样式。

- [ ] **Step 7: 替换 loading 样式**

在 `src/styles/inject.css` 把现有的：

```css
/* 待翻译状态 */
.ilmt-tr[data-loading="1"] {
  opacity: 0.4 !important;
}
```

替换为：

```css
/* 待翻译状态：译文位置的呼吸骨架 */
.ilmt-tr[data-loading="1"] {
  opacity: 1 !important;
  min-height: 1.15em;
}

.ilmt-tr[data-loading="1"]::before {
  content: "";
  display: block;
  width: 100%;
  height: 0.95em;
  border-radius: 4px;
  background: currentColor;
  opacity: 0.18;
  animation: ilmt-loading-pulse 1.4s ease-in-out infinite;
}

.ilmt-tr[data-loading="1"][data-ilmt-heading="1"]::before {
  height: 0.62em;
  max-width: 8em;
}

@keyframes ilmt-loading-pulse {
  0%,
  100% {
    opacity: 0.1;
  }
  50% {
    opacity: 0.28;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ilmt-tr[data-loading="1"]::before {
    animation: none;
    opacity: 0.18;
  }
}
```

- [ ] **Step 8: 跑渲染和构建测试确认通过**

Run: `npx vitest run tests/unit/render.test.ts tests/unit/build.test.ts`
Expected: PASS。

- [ ] **Step 9: 提交**

```bash
git add src/content/render.ts src/styles/inject.css tests/unit/render.test.ts tests/unit/build.test.ts
git commit -m "feat: add loading skeleton rendering for translation pieces"
```

---

### Task 2: 内容主流程接入占位与清理

**Files:**
- Modify: `src/content/main.ts`
- Test: `tests/unit/main-ui.test.ts`

**Interfaces:**
- Consumes: `renderLoading(target, id, targetLang)`、`discardLoading(id)`、`clearInlineLoader(id)`（Task 1）。
- Produces: `pump()` 在发送前为当前批次插入占位；`handleResult` 清理对应标记；`failIds` 丢弃空占位。

- [ ] **Step 1: 写失败的主流程测试**

在 `tests/unit/main-ui.test.ts` 新增：

```ts
it("shows loading placeholders only for the in-flight batch", async () => {
  document.body.innerHTML = Array.from(
    { length: 21 },
    (_, i) => `<p>Paragraph number ${i} here.</p>`,
  ).join("");
  const { request } = await startTranslating();

  expect(request.items).toHaveLength(20);
  expect(document.querySelectorAll('.ilmt-tr[data-loading="1"]')).toHaveLength(20);
  expect(document.querySelectorAll(".ilmt-tr")).toHaveLength(20);
});

it("does not insert a placeholder for a piece detached before the batch sends", async () => {
  document.body.innerHTML = `<p id="gone">Hello world from the page.</p>`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  (chrome as any).i18n = {
    detectLanguage: vi.fn((_text: string, callback: (result: unknown) => void) => {
      void gate.then(() => callback({ languages: [{ language: "en", percentage: 100 }] }));
    }),
  };

  const { runContentMain } = await import("../../src/content/main");
  runContentMain();
  const sent: any[] = [];
  (globalThis as any).__ilmtTestPort = { send: (message: unknown) => sent.push(message) };

  const scanning = (globalThis as any).__ilmtMain.translatePage();
  await until(() => (chrome as any).i18n.detectLanguage.mock.calls.length > 0);
  document.querySelector("#gone")!.remove();
  release();
  await scanning;

  expect(sent.some((message) => message.type === "translate")).toBe(true);
  expect(document.querySelectorAll(".ilmt-tr")).toHaveLength(0);
});

it("replaces loading placeholders with the returned translation", async () => {
  document.body.innerHTML = `<p>Hello world from the page.</p><p>Second paragraph here.</p>`;
  const { deliver, request } = await startTranslating();
  expect(document.querySelectorAll('.ilmt-tr[data-loading="1"]')).toHaveLength(request.items.length);

  deliver({
    type: "result",
    requestId: request.requestId,
    items: request.items.map((item: any) => ({ id: item.id, text: "译" })),
  });

  expect(document.querySelectorAll('.ilmt-tr[data-loading="1"]')).toHaveLength(0);
  expect(document.querySelectorAll(".ilmt-tr")).toHaveLength(request.items.length);
});

it("removes empty loading placeholders when a batch fails", async () => {
  document.body.innerHTML = `<p>Hello world from the page.</p>`;
  const { deliver, request } = await startTranslating();
  expect(document.querySelectorAll('.ilmt-tr[data-loading="1"]')).toHaveLength(1);

  deliver({
    type: "error",
    requestId: request.requestId,
    code: "auth",
    message: "invalid key",
    retryable: false,
    ids: request.items.map((item: any) => item.id),
  });
  deliver({ type: "finish", requestId: request.requestId });

  expect(document.querySelectorAll(".ilmt-tr")).toHaveLength(0);
});

it("removes loading placeholders on restore", async () => {
  document.body.innerHTML = `<p>Hello world from the page.</p>`;
  await startTranslating();
  expect(document.querySelectorAll('.ilmt-tr[data-loading="1"]')).toHaveLength(1);

  (globalThis as any).__ilmtMain.restore();

  expect(document.querySelectorAll('.ilmt-tr[data-loading="1"]')).toHaveLength(0);
});
```

在现有 `"appends streaming deltas instead of replacing the previous chunk"` 测试开头补一条断言：

```ts
expect(document.querySelector(`[data-ilmt-for="${id}"]`)?.getAttribute("data-loading")).toBe("1");
```

并在 delta 之后补：

```ts
expect(document.querySelector(`[data-ilmt-for="${id}"]`)?.hasAttribute("data-loading")).toBe(false);
```

在现有 rate-limit 测试的重试循环里补一条断言，确保占位不重复：

```ts
expect(document.querySelectorAll(".ilmt-tr")).toHaveLength(1);
```

- [ ] **Step 2: 跑主流程测试确认失败**

Run: `npx vitest run tests/unit/main-ui.test.ts`
Expected: FAIL，`pump()` 尚未插入占位。

- [ ] **Step 3: 接入 `pump()`**

在 `src/content/main.ts` 导入 `renderLoading`、`discardLoading`、`clearInlineLoader`。

在 `pump()` 取到 `batch` 之后、创建 `requestId` 之前：

```ts
for (const rec of batch) {
  const root = rec.el.deref();
  const anchor = rec.anchor.deref();
  if (!root || !anchor || !root.isConnected || !anchor.isConnected) continue;
  renderLoading({ root, anchor, heading: rec.heading }, rec.id, targetLang);
}
```

- [ ] **Step 4: 接入结果和失败清理**

在 `handleResult` 的每条 item 处理后调用 `clearInlineLoader(item.id)`（即使 root/anchor 已失效也能清掉残留标记）。

在 `failIds` 循环里调用 `discardLoading(id)`。

- [ ] **Step 5: 跑主流程测试确认通过**

Run: `npx vitest run tests/unit/main-ui.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/content/main.ts tests/unit/main-ui.test.ts
git commit -m "feat: show loading placeholders for in-flight translation batches"
```

---

### Task 3: 全量验证与手动检查

**Files:**
- Verify only; no source changes expected.

- [ ] **Step 1: 跑全量单元测试**

Run: `npm test`
Expected: 全部通过，无新增失败。

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出、退出码 0。

- [ ] **Step 3: 构建**

Run: `npm run build`
Expected: 构建成功，`dist/inject.css` 包含 `[data-loading="1"]` 和 `@keyframes ilmt-loading-pulse`。

- [ ] **Step 4: 手动检查**

在 `chrome://extensions` 刷新扩展并刷新目标网页，点「翻译当前页面」：

- 视口内进入首批的段落下方立即出现呼吸骨架。
- 译文返回后骨架消失，同一位置显示译文，没有重复 `.ilmt-tr`。
- 点「还原」后骨架和译文全部消失，页面文本恢复原样。

- [ ] **Step 5: 提交设计/计划文档（若尚未提交）**

```bash
git add docs/superpowers/specs/2026-11-09-inline-loading-placeholder-design.md docs/superpowers/plans/2026-11-09-inline-loading-placeholder.md
git commit -m "docs: add inline loading placeholder design and plan"
```
