# Last Translate Extension

一个 Chrome 扩展：把网页内容翻译成中文并**插在原文下方**，同时支持划词解释、侧栏追问和自定义 OpenAI 兼容模型。

目标很简单：读外文网页时，不用切换到另一个翻译工具，也不用在阅读和提问之间来回跳。

## 功能

- **一键双语翻译**：按 `Opt+A`（Windows/Linux 为 `Alt+A`）开始翻译当前页；原文保留，译文在下方出现。
- **再次按键还原**：再按一次同一快捷键，移除译文并恢复原文。
- **渐进式翻译**：按视口和段落分批处理，不一次性把整页塞给模型，也不阻塞页面。
- **划词解释 / 追问**：选中文字后出现「解释 / 追问」气泡，侧栏打开并带上选中文字及所在段落上下文。
- **快捷键提问**：`Opt+Q` 解释当前选区，`Opt+S` 打开翻译侧栏。
- **多套模型配置**：内置 DeepSeek 预设，也支持任意 OpenAI 兼容接口；可保存多套配置、切换、拉取模型列表和测试连接。
- **全局队列与限速**：翻译和侧栏问答共用后台队列，避免多标签页同时把接口打爆。
- **请求可取消、可重试**：支持中断当前翻译、失败重试和断流恢复。
- **缓存**：相同段落命中缓存时直接复用，减少重复请求。
- **悬停学习注释**：翻译时用中性灰和轻微悬空阴影标出 0～3 个值得学的词/短语，不铺底色；悬停看本句释义；默认开启，可在设置关闭。
- **动态页面**：SPA 路由切换后重新扫描；页面新增内容在翻译开启时继续处理。
- **本地配置**：API Key 只保存在 `chrome.storage.local`，不进入内容脚本，不随扩展代码下发。

## 安装

### 从源码构建

要求：

- Node.js 20.19+（或 22.12+）
- Chrome 120+

```bash
git clone https://github.com/AZEROSTART/last-translate-extension.git
cd last-translate-extension
npm install
npm run build
```

然后在 Chrome 中：

1. 打开 `chrome://extensions`
2. 打开右上角「开发者模式」
3. 点击「加载未打包的扩展程序」
4. 选择仓库里的 `dist/` 目录

> 每次重新执行 `npm run build` 后，需要在 `chrome://extensions` 里点一次扩展的「重新加载」，并刷新正在测试的页面。

### 开发模式

```bash
npm run dev
```

`dev` 会监听源码变化并持续构建到 `dist/`。重新加载扩展后生效。

## 使用

| 操作 | 快捷键 |
| --- | --- |
| 翻译当前页面 / 还原 | `Opt+A`（`Alt+A`） |
| 解释当前选区 | `Opt+Q` |
| 打开翻译侧栏 | `Opt+S` |

快捷键可以在 `chrome://extensions/shortcuts` 里修改。

### 悬停学习注释

翻译完成后，正文中值得学习的词会用中性灰 + 很淡的阴影标出，不再使用底色框。把鼠标停在词上会显示词性、释义和例句；还原翻译后高亮和卡片一起清除。可在设置页的「学习注释」中关闭。

### 配置模型

点击工具栏里的扩展图标打开设置 popup：

1. 选择或新增一个 provider。
2. 填写 `baseURL`、`API Key`、模型名。
3. 需要时点「拉取模型」或「测试连接」。
4. 保存并设为当前配置。

OpenAI 兼容接口通常使用：

```text
baseURL: https://api.example.com
实际请求: https://api.example.com/v1/chat/completions
模型列表: https://api.example.com/v1/models
```

默认会自动补 `/v1`；如果网关不需要这个后缀，取消勾选「自动补 /v1」。DeepSeek 预设会自动关闭这个选项。

也可以使用 DeepSeek、OpenAI、OpenRouter、自建 one-api / new-api 网关、Ollama、LM Studio 等服务；对扩展来说都是「一个 baseURL + 一个 key + 一个模型名」。

## 开发

```bash
npm install          # 安装依赖
npm run dev          # 监听构建
npm run build        # 生产构建到 dist/
npm test             # 单元测试
npm run test:e2e     # Playwright 端到端测试
npm run verify:delivery  # 交付门禁：测试 + 类型检查 + 构建 + 产物检查
```

交付前必须完成的 P0 浏览器验证见 [docs/delivery-verification.md](docs/delivery-verification.md)，规则入口见 [AGENTS.md](AGENTS.md)。

## 项目结构

```text
public/
  manifest.json          # MV3 manifest、快捷键、权限、入口
src/
  background/            # Service Worker：命令、队列、缓存、provider 调度
  content/               # 内容脚本：段落识别、渲染、还原、划词气泡
  panel/                 # 侧栏聊天
  popup/                 # 工具栏 popup：模型配置
  options/               # 高级设置页
  providers/             # OpenAI 兼容请求与流式解析
  shared/                # 类型、存储、prompt、错误
  styles/                # 注入样式和扩展页样式
tests/
  unit/                  # Vitest 单元测试
  e2e/                   # Playwright 端到端测试
  fixtures/              # 测试页面
scripts/
  check-build.mjs        # 校验 dist 产物可被 Chrome 加载
docs/
  delivery-verification.md  # P0 交付验证流程
```

## 隐私与安全

- API Key 只保存在本机的 `chrome.storage.local`，由后台 Service Worker 使用。
- 扩展不包含远程代码，所有 JS 随扩展打包，符合 Manifest V3 CSP。
- 扩展不收集遥测数据。
- 翻译文本和你主动发起的划词/侧栏问题会发送到你自己配置的模型服务；除此之外没有额外上传。
- 扩展需要 `<all_urls>` 权限来读取网页正文；只在用户触发翻译或划词时处理当前主框架页面。

## 已知限制

- 只处理顶层 frame，不扫描 iframe 内部。
- 主要面向 HTML 正文；PDF、图片/OCR、视频字幕不在当前范围。
- 动态页面和复杂布局依赖段落启发式识别，个别站点可能需要调整站点规则。
- 重新构建 `dist/` 后必须重载扩展并刷新页面，否则可能继续使用旧的 content script。

## 相关文档

- [交付验证主流程](docs/delivery-verification.md)
- [设计文档](docs/superpowers/specs/2026-11-04-bilingual-translate-extension-design.md)
