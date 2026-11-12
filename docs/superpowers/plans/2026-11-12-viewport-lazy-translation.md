# 看到才翻译（视口懒加载）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 激活后只翻译当前视口和下方 1 屏内的段落，滚动进入预取带时自动补翻，不再整页排队。

**Architecture:** 扫描仍然遍历整页并打标，但不再统一置 `queued`；扫描结束做一次同步可见带判定，其余 piece root 交给 `IntersectionObserver`（`rootMargin` 下 1 屏），命中后 150ms 合批入队。入队是唯一门槛，`pump()` 与后台调度保持不变。

**Tech Stack:** TypeScript、Vite、Vitest + jsdom、Playwright、Chrome MV3 content script。

**Spec:** `docs/superpowers/specs/2026-11-12-viewport-lazy-translation-design.md`

## Global Constraints

- 不新增运行时依赖，不新增扩展权限，不改 manifest。
- 预取固定为视口下方 1 屏；视口上方不预取。
- 可见命中合批窗口 150ms；`translate` 单请求仍最多 20 段。
- `MAX_PARAGRAPHS = 2000` 不变；不提供「翻译整页」入口。
- 全部新增代码在 content script 内，类型检查用 `npx tsc --noEmit`。
- 单元测试运行在 jsdom（无 `IntersectionObserver`、无布局）；内容脚本单测必须继续通过且不新增 `waitFor` 式轮询。
- 提交信息用英文、conventional 前缀（`feat:` / `test:` / `docs:`）。

## Review Focus

- 长页面只读首屏时，视口外段落不能出现骨架屏，也不能进入 `translate` 请求。
- 向下滚动后，新段落必须被入队并翻译，不能永久停在 `unseen`。
- 按 `Opt+A` 恢复后再次激活，旧观察器和旧合批定时器不能把段落重新入队。
- SPA 路由切换（rescan）后，旧页面的 root 不能触发新页面入队。
- 已有译文的段落滚出再滚回时，不能重复请求，也不能撤销译文。

---

### Task 1: 可见性模块

**Files:**
- Create: `src/content/visibility.ts`
- Test: `tests/unit/visibility.test.ts`

**Interfaces:**
- Consumes: 浏览器全局 `IntersectionObserver`、`Element`。
- Produces:
  - `inPrefetchBand(rect: { top: number; bottom: number }, viewportHeight: number, prefetchScreens: number): boolean`
  - `createVisibilityObserver(options: VisibilityOptions): VisibilityObserver`
  - `interface VisibilityOptions { prefetchScreens: number; batchMs: number; onVisible(ids: string[]): void }`
  - `interface VisibilityObserver { observe(root: Element, ids: string[]): void; unobserve(root: Element): void; stop(): void }`

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/visibility.test.ts`：

```ts
import { it, expect, vi, afterEach } from "vitest";
import { createVisibilityObserver, inPrefetchBand } from "../../src/content/visibility";

type Entry = { target: Element; isIntersecting: boolean };

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  disconnected = false;

  constructor(
    public readonly callback: IntersectionObserverCallback,
    public readonly options: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.instances.push(this);
  }

  observe(el: Element): void {
    this.targets.add(el);
  }

  unobserve(el: Element): void {
    this.targets.delete(el);
  }

  disconnect(): void {
    this.targets.clear();
    this.disconnected = true;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  fire(entries: Entry[]): void {
    this.callback(
      entries.map((entry) => ({
        ...entry,
        intersectionRatio: entry.isIntersecting ? 1 : 0,
      })) as IntersectionObserverEntry[],
      this as unknown as IntersectionObserver,
    );
  }
}

function installFake(): void {
  FakeIntersectionObserver.instances = [];
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver;
}

afterEach(() => {
  vi.useRealTimers();
});

it("treats the viewport plus the prefetch band as visible", () => {
  expect(inPrefetchBand({ top: 100, bottom: 140 }, 800, 1)).toBe(true);
  expect(inPrefetchBand({ top: -20, bottom: 60 }, 800, 1)).toBe(true);
  expect(inPrefetchBand({ top: 850, bottom: 900 }, 800, 1)).toBe(true);
  expect(inPrefetchBand({ top: 1700, bottom: 1760 }, 800, 1)).toBe(false);
  expect(inPrefetchBand({ top: -120, bottom: -60 }, 800, 1)).toBe(false);
});

it("batches intersecting roots once after the window and stops observing them", () => {
  vi.useFakeTimers();
  installFake();
  const batches: string[][] = [];
  const gate = createVisibilityObserver({
    prefetchScreens: 1,
    batchMs: 150,
    onVisible: (ids) => batches.push(ids),
  });
  const io = FakeIntersectionObserver.instances[0];
  expect(io.options.rootMargin).toBe("0px 0px 100% 0px");

  const root = document.createElement("p");
  gate.observe(root, ["a", "b"]);
  expect(io.targets.has(root)).toBe(true);

  io.fire([{ target: root, isIntersecting: true }]);
  vi.advanceTimersByTime(149);
  expect(batches).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(batches).toEqual([["a", "b"]]);
  expect(io.targets.has(root)).toBe(false);

  io.fire([{ target: root, isIntersecting: true }]);
  vi.advanceTimersByTime(150);
  expect(batches).toHaveLength(1);
});

it("coalesces two roots that intersect in the same window", () => {
  vi.useFakeTimers();
  installFake();
  const batches: string[][] = [];
  const gate = createVisibilityObserver({
    prefetchScreens: 1,
    batchMs: 150,
    onVisible: (ids) => batches.push(ids),
  });
  const io = FakeIntersectionObserver.instances[0];
  const first = document.createElement("p");
  const second = document.createElement("p");
  gate.observe(first, ["a"]);
  gate.observe(second, ["b"]);

  io.fire([
    { target: first, isIntersecting: true },
    { target: second, isIntersecting: true },
  ]);
  vi.advanceTimersByTime(150);

  expect(batches).toHaveLength(1);
  expect([...batches[0]].sort()).toEqual(["a", "b"]);
});

it("ignores entries that are not intersecting", () => {
  vi.useFakeTimers();
  installFake();
  const batches: string[][] = [];
  const gate = createVisibilityObserver({
    prefetchScreens: 1,
    batchMs: 150,
    onVisible: (ids) => batches.push(ids),
  });
  const io = FakeIntersectionObserver.instances[0];
  const root = document.createElement("p");
  gate.observe(root, ["a"]);

  io.fire([{ target: root, isIntersecting: false }]);
  vi.advanceTimersByTime(150);

  expect(batches).toEqual([]);
  expect(io.targets.has(root)).toBe(true);
});

it("drops pending work and disconnects on stop", () => {
  vi.useFakeTimers();
  installFake();
  const batches: string[][] = [];
  const gate = createVisibilityObserver({
    prefetchScreens: 1,
    batchMs: 150,
    onVisible: (ids) => batches.push(ids),
  });
  const io = FakeIntersectionObserver.instances[0];
  const root = document.createElement("p");
  gate.observe(root, ["a"]);
  io.fire([{ target: root, isIntersecting: true }]);

  gate.stop();
  vi.advanceTimersByTime(150);

  expect(batches).toEqual([]);
  expect(io.disconnected).toBe(true);
  expect(io.targets.size).toBe(0);
});

it("stops mapping a root after unobserve", () => {
  vi.useFakeTimers();
  installFake();
  const batches: string[][] = [];
  const gate = createVisibilityObserver({
    prefetchScreens: 1,
    batchMs: 150,
    onVisible: (ids) => batches.push(ids),
  });
  const io = FakeIntersectionObserver.instances[0];
  const root = document.createElement("p");
  gate.observe(root, ["a"]);
  gate.unobserve(root);

  io.fire([{ target: root, isIntersecting: true }]);
  vi.advanceTimersByTime(150);

  expect(batches).toEqual([]);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run tests/unit/visibility.test.ts`
Expected: FAIL，`Failed to resolve import "../../src/content/visibility"`。

- [ ] **Step 3: 实现 `src/content/visibility.ts`**

文件头注释说明：可见性只决定「何时入队」，翻译调度仍归 `main.ts`。实现：

```ts
export interface VisibilityOptions {
  prefetchScreens: number;
  batchMs: number;
  onVisible(ids: string[]): void;
}

export interface VisibilityObserver {
  observe(root: Element, ids: string[]): void;
  unobserve(root: Element): void;
  stop(): void;
}

export function inPrefetchBand(
  rect: { top: number; bottom: number },
  viewportHeight: number,
  prefetchScreens: number,
): boolean {
  return rect.bottom >= 0 && rect.top <= viewportHeight * (1 + prefetchScreens);
}

export function createVisibilityObserver(options: VisibilityOptions): VisibilityObserver {
  const roots = new Map<Element, Set<string>>();
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    timer = null;
    const ids = [...pending];
    pending.clear();
    if (ids.length > 0) options.onVisible(ids);
  }

  function schedule(): void {
    if (timer !== null) return;
    timer = setTimeout(flush, options.batchMs);
  }

  const io = new IntersectionObserver(
    (entries) => {
      let found = false;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const ids = roots.get(entry.target);
        if (!ids) continue;
        io.unobserve(entry.target);
        roots.delete(entry.target);
        for (const id of ids) pending.add(id);
        found = true;
      }
      if (found) schedule();
    },
    {
      root: null,
      rootMargin: `0px 0px ${options.prefetchScreens * 100}% 0px`,
      threshold: 0,
    },
  );

  return {
    observe(root, ids) {
      const existing = roots.get(root);
      if (existing) {
        for (const id of ids) existing.add(id);
        return;
      }
      roots.set(root, new Set(ids));
      io.observe(root);
    },
    unobserve(root) {
      if (!roots.delete(root)) return;
      io.unobserve(root);
    },
    stop() {
      io.disconnect();
      roots.clear();
      pending.clear();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
```

- [ ] **Step 4: 运行并确认通过**

Run: `npx vitest run tests/unit/visibility.test.ts`
Expected: PASS，6 个用例全绿。

- [ ] **Step 5: 提交**

```bash
git add src/content/visibility.ts tests/unit/visibility.test.ts
git commit -m "feat: add a viewport visibility gate for lazy translation"
```

---

### Task 2: 主流程接入

**Files:**
- Create: `tests/setup/intersection-observer.ts`
- Modify: `vite.config.ts:90`（`setupFiles`）
- Modify: `src/content/main.ts`（常量、状态、扫描、恢复、动态内容）
- Test: `tests/unit/main.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `createVisibilityObserver`、`inPrefetchBand`、`VisibilityObserver`。
- Produces: `main.ts` 内部 `registerScannedNodes(nodes: ParagraphNode[]): void`（扫描与动态内容共用）、`startVisibilityObserver(): void`、`stopVisibilityObserver(): void`。无新的导出。

- [ ] **Step 1: 给 jsdom 补一个 `IntersectionObserver` 占位**

创建 `tests/setup/intersection-observer.ts`：

```ts
/**
 * jsdom has no IntersectionObserver. Most content-script tests rely on the
 * eager viewport band (jsdom reports every rect at the origin); this no-op
 * class keeps activation from throwing. Tests that assert lazy behavior
 * install a recording fake in place of this class.
 */
class NoopIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin = "0px";
  readonly thresholds: ReadonlyArray<number> = [];

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

if (typeof globalThis.IntersectionObserver !== "function") {
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
    NoopIntersectionObserver;
}
```

在 `vite.config.ts` 的 `test.setupFiles` 里追加：

```ts
setupFiles: ["./tests/setup/chrome-mock.ts", "./tests/setup/intersection-observer.ts"],
```

- [ ] **Step 2: 写失败测试**

在 `tests/unit/main.test.ts` 顶部（`djb2Hex` 之后）加入测试用的假观察器：

```ts
type VisibilityEntry = { target: Element; isIntersecting: boolean };

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  disconnected = false;

  constructor(
    public readonly callback: IntersectionObserverCallback,
    public readonly options: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.instances.push(this);
  }

  observe(el: Element): void {
    this.targets.add(el);
  }

  unobserve(el: Element): void {
    this.targets.delete(el);
  }

  disconnect(): void {
    this.targets.clear();
    this.disconnected = true;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  fire(entries: VisibilityEntry[]): void {
    this.callback(
      entries.map((entry) => ({
        ...entry,
        intersectionRatio: entry.isIntersecting ? 1 : 0,
      })) as IntersectionObserverEntry[],
      this as unknown as IntersectionObserver,
    );
  }
}

/** Install the fake for one test; the original constructor is restored after. */
function installFakeIntersectionObserver(): () => void {
  const original = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  FakeIntersectionObserver.instances = [];
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver;
  return () => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = original;
  };
}
```

把现有的 `sends the paragraph nearest the viewport first, then the 300px band` 改成「全部在可见带内，只验证批内排序」：

```ts
it("sends the paragraph nearest the viewport first inside one batch", async () => {
  document.body.innerHTML = [
    `<p id="far">Far away paragraph here.</p>`,
    `<p id="near">Nearest paragraph here.</p>`,
    `<p id="below">Just below paragraph here.</p>`,
  ].join("");
  stubRect(document.getElementById("far")!, 1200, 1250);
  stubRect(document.getElementById("near")!, 100, 150);
  stubRect(document.getElementById("below")!, 900, 950);

  const { runContentMain } = await import("../../src/content/main");
  runContentMain();
  const sent: any[] = [];
  (globalThis as any).__ilmtTestPort = { send: (m: any) => sent.push(m) };
  await (globalThis as any).__ilmtMain.translatePage();

  const translate = sent.find((m) => m.type === "translate");
  expect(translate.items.map((item: any) => item.text)).toEqual([
    "Nearest paragraph here.",
    "Just below paragraph here.",
    "Far away paragraph here.",
  ]);
});
```

把现有的 `pumps queued paragraphs on scroll when no request is in flight` 换成「滚动本身不再触发 pump，视口外段落等观察器」：

```ts
it("leaves off-screen paragraphs to the observer instead of pumping on scroll", async () => {
  document.body.innerHTML = Array.from(
    { length: 21 },
    (_, i) => `<p>Paragraph number ${i} here.</p>`,
  ).join("");
  const restoreIo = installFakeIntersectionObserver();
  try {
    const last = document.querySelectorAll("p")[20]!;
    stubRect(last, 6000, 6040);
    const { runContentMain } = await import("../../src/content/main");
    const { sent, connect } = captureConnectPort();
    (globalThis as any).chrome.runtime.connect = connect;
    runContentMain();
    await (globalThis as any).__ilmtMain.translatePage();

    expect(sent.filter((m) => m.type === "translate")).toHaveLength(1);
    expect(document.querySelectorAll('.ilmt-tr[data-loading="1"]')).toHaveLength(20);

    window.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 320));

    expect(sent.filter((m) => m.type === "translate")).toHaveLength(1);
    expect(document.querySelectorAll(".ilmt-tr")).toHaveLength(20);
    expect(FakeIntersectionObserver.instances.at(-1)!.targets.has(last)).toBe(true);
  } finally {
    restoreIo();
  }
});
```

在文件末尾追加 4 个懒加载测试：

```ts
it("translates only the viewport band, then follows the observer", async () => {
  document.body.innerHTML = `<p id="top">First paragraph here.</p><p id="bottom">Last paragraph here.</p>`;
  const restoreIo = installFakeIntersectionObserver();
  try {
    stubRect(document.getElementById("bottom")!, 5000, 5040);
    const { runContentMain } = await import("../../src/content/main");
    const { sent, messageListeners, connect } = captureConnectPort();
    (globalThis as any).chrome.runtime.connect = connect;
    runContentMain();
    await (globalThis as any).__ilmtMain.translatePage();

    const first = sent.find((m) => m.type === "translate");
    expect(first.items.map((item: any) => item.text)).toEqual(["First paragraph here."]);

    const io = FakeIntersectionObserver.instances.at(-1)!;
    const bottom = document.getElementById("bottom")!;
    expect(io.targets.has(bottom)).toBe(true);

    io.fire([{ target: bottom, isIntersecting: true }]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    messageListeners[0]({ type: "finish", requestId: first.requestId });

    const translates = sent.filter((m) => m.type === "translate");
    expect(translates).toHaveLength(2);
    expect(translates[1].items.map((item: any) => item.text)).toEqual(["Last paragraph here."]);
  } finally {
    restoreIo();
  }
});

it("does not re-observe a paragraph the initial band already queued", async () => {
  document.body.innerHTML = `<p id="top">First paragraph here.</p>`;
  const restoreIo = installFakeIntersectionObserver();
  try {
    const { runContentMain } = await import("../../src/content/main");
    runContentMain();
    (globalThis as any).__ilmtTestPort = { send: vi.fn() };
    await (globalThis as any).__ilmtMain.translatePage();

    const io = FakeIntersectionObserver.instances.at(-1)!;
    expect(io.targets.size).toBe(0);
  } finally {
    restoreIo();
  }
});

it("disconnects the visibility observer on restore", async () => {
  document.body.innerHTML = `<p id="top">First paragraph here.</p><p id="bottom">Last paragraph here.</p>`;
  const restoreIo = installFakeIntersectionObserver();
  try {
    stubRect(document.getElementById("bottom")!, 5000, 5040);
    const { runContentMain } = await import("../../src/content/main");
    const sent: any[] = [];
    (globalThis as any).__ilmtTestPort = { send: (m: any) => sent.push(m) };
    runContentMain();
    await (globalThis as any).__ilmtMain.translatePage();

    const io = FakeIntersectionObserver.instances.at(-1)!;
    (globalThis as any).__ilmtMain.restore();
    expect(io.disconnected).toBe(true);

    io.fire([{ target: document.getElementById("bottom")!, isIntersecting: true }]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sent.filter((m) => m.type === "translate")).toHaveLength(1);
  } finally {
    restoreIo();
  }
});

it("replaces the visibility observer on an SPA rescan", async () => {
  document.body.innerHTML = `<p>First paragraph here.</p>`;
  const restoreIo = installFakeIntersectionObserver();
  try {
    const { runContentMain } = await import("../../src/content/main");
    const navListeners: Array<(message: unknown, sender: { id?: string }) => void> = [];
    (globalThis as any).chrome.runtime.onMessage.addListener = (cb: any) => navListeners.push(cb);
    (globalThis as any).__ilmtTestPort = { send: vi.fn() };
    runContentMain();
    await (globalThis as any).__ilmtMain.translatePage();
    const firstIo = FakeIntersectionObserver.instances.at(-1)!;

    navListeners[0]({ type: "page-navigated" }, { id: (globalThis as any).chrome.runtime.id });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondIo = FakeIntersectionObserver.instances.at(-1)!;
    expect(secondIo).not.toBe(firstIo);
    expect(firstIo.disconnected).toBe(true);
  } finally {
    restoreIo();
  }
});
```

- [ ] **Step 3: 运行并确认失败**

Run: `npx vitest run tests/unit/main.test.ts`
Expected: FAIL。未改实现前，第二个 `translate` 请求不会出现，`io.targets.has(bottom)` 为 false，`io.disconnected` 为 false。

- [ ] **Step 4: 改 `src/content/main.ts`**

1. 导入：

```ts
import {
  createVisibilityObserver,
  inPrefetchBand,
  type VisibilityObserver,
} from "./visibility";
```

2. 常量：删除 `SCROLL_DEBOUNCE_MS`；新增：

```ts
/** Viewport heights below the fold that are queued before they are seen. */
const VIEWPORT_PREFETCH_SCREENS = 1;
/** Coalescing window for roots that enter the band together. */
const VISIBILITY_BATCH_MS = 150;
```

`VIEWPORT_MARGIN_PX` 保留，仅用于批内排序。

3. 状态：删除 `scrollListening`、`scrollTimer`；新增 `let visibility: VisibilityObserver | null = null;`。

4. `translatePage()`：把 `startScrollListener();` 换成 `startVisibilityObserver();`。

5. `rescan()`：在 `registry = new ParagraphRegistry();` 之前调用 `stopVisibilityObserver();`。

6. `restore()`：把 `stopScrollListener();` 换成 `stopVisibilityObserver();`。

7. 把 `collectAndQueue` 重命名为 `collectAndObserve`（含 `runScanQueue` 里的调用），末尾改成 `registerScannedNodes(nodes.slice(0, MAX_PARAGRAPHS));`。

8. 把 `queueNodes` 替换成以下三个函数（`ParagraphNode` 已在文件顶部导入）：

```ts
function startVisibilityObserver(): void {
  if (visibility) return;
  visibility = createVisibilityObserver({
    prefetchScreens: VIEWPORT_PREFETCH_SCREENS,
    batchMs: VISIBILITY_BATCH_MS,
    onVisible(ids) {
      if (!active) return;
      for (const id of ids) registry.setStatus(id, "queued");
      pump();
    },
  });
}

function stopVisibilityObserver(): void {
  visibility?.stop();
  visibility = null;
}

/**
 * Register a scanned batch and grant queue rights only to roots that are
 * already inside the viewport band. Everything else waits for the observer.
 */
function registerScannedNodes(nodes: ParagraphNode[]): void {
  for (const node of nodes) registry.add(node);
  if (nodes.length === 0) return;
  startVisibilityObserver();

  const groups = new Map<Element, string[]>();
  for (const node of nodes) {
    const ids = groups.get(node.el);
    if (ids) ids.push(node.id);
    else groups.set(node.el, [node.id]);
  }

  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  let queued = false;
  for (const [root, ids] of groups) {
    if (inPrefetchBand(root.getBoundingClientRect(), viewportHeight, VIEWPORT_PREFETCH_SCREENS)) {
      for (const id of ids) registry.setStatus(id, "queued");
      queued = true;
    } else {
      visibility!.observe(root, ids);
    }
  }
  if (queued) pump();
}
```

9. `enqueueNewParagraphs()`：把 `queueNodes(nodes);` 改成 `registerScannedNodes(nodes);`。

10. `invalidatePieceRoot()`：在 `forgetPiecesInRoot(root);` 之后加 `visibility?.unobserve(root);`。

11. 删除 `startScrollListener()`、`stopScrollListener()`、`handleScroll()` 三个函数（滚动只由观察器驱动）。确认文件里不再有 `scrollListening` / `scrollTimer` / `SCROLL_DEBOUNCE_MS` 引用。

12. 更新文件头注释里「queue」的描述为「observe/queue」。

- [ ] **Step 5: 运行并确认通过**

Run: `npx vitest run tests/unit/main.test.ts tests/unit/main-messages.test.ts tests/unit/main-ui.test.ts tests/unit/main-startup.test.ts tests/unit/main-language.test.ts`
Expected: PASS。

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/content/main.ts tests/unit/main.test.ts tests/setup/intersection-observer.ts vite.config.ts
git commit -m "feat: translate only paragraphs entering the viewport band"
```

---

### Task 3: 长页 E2E

**Files:**
- Create: `tests/fixtures/long.html`
- Modify: `tests/e2e/translate.spec.ts`（`ARTICLES` 与新增用例）

**Interfaces:**
- Consumes: 现有 `launchExtension` / `seedSettings` / `activate` / `findContentMainContext` / `evaluateInContent`。
- Produces: 无。

- [ ] **Step 1: 创建长页 fixture**

`tests/fixtures/long.html`，60 段、每段 `min-height: 120px`（≈7200px，确保 2 屏外仍有内容）：

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>E2E long article</title>
    <style>
      body { margin: 0; font: 16px/1.5 sans-serif; }
      #long p { min-height: 120px; margin: 0; padding: 8px 16px; }
    </style>
  </head>
  <body>
    <main id="long">
      <p id="long-p1">Paragraph one explains why the workshop keeps every tool within reach.</p>
      <!-- long-p2 … long-p59 同结构，文案各不相同 -->
      <p id="long-p60">Paragraph sixty closes with a note about sweeping the floor before leaving.</p>
    </main>
  </body>
</html>
```

生成剩余 58 段时，每段一行、`id` 连续；文案例如 `Paragraph N describes the bench where the next job is measured.`。

- [ ] **Step 2: 写失败测试**

在 `tests/e2e/translate.spec.ts` 的 `ARTICLES` 里加 `long: "long.html"`，并在 `test.describe("loaded extension")` 末尾追加：

```ts
test("translates the viewport band first and follows the scroll", async () => {
  try {
    server = await startMockServer();
    extension = await launchExtension();
    await seedSettings(extension.worker, server.origin);

    const page = await extension.context.newPage();
    await page.goto(`${server.origin}/${ARTICLES.long}`);
    await activate(extension.worker, await activeTabId(extension.worker, page.url()));
    const content = await findContentMainContext(page);
    await evaluateInContent(content, "globalThis.__ilmtMain.translatePage()");

    await expect(page.locator("#long-p1 .ilmt-tr")).toHaveCount(1);
    await expect(page.locator("#long-p60 .ilmt-tr")).toHaveCount(0);
    const initialCount = await page.locator(".ilmt-tr").count();
    expect(initialCount).toBeGreaterThan(0);
    expect(initialCount).toBeLessThan(30);

    await page.locator("#long-p30").scrollIntoViewIfNeeded();
    await expect(page.locator("#long-p30 .ilmt-tr")).toHaveCount(1);
    await expect(page.locator("#long-p60 .ilmt-tr")).toHaveCount(0);

    // Scrolling back must not re-request or duplicate the first paragraph.
    await page.locator("#long-p1").scrollIntoViewIfNeeded();
    await expect(page.locator("#long-p1 .ilmt-tr")).toHaveCount(1);

    await evaluateInContent(content, "globalThis.__ilmtMain.restore()");
    await expect(page.locator(".ilmt-tr")).toHaveCount(0);
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 3: 运行并确认失败**

Run: `npm run build && npx playwright test -g "translates the viewport band"`
Expected: FAIL，`#long-p60 .ilmt-tr` 或 `initialCount < 30` 不满足（改前整页会被排队翻译）。

- [ ] **Step 4: 运行并确认通过**

实现已在 Task 2 完成，本 Task 只补 E2E。

Run: `npx playwright test -g "translates the viewport band"`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add tests/fixtures/long.html tests/e2e/translate.spec.ts
git commit -m "test: cover lazy viewport translation end to end"
```

---

### Task 4: 文档与交付验证

**Files:**
- Modify: `README.md:11`
- Modify: `docs/superpowers/specs/2026-11-12-viewport-lazy-translation-design.md`（状态行）
- Modify: `docs/delivery-verification.md`（追加验证记录）

**Interfaces:**
- Consumes: Task 1–3 的行为与测试。
- Produces: 无。

- [ ] **Step 1: 更新 README 功能描述**

把第 11 行的「渐进式翻译」改成：

```md
- **看到才翻译**：按 `Opt+A` 后只翻译当前视口和下方一屏，向下滚动时自动补翻；不在视口附近的内容不会进入请求。
```

- [ ] **Step 2: 更新 spec 状态**

把 `2026-11-12-viewport-lazy-translation-design.md` 头部的 `- 状态：待实现` 改成 `- 状态：已实现（2026-11-12）`。

- [ ] **Step 3: 跑自动门禁**

Run: `npm run verify:delivery`
Expected: 单测、`tsc`、build、`check-build` 全部通过。

- [ ] **Step 4: 跑完整 E2E**

Run: `npx playwright test`
Expected: 全部通过（含新增长页用例）。

- [ ] **Step 5: 执行 P0 主流程**

按 `docs/delivery-verification.md` 第 0–2 节执行：重载扩展、`article.html` 按 `Opt+A`、检查 10/10 双语、再按恢复、popup、划词解释、控制台无红色报错。任何一项失败先修复并重跑。

- [ ] **Step 6: 追加验证记录**

在 `docs/delivery-verification.md` 末尾追加 `## 8. 本次验证记录（2026-11-12，视口懒加载）`，按现有模板逐项写「通过 / 失败」，并补一行「长页懒加载：通过（`long.html` 首屏 < 30 段，滚动后补翻，底部未翻）」；同时记录单测数量、E2E 数量。

- [ ] **Step 7: 提交**

```bash
git add README.md docs/delivery-verification.md docs/superpowers/specs/2026-11-12-viewport-lazy-translation-design.md
git commit -m "docs: describe viewport-first lazy translation"
```
