# Paper Reader

Paper Reader 是面向科研论文阅读的 VS Code 插件。当前代码库包含 PDF 阅读、MinerU 文档解析、AI 全文翻译、Markdown 编辑与预览、PDF/Markdown/代码选区发送到 Codex、Markdown 笔记和配置自检等功能。

本文档记录当前架构、Markdown 编辑体验问题的根因、五阶段重构及可复现的验证方法。Markdown 光标点击与拖拽选择已按字符偏移严格回归；测试结果和已知边界见下文及[重构问题日志](logs/README.md)。

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

## Markdown 编辑体验问题与根因

### 1. 指针操作期间光标位置漂移或拖选失效

最初的问题不只发生在公式：普通正文、标题、引用、表格和代码也会跳到下一行或块尾；源码字符与像素位置不一致时，拖动选区也会丢失。

根因是自定义编辑器在同一指针手势中同时改变 CodeMirror selection、Markdown 装饰和 DOM：`pointerdown` 后源码可能被预览 Widget 替换，浏览器随后派发的兼容 `mousedown`/`click` 命中不同 DOM。旧逻辑会在后续事件重新推算位置，或在预览重新显示后覆盖 selection。公式还有独立的映射问题：KaTeX 字形与 LaTeX 源字符并非一对一，按宽度比例换算偏移必然不精确。此前测试只验证落在同一块或允许数个字符误差，不能反映用户要求的逐字符精度。

当前指针流程在手势开始时记录来源态 DOM caret 对应的源码位置，并保留手势起点类型，兼容鼠标事件不会覆盖原始位置。短点击在 `click` 阶段应用被冻结的位置；拖动超过阈值后，由指针移动更新 CodeMirror anchor/head，释放时校准最终端点。Widget 预览的源码切换与源码态定位分开处理。KaTeX 源码 glyph 信息按公式缓存，渲染后的实际字形矩形用于命中测试，不通过公式整体宽度猜偏移。

### 2. 长文档更新成本和重复解析

旧版同时维护 CodeMirror 解析树、独立 TreeFragment/块扫描状态和重复的装饰更新路径；编辑后不同索引可能使用不同步的解析结果，长文档滚动与修改时增加额外工作。重构后由 CodeMirror/Lezer 的语法树作为 Markdown 结构来源，在变更涉及的范围更新块索引和可见区装饰；全文级扫描次数、解析/区间扫描/更新延迟均有统计和性能守卫。KaTeX hit map 缓存也避免在每次点击时重新解析公式。

五阶段设计与问题处置记录见[logs/README.md](logs/README.md)。

## 验证

测试文件：

```text
E:\Desktop\repo\paper-reader\test.md
```

严格逐点测试通过 `MARKDOWN_FIXTURE` 指向该文件；它检查鼠标实际命中位置和 CodeMirror selection 的字符偏移完全相等，而不是只检查是否仍在同一块内。图片路径需要与文档的资源目录匹配；仓库根目录的 `test.md` 没有配套的 `assets/images`，因此不可把此处的缺图误判为编辑器渲染回归。


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

## 验收范围与已知边界

1.5.0 验证结果以 `logs/README.md` 记录的最终运行结果和发布提交为准。严格位置测试必须通过 `test.md` 全量扫描，且点击预期偏移与实际 CodeMirror selection 精确相等；短文档测试覆盖正向/反向拖选。性能守卫检查可视区扫描与局部更新，不把单一机器的耗时解释为所有设备的绝对性能保证。

`test.md` 的图片相对路径没有同目录资源，因此该文件本身不适合作为图片加载验收样本。图片问题需用包含真实 `assets/images` 的 Markdown 文档在 VS Code Webview 中验证；这项检查与光标回归彼此独立。

## License

请参阅仓库中的 `LICENSE` 文件。
