# 看到才翻译（视口懒加载）设计

- 日期：2026-11-12
- 状态：已实现（2026-11-12）
- 关联：`2026-11-04-bilingual-translate-extension-design.md` §8.4/§8.5（动态内容与批量）、`2026-11-11-hover-glossary-design.md`

## 1. 背景

当前激活后会把整页段落一次性标成 `queued`，`completeRequest()` 每次结束都继续 `pump()`，直到队列清空，因此：

- 用户只读首屏，也会为整页付翻译成本与请求时间；
- 长页面首屏的请求被后续段落挤占，首屏反而变慢；
- 与沉浸式翻译的默认体验不一致（它默认 `translationStartMode: "dynamic"`，只翻进入视口附近的内容）。

已经具备但不足以解决问题的部分：

- `takeNearestQueued()` 只做**排序**（视口优先），不做**过滤**；
- `handleScroll` 只是额外催一次 `pump()`，没有可见性门槛。

## 2. 目标

1. 激活后只翻译**当前视口 + 下方 1 屏预取**内的段落。
2. 用户向下/向上滚动进入预取带时，自动翻译新内容，无需操作。
3. 已翻译内容不因滚出视口而撤销、不重复请求。
4. 保持现有的单请求在途、批量、去重、速率限制、错误横幅、恢复原文、SPA 重扫、动态内容行为。

## 3. 非目标

- 不提供「翻译整页」入口（用户明确不要），因此不保证打印、`Ctrl+F` 找中文、整页截图能拿到全文译文。
- 不改变段落检测规则、站点规则、prompt、学习闭环、悬停词汇。
- 不引入服务端或跨页缓存；不预取「用户可能去的下一屏」之外的任何内容。

## 4. 方案

**全页扫描 + 视口授予入队权**（与沉浸式翻译同构）。

- 扫描仍然遍历整页，建立锚点/段落 id/`data-ilmt-p` 标记（本地开销，已经存在且便宜）。
- 新扫描出的段落默认状态保持 `unseen`（`ParagraphRegistry.add` 的默认值），**不再**由 `queueNodes()` 统一置为 `queued`。
- 用 `IntersectionObserver` 观察段落所属的 piece root；命中后把该 root 上的所有段落 id 置为 `queued` 并解除观察。
- `pump()` 仍然只从 `queued` 中按视口距离排序取批，因此不需要在 `takeQueued` 里再加门槛。

### 4.1 观察器

```ts
new IntersectionObserver(callback, {
  root: null,                       // 浏览器视口（含内部滚动容器的裁剪）
  rootMargin: "0px 0px 100% 0px",   // 下方预取 1 屏
  threshold: 0,
});
```

- 观察目标是 `record.el`（piece root），同一 root 可能挂多个段落 id（`data-ilmt-p` 是空格分隔列表），命中的是 root，入队的是它名下所有仍为 `unseen` 的 id。
- 用 `Map<Element, string[]>` 维护 `observedRoots`，同一 root 只观察一次；`unobserve` 后从 Map 删除。
- 回调内先同步 `unobserve`，再入队，避免同一目标重复触发。
- `isIntersecting` 为 false 的条目（首次回调就可能发生）直接忽略，继续观察。

### 4.2 初始同步带

`IntersectionObserver` 的回调永远是异步的。如果首屏也等回调，激活后要多等一个合批窗口（150ms）才发出第一批，首屏体感比现在差。因此扫描结束时先做一次同步判定：

- 对每个 piece root 调 `getBoundingClientRect()`；
- 落在「视口 + 下方 1 屏」内的 root，其名下段落立刻置 `queued`，不加入观察；
- 其余 root 交给观察器。

这一步与观察器复用同一个 `inPrefetchBand(rect, viewportHeight, prefetchScreens)` 判定，不引入第二套可见性语义。它只处理扫描完成这一刻的可见带，之后的滚动全部由观察器负责。

### 4.3 合批

快速滚动或首屏有几十段时，IO 会在一两帧内连续回调。加一个 `VISIBILITY_BATCH_MS = 150` 的合并窗口：

- 命中只置 `queued` 并排一个定时器；
- 定时器到点后清空并调用一次 `pump()`；
- 定时器在 `restore()` / `rescan()` 时清除；
- 若已有请求在途，`pump()` 自身会直接返回，由 `completeRequest()` 继续消化队列，合批不会丢段落。

### 4.4 状态流转

```
扫描 → unseen ──(IO 命中)──> queued ──pump──> inflight ──> done
                                   ↑                │
                                   └── 429 重试 ────┘
                                   failed ──(用户重试)──> queued
```

- `unseen` 的段落不显示骨架屏，也不参与 `pump()`。
- `retryFailedRequests()` 保持现状：用户点重试时把 `failed` 全部改回 `queued`（它们此前必然可见过）。
- `requeueInflight()`（端口重连）保持现状，直接回到 `queued`。

### 4.5 扫描、动态内容、SPA、恢复

- `collectAndQueue()` → 重命名为 `collectAndObserve()`：`registry.add()` 后对每个节点调用 `observeParagraph()`；不再 `setStatus("queued")`，也不再在扫描末尾调用 `pump()`（首个可见批次由 IO 回调触发）。
- `enqueueNewParagraphs()`（MutationObserver 动态内容）同样改为注册 + 观察，不直接入队。
- `invalidatePieceRoot()` 在删除记录后，若该 root 还在 `observedRoots` 中，需要 `unobserve` 并删除条目。
- `rescan()` / `restore()`：`visibilityObserver.disconnect()`、清空 `observedRoots`、清空合批定时器；随后按新页面重新观察。
- 站点规则禁用或段落超长被跳过时行为不变（本来就不会产生节点）。
- `document.visibilityState` 变化不需要专门处理：标签页重新可见时浏览器会对观察中的元素重新计算交集。

### 4.6 滚动监听

`startScrollListener()` / `handleScroll()` / `SCROLL_DEBOUNCE_MS` 删除。滚动不再驱动 pump，唯一入口是 IO 回调、mutation、请求完成、重试与重连。词汇卡片自己的滚动隐藏逻辑在 `glossary.ts`，不受影响。

### 4.7 常量

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `VIEWPORT_PREFETCH_SCREENS` | `1` | 视口下方预取屏数，换算成 `rootMargin` 底部百分比 |
| `VISIBILITY_BATCH_MS` | `150` | 可见命中合批窗口 |
| `VIEWPORT_MARGIN_PX` | 保留 `300` | 仅用于 `pump()` 的批内排序，不参与可见性判定 |
| `BATCH_SIZE` | 保留 `20` | 每个 `translate` 请求的段数 |
| `MAX_PARAGRAPHS` | 保留 `2000` | 超长页面仍只处理前 2000 个段落；这是扫描上限，不是翻译上限 |

## 5. 边界与取舍

- **打印 / Ctrl+F / 整页截图**：只有看过的部分有译文。已知并接受（用户明确不要整页入口）。
- **快速滚动**：预取 1 屏 + 150ms 合批，通常能在内容进入视口前完成请求；极快滚动时新段落会短暂显示加载骨架，与沉浸式一致。
- **首屏**：扫描是异步的（语言检测），IO 观察在扫描完成后才开始，因此首屏会出现与现在相同的“先骨架、后译文”，但不会被整页请求挤占。
- **隐藏/离屏元素**：滚动后动态加入的 `display:none` 段落不会命中 IO，保持 `unseen`；但初始同步带只用 `getBoundingClientRect()`，隐藏段落的 0×0 矩形会被当成「在视野内」而随首批翻译。这与当前「整页都翻」的行为一致，不构成回归，暂不为它引入布局探测。
- **预取内容滚过又回来**：入队后不再取消，回来时已经翻好。
- **超长页面**：`MAX_PARAGRAPHS = 2000` 之后的内容永不翻译（现状保留）。
- **无 IntersectionObserver**：目标环境是 Chrome 扩展，不做降级；单测里注入假实现。

## 6. 测试计划

单元测试（`tests/unit/main.test.ts` 等，jsdom 无 IO，需要 `globalThis.IntersectionObserver` 假实现）：

1. 扫描后所有段落为 `unseen`，且没有任何 `translate` 消息。
2. 假 IO 触发一个 root 命中：该 root 名下段落变 `queued`，150ms 后收到一个 `translate` 请求，且只包含这些段落。
3. 同一 root 重复命中不会重复入队、不会重复请求。
4. 命中两个 root 在同一个合批窗口内，只发一次请求。
5. `restore()` 会 disconnect 观察器、清掉合批定时器，之后 IO 命中不再发请求。
6. `rescan()` 后旧观察不生效，新段落重新观察。
7. 既有测试更新：原先断言“扫描即全部 queued”的用例改为断言 `unseen` + IO 驱动。

E2E（`tests/e2e/translate.spec.ts` 或新增 `lazy-translate.spec.ts`）：

1. 打开长页（视口外有可识别段落），激活后：首屏译文出现，文档后半部分仍无译文、无骨架。
2. 滚动到后半部分：对应段落出现译文，且请求数量没有覆盖整页。
3. 再按 `Opt+A`：恢复原文，观察器停止。

## 7. 验收标准

- 首次激活后的 `translate` 请求只覆盖视口 + 下方 1 屏内的段落。
- 滚动进入新区域能自动翻译，无需再次按键。
- 已翻译内容滚出视口再回来不重复请求、译文仍在。
- `npm run verify:delivery` 通过；P0 主流程（翻译 / 恢复 / popup / 划词解释）不回归。
