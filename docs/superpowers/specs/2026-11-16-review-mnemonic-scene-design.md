# 复习「演出式」记忆钩子设计（mnemonic scene）

- 日期：2026-11-16
- 状态：已实现（2026-11-16）
- 相关：`2026-11-13-claim-effects-design.md`（特效契约）、`2026-11-12-review-reveal-after-grade-design.md`（复习揭晓）

## 1. 问题

复习时点「忘了 / 模糊 / 认识」，揭晓的只有：目标语言释义、其他语言释义、补全后的原句。
用户反馈这「只是把原句拿出来」，没有加深印象。再叠一块「释义 + 词根提示」虽然有用，
但和市面上的背单词软件没有区别。

## 2. 目标

1. 揭晓时，**该词的收录特效演一次**：地鼠把词拖进洞里、磁铁把它吸过去、猫把词抱进怀里、
   贴纸猫掀起来上色——用这只用户自己选的角色把词「演」出来。
2. 演出配一行**画面钩子**字幕（模型生成，≤40 字，荒诞但贴住词义），字幕才是记忆的抓手。
3. 每个词只生成一次，落库；同一台设备离线再复习时仍有字幕，只是不重新生成。
4. 可以「再看一次」重播，不重新请求模型。
5. 不阻塞复习：生成失败、没有 provider，都只是少一块演出，评级和间隔照旧。

## 3. 非目标

- 不做新的特效（复用已注册的四个）。
- 不生成图片、不做语音、不改 SRS 间隔算法。
- 不做「换句再认」「词素拼装」——用户在方案里选了 C。

## 4. 交互

揭晓后，在释义与完整例句之间插入一块 `ilmt-review-scene`：

```
[特效舞台 56×52]  给它想一个画面…            ← 生成中
[特效舞台 56×52]  小工具活过了它的对手，猫把它抱进了怀里。   [再看一次]
[特效舞台 56×52]  画面没生成出来 · 重试        ← 失败
```

- 有缓存：直接显示字幕并播放一次（约 700ms）。
- 无缓存：请求 `mnemonic` 消息，成功即落库并播放；失败显示重试，不弹错误条。
- 答案展开后右上角的装饰头像隐藏，避免同一张脸在场景里出现两次。
- 字幕跟随「复习答案语言」（默认中文）；模型失败时退回目标语言释义已够用。

## 5. 契约变化

`ClaimHandle` 增加一个可选方法：

```ts
export interface ClaimHandle {
  setState(phase: ClaimPhase): void;
  /** Optional: play the claim animation without claiming. */
  play?(): void;
  destroy(): void;
}
```

- `play()` 只做演出：进入 `hit` 相位、播各自的动画、结束后回到调用前的相位。
- 演出期间不接受点击（与真实点击共用 `busy`），`destroy()` 清掉定时器。
- 卡片（悬停卡）不调用 `play`，行为不变；只有复习舞台调用。

## 6. 数据

```ts
export interface WordMnemonic {
  /** 一行画面钩子，≤40 字。 */
  caption: string;
  lang: string;
  at: number;
}

export interface LearningWord {
  // …
  mnemonic?: WordMnemonic;
}
```

`parseLearningState` 负责容错：非对象、空字幕、超长字幕都丢弃，旧数据无字段照常可用。

## 7. 消息与提示词

```ts
{ type: "mnemonic", id: "en:outlive" }
→ { ok: true, mnemonic } | { ok: false, reason: "no-provider" | "failed" | "unknown-word" }
```

提示词（`src/shared/mnemonic.ts`，纯函数）：

- 角色：记忆教练。
- 输入：词、词性（可选）、当前语境释义、原句。
- 输出：一行画面，≤40 字；必须是谁在做什么的具体画面；不解释词义、不翻译、不加引号、不用列表。
- 温度 0.8，`max_tokens` 120，非流式；生成后 `sanitizeCaption` 去引号/换行、截断 40 字。

## 8. 落点

| 文件 | 变化 |
| --- | --- |
| `src/shared/mnemonic.ts` | 新增：提示词与清洗 |
| `src/background/mnemonic.ts` | 新增：读库 → 缓存命中直接回 → 调模型 → 落库 |
| `src/background/learning.ts` | 消息分发加 `mnemonic` |
| `src/content/effects/types.ts` + 四个特效 | `play?()` |
| `src/panel/review.ts` | 舞台块、请求、重播、失败重试 |
| `src/styles/panel.css` | 舞台样式 |
| `tests/mock-server.ts` | 识别画面请求并回一句话 |

## 9. 测试

- 纯函数：提示词包含词与释义；清洗去引号、压成单行、截断。
- 背景：命中缓存不请求；未命中生成并写库；失败回 `{ ok: false }`；无 provider 回 `no-provider`；不认识词回 `unknown-word`。
- 特效：`play()` 进入 `hit` 并在各自的动画时长后回到原相位；期间不再 claim；`destroy()` 中止。
- 面板：揭晓触发请求；成功渲染字幕并调用 `play`；失败显示重试；「再看一次」只 `play` 不请求；演出时头像隐藏。
- E2E：mock provider 回画面 → 点评级 → 字幕出现 → 重播。

## 10. 已知限制

- 字幕质量取决于模型；`temperature 0.8` 会有波动，但只生成一次，之后稳定。
- 四个特效的「演出」是各自固定的动作，不随字幕内容变化——字幕负责语义，动作负责记忆锚点。
- 没有 provider 时只有一次重试机会，不会排队后台重试。
