# Paper Reader

Paper Reader 是面向科研论文阅读的 VS Code 插件。当前代码库包含 PDF 阅读、MinerU 文档解析、AI 全文翻译、Markdown 编辑与预览、PDF/Markdown/代码选区发送到 Codex、Markdown 笔记和配置自检等功能。

本文档同时记录当前实现的架构、已经确认的问题、测试方法和真实测试结果。特别是图片显示和 Markdown 光标定位目前仍然需要继续验收，不能把自动化测试中的局部通过结果理解为全部问题已经解决。

## 当前架构

### PDF

- `src/pdfPreview.ts` 创建和管理 PDF Webview。
- `media/web/` 提供 PDF.js 资源和 PDF 页面 UI。
- PDF 中选中文本后，可通过右键菜单发送到 `openai.chatgpt` 的 Codex 对话。
- PDF 笔记标记保存在 SQLite/NoteStore 中，并在 PDF Webview 中重新显示。

### Markdown

- `src/markdownWysiwygProvider.ts` 注册 `paper-reader.markdownEditor` Custom Text Editor。
- Markdown 编辑器运行在 Webview 中，核心是 CodeMirror 6 + Lezer Markdown parser。
- `media/markdown/codemirror-entry.js` 保存编辑器逻辑，`codemirror.bundle.js` 是打包后的浏览器资源。
- Markdown 原文仍然是 CodeMirror 的真实文档。公式、图片、表格、代码块只对当前可视区域创建 Widget，点击 Widget 后切回对应源码范围。
- KaTeX 负责公式渲染；代码块、表格、图片由自定义 CodeMirror Widget 渲染。
- Markdown 文件可以通过右键 `Paper Reader: Open Markdown` 打开。

### 全文翻译

PDF 全文翻译流程为：

1. 优先复用已有 MinerU Markdown 缓存。
2. 使用 MinerU 解析 PDF，生成 Markdown 和图片资源。
3. 将正文批次发送到 OpenAI-compatible 翻译 API。
4. 保存 MinerU 原文版和 AI 中文版 Markdown。
5. 使用 Paper Reader Markdown 编辑器打开输出文件。

默认输出结构：

```text
paper-reader-output/
└─ translations/
   └─ <PDF 文件名>/
      ├─ <PDF 文件名>.mineru-original.md
      ├─ <PDF 文件名>.deepseek-zh.md
      └─ assets/
         └─ images/
```

### Codex 联动

PDF、Markdown 和普通代码文件的选区可以通过 Paper Reader 命令发送到 Codex。该功能依赖官方插件：

```text
openai.chatgpt
```

Paper Reader 不能读取闭源 Codex 的内部 API，只能通过公开命令和当前活动编辑器/临时文档桥接。

## 已确认的问题

### 1. 图片显示为空

现象：

- Markdown 中图片语法存在，例如：

  ```markdown
  ![](assets/images/223ed8088c13ab489352fd30b711eb9fc1e7b8178d1a92ac9b8e903bd2580bc2.jpg)
  ```

- 图片位置会预留出一块高度，但图片内容为空，或者只看到标题/图注。
- 典型截图中“图 1”对应的原始 JPG 实际存在且不是空白图。

已经确认的事实：

1. `E:\Desktop\repo\paper-reader\test.md` 所在目录没有 `assets/images`，因此直接打开这个文件时，下面的相对路径没有对应文件。这种情况下图片加载失败是正确结果，不是 MinerU 公式或 KaTeX 的问题。
2. 翻译输出目录中确实存在对应资源，例如：

   ```text
   E:\Desktop\DIPE\paper-reader-output\translations\Distributed quantum inner product estimation\assets\images\223ed8088c13ab489352fd30b711eb9fc1e7b8178d1a92ac9b8e903bd2580bc2.jpg
   ```

   该图片已验证自然尺寸为 `1296 x 232`，文件内容正常。
3. Markdown Provider 将当前 Markdown 文件父目录加入 `webview.options.localResourceRoots`。
4. 图片资源现在由主进程生成当前文档目录对应的 `documentBasePath`，前端 `ImageWidget` 使用 `new URL(relativePath, documentBasePath)` 得到完整的 Webview URI，再赋值给 `image.src`。图片加载不再只依赖 HTML `<base>` 的隐式解析。
5. 自动化测试服务器可以验证相对路径和图片自然尺寸，但不能替代真实 VS Code Webview 的 URI/CSP/本地文件访问测试。

因此目前图片问题有两个不同层次，不能混为一谈：

- **资源不存在**：`test.md` 原目录没有图片，这是测试数据布局问题。
- **资源存在但 Webview 仍为空**：需要在真实 VS Code Webview 中检查图片最终 `src`、网络请求状态和 `naturalWidth`。当前代码已经改为显式 Webview URI；如果仍失败，应继续根据开发者工具中的最终 URI 和错误信息处理具体平台问题。

真实诊断方式见“图片专项测试”。

### 2. Markdown 光标位置失真

用户可观察到的现象：

- 点击第三级标题、正文、引用、独立公式或行内公式后，光标可能跳到下一行、源码块开头、公式结尾，或者文档前部。
- 文档前半部分有时正常，向后滚动到长文档后半部分后失真明显增多。
- 公式和图片等可变高度 Widget 越多，问题越容易出现。

已经确认的根因和历史原因：

1. CodeMirror 的 `EditorView.posAtCoords()` 会依赖编辑器对当前文档布局的测量结果。前方存在大量可变高度 Widget 时，真实鼠标位置与 CodeMirror 的行布局模型可能不同，导致点击某个 `.cm-line` 后返回下一行或错误源码位置。
2. 渲染公式的 KaTeX 字形没有和 LaTeX 源码字符一一对应的几何映射。不能用 KaTeX 宽度比例反推源码字符偏移。
3. 旧实现曾在 Widget 点击后使用 `requestAnimationFrame` 等待源码重新挂载，再用坐标寻找“最近”源码位置。这种延迟定位会在用户已经继续点击、输入或删除后覆盖新的 selection，是光标突然跳动的直接原因。
4. 目前已经移除这段延迟定位、重试和 `posAtCoords()` 反推逻辑。点击渲染 Widget 现在只负责切回对应源码块并把初始 selection 放在源码块起点；源码态的鼠标定位使用浏览器真实 DOM caret 和 CodeMirror `posAtDOM()`，并在 `mousedown` 阶段设置 selection。

当前状态必须如实理解：

- 预览 Widget 的块范围测试已经通过。
- “源码态点击后是否精确落在指定字符偏移”仍未全部通过，不能声称光标问题已经根治。
- 最近一次完整测试的源码字符级结果为：独立公式 `156/300`，行内公式 `21/100`。这些失败必须继续处理，不能用“仍在同一个公式块内”替代“精确落在用户点击的字符附近”。

## 当前自动化测试结果

测试文件：

```text
E:\Desktop\repo\paper-reader\test.md
```

测试使用的翻译目录资源根目录：

```text
E:\Desktop\DIPE\paper-reader-output\translations\Distributed quantum inner product estimation
```


## 开发环境安装

在插件仓库根目录执行：

```powershell
npm install
npm run compile
```

如果使用 MinerU 本地 CLI，需要额外准备 MinerU Python/Conda 环境；如果使用远程 MinerU API，则只需在 Paper Reader 配置中填写 API 地址。

## VS Code 中调试插件

1. 在 VS Code 中打开本仓库根目录。
2. 确认依赖已安装：

   ```powershell
   npm install
   ```

3. 执行 `npm run compile`。
4. 按 `F5` 启动 **Extension Development Host**。
5. 在新打开的 Extension Development Host 中重新执行 `Developer: Reload Window`。
6. 对 PDF 使用 `Open With...`，明确选择 `Paper Reader`，避免被 `vscode-pdf`、Office Viewer 或其他 PDF 插件接管。
7. 对 Markdown 文件使用：

   ```text
   Paper Reader: Open Markdown
   ```

8. 需要查看 Webview 错误时，在 Extension Development Host 中执行：

   ```text
   Developer: Open Webview Developer Tools
   ```

不要只在普通 VS Code 窗口中打开文件判断是否使用了新代码；必须确认窗口是按 F5 启动的 Extension Development Host，并且状态栏/开发者工具中没有加载旧 VSIX。

## 基础质量检查

在仓库根目录依次执行：

```powershell
npm run compile
npm run lint
npm run test:unit
npm run test:performance
npm run test:markdown-performance
```

预期结果：

- `compile` 成功结束。
- `lint` 没有 ESLint 错误。
- `test:unit` 输出 `Unit tests passed.`。
- `test:performance` 输出 `Performance guard checks passed.`。
- `test:markdown-performance` 输出 JSON，并且 `checks` 为 `passed`。

当前 Markdown 性能守卫的代表数据：

```json
{
  "documentBytes": 506670,
  "visibleBytes": 16000,
  "visibleRatio": 0.0316,
  "checks": "passed"
}
```

该指标证明长文档没有被每次更新都完整扫描和渲染，但它不证明光标字符级定位已经正确。

## 图片专项测试

### A. 验证测试数据是否缺少资源

```powershell
$md = 'E:\Desktop\repo\paper-reader\test.md'
$folder = Split-Path -Parent $md
Test-Path (Join-Path $folder 'assets\images')
```

如果输出 `False`，直接打开 `test.md` 时图片无法显示是因为资源不存在。应使用包含以下结构的 Markdown 目录测试：

```text
article.md
assets/
└─ images/
   ├─ image-1.jpg
   └─ image-2.jpg
```

### B. 用真实翻译输出测试

确认 Markdown 和资源位于同一个父目录体系：

```powershell
$root = 'E:\Desktop\DIPE\paper-reader-output\translations\Distributed quantum inner product estimation'
Test-Path (Join-Path $root 'Distributed quantum inner product estimation.deepseek-zh.md')
Test-Path (Join-Path $root 'assets\images\223ed8088c13ab489352fd30b711eb9fc1e7b8178d1a92ac9b8e903bd2580bc2.jpg')
```

在 Extension Development Host 中用 Paper Reader 打开该 `.deepseek-zh.md`，然后打开 Webview Developer Tools 执行：

```javascript
[...document.querySelectorAll('.paper-reader-cm-image img')].map((img) => ({
  src: img.src,
  currentSrc: img.currentSrc,
  complete: img.complete,
  naturalWidth: img.naturalWidth,
  naturalHeight: img.naturalHeight,
  baseURI: img.baseURI
}))
```

判定标准：

- `complete === true`
- `naturalWidth > 0`
- `naturalHeight > 0`
- `currentSrc` 指向当前 Markdown 所在目录下的 `assets/images` 对应资源

如果 `complete === true` 但 `naturalWidth === 0`，说明请求失败；重点检查 Webview Developer Tools 的 Network/Console 中是否有 `ERR_FILE_NOT_FOUND`、资源被 CSP 拒绝、URI 编码错误或 Webview 根目录不在 `localResourceRoots` 中。

### C. 自动化图片检查

翻译目录资源存在时：

```powershell
$env:MARKDOWN_FIXTURE = 'E:\Desktop\repo\paper-reader\test.md'
$env:MARKDOWN_ASSET_ROOT = 'E:\Desktop\DIPE\paper-reader-output\translations\Distributed quantum inner product estimation'
$env:MARKDOWN_SWEEP = 'true'
node scripts/checkMarkdownHeadingSelection.js
```

该脚本检查真实 DOM 图片的 `complete`、`naturalWidth` 和 `naturalHeight`。如果不设置 `MARKDOWN_ASSET_ROOT`，脚本会从 `test.md` 所在目录找资源，此时由于仓库中没有 `assets/images`，图片失败是预期结果。

## 严格 Markdown 位置测试

执行：

```powershell
$env:MARKDOWN_FIXTURE = 'E:\Desktop\repo\paper-reader\test.md'
$env:MARKDOWN_ASSET_ROOT = 'E:\Desktop\DIPE\paper-reader-output\translations\Distributed quantum inner product estimation'
$env:MARKDOWN_SWEEP = 'true'
Remove-Item Env:MARKDOWN_ONLY_OFFSETS -ErrorAction SilentlyContinue
Remove-Item Env:MARKDOWN_SKIP_INLINE -ErrorAction SilentlyContinue
Remove-Item Env:MARKDOWN_SKIP_PROSE -ErrorAction SilentlyContinue
node scripts/checkMarkdownHeadingSelection.js
```

测试输入坐标必须来自真实 DOM：

- Widget 测试从目标 Widget 的 `getBoundingClientRect()` 生成坐标。
- 源码测试从真实 TextNode 建立 `Range`，再从 Range 的矩形生成坐标。
- 不能使用 `EditorView.coordsAtPos()` 生成鼠标输入坐标，否则测试会把编辑器自己的映射结果当成真实鼠标坐标，无法发现位置失真。

结果解释：

- `normal.display/inline/prose/images`：预览块范围和图片加载结果。
- `sourceCaret.normal`：切回源码后，点击指定源码字符的字符级结果。
- 仅仅显示 `caret` 仍在公式的 `from/to` 范围内，不等于精确定位成功。
- 如果 `sourceCaret` 仍然失败，必须继续调查 DOM TextNode、CodeMirror `posAtDOM`、虚拟滚动和 Widget 切换顺序，不能把结果报告为全部通过。

## 性能测试说明

`checkMarkdownHeadingSelection.js` 为了避免 Widget 尚未挂载而误报，会在测试过程中等待布局稳定。这些等待只影响测试总耗时，不会写入 `codemirror-entry.js` 的运行时逻辑。

性能验收至少要包括：

1. 打开约 `500KB` Markdown 文件。
2. 从文档前部滚动到中部和后部。
3. 连续输入、删除、撤销、重做。
4. 点击公式/图片切换源码，再立即输入。
5. 检查 `window.paperReaderMarkdownPerformance`：

   ```javascript
   window.paperReaderMarkdownPerformance
   ```

6. 重点观察 `visibleScanChars`、`maxUpdateMs`、`maxParseMs` 和 `maxBlockScanMs`。

性能通过不代表功能通过。光标位置、图片加载和公式渲染必须单独验收。

## 打包与安装

```powershell
npm run compile
npm run build:markdown
npm run package
```

生成 VSIX 后安装：

```powershell
code --install-extension .\paper-reader-<version>.vsix --force
```

安装后执行：

```text
Developer: Reload Window
```

若本机同时安装了旧版 Paper Reader、`vscode-pdf` 或 Office Viewer，必须在 PDF 的 `Open With...` 中确认实际使用的编辑器，避免把其他插件的行为误判为 Paper Reader 的行为。

## 当前验收结论

当前可以确认：

- 基础编译、Lint、单元测试和性能守卫通过。
- Markdown 长文档的可视区域渲染策略已经建立。
- 预览层的公式、正文和图片自动化测试在正确资源根目录下通过。
- 图片文件本身和翻译输出目录的资源结构已确认存在。

当前仍需在用户的真实 VS Code 窗口确认：

- Markdown 源码字符级光标定位已经全部正确。
- 公式、图片和编辑态切换在所有长文档位置都没有跳动。

因此，在图片真实 Webview 诊断和 `sourceCaret` 字符级测试全部通过前，不应发布为“光标和图片问题已经完全修复”的正式稳定版本。

## License

请参阅仓库中的 `LICENSE` 文件。
