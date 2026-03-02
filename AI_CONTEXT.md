# Get - Web to Obsidian Chrome Extension

## 📚 1. 项目概述 (Project Overview)
- **名称**: Get
- **类型**: Chrome 浏览器扩展 (Manifest V3)
- **主要目的**: 提取浏览器当前标签页（或指定的网址）的网页正文内容，自动下载其中的图片，并将其一键转换为规范的 Markdown 格式，然后利用浏览器的 **File System Access API** 直接将文件无缝写入用户本地指定的 Obsidian Vault 目录中。
- **特殊处理逻辑**: 
  - 如果目标 URL 为 `github.com`（如仓库地址），则将其保存到 `GitHub 工具` 文件夹，并采用特定命名策略。
  - 如果目标网址属于 `mp.weixin.qq.com`，则存放入 `微信公众号` 文件夹。
  - 如果目标网址属于 `x.com` 或 `twitter.com`，则存放入 `X` 文件夹，文件自动采取 `时间-作者-标题.md` 命名。
- **状态与定位**: 这是个纯粹的**本地处理插件**，去除了早期版本的 AI 摘要或服务端文本清洗流程（详见近期变更），所有功能均在本地浏览器内完成。

## 🏗 2. 技术架构与核心模块 (Architecture & Modules)
项目设计简洁（KISS原则），以 Service Worker `background.js` 作为功能中心，Popup 提供界面控制。

### 核心文件分布与说明：
- **`manifest.json`**: Manifest V3 配置，声明了扩展功能及所需权限（`activeTab`, `scripting`, `storage`, `tabs`, `sidePanel`），以及默认展示的弹窗 `popup.html`。
- **`background.js`**: (核心引擎)
  - **IndexedDB 初始化封装**: 在不依赖外部库的情况下自建 `getDb`, `idbGet`, `idbSet` 用于缓存文件句柄（Vault Handle）和各项配置（如图片保存目录 `imageDir`）。
  - **Pipeline 工作流引擎**: `runPipeline` 作为提取流程的主控制中心。
  - **正文提取**: 向目标页面注入 `extractReadablePayload` 函数，包含噪音节点（广告、工具栏、相关推荐等）清洗，及基于特定容器标签的选择和权重估算器提取最优正文块。
  - **图片下载与替换**: `downloadImages` 提取图片链接利用 `fetch` 下载转换位 Blob，然后保存在 Vault 的指定目录（通常为 `_assets/webclip-images`），并通过 `applyImagePlaceholders` 将原文中的标记（如 `[[IMG_001]]`）替换为了标准的 Markdown 格式。
  - **文件生成层**: 提供 YAML frontmatter 拼接生成逻辑，并处理不同源（微信/GitHub）的文件分配及命名（`slugify` 和 `sanitizeFileName`）。
- **`popup.js` / `popup.html` / `popup.css`**: (用户界面)
  - 实现了基于玻璃拟物风（Glassmorphism）和微妙过渡动画的现代扩展交互UI。
  - 核心功能包括：
    - **模式切换**: 可选“当前标签页”与“指定网址”两种抓取模式。
    - **授权认证管理**: 利用 `window.showDirectoryPicker()` 获取目标存储目录（如 Obsidian 根路径）的持续写入和读取权限，存入 IDB 中（`vaultHandle`）。
    - **执行与监控**: 和 Service Worker (`background.js`) 通信传递 `runExtraction` 消息，通过监听进度消息 (`pipeline-progress`) 在界面上更新百分比及状态提示。
- **`model-config.js`**: 曾用于 AI 模型支持（配置大模型与 Endpoint），由于最近一次代码重构确定回归纯粹的数据抓取和结构化本地处理，因此目前为空白或保留了空逻辑占位符。

## ⚙️ 3. 核心机制设计

### (1) Permission & Storage Flow（权限与存储流）
- 用户打开 popup -> 点击「授权 Vault 目录」-> 浏览器调用系统原生目录读取器 `showDirectoryPicker` -> 用户授予权限得到 `FileSystemDirectoryHandle`。
- 得到手柄后写入 IndexedDB (`web2obsidian-db`) 中，以便后续多次访问无需重新授权（`ensureVaultPermission` 与 `requireVaultHandle` 函数）。
- 若因浏览器安全策略引发 handle 的访问失效，则需要重新触发 prompt 或由用户重新主动点击授权。

### (2) Extraction Pipeline（提取管道流）
从开始抓取到最终落地需要经历下述流程管理，主要由 `background.js` - `runPipeline` 接管调度，过程伴有精确到整数的阶段进度回调（用于 UI）：
1. **05% 校验 Vault 权限**: 测试 IndexedDB 取出的句柄是否有效。
2. **18% 提取网页正文**: （支持重试 `executeExtractionWithRetry`）向活动 Tab 或后台隐藏创建的新 Tab 注入内容抽离脚本。获取包含图片占位符（Token）的正文及抓取的实际图片队列。
3. **46% 本地整理正文**: 简单清洗、去除常见的点赞/赞赏等干扰文字。
4. **70% 下载图片与整理文件**: 请求 `fetch` 所有提取的图片，匹配格式后作为 `Blob` 通过 `File System Access API` 写入 `imageDir`（默认 `_assets/webclip-images`）中。
5. **88% 生成 Markdown**: 融合原文元信息、正文段落及成功落盘替换了 Token 的 Markdown 图片语法标记。
6. **96% 写入 Obsidian Vault**: 直接写入对应的 `targetFolder`。
7. **100% 完成**: 向 UI 返回汇总结果。

## 🔄 4. 近期变更历史 (Recent Refactor Changes)
这些变更是当前代码与过去版本的最大差异点：
1. **彻底拔除 AI Summarization**: 摈弃了过往所有调用大型语言模型获取内容总结或二次清洗的负担，全面回归原始内容的结构化提取，因此相关逻辑层如 `model-config.js` 被清空或闲置。
2. **专项路由定制**: 为 GitHub 实施了特殊处理（`isGithub` 检测），将 URL 类似 `github.com/owner/repo` 的仓库地址抓取为仅仅保存标题与链接形式（视具体需求可微调），并保存在名为 `GitHub 工具` 的 Obsidian 目录下。
3. **UI 现代化升级**: Popup 面板做了大规模重构，视觉主张现代感与质感，主要侧重对进度条、圆角、背景等元素运用了现代 Web CSS 技术（高斯模糊/毛玻璃效果）。

## 🤖 5. 给 AI 系统的新会话指令
若是全新的对话窗口涉及修改或新增功能，请 **直接参阅本文件** 获取整个项目结构与逻辑链条。所有的改动请恪守：
1. **KISS 原则**: 不增加跨环境通讯依赖，尽量维持本地 JS 能力的使用。
2. **渐进迭代**: 针对任何功能点（如增强 Markdown 格式转换、扩充匹配网站列表等），修改前需要详细调研 `executeExtraction` （正文解析节点）与 `runPipeline` （流程引擎节点）的承载力。
3. **File System API 兼容**: Chrome 扩展中访问 IndexedDB 里存的句柄是敏感且易受刷新、更新影响的，任何涉及权限交互的调整需极为谨慎。
