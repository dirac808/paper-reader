# Paper Reader

Paper Reader 是一款面向科研论文阅读的 VS Code 插件。它基于 PDF.js 提供 PDF 阅读能力，并集成 OpenAI Codex 插件、MinerU 和 OpenAI-compatible 翻译接口，实现论文阅读、划词处理、全文解析与中文翻译的一体化工作流。

## 功能特性

- PDF 阅读：使用 VS Code 自定义编辑器打开 PDF。
- 划词送入 Codex：在 PDF、Markdown 或代码文件中选中文本后，通过右键菜单加入 Codex 对话上下文。
- 划词翻译：在 PDF 中选中文本后调用可配置的 OpenAI-compatible API 返回中文翻译。
- 全文翻译：调用 MinerU 将 PDF 解析为 Markdown，再由 AI 翻译正文，保留图片、公式、代码块和 Markdown 结构。
- Markdown 笔记：从 PDF 或 Markdown 选区创建真实 `.md` 笔记文件，支持 VS Code 原生 Markdown 编辑与预览。
- 知识图谱：基于笔记、PDF 与链接关系展示知识节点。
- 配置面板：在 VS Code 左侧 Activity Bar 中提供 Paper Reader 配置 UI 和自检入口。

## 依赖条件

### 必需

- VS Code 1.46 或更高版本。
- Node.js 和 npm，用于开发和打包。
- OpenAI Codex VS Code 插件：`openai.chatgpt`，用于“发送到 Codex”功能。

### 全文解析与翻译

- 推荐使用远程 MinerU FastAPI v2。插件会直接上传 PDF、轮询任务并下载 Markdown 与图片，
  客户端无需安装 Python、MinerU、CUDA 或模型。
- 也可以在同一台电脑安装 MinerU CLI，例如：

```powershell
D:\anaconda\envs\paperreader\Scripts\mineru.exe
```

- 一个 OpenAI-compatible API，例如 DeepSeek、OpenAI-compatible 网关或其他兼容服务。
- 如果使用 MinerU `hybrid-engine` / `vlm-engine`，需要安装对应 Python 环境、Torch GPU 版本和 VLM 模型。

远程 GPU 主机示例：

```powershell
$env:CUDA_VISIBLE_DEVICES = "0"
$env:MINERU_MODEL_SOURCE = "local"
$env:MINERU_API_MAX_CONCURRENT_REQUESTS = "1"
mineru-api --host <TAILSCALE_IP> --port 18180 --enable-vlm-preload false
```

客户端只需将 `MinerU API URL` 配置为 `http://<TAILSCALE_IP>:18180`。不要把未提供认证的
MinerU API 绑定到公网地址；应绑定 VPN 地址并用防火墙限制来源。

当前已验证的本地高精度配置：

- `MinerU Backend`: `hybrid-engine`
- `MinerU Hybrid Effort`: `high`
- `MinerU Model Source`: `local`，模型下载完成后推荐使用
- `MinerU Device`: `cuda` 或 `auto`
- `MinerU Download Proxy URL`: `http://127.0.0.1:7897`，仅用于 MinerU 本地模型下载

## 安装 VSIX

在本目录执行打包后会生成类似下面的文件：

```text
paper-reader-1.4.0.vsix
```

安装方式：

```powershell
code --install-extension .\paper-reader-1.4.0.vsix --force
```

也可以在 VS Code 中打开 Extensions 侧栏，点击右上角 `...`，选择 `Install from VSIX...`。

安装完成后建议重新加载 VS Code。

## 使用方式

### 打开 PDF

在资源管理器中右键 PDF：

- `Paper Reader: Open Current PDF`
- `Paper Reader: Translate Current PDF`

也可以直接双击 PDF。如果系统中安装了其他 PDF 插件，请在 `Open With...` 中选择 `Paper Reader`。

### 发送选区到 Codex

PDF 中选中文本后右键：

- `Paper Reader: Send Selection to Codex`

Markdown 或代码文件中选中文本后右键：

- `Paper Reader: Send Selection to Codex`

该功能依赖 `openai.chatgpt` 插件暴露的 Codex 命令。

### 全文翻译

对 PDF 执行：

- `Paper Reader: Translate Current PDF`

生成文件默认保存到工作区：

```text
paper-reader-output/
  translations/
    <PDF文件名>/
      <PDF文件名>.mineru-original.md
      <PDF文件名>.deepseek-zh.md
      assets/
```

其中：

- `.mineru-original.md` 是 MinerU 解析出的原始 Markdown。
- `.deepseek-zh.md` 是 AI 翻译后的中文 Markdown。
- `assets/` 保存图片等资源。

### 配置

点击 VS Code 左侧 Activity Bar 的 Paper Reader 图标，进入配置界面。

主要配置项：

- `AI API Key`: 全文翻译 API Key。
- `AI Base URL`: OpenAI-compatible API 地址。
- `AI Model`: 全文翻译模型。
- `Full Translation Prompt`: 全文翻译提示词，默认使用 JSON 强约束格式，通常不需要修改。
- `Selection API Key/Base URL/Model/Prompt`: 划词翻译专用配置。留空时继承全文翻译配置。
- `Output Directory`: 输出目录，默认 `paper-reader-output`。
- `MinerU API URL`: 远程 MinerU FastAPI v2 地址；配置后直接使用远程 GPU。
- `MinerU Executable`: 本地 MinerU CLI 路径；远程 API 模式下忽略。
- `MinerU Backend`: MinerU backend，例如 `pipeline`、`vlm-engine`、`hybrid-engine`。
- `MinerU Hybrid Effort`: `medium` 或 `high`。
- `MinerU Model Source`: `auto`、`huggingface`、`modelscope`、`local`。
- `MinerU Download Proxy URL`: MinerU 下载模型时使用的代理。
- `MinerU Formula/Table/Image Analysis`: 公式、表格、图像分析开关。
- `MinerU Device`: `auto`、`cpu`、`cuda`。
- `Fallback to PDF.js`: MinerU 失败时是否退回 PDF.js 文本提取。

配置界面中的 `Self Check` 会检查：

- 已配置远程 API 时，检查 MinerU API 健康状态、版本和协议；否则检查本地 MinerU 是否可执行。
- AI API 是否可用。
- Codex 插件接口是否可用。

### Markdown 性能架构

Paper Reader Markdown 使用 CodeMirror 6 + Lezer 作为编辑核心。Markdown 源文档始终保留在
增量文档模型中；公式和图片只在当前可见区创建 widget，点击 widget 会恢复对应 Markdown
源码块。这样长文档滚动和输入不会触发全文 HTML 重建，也不会因为屏幕外公式创建 DOM。

开发环境可以查看 Markdown Webview 的 `window.paperReaderMarkdownPerformance`，其中包含
可见区扫描字节数、渲染 widget 数量、更新次数和最大更新耗时。

## 开发

安装依赖：

```powershell
npm install
```

编译：

```powershell
npm run compile
```

代码检查：

```powershell
npm run lint
```

单元测试：

```powershell
npm run test:unit
```

在 VS Code 中按 `F5` 启动 Extension Development Host，即可调试插件。

## 打包

生成 VSIX：

```powershell
npm run package
```

完整发布前建议依次执行：

```powershell
npm run compile
npm run lint
npm run test:unit
npm run test:performance
npm run test:markdown-performance
npm run package
```

## 注意事项

- 本插件不内置 MinerU 模型文件，首次使用高精度 backend 时 MinerU 可能需要下载数 GB 模型。
- `hybrid-engine high` 会占用 GPU 显存和系统内存。6GB 显存环境下通常会自动使用较小 batch。
- `MinerU Download Proxy URL` 只用于 MinerU 本地模型下载/加载所在子进程，不会影响 AI 翻译 API。
- 如果 VS Code 仍使用其他 PDF 插件打开 PDF，请通过 `Open With...` 选择 Paper Reader。

## License

请参考仓库中的 LICENSE 文件。
