# 右键菜单「翻译当前页面」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在网页右键菜单里增加「翻译当前页面」，点击后复用现有 `Alt+A` 链路翻译当前标签页。

**Architecture:** 只在 background service worker 里注册 `chrome.contextMenus` 菜单并监听点击；点击时调用现有的 `sendToCommandTab(tab, { type: "activate" })`，不新增消息类型、不改内容脚本、不改 manifest 权限。

**Tech Stack:** TypeScript、Chrome MV3、Vitest、jsdom

**Spec:** `docs/superpowers/specs/2026-11-08-context-menu-translate-design.md`

## Global Constraints

- 所有用户可见文案必须是中文。
- 不新增扩展权限；`contextMenus` 已在 manifest 中声明。
- 不修改页面原始文本节点；本功能完全复用现有内容脚本。
- 不修改 `Alt+A` 的绑定逻辑。
- 所有现有测试、`npx tsc --noEmit`、`npm run build` 必须保持通过。
- 菜单项固定为：id `translate-page`，文案「翻译当前页面」，`contexts: ["page"]`。

## Review Focus

- 右键点击时页面已有选区：`contexts: ["page"]` 仍应显示菜单，不能因为选区而消失。
- 在 `chrome://` 等受保护页面右键：Chrome 不显示扩展菜单，不做特殊处理。
- 扩展更新后未刷新的旧页面：没有内容脚本接收消息，必须静默失败，不能抛错。
- 连续点击两次菜单：`translatePage` 的幂等保护应阻止重复翻译。
- 菜单 id 重复注册：`onInstalled` 里先 `removeAll()`，创建失败也必须吞掉，不能影响后台其他监听器。

---

### Task 1: 注册「翻译当前页面」右键菜单

**Files:**
- Modify: `src/background/index.ts`
- Test: `tests/unit/background-index.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - 常量 `TRANSLATE_PAGE_MENU_ID = "translate-page"`（模块内）
  - 注册函数 `registerTranslateContextMenu(): void`（模块内，不导出）
  - 菜单项 `{ id: TRANSLATE_PAGE_MENU_ID, title: "翻译当前页面", contexts: ["page"] }`

- [ ] **Step 1: 扩展测试用的 chrome mock，并写失败测试**

在 `tests/unit/background-index.test.ts` 的 `installChrome()` 里增加：

```ts
const onInstalled: Listener[] = [];
const contextMenusCreate = vi.fn();
const contextMenusRemoveAll = vi.fn((callback?: () => void) => {
  callback?.();
});
```

在返回的 `chrome` 对象里加入：

```ts
runtime: {
  // ...existing fields
  onInstalled: { addListener: (cb: Listener) => onInstalled.push(cb) },
},
contextMenus: {
  create: contextMenusCreate,
  removeAll: contextMenusRemoveAll,
},
```

并在这两个返回对象里补上 `onInstalled`、`contextMenusCreate`、`contextMenusRemoveAll`。

新增测试：

```ts
it("registers the translate-page context menu on install", async () => {
  const { onInstalled, contextMenusCreate, contextMenusRemoveAll } = installChrome();
  await importIndexAndSpyOnQueue();

  onInstalled[0]({ reason: "install" });

  expect(contextMenusRemoveAll).toHaveBeenCalledTimes(1);
  expect(contextMenusCreate).toHaveBeenCalledWith(
    { id: "translate-page", title: "翻译当前页面", contexts: ["page"] },
    expect.any(Function),
  );
});

it("re-registers the context menu on extension update", async () => {
  const { onInstalled, contextMenusCreate } = installChrome();
  await importIndexAndSpyOnQueue();

  onInstalled[0]({ reason: "update" });

  expect(contextMenusCreate).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/background-index.test.ts -t "context menu"`
Expected: FAIL，因为 `onInstalled` 没有被调用，`contextMenusCreate` 调用次数为 0。

- [ ] **Step 3: 在 `src/background/index.ts` 实现菜单注册**

在 `sendToCommandTab` 之后、`chrome.commands.onCommand` 之前加入：

```ts
const TRANSLATE_PAGE_MENU_ID = "translate-page";

function registerTranslateContextMenu(): void {
  const create = (): void => {
    try {
      chrome.contextMenus.create(
        { id: TRANSLATE_PAGE_MENU_ID, title: "翻译当前页面", contexts: ["page"] },
        () => {
          // Duplicate ids after a reload are harmless; reading lastError keeps
          // Chrome from logging an unchecked-error warning.
          void chrome.runtime.lastError;
        },
      );
    } catch {
      // Context menus unavailable; never break the service worker.
    }
  };

  try {
    chrome.contextMenus.removeAll(() => create());
  } catch {
    create();
  }
}

chrome.runtime.onInstalled.addListener(() => {
  registerTranslateContextMenu();
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/background-index.test.ts -t "context menu"`
Expected: PASS（2 tests）。

- [ ] **Step 5: 提交**

```bash
git add src/background/index.ts tests/unit/background-index.test.ts
git commit -m "feat: register translate-page context menu"
```

---

### Task 2: 点击菜单时触发当前标签页翻译

**Files:**
- Modify: `src/background/index.ts`
- Test: `tests/unit/background-index.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `TRANSLATE_PAGE_MENU_ID`；现有的 `sendToCommandTab(tab, message)`
- Produces: `chrome.contextMenus.onClicked` 监听器；点击 `translate-page` 时发送 `{ type: "activate" }`

- [ ] **Step 1: 写失败测试**

在 `installChrome()` 里增加：

```ts
const onContextMenuClicked: Listener[] = [];
```

在 `chrome.contextMenus` 里加入：

```ts
onClicked: { addListener: (cb: Listener) => onContextMenuClicked.push(cb) },
```

并返回 `onContextMenuClicked`。

新增测试：

```ts
it("sends activate when the translate-page menu is clicked", async () => {
  const { onContextMenuClicked, tabsQuery, tabsSendMessage } = installChrome();
  await importIndexAndSpyOnQueue();

  onContextMenuClicked[0]({ menuItemId: "translate-page" }, { id: 7 });

  expect(tabsQuery).not.toHaveBeenCalled();
  expect(tabsSendMessage).toHaveBeenCalledWith(7, { type: "activate" });
});

it("ignores other context menu ids", async () => {
  const { onContextMenuClicked, tabsSendMessage } = installChrome();
  await importIndexAndSpyOnQueue();

  onContextMenuClicked[0]({ menuItemId: "something-else" }, { id: 7 });

  expect(tabsSendMessage).not.toHaveBeenCalled();
});

it("falls back to the active tab when a menu click has no tab", async () => {
  const { onContextMenuClicked, tabsQuery, tabsSendMessage } = installChrome();
  await importIndexAndSpyOnQueue();

  onContextMenuClicked[0]({ menuItemId: "translate-page" }, undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(tabsQuery).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
  expect(tabsSendMessage).toHaveBeenCalledWith(42, { type: "activate" });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/background-index.test.ts -t "context menu"`
Expected: FAIL，`tabsSendMessage` 没有被调用。

- [ ] **Step 3: 在 `src/background/index.ts` 实现点击处理**

在注册函数之后加入：

```ts
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== TRANSLATE_PAGE_MENU_ID) return;
  sendToCommandTab(tab, { type: "activate" });
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/background-index.test.ts -t "context menu"`
Expected: PASS（5 tests）。

- [ ] **Step 5: 提交**

```bash
git add src/background/index.ts tests/unit/background-index.test.ts
git commit -m "feat: translate current page from context menu"
```

---

### Task 3: 全量验证与收尾

**Files:**
- 无新增；只验证 Task 1–2 的改动

**Interfaces:**
- Consumes: Task 1–2
- Produces: 可合并的干净工作树

- [ ] **Step 1: 运行完整单元测试**

Run: `npm test`
Expected: 全部通过，无新增失败。

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出，退出码 0。

- [ ] **Step 3: 构建并检查产物**

Run: `npm run build && node scripts/check-build.mjs`
Expected: 构建成功，检查脚本无报错。

- [ ] **Step 4: 在真实 Chrome 里手动验证**

1. 重新加载扩展（`chrome://extensions` → 刷新本扩展）。
2. 打开任意英文网页。
3. 右键，确认出现「翻译当前页面」。
4. 点击，确认顶部出现翻译横幅、段落下方出现中文译文。
5. 再次右键点击，确认没有重复译文。

若浏览器由 `opencli` 控制，可先打开测试页，再让用户手动右键；`opencli` 不保证能模拟浏览器原生右键菜单。

- [ ] **Step 5: 清理临时诊断文件（如果仍在）**

```bash
rm -f tests/e2e/shortcut-diagnostic.spec.ts
rm -rf test-results
```

不要删除 `tests/e2e/translate.spec.ts`。

- [ ] **Step 6: 提交收尾**

```bash
git add -A
git commit -m "chore: clean up shortcut diagnostics"
```

如果没有可提交的内容，跳过此步。

---

## Self-Review

- **Spec coverage:** 菜单注册（Task 1）、点击触发（Task 2）、验收与验证（Task 3）覆盖设计文档全部要求。
- **Step scan:** 每个实现步骤都给出了具体文件、签名和固定文案；测试步骤给出了完整断言。
- **Type consistency:** `TRANSLATE_PAGE_MENU_ID`、`registerTranslateContextMenu`、`sendToCommandTab` 在任务间命名一致。
- **Review Focus:** 选区、受保护页面、旧页面无内容脚本、重复点击、重复 id 五个风险点都已在 Review Focus 中列出，并在 Task 1–2 的测试或实现中处理。
- **Proportion:** 计划只描述一个后台文件和一个测试文件的改动，没有复述现有翻译逻辑。
