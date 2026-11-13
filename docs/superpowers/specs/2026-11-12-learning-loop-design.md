# 学习闭环（认领角色 + 间隔复习 + 多语言 + Prompt 分层）设计

- 日期：2026-11-12
- 状态：已实现（2026-11-12）
- 依赖：`2026-11-11-hover-glossary-design.md`（悬停释义已完成）
- 范围：方案 B「完整闭环」。方案 C（文章内就地复习）为下一期，不在本文件内。

## 1. 一句话

悬停卡片上有一个可点的「认领角色」（首期是地鼠）；点它 = **认领**这个词，词进入学习库并排队复习；侧栏按记忆曲线把词放回你面前，答对间隔变长，直到毕业。翻译由**格式层 + 偏好层**两段 prompt 驱动：格式固定、偏好可换（法律/计算机/通用…）；释义在第一次翻译时按「学习目标」一并取回。

## 2. 目标与非目标

### 目标

- 悬停释义卡片上有一个卡通角色（首期：地鼠），可点击，点击有「敲下去」的动效反馈。
- **表现层可扩展**：角色是独立皮肤模块，新增角色不改卡片核心逻辑；支持随机轮换与抗疲劳策略。
- 点击即把词写入学习库（本地），同一词只存一张卡。
- 学习库由**间隔重复**驱动，不是收藏夹：每个词有下一次到期时间。
- 复习发生在侧栏，形式是「先回想、再自评」，每第 3 次复习换成四选一抽查。
- **Prompt 分层**：输出格式由扩展固定（用户不可改），翻译风格/行业偏好可配置；偏好永远不能破坏格式与解析。
- **多语言就位**：词的身份包含语言；「学习目标」可勾选英语/日语/西班牙语/法语，翻译时顺带取回对应语言的释义并保存到学习库；**悬停卡片始终只显示目标语言释义**，额外语言只在复习时出现。
- 扩展图标徽标显示今日待复习数；不打开侧栏也能感知到压力。
- 全部数据本地存储，不上传。

### 非目标（本版明确不做）

- 不做养宠物、积分商城、排行榜、打卡奖励。
- 不做发音/TTS、音标。
- 不做术语对照表 UI（`terms` 字段预留）。
- 不做事后补译：只在第一次翻译时取回当时配置的语言；之后新加的语言对已缓存页不追溯（预留 `lookup-gloss`）。
- 不用模型生成题目（抽查干扰项从本地库里抽，零 API 成本）。
- 不做跨设备同步。
- 不做词形还原（`outlive` / `outlived` 视为两张卡；见 §14 已知限制）。
- 不做「文章内就地复习」（C 期）。

## 3. 核心语义

| 动作 | 含义 | 对调度的影响 |
| --- | --- | --- |
| 悬停看释义 | 阅读辅助 | 无 |
| 点认领角色（地鼠） | **认领**：我想记这个词 | 建卡，`box=0`，`dueAt = now + 10min` |
| 复习自评「认识」 | 想起来了 | `box+1`，按新 box 排下次 |
| 复习自评「模糊」 | 想得吃力 | `box` 不变，按当前 box 间隔重排 |
| 复习自评「忘了」 | 没想起来 | `box=0`，10 分钟后再来 |
| 抽查答错 | 等同于「忘了」 | `box=0` |
| box 5 答对 | 毕业 | `status="mastered"`，`dueAt=null` |

三条硬规则：

1. **收录 ≠ 掌握**。点角色只产生「待复习」，绝不直接标记已学会。
2. **只有侧栏的正式复习算数**。在文章里再次遇到同一个词，只更新语境与 `lastSeenAt`，不动 `box`/`dueAt`，避免刷阅读量骗间隔。
3. **复习不掺水**。抽查每 3 次强制一次，答错直接掉回 box 0。

### 3.1 语言维度

**为什么现在就要进模型**：同一个拼写在不同语言里是**不同的词**——西语 `actual` 是「当前的」，英语 `actual` 是「实际的」；`red` 在英语是颜色，在西语是「网络」。如果 `id` 只用拼写，两张卡会被合并、释义互相覆盖，以后再拆只能靠猜。所以：

- 词的身份 = **`termLang` + 归一化词形**：`id = "${termLang}:${normalized}"`。
- `termLang` 由 content 侧 `chrome.i18n.detectLanguage` 判定（复用已有 `langCache`），失败回退 `en`。

**学习目标（`settings.learningLangs`）**：默认 `["en"]`，可追加 `ja` / `es` / `fr`。它同时承担两件事：

1. **哪些页面的词值得注释**：只有 `termLang ∈ learningLangs` 的段落显示悬停注释。默认 `["en"]`，行为与今天一致；读法语页时不会给你塞英文注释。
2. **注释里带哪些额外释义**：对每个注释，除 `targetLang` 释义外，再请求 `learningLangs − {termLang, targetLang}` 的释义，随**同一次翻译请求**返回并保存。
3. **额外释义只进学习库，不上悬停卡片**：卡片永远只显示 `targetLang` 释义（不打断阅读）；额外语言只在**复习**时出现。

| learningLangs | 页面语言 | 额外释义 | 额外 token |
| --- | --- | --- | --- |
| `["en"]`（默认） | en | 无 | 0 |
| `["en","es"]` | en | es | 每段 ≤3 条 × 短词 ≈ 30–90 tokens |
| `["en","es","ja","fr"]` | en | es, ja, fr | 视为上限，见 §3.2 |

**复习时的答案语言** = `targetLang` ∪ (`learningLangs` − `{termLang}`)。勾了西语才出现「用西语复习英文词」；取消勾选后，已存的西语释义仍留在库里，只是不再出现。

### 3.2 为什么额外释义放进第一次请求

放在翻译请求里：零额外往返、零额外延迟，模型已有整段上下文，释义质量优于孤立查词。

四条护栏（必须同时满足，否则退回「翻译完成后单独批量请求」）：

1. **只挂在注释上**：额外释义挂在 `GlossaryNote.glosses`；没有注释就没有该字段；`glossaryEnabled=false` 时整块不出现。
2. **封顶**：额外语言最多 3 种（总学习语言最多 4 种），每条释义 ≤ 12 字/词，超长丢弃。
3. **失败只丢释义**：`glosses` 解析失败、语言代码不在白名单、值不是字符串 → 丢掉该字段，**译文与注释照常**（沿用现有 glossary 降级契约）。
4. **不动缓存 key**：语言列表**不参与** `promptVersion`（见 §4.4）。加了语言不应让整页重译，代价是老页面暂无新语言释义。

### 3.3 预留的补译接缝

本版不调用任何额外请求，只留四个接缝：

1. 消息 `lookup-gloss`（§10）——给已缓存的页补某语言释义。
2. 缓存 `learn-gloss-cache`（§8）。
3. UI 占位：缺语言时显示 `该语言释义尚未生成`，不回退到别的语言冒充。
4. `buildGlossPrompt()` 签名与版本位（`src/shared/prompt.ts`）。

补的时候只填 prompt + 把消息接到现有 provider 通道，`LearningWord` 结构不动。

## 4. Prompt 分层与翻译偏好

### 4.1 为什么必须分层

现状是**一个自由文本** `settings.systemPrompt` 同时承担两件事：

- **格式契约**：`[编号] 译文` 逐行对应、保留专有名词/代码/URL、注释 JSON 的形状与标记；
- **风格偏好**：语气、行业术语、意译程度。

后果：

- 用户只想加一句「法律行业，术语要严谨」，却要面对整段输出规则；改错一个字，解析失败，整段不显示。
- 格式要演进（例如新增 `glosses` 字段）时，用户手里的旧文本会**覆盖**新格式，扩展无法安全升级。
- 无法做「换行业」这种开关，只能整段替换。

分层后：

```
system prompt = 格式层（扩展拥有，不可编辑）
              + 偏好层（用户拥有，可选）
```

顺序不可颠倒：格式在前、偏好在后，并在偏好层开头写死一句「不得改变上面的输出格式」。

### 4.2 格式层

```ts
/** 开发者维护；改格式契约必须 +1，缓存随之失效。 */
export const FORMAT_VERSION = 2;

export interface FormatOptions {
  targetLang: string;
  glossaryEnabled: boolean;
  /** 额外释义语言，≤3，可为空。 */
  glossLangs: string[];
}

export function buildFormatPrompt(o: FormatOptions): string;
```

内容（示意，实际以代码常量为准）：

```
你是一个翻译引擎。把用户给出的编号段落翻译成{{targetLang}}。
输出格式（必须严格遵守，任何偏好都不得改变它）：
1. 只输出 `[编号] 译文`，逐行对应；不解释、不合并、不遗漏、不调整顺序。
2. 保留原文的专有名词、代码、URL、数字、单位与变量名。
3. 不使用 Markdown 代码块，不输出前言、后语或说明性空行。

[仅 glossaryEnabled 时追加]
注释协议：全部译文之后另起一行输出 <<<ILMT_GLOSSARY>>>，下一行只输出一个 JSON 对象……
额外释义语言：es, ja。每个注释在这几种语言下各给一条 ≤12 字的释义；缺失则省略该语言。
```

- 格式层是**唯一**决定解析契约的地方，解析器（`parseGlossaryNotes`、`parseTranslations`）只认这一层。
- 语言清单写在这一层，但**不进入版本哈希**（§4.4 说明取舍）。

### 4.3 偏好层

```ts
export type DomainPreset = "general" | "legal" | "tech" | "medical" | "literary" | "custom";

export interface TranslationPreference {
  /** 领域预设；custom 表示只靠 instructions。 */
  domain: DomainPreset;
  /** 追加说明，≤500 字。 */
  instructions: string;
  /** 预留：术语对照表（本版不做 UI）。 */
  terms?: Array<{ from: string; to: string }>;
}
```

预设文案（`src/shared/preferences.ts`）。**v1 只实现 `general` / `tech` / `custom`**，其余三个先把文案与枚举留好，不接 UI：

| domain | 文案要点 |
| --- | --- |
| `general`（默认） | 自然通顺的现代{{targetLang}}，避免翻译腔，术语用通行译法 |
| `legal` | 条款结构、主体、条件、义务、例外必须准确；法律术语用通行译法；不确定的术语保留原文括注 |
| `tech` | API、函数名、命令行、代码、错误信息、变量名保留英文；技术术语用开发者社区通行译法；语气简洁 |
| `medical` | 解剖、药物、剂量、单位精确；药名保留通用名并括注原文；不臆测诊断 |
| `literary` | 保留语气、节奏与修辞；允许意译；对话自然；不用网络流行语 |
| `custom` | 不加预设，只用用户 `instructions` |

`buildPreferencePrompt(pref)` 输出：

```
【翻译偏好】以下偏好只影响用词、语气与术语选择，不得改变上面的输出格式、段号对应或注释协议；若冲突，以输出格式为准。
{预设文案}
{用户追加说明}
```

若预设为 `general` 且无追加说明 → 返回空串，整层省略（默认请求与今天几乎等价）。

**优先级**：`provider.overrides.systemPrompt`（单提供商自定义）**替换**全局偏好层，但仍然插在格式层之后、受同一句硬约束。这样高级用户仍可定制，却不可能破坏解析。

### 4.4 版本与缓存

```ts
promptVersion = sha256(
  `v${FORMAT_VERSION}\u0000${glossaryEnabled ? "g" : ""}\u0000${preferenceText}`
);
```

- **不含 `glossLangs`**：多加一门语言不应导致整页重译。代价：加语言之前已缓存的页面不会自动带出新语言释义（复习显示占位），由 §3.3 的 `lookup-gloss` 补。
- **含 `glossaryEnabled`**：保持现有语义，开关注释会重译，让注释立刻出现。
- **含 `preferenceText`**：改偏好自然失效——这是正确的，译文确实会变。
- `promptVersion` 从「存进 settings 的字段」改为**请求时计算的派生值**；settings 上的字段标记 `@deprecated` 并迁移。
- `FORMAT_VERSION` 由开发者维护；改格式契约必须 +1。

### 4.5 迁移旧 `systemPrompt`

`getSettings()` 里一次性迁移：

- 无 `preference` 且 `systemPrompt` 为空或**等于旧默认文本** → `{ domain: "general", instructions: "" }`
- 否则 → `{ domain: "custom", instructions: 去掉旧默认开头后的剩余文本 }`（前缀匹配失败则整段保留）
- `systemPrompt` 继续可读但不写回（`@deprecated`），避免旧代码路径抛错。
- 迁移会同时 bump `FORMAT_VERSION`，老缓存失效一次，可接受（一次性成本）。

### 4.6 UI

「高级」分组里的自由提示词 textarea 移除，替换为：

- **翻译风格**：通用（默认）/ 法律 / 计算机 / 医学 / 文学 / 自定义
- **追加说明**：textarea，500 字上限，placeholder 示例「面向初学者：术语第一次出现时保留英文原文」
- **术语表**：置灰，「即将支持」
- 提供商表单里的「系统提示词」改为「该提供商的翻译偏好（仍受格式约束）」

### 4.7 风险

- 用户在追加说明里写强指令（「忽略上面的规则」）→ 由格式层在前 + 硬约束句缓解；测试里加「恶意偏好不破坏解析」用例（mock provider 回显）。
- 法律/医学预设文案需要保守，宁少不误导；文案本身要人工审。
- 「加语言不改版本哈希」是**有意的信息损失**，必须写进已知限制，不能假装没有。

## 5. 用户体验

### 5.1 阅读态：认领一个词

```
outlive  v.
比……存在得更久
Small tools often outlive their larger competitors.
                                        ╭───╮
                                        │ •ᴥ•│  ← 认领角色（半个身子在洞里）
                                        ╰───╯
```

1. 悬停原文高亮词 → 卡片出现（沿用现状）。
2. 卡片右下角出现角色，**轻轻上下探头**（2.4s 循环）。
3. 鼠标可以移进卡片（卡片从 `pointer-events:none` 改为可交互）。
4. 点击角色：角色专属动效（地鼠 = 锤子落下 → 压扁缩回 → 尘土小爆）→ 卡片右上角出现 `已抓住 · 10 分钟后复习`。
5. 卡片停留 900ms 后自动关闭。
6. 再次悬停同一个词：角色变成「已认出你」状态（趴着/打盹），点击显示 `已在学习中 · 下次复习 3 小时后`，并提供「去复习」按钮。

**卡片只显示目标语言释义**：即使该词在翻译时还取回了西语/日语释义，也不会出现在悬停卡片里。额外语言是学习库的资产，只在复习时使用。

### 5.2 复习态：侧栏

> 2026-11-13 修订：点「忘了 / 模糊 / 认识」后原地揭晓释义与完整例句，可改判，点「下一张」才计入间隔。见 `2026-11-12-review-reveal-after-grade-design.md`。

侧栏顶部新增分段控件：`对话 | 复习 (3)`，括号内是今日到期数。

复习视图顶部有一行**语言筛选**（只有库里出现 2 种及以上 `termLang` 时才显示）：

```
[ 全部 ]  [ 英语 12 ]  [ 西语 4 ]        答案语言：中文 ▾
```

- 左：按词语言过滤本轮队列（默认「全部」= 混排）。
- 右：释义语言下拉（默认 `settings.targetLang`；选了库里没有的语言 → 占位态）。
- 选择存 `sessionStorage`，不改全局设置。

复习卡片（一次一张）：

```
┌──────────────────────────────┐
│ 3 / 12                  ✕ 结束 │
│                              │
│        outlive  v.  en       │
│  Small tools often ____      │
│  their larger competitors.   │
│                              │
│  [ 想不起来，看答案 ]          │
│                              │
│  ┌────┐  ┌────┐  ┌────┐      │
│  │ 忘了 │ │ 模糊 │ │ 认识 │      │
│  └────┘  └────┘  └────┘      │
└──────────────────────────────┘
```

- 默认只给词、词性、语言标签、挖空原句；释义和完整原句点「看答案」才展开。
- **答案区是「搭配」不是「二选一」**：主行显示所选「答案语言」的释义，下方浅色小字并列其他已存语言。例如选了西语，就西语在前、中文在后；选了中文，则中文在前、西语在后。这样不牺牲母语锚点。
- 三个按钮文案**固定**为「忘了 / 模糊 / 认识」，不随角色变化。点「认识」播放该词的角色的敲击动效。
- 空状态：`今天没有要复习的词` + 今日已复习数。
- 结束页：`本轮 12 个 · 答对 9 · 明日还有 8 个`。

**抽查**：每个词维护 `checksSinceSpot`。第 3、6、9… 次复习改为四选一——题干是词 + 挖空句，四个选项是**同一 `glossLang`** 的释义，干扰项从库里其他词随机抽 3 个（优先抽本轮未出现的）。答对 → `good`；答错 → `again`，并展示正确答案。

### 5.3 徽标

- `chrome.action.setBadgeText` = 今日到期数（>99 显示 `99+`）。
- 背景色用主题青 `#2dd4bf`，文字深色。
- 到期数为 0 时清空徽标（不是显示 `0`）。

## 6. 表现层：可扩展的「认领角色」

### 6.1 为什么现在就要抽象

后续会加入其他表现形式，并随机出现以避免疲劳。如果把地鼠写死在 `glossary.ts` 里，第二个形态就要改核心逻辑。所以从第一版就分层：

- **交互契约固定**：卡片右下角有一个「认领位」，热区固定 44×44（含洞口），不随角色变化。
- **角色是纯皮肤**：只负责「怎么画、怎么动、说哪句话」，**不负责**存储、调度、命中判定、显示隐藏。
- **状态机固定**：所有角色共用 `idle → hit → caught | known`。

### 6.2 契约

```ts
export type MascotState = "idle" | "hit" | "caught" | "known";

export interface MascotSkin {
  /** 稳定 id，存进学习库用于复习时复现；发布后不可改。 */
  id: string;
  label: string;
  /** 内联 SVG 工厂：禁止外部图片/字体/网络请求，遵守 MV3 CSP。 */
  render(state: MascotState, theme: "light" | "dark"): SVGElement;
  /** 动作动词，用于 aria-label 与提示文案。 */
  verb: string;
  caughtLabel: string;
  knownLabel: string;
  /** 随机轮换的基础权重，默认 1。 */
  weight: number;
  /** 敲击动效时长；reduced-motion 时按 0 处理。 */
  hitDurationMs: number;
}
```

注册表 `src/content/mascots/index.ts`：

```ts
registerMascot(skin: MascotSkin): void;
getMascots(): MascotSkin[];
getMascot(id: string): MascotSkin | undefined;
pickMascot(opts: { enabledIds: string[]; lastPicks: string[]; seed?: number }): MascotSkin;
```

- 角色用**显式 import 静态注册**，不做动态 `import()`：避免首帧闪烁与 CSP 问题。
- 新增角色 = 新建 `mascots/<id>.ts` + 在 `index.ts` 加一行。

### 6.3 随机与抗疲劳

历史只存 `sessionStorage` 的 `ilmt:mascot-history`（最近 2 个 id），只防「同屏连续重复」，不进学习库。

`pickMascot` 规则：

1. 候选池 = 启用角色 − `lastPicks`。
2. 候选池为空（只启用 1 个）→ 忽略排除，退回全部。
3. 加权随机：`weight_i = base_i × (1 + 0.5 × 连续未出现次数)`，冷门角色概率逐渐抬升。
4. 选中后写入 `lastPicks`，只保留最近 2 个。

**同一张卡片打开期间不换角色**；下一次悬停才重抽。

### 6.4 首期形态

首期只实现 `gopher`：洞 + 半身 + 2.4s 探头循环；`hit` 锤子 + 压扁；`caught` 趴平 + `+1`；`known` 打盹。`cat` / `frog` 只留占位注释，用来验证「加角色不碰核心」。

### 6.5 设置

```ts
export interface MascotSettings {
  mode: "rotate" | "fixed";
  fixedId?: string;
  enabledIds: string[];   // 空数组 = 全部
  animations: boolean;
}
```

popup「学习」分组新增：`认领角色：随机轮换 / 固定为…` + 缩略图列表。

### 6.6 与复习的关系

- 学习库存 `mascotId`，复习卡片用**当时抓住它的那个角色**。
- 按钮文案固定，角色只负责动效。
- 角色被移除/禁用 → 回退到 `pickMascot` 结果，不报错、不丢词。

### 6.7 可访问性

- 角色是纯装饰；真正可点的是 44×44 `<button>`，`aria-label` = `把${label}打下去，收录这个单词`。
- `prefers-reduced-motion` 或关闭动效 → 不播动画，只切文案与图标。
- 键盘用户无法聚焦高亮词（CSS Highlight 限制），只能用侧栏复习。写进已知限制。

## 7. 数据模型

### 7.1 既有类型的改动

```ts
// src/shared/types.ts
export interface GlossaryNote {
  surface: string;
  pos?: string;
  meaning: string;
  example?: string;
  /** 新增：额外语言 → 释义，例如 { es: "sobrevivir a" }。 */
  glosses?: Record<string, string>;
}
```

### 7.2 学习库

```ts
export type LearningGrade = "again" | "hard" | "good";

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
  sentence: string;   // 含该词的原句，≤240 字符
  pageUrl: string;
  pageTitle?: string;
  at: number;
}

export interface WordGloss {
  lang: string;       // "zh" / "es" / "ja"
  meaning: string;
  /** translation = 随页面翻译返回（本版唯一来源）；lookup = 事后补译（预留）。 */
  source: "translation" | "lookup";
  at: number;
}

export type WordStatus = "learning" | "mastered";

export interface LearningWord {
  /** `${termLang}:${normalizeSurface(surface)}` */
  id: string;
  termLang: string;
  surface: string;
  pos?: string;
  glosses: WordGloss[];
  /** 复习默认答案语言；建卡时 = settings.targetLang。 */
  glossLang: string;
  contexts: WordContext[];
  status: WordStatus;
  box: number;              // 0..5
  dueAt: number | null;     // 毕业为 null
  mascotId?: string;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  reviews: ReviewEntry[];   // 最近 10 条
  reviewsCount: number;
  correctCount: number;
  checksSinceSpot: number;
}

export interface LearningStats {
  /** 本地日期 YYYY-MM-DD；换日时 todayReviewed 归零。 */
  day: string;
  /** 当天已复习的词数，只用于结束页文案（不做连续天数）。 */
  todayReviewed: number;
}

export interface LearningState {
  version: 1;
  words: LearningWord[];
  stats: LearningStats;
  updatedAt: number;
}
```

### 7.3 设置

```ts
export interface Settings {
  // ...既有字段
  /** 新增：学习目标语言，默认 ["en"]，最多 4 种。 */
  learningLangs: string[];
  /** 新增：翻译偏好。 */
  preference: TranslationPreference;
  /** 新增：认领角色。 */
  mascot: MascotSettings;
  /** @deprecated 迁移到 preference.instructions，保留读取。 */
  systemPrompt?: string;
  /** @deprecated 改为请求时派生，不再写入。 */
  promptVersion?: string;
}
```

`normalizeSurface`：`trim()` → 合并空白 → `toLocaleLowerCase()`；`termLang` 用 `languagePrefix()` 归一到 `en` / `es` / `zh`。
同一词形不同语言 = 两张卡（有意）；同一语言下不同词性合并成一张卡。

## 8. 存储

- key `learning` → `LearningState`。`getLearning()` 在缺失/坏 JSON/版本不符时返回空状态，**绝不抛错**。
- 写入只在 background，经串行队列（`src/background/storage-queue.ts`）read-modify-write，避免多标签页并发覆盖。
- 体积：单词约 400–800 字节。上限 **2000 词**，超出先删最早 `mastered`。10MB 配额下约 1.6MB，安全。
- 迁移：`version` 预留；修正 `termLang` 判定时写 `v1 → v2`，按新 `id` 重建并标 `legacy:true`，不直接删。
- **预留 key `learn-gloss-cache`**（本版不写）：key = `${termLang}:${glossLang}:${normalized}`，LRU 1000。

## 9. 调度算法（纯函数，可单测）

```ts
const INTERVALS_MS = [
  10 * 60 * 1000,           // box 0 → 10 分钟
  24 * 60 * 60 * 1000,      // box 1 → 1 天
  3 * 24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  16 * 24 * 60 * 60 * 1000,
  35 * 24 * 60 * 60 * 1000, // box 5 → 35 天
];
```

| grade | box | dueAt |
| --- | --- | --- |
| `again` | `0` | `now + INTERVALS[0]` |
| `hard` | 不变 | `now + INTERVALS[box]` |
| `good` | `+1`；原 5 → 毕业 | `now + INTERVALS[min(box+1,5)]`；毕业 `null` |

- 抽查答对 → `good`；答错 → `again`。
- `reviewsCount` / `correctCount`：`again`、`hard` 不加答对，`good` +1。
- 每次复习 `checksSinceSpot++`；触发抽查归零。
- 到期：`status==="learning" && dueAt!==null && dueAt<=now`。
- **语言与调度解耦**：`box`/`dueAt` 每词一份，换答案语言复习仍推进同一个盒子。
- `now` 由调用方注入，测试不依赖真实时钟。

## 10. 消息协议

```ts
export interface LearnWordMessage {
  type: "learn-word";
  surface: string;
  termLang: string;                 // content 侧 detectLanguage 判定
  glossLang: string;                // = settings.targetLang
  pos?: string;
  meaning: string;
  /** 额外语言释义，来自 GlossaryNote.glosses。 */
  glosses?: Record<string, string>;
  sentence: string;
  pageUrl: string;
  pageTitle?: string;
  mascotId?: string;
}
export interface LearnWordResponse {
  ok: true;
  created: boolean;                 // false = 已收录
  dueAt: number | null;
  nextDueLabel: string;
}

export interface ReviewAnswerMessage {
  type: "review-answer";
  id: string;
  grade: LearningGrade;
  glossLang?: string;
  spot?: boolean;
  spotCorrect?: boolean;
}
export interface ReviewAnswerResponse { ok: true; word: LearningWord }

export interface GetLearningMessage { type: "get-learning" }
export interface GetLearningResponse { ok: true; state: LearningState }

/** 预留：补译（本版返回 { ok:false, reason:"not-implemented" }，不写库）。 */
export interface LookupGlossMessage {
  type: "lookup-gloss";
  termLang: string;
  glossLang: string;
  surface: string;
  sentence: string;
}
```

- `learn-word` 幂等：同 `id` 已存在时只合并 `glosses`、追加 `contexts`、更新 `lastSeenAt`，**不重置** `box`，**不覆盖** `mascotId`。
- 侧栏与 content 可直接读 storage 渲染；**写只走消息**。
- 徽标刷新：storage 变更、`chrome.alarms` 每 30 分钟、`onStartup`、每次 `learn-word`/`review-answer` 后。

## 11. UI 改动点

### 11.1 悬停卡片（`src/content/glossary.ts` + 新 `src/content/mascots/`）

现状 `pointer-events: none`、离开即隐藏，需改 hover-intent：

- 卡片 `pointer-events: auto`；隐藏条件改为「离开词 **且** 不在卡片内」，延迟 180ms；进入卡片取消隐藏。
- 认领位固定 44×44；状态切换只调用 `MascotSkin.render`，不重建整卡。
- `click` 只绑在认领按钮，**阻止冒泡**，避免触发页面自身交互。
- 销毁时清动画、监听、`sessionStorage` 写入；`stop()` 一并清理。
- `termLang` 在 `setParagraph` 时算好并缓存（已有 `langCache`）；`termLang ∉ learningLangs` 的段落**不注册注释**。
- 额外释义取自 `note.glosses`；`glossLangs` 为空时不产生额外字段。

### 11.2 侧栏（`src/panel/main.ts` + 新 `src/panel/review.ts`）

- 顶部加分段控件 `对话 | 复习 (N)`，放在 `provider-bar` 上方。
- 复习视图独立模块；切回对话保留会话（现有 `renderAll()` 不动）。
- 只读 `LearningState`，作答后发 `review-answer`，用返回的 `word` 局部更新队列。
- 语言筛选行：`groupBy(termLang)` 生成 chip；`glossLang` 下拉取 `word.glosses` 语言并集，默认 `settings.targetLang`；选择存 `sessionStorage`。
- 复习卡片里的角色也走 `MascotSkin.render`。
- 不复用 chat 的消息列表，避免 911 行继续膨胀。

### 11.3 徽标（`src/background/index.ts`）

- 新文件 `src/background/badge.ts`：`refreshBadge()` 算到期数、写徽标。
- `chrome.alarms.create("ilmt-learning-tick", { periodInMinutes: 30 })`。
- `manifest.json` 需要 `"alarms"` 权限（先确认是否已存在）。

### 11.4 设置（popup）

- **翻译** 分组：`翻译风格` 下拉 + `追加说明` textarea + `术语表`（置灰）。
- **学习** 分组：`学习目标`（英语默认 / 日语 / 西班牙语 / 法语）、`认领角色`、`复习答案语言`、`复习方向`（置灰）。
- 高级分组移除自由提示词；provider 表单改为「该提供商的翻译偏好（仍受格式约束）」。

## 12. 失败与边界

| 场景 | 行为 |
| --- | --- |
| 存储写满 / 超配额 | 卡片显示 `保存失败 · 学习库已满`；超 2000 词先清理最早 `mastered` |
| 扩展重载导致 context invalidated | `sendMessage` try/catch 吞掉，UI 不动 |
| 关闭「学习注释」 | 悬停卡片消失；已收录的词与复习不受影响 |
| 同词多标签页同时点击 | background 串行队列保证只建一张卡 |
| 库里少于 4 个词 | 抽查退化为自评，记 `spot:false` |
| 角色 id 未知 | 回退 `pickMascot` 结果，词不丢、不报错 |
| 只启用 1 个角色 | 轮换失效，恒定使用该角色 |
| 同形不同语言 | 两张卡（`id` 含 `termLang`） |
| 所选 `glossLang` 下没有释义 | 显示 `该语言释义尚未生成`，不回退冒充 |
| 语言检测失败 / 太短 | `termLang` 回退 `en`，保留原句便于人工纠正 |
| 页面语言不在学习目标 | 该页不生成注释（省 token，也避免噪音） |
| 用户偏好写成强指令 | 格式层在前 + 硬约束句；解析失败仍只丢注释，译文照常 |
| 加语言后访问旧缓存页 | 复用译文，缺的语言显示占位（不改缓存 key 的代价） |
| 侧栏未打开 | 徽标照常计数；popup 里加「待复习 N · 打开复习」入口 |

## 13. 测试

### 单测（Vitest）

- **prompt 分层**：格式层永远存在且包含 `[编号]` 契约；`glossaryEnabled=false` 时不出现注释标记；`glossLangs` 非空时语言清单出现在格式层；偏好层为空时不产生多余空行；`domain` 预设文本被包含；`provider.overrides.systemPrompt` 只替换偏好层、**不替换**格式层。
- **promptVersion**：改 `preference` → 变化；改 `FORMAT_VERSION` → 变化；切 `glossaryEnabled` → 变化；**改 `glossLangs` → 不变**（明确断言，防止以后误改）。
- **解析**：`glosses` 合法 → 保留；未知语言代码 → 丢弃；值非字符串/超长 → 丢弃；无 `glosses` → 行为与今天一致；注释解析失败 → 译文仍可用。
- **迁移**：旧默认 `systemPrompt` → `general + 空`；自定义文本 → `custom + 文本`；`preference` 已存在 → 不覆盖。
- `srs.ts`：3 档 × 6 个 box 全转移表；毕业边界；`formatDueLabel()` 各时间档；换 `glossLang` 不影响 `box`。
- `learning-storage.ts`：缺 key / 坏 JSON / 版本不符 → 空状态；语境 FIFO；`reviews` 截断 10；2000 词淘汰；`todayReviewed` 跨本地午夜归零。
- **去重**：大小写/空白归一；`en:actual` 与 `es:actual` 不合并。
- `pickMascot`：排除最近 2 个；池空回退；`fixed` 恒定；单角色稳定；权重冷却使分布均衡（固定 seed 跑 10000 次）；SVG 无外部引用。
- background：`learn-word` 幂等（两次 → `created:false`、`box` 不变、`mascotId` 不覆盖、`glosses` 合并）；`review-answer` 并发 5 次不丢写。
- 徽标：0 → `""`，1 → `"1"`，120 → `"99+"`。

### E2E（Playwright，沿用现有 fixture）

1. 翻译页面 → 悬停高亮词 → 卡片出现 → 点击角色 → `words.length===1`、`dueAt≈now+10min`、`mascotId==="gopher"`、`termLang==="en"`、徽标 `1`。
2. 同词再悬停 → `known` 状态，文案含「已在学习中」。
3. 打开侧栏 → 复习显示该词与同一角色 → 点「认识」→ `box===1`、`dueAt≈now+1d`。
4. 第 3 次复习四选一，答错 → `box===0`。
5. 连对到 box 5 → `mastered`、徽标清空。
6. 注入一条 `termLang:"es"` 的词 → 语言筛选出现「英语/西语」，切西语只剩 1 张。
7. 切到 `legal` 预设翻译 → mock provider 收到含格式层 + 法律偏好的 system prompt（断言两段都在）。
8. `prefers-reduced-motion` → 无动画类，但文案与存储正确。

### P0 回归

`npm run verify:delivery` + `docs/delivery-verification.md` 主流程全过：翻译、双语、还原、popup、划词解释。**新增卡片交互不能破坏原有悬停隐藏逻辑；prompt 分层不能破坏既有解析**，这是本版两个最高回归风险。

## 14. 已知限制

- 悬停卡片**不显示**额外语言释义（有意保持阅读干净），只有复习时能看到。
- 无词形还原：`outlive` 与 `outlived` 是两张卡。
- 事后加语言不追溯旧缓存页：只显示占位，等 `lookup-gloss` 补。
- 语言检测对短词/专有名词可能误判，回退 `en`；暂不支持手动改词的语言。
- 翻译偏好只影响翻译，不影响侧栏问答。
- 复习只能在侧栏做，窄屏未验证。
- 抽查选项措辞可能高度相似，跨语言混排时更明显。
- CSS Custom Highlight 不可聚焦，键盘用户无法用悬停卡片收录。
- 角色是内联 SVG，超过约 10 个角色需改分包懒加载。

## 15. 落地顺序（拆成 7 步）

1. **数据层**：`types.ts`（`termLang`/`glosses`/`preference`/`mascot`）+ `srs.ts` + `learning-storage.ts` + 设置迁移 + 单测。
2. **Prompt 分层**：`FORMAT_VERSION`、`buildFormatPrompt`、`preferences.ts`、`buildSystemPrompt`、`buildPromptVersion`、解析 `glosses`、dispatch 接线、迁移测试。
3. **background**：`learn-word` / `review-answer` / `get-learning` + 串行队列 + 徽标 + alarm + `lookup-gloss` 占位 + 单测。
4. **表现层骨架 + 地鼠**：`MascotSkin`、注册表、`pickMascot`、hover-intent、gopher 皮肤、收录反馈、`termLang` 检测（风险最高，单独提交）。
5. **侧栏复习视图**：分段控件 + 卡片 + 三档自评 + 语言筛选。
6. **抽查 + 设置 + 统计**：抽查逻辑、角色设置、翻译风格 UI（通用/计算机/自定义）、学习目标 UI、popup 待复习入口。
7. **回归与文档**：`verify:delivery`、P0 主流程、更新 spec 状态。

## 16. 已确认的决定

- **学习目标语义**：勾选的语言决定「哪些页面的词值得注释」，并为注释请求这些语言的释义；但**悬停卡片只显示目标语言释义**，额外语言只在复习时出现（答案区中文与其他语言并列）。
- **翻译风格**：v1 只做 `general`（默认）/ `tech`（计算机）/ `custom`；法律、医学、文学留枚举与文案，不接 UI。
- **连续天数与导出 JSON**：本版不做，留到以后。
- **角色数量**：首期只做地鼠；`cat` / `frog` 只留占位注释验证扩展成本。
- 复习按钮文案固定为「忘了 / 模糊 / 认识」。
- 「暂停/移除某个词」本版不做。
