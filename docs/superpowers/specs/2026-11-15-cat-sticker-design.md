# 收录特效：纸缝猫（照片贴纸）设计

- 日期：2026-11-15
- 状态：已实现
- 相关：`2026-11-13-claim-effects-design.md`（特效契约）、`2026-11-14-cat-hoard-design.md`（第三个特效，重画的猫）
- 素材：用户提供的第二张猫照（长毛金渐层、被托在手里、瞪大眼睛），原图存在 `docs/assets/cat-held-original.jpg`

## 1. 意图

用户拿了一张新照片，问「这次可以抠图吗」，并明确要求**新增**而不是替换已有的「怀里猫」。
前一只猫是矢量重画（能换色、能分部件动），这一只正好相反：保留照片的毛物质感，
接受「不能换色、只能整体做动作」的代价。两只猫并列存在，交给轮换去决定。

## 2. 目标

1. 用**真照片抠图**做一个收录特效，与地鼠 / 磁铁 / 怀里猫并列，进入默认轮换。
2. 抠图不引入新依赖、不改 manifest、不在页面上发起任何资源请求。
3. 动效只做照片能可信做到的动作：贴在词下方轻晃、点击时「掀起来再拍回去」、已收录时降饱和。
4. 复习卡右上角的 50×44 头像位不能被子图撑破。

## 3. 非目标

- 不做表情、不做眨眼、不做多帧。
- 不保留照片里那只手和袖口（默认裁掉，用户未反对）。
- 不替换「怀里猫」，不改 `ClaimEffect` 契约。

## 4. 抠图与资产管线

1. 原图从会话附件里取出，落到 `docs/assets/cat-held-original.jpg`（2000×1500）。
2. `sips -r 90` 转正（原图是横着拍的）。
3. macOS Vision `VNGenerateForegroundInstanceMaskRequest` 做主体提取，输出带 alpha 的 PNG。
   胡须与毛边都保住了，手被去掉。
4. `scripts/photo-sticker.swift` 裁到头部到胸口（`40 30 1150 1030`）、去透明边、缩到 176px 宽、
   沿 alpha 轮廓做 `CIMorphologyMaximum` 膨胀 5px 并填白——这就是 die-cut 白边。
5. `cwebp -q 90 -alpha_q 100` 转 WebP，**8.6KB**。

放进 `src/content/effects/assets/cat-held.webp`，由 `vite.config.ts` 的 `assetsInlineLimit`
强制内联成 data URI（默认阈值 4KB 会把它拆成单独文件，那需要 `web_accessible_resources`，
并且会被页面的 `img-src` CSP 约束）。

## 5. 方案取舍

| 方案 | 说明 | 结论 |
| --- | --- | --- |
| A. 卡片上开一道纸缝，猫从缝里探出来 | 能藏住照片底部被画框切平的边 | 否：缝比切边窄时毛边会露在缝两侧，缝要比猫还宽才成立，看起来像地基 |
| B. 白边贴纸（选定） | 白描边把平切边变成「贴纸边缘」，深浅色都成立；配 CSS 投影就能从卡面浮起来 | 是：实现最省，也最像真贴纸 |
| C. 羽化底部边缘 | 没有硬边 | 否：像幽灵，不像纸 |

## 6. 动效时序

| 阶段 | 时长 | 画面 |
| --- | --- | --- |
| `idle` | 循环 3.8s | 上下浮 2px、轻微旋转 -0.7° |
| `hit` | 720ms | 18% 掀起到 -7px/-4°，36% 顶点 -9px/-5°（缩放 1.04），56% 拍回卡面并压扁到 `1.02 × 0.96`，74% 回弹，100% 归位 |
| `settled` | 定格 | 停住，右侧淡入 `+1 已收录` |
| `known` | 定格 | `saturate(.25)` + 0.9 透明度，表示这一页的猫已经认识这个词 |

动效关闭时：点击后直接落到终态，不播放 keyframes。

## 7. 落点

- `src/content/effects/cat-sticker.ts`：`id: "cat-sticker"`、`label: "贴纸猫"`、`reserve.below = 84`。
  （最初叫「纸缝猫」，纸缝方案在 §5 被否掉，名字随之改成贴纸。）
- 复习卡：效果自己的 CSS 里带一条 `.ilmt-review-mascot [data-ilmt-effect="cat-sticker"] { transform: scale(.62) }`，
  让 80px 的贴纸收进 50×44 的头像位；其它特效不受影响。
- 三个挂载点各加一行导入（悬停卡 / 复习卡 / 设置页）。
- `docs/previews/cat-sticker.html` 是视觉基线（四态 × 明暗 × 三个尺寸）。

## 8. 已知限制

- 照片贴纸不参与深色换色：深色卡靠白边和毛色自然分开，浅色卡靠 CSS 投影。
- `assetsInlineLimit` 是按 `.webp` 后缀放行的规则；以后加别的照片素材要一并考虑体积
  （每张图会进 4 个 bundle：content / panel / popup / settings）。
- 抠图依赖 macOS 14+ 的 Vision 主体分割；换机器重跑要先确认 `VNGenerateForegroundInstanceMaskRequest` 可用。
