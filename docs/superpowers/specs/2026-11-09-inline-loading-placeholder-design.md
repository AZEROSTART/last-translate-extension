# 翻译中的分段 loading 占位 · 设计文档

- 日期：2026-11-09
- 状态：待批准
- 范围：内容脚本在发送翻译批次时，为每个在途片段插入骨架占位；不改后台、模型、队列、缓存、侧栏
- 关联：`2026-11-08-text-node-translation-design.md`

---

## 1. 意图

当前多段翻译按 20 段一批发送，且多段批次走非流式请求。模型/网关较慢时，用户点「翻译当前页面」后很久看不到任何译文，只会觉得“没反应”，甚至再次点击把请求取消。

本轮给**正在翻译的片段**加一个可感知的 loading 占位：点翻译后，原文下方立即出现一条呼吸中的骨架条；译文返回时同一个位置原地替换成译文。用户一眼就能看到翻译已经开始、哪些段落正在处理。

用户已选定：**骨架/呼吸条**，而不是「翻译中…」文字。

---

## 2. 目标 / 非目标 / 反目标

### 目标

- 每个进入在途批次（`inflight`，最多 20 段）的片段，在发送请求前立即出现骨架占位。
- 骨架出现在该片段译文最终会出现的同一安全锚点，不碰原文文本节点。
- 译文（流式 delta 或多段 result）到达时，同一个 `.ilmt-tr` 节点原地替换为译文，骨架消失。
- 失败、取消、还原时占位被正确清理，不残留、不永久闪烁。
- 标题占位比正文占位小一号，保持与 Style A 的标题译文一致。

### 非目标

- 不给尚未进入批次的排队段落显示占位（避免整页 2000 段同时插节点）。
- 不做百分比、进度条或「已完成 N/M」。
- 不改后台、模型、队列、超时和取消语义。
- 不增加新的运行时依赖。

### 反目标（即使「能跑」也算失败）

- 为了 loading 修改页面原有文本节点或给原元素加 style/class。
- 把占位插入 `<button>`、`<a role="button">`、`<summary>`、`<label>` 等交互元素内部。
- 失败或还原后仍留下空骨架，让用户以为一直在翻译。
- 每次滚动/动态加载都重新插一遍占位，造成闪动或重复节点。

---

## 3. 约束

- Chrome MV3 content script，TypeScript + 原生 DOM，无 React。
- 样式只走 manifest 注入的 `inject.css`，CSP 安全，不往页面插 `<style>` 或内联样式。
- 所有用户可见/可读文案保持中文（`aria-label="翻译中"`）。
- 原文文本节点只读；只新增 `.ilmt-tr` 节点和 `data-ilmt-p` 标记属性。
- 单元测试、`npx tsc --noEmit`、`npm run build` 必须通过。

---

## 4. 方案对比（用户已选 A）

| 方案 | 做法 | 代价 | 结论 |
|------|------|------|------|
| **A. 批次发出时插骨架** | `pump()` 取到下一批并标记 `inflight` 后，给这批每段插入骨架 | 只覆盖在途批次，未轮到的段落暂时无反馈；但第一批就是视口最近的 20 段，足够覆盖当前屏幕，DOM 和清理都简单 | **选 A** |
| B. 入队即给视口附近段落插骨架 | 入队时按视口范围给所有近处段落插骨架 | 整屏反馈更早，但长页面节点多，滚动/失败/取消的清理复杂，容易闪动 | 否 |
| C. 只加顶部进度提示 | 在现有 banner 上显示“正在翻译 3/20” | 改动最小，但仍不知道具体哪一段在翻，不符合“在被翻译的部分加 loading”的要求 | 否 |

---

## 5. 交互与状态

### 5.1 插入时机

在 `main.ts` 的 `pump()` 中：

1. `takeNearestQueued(BATCH_SIZE)` 选出本批记录并标记 `inflight`。
2. 对每条记录解析 `el` / `anchor`；根或锚点已断开时跳过占位（照常入队）。
3. 调用 `renderLoading({ root, anchor, heading }, id, targetLang)` 插入骨架。
4. 再 `send({ type: "translate", ... })`。

只给本批（≤20 段）插占位，不给全部排队段落插。

### 5.2 节点形态

```html
<span
  class="ilmt-tr ilmt-block"
  data-ilmt-for="p_123"
  data-loading="1"
  aria-busy="true"
  aria-label="翻译中"
  lang="zh-CN"
></span>
```

标题占位额外带 `data-ilmt-heading="1"`，与最终译文节点完全一致，保证锚点和布局不跳。

### 5.3 视觉

- 沿用 Style A 的位置、外边距和左侧细线。
- `.ilmt-tr[data-loading="1"]::before` 画一条呼吸条：
  - 正文：高度约 `0.95em`，宽度 100%，圆角 4px，`currentColor` 低透明度，`1.4s ease-in-out` 循环。
  - 标题：高度约 `0.62em`，宽度上限 `8em`。
- 骨架层 `opacity: 1`，不受 `.ilmt-block` 的 `0.78` 弱化影响。
- `prefers-reduced-motion: reduce` 时停止动画，只保留静态浅色条。
- 不写死浅色/深色；用 `currentColor` + 透明度适配页面主题。

### 5.4 生命周期

| 事件 | 占位处理 |
|------|----------|
| 批次发出 | 插入骨架 |
| 单段流式第一个 delta 到达 | 同一节点写入文本，移除 `data-loading` / `aria-busy` / `aria-label` |
| 多段 result 到达 | 同一节点写入译文，移除 loading 标记；即使根/锚点失效也要清标记 |
| 429 自动重试 | 记录回到 `queued`，占位保留（仍待翻译） |
| 端口断开重连 | `requeueInflight`，占位保留，后续批次复用同一节点 |
| 失败（非重试） | `failIds`：仍为 loading 的空节点直接移除；已有部分译文的节点只清 loading 标记 |
| 还原 / rescan | 现有 `restoreAll` 移除所有 `.ilmt-tr` 和 `data-ilmt-p` |
| 记录被 prune | 现有 `pruneOrphanTranslations` 按 `data-ilmt-for` 清理 |

---

## 6. 改动点

```
src/content/render.ts     提取节点创建/插入的共用逻辑；新增 renderLoading / discardLoading；复用节点时清 loading 标记
src/content/main.ts       pump 中插入占位；result / delta / failIds 清占位
src/styles/inject.css     用呼吸条替换旧的 data-loading 半透明样式
tests/unit/render.test.ts 占位插入、复用、还原
tests/unit/main-ui.test.ts 批次占位数量、返回后清除、失败清理
tests/unit/build.test.ts  构建产物包含骨架样式（可选）
```

不改 `registry.ts`、`paragraphs.ts`、后台和 provider。

---

## 7. 测试计划

### 7.1 `render.test.ts`

- `renderLoading` 在段落内插入 `.ilmt-block`，带 `data-loading` 和 `aria-busy`。
- 占位不会插入按钮内部。
- 同一 id 随后 `renderTranslation` 时复用同一个节点，文本正确，`data-loading` 消失。
- 标题占位带 `data-ilmt-heading="1"`。
- `restoreAll` 删除占位并把 DOM 还原到翻译前。

### 7.2 `main-ui.test.ts`

- 21 段页面启动翻译后，只有首批（20 段）有 `data-loading`，第 21 段没有。
- 收到 result 后，对应 `data-loading` 消失并显示译文。
- 收到非重试错误后，loading 节点被移除，不残留空骨架。
- `restore()` 后没有 `.ilmt-tr[data-loading="1"]`。

### 7.3 验证

- `npm test`
- `npx tsc --noEmit`
- `npm run build`
- 手动：GitHub 慢网/慢网关下点翻译，屏幕内段落立即出现骨架，译文返回后原地替换。

---

## 8. 明确不做

- 不修「再次点击取消翻译」的问题（单独处理）。
- 不改 15s 连接超时 / 45s 首 token / 180s 总超时。
- 不给缓存命中段做特殊占位（缓存结果返回很快，骨架一闪而过可以接受）。
- 不做骨架的站点级差异样式，先统一一套。
