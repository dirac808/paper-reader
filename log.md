# 问题调查、修复与验证日志

README 面向安装、配置与使用；本文集中保存历史故障、修复过程和验证边界。

本文记录 Paper Reader Markdown 编辑器在 1.5.0 稳定版之前遇到的交互故障、定位过程、根因和按五阶段实施的重构。记录重点是可以从代码与回归脚本验证的事实，不把“没有跳出公式块”当成光标正确，也不把模拟单击当作完整的真人验收。

## 用户遇到的问题

长论文中，点击公式靠后的字符，特别是 `\tag{4}` 前面的位置，光标有时跳到公式末尾或下一行。类似现象也出现在正文、标题、引用、代码和表格中。单击稳定后，拖动鼠标选择句子又失效。问题随滚动位置、可变高度公式/图片数量、点击位置和事件时序变化，因此只检查短文档或单一公式无法复现所有路径。

## 根因

### 同一手势中的 DOM 替换与事件时序

Markdown 编辑器将 Markdown 原文保存在 CodeMirror 文档中，但屏幕上的部分源码会由公式、表格、代码、图片等 Widget 替代。一次鼠标手势包含 `pointerdown`、浏览器兼容的 `mousedown`、`pointermove`、`pointerup` 和 `click` 等阶段。CodeMirror selection 变化会使装饰状态更新，源码 DOM 与 Widget DOM 可能在手势仍未结束时交换。

旧逻辑在后续事件阶段再根据当前 target 或当前 DOM 计算偏移。同一个物理坐标因此可能先对应源码节点、之后对应 Widget；等到 `click` 时再定位，得到的不是按下时命中的字符。某些路径还会等待渲染帧后再次定位，这使已经完成的点击可能被迟到的 selection 覆盖。它解释了为什么不同语法块都可能跳动，也解释了用户重复点击相同视觉位置时结果不稳定。

### 渲染字形与源码字符不是一一映射

KaTeX 将一个 LaTeX 命令渲染为一个或多个 HTML 节点/字形，反过来也可能把源码组合成单个字形。用公式整体宽度按比例换算字符索引没有数学依据；tag、上下标、组合符号和间距会让误差更大。此前“落在公式内部”以及容许多个字符误差的检查掩盖了这个问题，没有达到用户要求的精确位置。

### 拖选路径被短点击处理截断

修复单击时通过阻止浏览器默认 pointer/mouse 行为来避免 CodeMirror 在 `mousedown` 期间先改 selection。这也阻止了依赖默认事件链的拖拽选择；只实现按下位置冻结，不能自然得到 drag selection。因而必须把短点击与跨过移动阈值后的拖动当作不同状态处理，并在拖动过程中显式更新 selection。

### 长文档重复工作增加时序敏感性

此前存在额外的 TreeFragment 解析/块索引路径，与 CodeMirror 当前语法树、可见区装饰更新并行。解析和索引的维护路径越多，编辑期间产生重复计算和状态不一致的可能越高；高成本更新也延长了 DOM 与 selection 不一致的时间窗口。性能不是光标 bug 的唯一根因，但额外解析放大了体验的不稳定性。

## 五阶段重构

### 阶段一：建立严格、可复现的行为基线

- 扩展 Markdown 浏览器自动化，覆盖正文、标题、公式、代码、表格、引用，以及预览到源码的切换。
- 对指定源码偏移生成/查找鼠标测试坐标，记录命中预期位置与真实 selection。
- 将公式 glyph 映射、完整文档扫描次数、解析/块扫描/更新/指针延迟暴露为测试统计。
- 逐字符扫描使用严格相等断言；不再用“还在同一块”或数个字符容差替代精度要求。

### 阶段二：让 CodeMirror 成为解析与文档状态的唯一事实来源

- 移除独立 `TreeFragment` 增量解析入口，改用 CodeMirror Language 层的 `syntaxTree`、`ensureSyntaxTree` 和 `syntaxTreeAvailable`。
- 按语法树节点分组提取代码、表格、行内代码、引用和图片区间，避免维护一棵平行的 Markdown 解析树。
- 编辑后只刷新受影响的索引范围，保留可视区装饰策略。

### 阶段三：按变更范围维护块索引和装饰

- 用有序块区间索引查找编辑位置附近的 Markdown 块。
- 文档变化时刷新受影响的区间，记录扫描范围及完整扫描计数，防止局部输入退化成全文扫描。
- selection-only 更新不触发不必要的文档解析；装饰仍只为可见内容建立。

### 阶段四：统一并冻结指针手势的位置语义

- 在原始 `pointerdown` 阶段识别手势起点是源码还是预览 Widget，并立即冻结源码位置。
- 兼容 `mousedown` 不得把已记录的 PointerEvent 起点改写；后续 Widget target 也不得篡改源码起点。
- 短点击只应用冻结的位置，不等待下一帧重算位置。
- 拖动越过阈值后转成选择手势，以冻结位置作为 anchor，沿 pointer movement 更新 head，在释放时用最终端点校准。
- Widget 命中通过明确的源码区间和 glyph 几何命中表映射；不按 Widget 总宽度估算 LaTeX 偏移。

### 阶段五：缓存、性能守卫与端到端回归

- 对 KaTeX 解析得到的源码 glyph 关系进行有上限的 LRU 缓存；对实际渲染节点测量 hit map，并用弱引用关联 DOM 节点。
- 记录 parse、block scan、update 和 pointer latency 的分位数据、最大耗时、公式映射缓存命中及完整文档扫描数。
- 以大文档局部编辑断言没有触发全文扫描，并保留包大小和可见区工作量检查。
- 最终验证覆盖 VS Code 集成测试、基础/性能守卫、预览到源码、单击、反向与正向拖选及 `test.md` 字符级扫描。

## 回归结果与边界

1.5.0 发布前同一工作区最终验证记录（2026-09-23）：

- `npm run compile`、`npm run lint`、`npm run test:unit`、`npm run test:performance`、`npm run test:markdown-performance` 均通过。性能脚本报告文档 `506670` 字节、可见区 `16000` 字节、比例 `0.0316`、bundle `832599` 字节。
- `MARKDOWN_CURSOR_REGRESSION=true npm run test:markdown-selection` 通过，覆盖预览到源码以及代码、表格、引用和正文点击。
- `HEADING_SELECTION_DIRECTION` 分别为 `forward` 与 `reverse` 的拖选检查均通过，选择文本为 `Heading title`。
- 使用 `MARKDOWN_FIXTURE=E:\Desktop\repo\paper-reader\test.md` 与 `MARKDOWN_SWEEP=true` 的严格扫描通过：显示公式 `300/300`、行内公式 `100/100`、正文 `100/100`；`sourceCaret.failures`、正文失败和公式失败均为空。扫描中包含 `\tag{4}` 近邻偏移的检查。
- VS Code 集成测试 `npm test` 的 7 个用例通过，测试宿主退出码为 0。同次发布验证中也出现过用例通过、宿主退出码为 1 的运行；随后显式设置 `VSCODE_TEST_EXECUTABLE` 为 `Code.exe` 的一次运行退出码为 0。仅凭这些结果不能确定异常由 PATH 或 `code.cmd` 引起，宿主退出异常的根因未单独证实。
- 严格扫描报告图片请求 3 项失败，因为 `test.md` 所在目录没有 `assets/images`。此结果仅代表 fixture 资源缺失，不是图片渲染通过，也不计入光标失败。

复跑命令：

```powershell
npm run compile
npm run lint
npm run test:unit
npm run test:performance
npm run test:markdown-performance
npm test
npm run test:markdown-selection
$env:HEADING_SELECTION_DIRECTION = 'reverse'
npm run test:markdown-selection
Remove-Item Env:HEADING_SELECTION_DIRECTION -ErrorAction SilentlyContinue
$env:MARKDOWN_CURSOR_REGRESSION = 'true'
npm run test:markdown-selection
Remove-Item Env:MARKDOWN_CURSOR_REGRESSION -ErrorAction SilentlyContinue
$env:MARKDOWN_FIXTURE = 'E:\Desktop\repo\paper-reader\test.md'
$env:MARKDOWN_SWEEP = 'true'
npm run test:markdown-selection
Remove-Item Env:MARKDOWN_FIXTURE, Env:MARKDOWN_SWEEP -ErrorAction SilentlyContinue
```

各分支的环境变量应在切换测试后清理；尤其 `MARKDOWN_CURSOR_REGRESSION=true` 会优先执行短回归并返回，若留着它再设置 `MARKDOWN_SWEEP`，不会实际运行完整扫描。

逐点扫描要求 CodeMirror 实际 selection 与目标 UTF-16 源码偏移完全相等，包括显示公式、行内公式和公式 tag 附近字符。短文档还需验证拖选方向正向和反向，以及标题和引用的真实选择文本。`checkMarkdownPerformance.js` 的 506,670 / 16,000 / 0.0316 是脚本构造文本并截取窗口的静态守卫数据，不是编辑器运行时实测。真实浏览器中的可见区、耗时和局部编辑是否增加全文扫描由 `HEADING_SELECTION_LONG=true` 分支检查；二者都不能解释成所有设备的绝对性能保证。

测试文件 `E:\Desktop\repo\paper-reader\test.md` 引用了不在其同目录下的 `assets/images`。因此打开此 fixture 时图片请求失败是资源缺失，不能作为插件图片渲染故障结论。真实 VS Code Webview 的 URI/CSP 和图片资源验收需要存在的资源文件。

早期测试报告曾出现独立公式 `156/300`、行内公式 `21/100` 的字符级失败。该结果说明当时光标问题确实未解决；后续版本加入 glyph hit map、冻结手势起点和精确断言后，必须以重新运行的完整扫描结果替代这组历史数字，不能把历史失败隐去或当成当前结果。

## 发布记录

- 目标稳定版：`1.5.0`
- 核心变化：CodeMirror 单一解析来源、局部索引更新、精确 pointer/caret 映射、可拖动选择、KaTeX hit map 缓存和性能守卫。
- CachyOS 主机 `dell` 的 VS Code 1.138.0 已从生成的 VSIX 安装并核验 `paper-reader-lab.paper-reader@1.5.0`。
- GitHub Release：https://github.com/dirac808/paper-reader/releases/tag/v1.5.0（附带 `paper-reader-1.5.0.vsix`）。

## 图片路径与 Webview 资源修复

历史上图片位置预留高度但内容空白，需要区分资源缺失和 Webview URI 两类情况。`test.md` 被单独放在仓库外层，旁边没有它引用的 `assets/images`，此时自然宽度为 0 是文件缺失。真实翻译输出中的图片则需要通过当前文档父目录生成 `documentBasePath`，前端用 `new URL(relativePath, documentBasePath)` 解析资源，并把父目录加入 Webview 的 `localResourceRoots`。这避免仅依赖 HTML `<base>` 的隐式路径解析。移动论文时须连同 `assets` 一起移动；缺失文件无法靠 URI 修复恢复。

下面保留历史诊断路径以便重现；它们是当时机器的路径，不是安装前提。

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
- 当前严格扫描通过 `pointForPosition()` 先取得 `coordsAtPos()` 候选坐标，再使用运行时 `sourcePositionAtPoint()` 搜索可解析为目标偏移的位置。部分专项回归另用 DOM TextNode/Range 生成坐标。
- 严格偏移相等能验证候选位置在完整鼠标事件链中没有被改写；但坐标生成与运行时代码共享命中逻辑，不是完全独立的视觉精度验证。需结合用户实际点击诊断，不能将扫描通过解释成任意屏幕位置都已经测过。

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


## 2026-09-26：README 重整与 MinerU 接入说明

对照 `src/paperTranslation.ts`、`src/minerURemoteClient.ts`、配置面板和本地 MinerU 3.4.0 源码，补充两种部署方式、API 协议、全部设置、缓存/资源管理、模型和显卡配置、自检及使用限制。历史 bug 与修复说明迁至本文件，旧 `logs/README.md` 保留索引。此次为文档整理，未执行 MinerU 模型推理，也未重新声称历史测试结果是本次实测。上文同时修正了旧报告对静态性能守卫、共享命中逻辑和 VS Code 宿主退出原因的过度推断。

## 2026-09-28：空文档与长行编辑宽度

### 现象

新建空 Markdown 后，只有左侧一小块区域看起来可编辑；填入长段落后编辑区域宽度仍不正确，内容行看起来被截在一个固定宽度。问题也会影响点击空白处放置光标和对宽屏空间的利用。

### 根因

`#paper-reader-workspace` 是两列 CSS Grid：第一列为大纲 `auto` 轨道，第二列为编辑区 `minmax(0, 1fr)`。大纲用 `[hidden]` 隐藏时，编辑器没有指定列位置，Grid 自动把它放进第一条 `auto` 轨道。空文档按最小内容宽度收缩该轨道，长文档又会按内容的内在宽度撑开它，右边的 1fr 轨道反而成为空白。与此同时，CodeMirror 主题还将每行限制为 `max-width: 1100px` 并居中，进一步让行宽看似有上限。

### 修复

- 将 `#paper-reader-editor` 显式放到第二列并设为 `width: 100%`；隐藏大纲时第一列自然收缩为零，编辑器始终占据剩余空间。
- `.cm-content` 和 `.cm-line` 填满可用宽度，取消每行 1100px 上限和自动居中；保留 CodeMirror `lineWrapping`，长行仍会按视口宽度换行。
- 在自动化浏览器测试中分别加载空文档与 2400 字符单段文本，核验根节点、内容层和编辑行的几何宽度；持续运行布局断言以防回归。

### 验证

- 浏览器视口 758px 时，空文档编辑器/内容层均为 758px，行宽 710px（扣除左右内边距）。
- 长段落编辑器 758px，内容层 743px（浏览器滚动条占宽），编辑行 695px（再扣除左右内边距），文本随宽度换行。
- Markdown 单击光标回归、正反方向拖选、250,974 字符运行时性能分支、编译、Lint、单元测试、性能守卫和 Markdown 性能检查均通过。

## 2026-10-06：Markdown 表格原地编辑

### 现象

在 Markdown 编辑器里点击表格单元格、或让光标落在表格源码区间内，表格预览就会退化为 Markdown 源码；增删行列只能手工改源码。

### 根因

1. `shouldPreviewBlock`（`media/markdown/codemirror-entry.js`）只要「选区与块区间相交」就不渲染 widget，表格因此塌陷成源码。
2. 点击表格走 `activateRange` → `editingBlockUpdate`，`editingBlock` 非空后同样不渲染 widget。
3. 增删行列没有任何 UI 入口，只能编辑 Markdown 源码。

### 修复

- 新增纯模型模块 `media/markdown/tableModel.js`：`splitTableRowCells` 保留每个单元格的精确源码区间，`serializeTable` / `insertTableRow` / `deleteTableRow` / `insertTableColumn` / `deleteTableColumn` / `parseTableCellLines` 负责解析与增删行列。
- `TableWidget` 改为「活 DOM 会话」：`tableSession` 记住已挂载的 `<table>`，事务重建 widget 时把同一元素**移动**进新 wrapper，不重建、不丢焦点与光标；`eq` 在会话存活时判定相等，`tableDomMatchesSessionModel` 保证复用前 DOM 与文档模型一致。
- 单元格是可编辑子元素（CM 强制 widget 根 `contenteditable=false`，可编辑宿主必须是子节点）。编辑采用「文档为准、DOM 领先」：输入时只标记脏单元格，空闲 350ms / 失焦 / Enter / Tab / Escape / 保存前提交，用公共前后缀最小差异做一次 range 替换。因此连续输入只产生一次事务。
- 表格**永不因光标或选区退出表格视图**；只有显式「编辑表格源码」（工具栏按钮 / `editTableSource`）才进入源码模式。
- 表格外侧悬浮控件：行 `+` / 行 `×`、列 `+` / 列 `×`、底部与右侧追加、整表删除；控件不进入 Markdown 文档，一次整表事务完成增删。
- `findEditableBlock` 让「源码模式」只作用于非表格块；`findBlockAt` 供显式源码命令按区间精确命中表格。
- 新增 `scripts/tableModel.test.js`（解析/序列化往返、空单元格、转义、对齐、增删行列不漂移），并纳入 `npm run test:unit`。
- 更新 `scripts/checkMarkdownHeadingSelection.js`：原「点击表格进入源码」的两处断言改为新契约（表格保持渲染、光标仍落在对应源码偏移），并新增单元格编辑、选区、DOM 与模型一致、增删行列、源码模式入口等回归断言。

### 验证

- `npm run compile`、`npm run test:unit`、`npm run test:performance`、`npm run test:markdown-performance` 全部通过。
- `scripts/checkMarkdownHeadingSelection.js` 短文档正/反方向、长文档 250,974 字符分支全部通过。
- 250,974 字符长文档运行时对比（同一台机器、同一测试脚本）：

  | 指标 | 改动前 | 改动后 |
  | --- | --- | --- |
  | `maxUpdateMs` | 0.2 | 0.2 |
  | `maxBlockScanMs` | 1.5 | 0.7 |
  | `maxParseMs` | 9.1 | 5.7 |
  | `pointerP95` | 1.1 | 1.2 |
  | `fullSourceScans` | 22 | 22 |
  | `visibleChars` | 1750 | 1750 |

  数值随运行抖动，但无劣化：局部编辑仍只扫描本地区间，`fullSourceScans` 未上升。

## 2026-10-06（补充）：表格原地编辑的用户验收修复

插件安装到本地后，实际使用暴露了三个问题，均已修复并复测。

### 1. 光标只能停在单元格开头、拖不动

原因有两层：

- 点击表格单元格时，我把 CodeMirror 的 selection 强制设到该单元格源码的起始偏移，同时 `focus()` 单元格，导致浏览器把插入符重置到文本开头。
- widget 的 `mousedown` 被 CodeMirror `preventDefault()`，浏览器原生的插入符定位与拖选被取消。

修复：

- `activateRange` 的表格分支不再改编辑器 selection（只记录诊断信息），插入符完全交给单元格。
- 在 `pointerGesture` 里对表格单元格放行：不再对单元格 mousedown 调用 `preventDefault()`/`stopPropagation()`，让浏览器自行定位插入符与拖选。
- 单元格自身用 `document.caretRangeFromPoint` 兜底，把插入符放到点击点的字符偏移。

### 2. 外观：选中区被框起来、表格外侧有外框线

- 去掉 `.paper-reader-cm-table` 的卡片式边框与圆角，只保留行列分隔线，回到"渲染出来的 Markdown 表格"外观。
- 去掉单元格聚焦时的 `box-shadow` 焦点框，改为极浅的背景色。
- 控件从"常显网格"改为按需显示。

### 3. 外侧按钮不可用、且不应常显

- 控件改为**指针靠近某行/列边缘时**才显示该边缘对应的那一个按钮（`TABLE_CONTROL_EDGE_TOLERANCE = 12`），离开表格即隐藏。
- 定位改为以控件层自身 `getBoundingClientRect()` 为基准推导，并在表格位置变化时重新布局，修掉了"滚动后偏移一个滚动量"的问题。
- **真正的可用性 bug**：点击控件时 CodeMirror 会在指针按下期间重建 widget，按钮被移除，`click` 永远不会派发；`mousedown` 冒泡也被编辑器在 content 元素上 `stopPropagation` 截断。现在把激活绑定在 document 的 **`pointerdown` 捕获阶段**，无论哪个表格 DOM 处于挂载状态都能收到；同时保留 `mousedown` 合成事件兜底。诊断记录：真实点击路径为 `pointerdown`，旧实现只监听 `mousedown`/`click` 因此必然失效。

### 验证

- `npm run test:unit`、`npm run test:performance`、`npm run test:markdown-performance` 通过。
- `scripts/checkMarkdownHeadingSelection.js` 短文档正/反方向、长文档 250,974 字符分支全部通过；表格回归新增：点击落点插入符、单元格内拖选、控件默认隐藏、边缘悬停只显示一个、真实鼠标点击控件生效并增删行、DOM 与模型一致。
- 新增 `scripts/checkInstalledExtension.js`：用真实浏览器加载**已安装扩展**的 bundle（按 SHA256 与工作区一致）复测上述行为，全部通过。
- 长文档运行时：`maxUpdateMs` 0.2 / `maxBlockScanMs` 0.9 / `maxParseMs` 8.3 / `fullSourceScans` 22，与改动前基线一致，无劣化。

### 过程说明

期间我为了取性能基线执行了 `git checkout <ref> -- <files>`，误将工作区实现覆盖，随后依据本会话记录逐文件重建并重跑全部测试确认一致；未能提交的改动仍未进入 git 历史。

## 2026-10-06（再补充）：增删行列按钮的出现时机

用户反馈"按钮出现的时机不对"。实测（逐像素扫描表格）确认了两类问题：

### 问题 A：按钮比触发区大，指针一移上去就换掉

原来 `+`/`×` 各自在"距某条边界 12px"时显示，而按钮本身 16px。指针在行下边界触发 `+`，一移到按钮上就落进**下一行上边界**的感应区，按钮立刻被换成下一行的 `×`——按钮"抓不住"。

### 问题 B：感应区相对行高过大

行高约 36px，两侧各 12px 意味着**行内 2/3 的高度**都会弹出按钮，表格看起来一直在闪；更糟的是"粘滞"逻辑会让某个按钮被指针跨过整张表时一直保持显示（实测左上角的列 `×` 能横跨 y=128…314 持续可见）。

### 修复

- **一条边界 = 一组控件**：行下边界给 `insertRow`（末行为 `appendRow`）+ `deleteTable`；行上边界给 `deleteRow`；列左边界给 `deleteColumn`；列右边界给 `insertColumn`（末列为 `appendColumn`）。每条边界上的所有控件共享一个 `data-boundary` 标记，一起显示、一起隐藏。
- **感应区收紧到 6px**（`TABLE_BOUNDARY_TOLERANCE`），并且**同一时刻只有一条边界生效**（按距离取最近），彻底去掉跨表粘滞。
- **可达性**：在某条边界内，若指针已经落在该组某个按钮的矩形内（±2px），该按钮继续显示，因此从边界移到按钮上再按下不会中断。
- 重新定位：行控件放在左侧留白内（`rect.left + 2`，不再跑到视口外），滚动后按控件层自身原点重新布局。

### 实测时机（x=首列左侧 46px 纵向扫描，4 行表格）

```
128-146 deleteColumn:0     ← 表头列左边界
150-160 无                  ← 行内安静区
162-172 deleteRow:0        ← 第 1 行上边界
174-196 无
198-202 insertRow:0        ← 第 1 行下边界
204-208 deleteRow:1
210-232 无
234-240 insertRow:1
```

即每条边界只有约 12px 的响应窗口，行中间完全安静；列边界同理（`deleteColumn` 只在列左边界 ±6px 出现）。

### 验证

- `npm run test:unit`、`npm run test:performance`、`npm run test:markdown-performance` 通过。
- `scripts/checkMarkdownHeadingSelection.js` 短文档正/反方向、长文档 250,974 字符分支通过；新增断言：行中间悬停不得弹出控件、行边界只提供行相关控件、真实鼠标点击边界按钮生效。
- `scripts/checkInstalledExtension.js`（加载已安装扩展 bundle，SHA256 与工作区一致）9/9 通过。
- 长文档运行时 `maxUpdateMs` 0.2 / `maxBlockScanMs` 2.0 / `maxParseMs` 9.6 / `fullSourceScans` 22，与基线一致。

## 2026-10-06（第三次补充）：四个按钮的显示位置重构

用户反馈"看不到添加列，删除行和添加行叠在一起"。我写了一个探针把**每个控件的实际矩形**全部打印出来（含两两重叠检测），一次就找到了根因。

### 根因：所有控件都堆在同一个点上

```
insertColumn:0  lane=0  rect=(150,118) 16x16
insertColumn:1  lane=0  rect=(150,118) 16x16
insertRow:0     lane=1  rect=(150,118) 16x16
deleteRow:0     lane=3  rect=(150,118) 16x16
... 15 个控件全部 rect=(150,118)
```

`layoutTableControls()` 在 `attachTableControls()` 里被调用，而那时表格还没插进文档，控件层的 `getBoundingClientRect()` 全为 0，函数直接 return，"定位"从未发生过。于是所有按钮保持默认位置、叠在控件层原点：只有 DOM 顺序最后一个能收到鼠标事件——**这就是"添加列看不到"和"增删行叠在一起"的唯一原因**。

### 修复

1. **挂载后再布局**：`toDOM()` 里在 rAF 中调用一次 `session.layoutTableControls()`（`toDOM` 返回时元素才被插入文档）；同时每次指针经过都重算一次，这样滚动、缩放、widget 重建都不可能再留下堆叠状态。原来的"原点变化才重算"判断已删除，它不可靠。
2. **四个动作各占独立区域**（互不重叠）：
   - 表头上方预留 34px 横向带，分两行：第一行放 `×` 删除列，第二行放 `+` 插入列（末列固定为"末尾添加列"）。
   - 表格左侧 34px 留白放行控件，按行交替泳道：`+` 靠外、`×` 靠内，因此相邻行共享同一条边界线时也不会撞在一起。
   - 表格末尾的"末尾添加行""删除表格"复用同两条泳道，避免再向外扩一条泳道而在窄面板里跑出视口（探针实测面板 750px 宽时曾跑到 x=-4）。
3. **补上"可达性"缺口**：控件显示后，指针允许在按钮矩形 ±6px 内移动，控件保持显示。之前指针从边界挪到按钮的最后几像素会先离开 6px 感应带，按钮在按下前消失。

### 新增的永久断言

- 浏览器套件：**任何两个控件矩形不得重叠**、每个控件都必须归属某条边界（不得有未定位的控件）、四个动作都必须能从某条边界触发到。
- 静态守卫：锁定 `COLUMN_BAND_HEIGHT`/`ROW_CONTROL_LANE` 泳道常量与挂载后 rAF 布局调用。
- `scripts/checkInstalledExtension.js`：在**已安装扩展**上复测"无重叠 + 全部在视口内 + 四个动作齐全"。

### 验证

`test:unit`、`test:performance`、`test:markdown-performance` 全部通过；短文档正/反方向、长文档 250,974 字符三个分支通过；已安装 bundle（SHA256 与工作区一致）11/11 通过。长文档 `maxUpdateMs` 1.1 / `maxBlockScanMs` 0.7 / `maxParseMs` 8.2 / `fullSourceScans` 22，与基线一致。

## 2026-10-06（第四次补充）：标题不再显示 `##`

### 改动

`## 选择 MinerU 部署方式` 以前会把 `##` 一起画出来（截图里还带着下划线）。原因：`hiddenSyntax` 集合只含 `CodeMark`/`EmphasisMark`/`LinkMark`/`URL`，**`HeaderMark` 从来没被隐藏过**；CSS 里那个 `.paper-reader-cm-heading-marker { visibility: hidden }` 因没有任何代码添加该 class 而从未生效。

修复：在语法树遍历里对 `HeaderMark` 输出 `Decoration.replace({})`，把 `##` 连同其后一个空格一起**折叠掉**（不是 `visibility: hidden`——那样会留下宽度，标题下划线会在空白下画一截）。标题行的 `paper-reader-cm-heading-N` 样式保持不变。

源码侧不受影响：`HeaderMark` 只影响渲染，文档里仍然是 `## 选择 MinerU 部署方式`，保存后照旧。光标进入标题也不再闪现 `##`。

### 验证

- 浏览器套件新增断言：标题行 DOM 文本不含 `#`、仍带 `paper-reader-cm-heading-` 样式类、文档源码仍匹配 `^#{1,6} Heading title$`。
- 两个静态守卫新增：必须存在 `HeaderMark` 折叠分支、必须不存在 `paper-reader-cm-heading-marker`（防止退回旧做法）。
- `test:unit`、`test:performance`、`test:markdown-performance` 通过；短文档正/反方向、长文档 250,974 字符三个分支通过；已安装 bundle 复测通过。长文档 `maxUpdateMs` 1.3 / `maxBlockScanMs` 0.9 / `maxParseMs` 3.9 / `fullSourceScans` 22。

### 截图里另外两点（已核实，非缺陷 / 待定）

- **表格右侧"被截断"**：实测面板宽度 1400/900/750/560px 下，表格右边缘始终在 `.cm-content` 右边缘内 54–150px，无横向溢出；最后一行最后一列的文本完整存在于 DOM。截图是右侧被裁切的视觉效果，表格本身没有超出。
- **单元格里的反引号**：单元格是 `plaintext-only` 的 contenteditable，`host.textContent = text`，未做任何行内 Markdown 渲染，所以 `` `paper-reader.mineru.apiUrl` `` 按字面显示。这是表格原地编辑模型的直接后果——整套偏移/插入符/提交逻辑都建立在"单元格文本 === 源码文本"之上。要不要做单元格行内渲染需要单独决定与实现，本轮未改。

## 2026-10-06（第五次补充）：按钮位置改为语义化，并修掉一串几何失效问题

按用户的语义要求重做：**`+` 贴在行/列交界处**（"在这两行之间添加行"），**`×` 贴在它所属的那一行/列旁**（"删除这一行"），且都在表格外侧、紧靠表格。

### 新布局

| 控件 | 位置 |
|---|---|
| 删除行 `×` | 左侧留白，**该行垂直中心线**上（紧靠表格内层左边缘） |
| 插入行 `+` | 左侧留外一条泳道，**该行下边界（与下一行的交界）**上 |
| 删除列 `×` | 表头上方**第一行**，位于**该列水平中心** |
| 插入列 `+` | 表头上方**第二行**，位于**该列右边界（与下一列的交界）** |
| 末尾加行/加列、删除表格 | 表格末端各自的空闲泳道 |

响应区也按语义切分：**一行被分成互不重叠的两段**——上半段属于该行自己的 `×`，下半段属于交界处的 `+`；列同理，且列的响应区止于表头（否则宽列会把整个表身吞掉，行控件永远触发不到）。

### 这一轮暴露并修掉的 5 个真实缺陷

写了一个探针把每个控件的矩形、它所属的响应区、以及"鼠标停在按钮正中心能否显示该按钮"全部断言出来，于是连环挖出：

1. **`layoutTableControls()` 的返回值被忽略**：函数在测不到几何时 `return false`，但调用方照旧继续，于是用陈旧几何算出一堆错位按钮（探针抓到 `insertRow:0` 被画到 `y=94`，比表格还高）。
2. **监听器绑在 `<table>` 上**：按钮现在位于表格**之外**的留白里，指针移向按钮时表格级 `mousemove` 根本不触发，按钮在按到之前就消失。改为绑在 widget 根节点上。
3. **几何在构建时被闭包捕获**：`buildTableElement` 在表格**还游离于文档之外**时就 `attachTableHandlers`，闭包捕获的单元格矩形全是 0 —— 所有响应区形同虚设。改为"只在挂载后绑定"（新增 `mountTableElement`），且每次指针经过都从**当前已连接的** `<table>` 重新查询单元格。
4. **控件注册表是闭包私有的 Map**：重建后解析器仍持有旧图层的按钮（`isConnected:false`），画出来的按钮不在文档里。改为 `session.controls` 单一权威注册表，并在揭示时拒绝未挂载的按钮。
5. **`hideTableControls()` 只清了 DOM class，没清 `session.visibleControls`**：粘滞判断因此认为"指针仍停在按钮上"，永远短路，什么都不再显示。

另外补上：图层尺寸为 0 时改用 wrapper 的矩形作为定位基准（`inset:0` 的纯定位层可以测出 0），以及表格级 cell 事件处理器加了 `dataset` 守卫，避免重复绑定。

### 永久断言（防回归）

- 主套件：**每个控件必须能被它语义对应的位置触发出来**（`row-i` → deleteRow、`row-junction-i` → insertRow、`column-i` → deleteColumn、`col-junction-i` → insertColumn），任何一个不匹配即失败。
- 已安装扩展验证器：新增"控件不得重叠 / 全部在视口内 / 四个动作齐全 / **每个控件的位置与它作用的行、列或交界一致**"。
- 静态守卫：锁定"从已挂载表格读取几何""布局失败即不显示""拒绝未挂载按钮""挂载后才绑定处理器"。

### 验证

`test:unit`、`test:performance`、`test:markdown-performance` 通过；短文档正/反方向、长文档 250,974 字符通过；已安装 bundle（SHA256 与工作区一致）12/12 通过。长文档 `maxUpdateMs` 0.1 / `maxBlockScanMs` 0.9 / `maxParseMs` 4.4 / `fullSourceScans` 22。

## 2026-10-06（第六次补充）：让按钮真正紧贴表格

用户看完截图后指出"按钮没有紧贴，而且似乎也不是两行的交接处"。我又写了一个专门的**间距探针**，把每个按钮到表格边缘、到行交界线的像素距离全部量出来，结论是：

### 先纠正我自己的判断

- **垂直方向其实是对的**：`insertRow:0` 的中心距该行下边界 **-0.4px**，`insertRow:1` 是 **0px**，`insertRow:2` 是 **-0.7px**。也就是 `+` 确实落在两行的交界线上。截图里看着偏，是因为截图被裁切、表格上方还有看不见的行，肉眼很难对位。
- **水平方向确实不合格**：`×` 距表格左边 **2px**（合格），但 `+` 距 **20px** —— 因为 `+` 被放在外侧泳道，看起来就是"飘在外面"。

### 修复

1. **两条行泳道改为都向右对齐**，`+` 贴住表格左边缘（间距 2px），`×` 往左一条泳道（间距 20px）。这样 `+` 紧贴表格，同时两者在共享的行交界处纵向分割、永不重叠。
2. **列按钮不再互相压住**：`insertColumn` 的 `+` 原来自中心压在列边界上，会和**右邻列**的 `×` 重叠 16px。现在 `+` 收在边界左侧（`rect.right - half - 2`），与右邻列的 `×` 相隔 4px；`appendColumn` 也移到表格右外侧。
3. **删掉表格的 `title` 提示**：截图里那个 `Click a cell to edit the table in place` 原生 tooltip 会跟着鼠标扫过整张表格、盖住单元格。

### 新增断言

- 已安装验证器新增"**间距断言**"：`insertRow` 必须紧贴表格边缘（间距 0–4px）、`deleteRow` 必须恰好在外侧一条泳道（14–26px）、列控件必须落在正确的列中心/交界上。
- 静态守卫锁定两条泳道常量的定义式。

### 验证

`test:unit`、`test:performance`、`test:markdown-performance` 通过；短文档正/反方向、长文档 250,974 字符通过；已安装 bundle（SHA256 与工作区一致）12/12 通过。长文档 `maxUpdateMs` 0.6 / `maxBlockScanMs` 1.3 / `maxParseMs` 8.8 / `fullSourceScans` 22。

## 2026-10-06（第七次补充）：同一条泳道、真正贴紧

用户给了两张**完整包含表格上下边界**的截图，并指出："并没有贴紧也没有对齐……如果安排合理，目前这个按钮大小全都贴紧也是可以互不重叠的。"

这句话点破了症结。我之前的方案是**两条水平交错的泳道**（`+` 贴表格、`×` 往外一条），理由是"两者中心只差半行、必须错开"。但用户说得对——算一下就明白：

- 行高 ≈ 36px，`×` 在行中心、`+` 在行交界，两者中心相距 **18px**；
- 按钮宽度只要 **≤ 16px**，放在**同一条泳道上**就永远不会重叠。

也就是说**根本不需要两条泳道**，我多绕了一层，代价就是 `+` 被推到离表格 20px 的地方。

### 最终布局

| 项 | 值 |
|---|---|
| 按钮尺寸 | **14×14**（原 16×16） |
| 控件泳道 | **唯一一条**，右对齐贴住表格左边缘，间距 **2px** |
| `×` 位置 | 该行垂直中心线 |
| `+` 位置 | 该行下边界（交界）再下移 2px |
| 泳道内两者间距 | 9px（不重叠，有呼吸） |
| 左侧留白 | 38px（原 34px，仍只放一条泳道） |
| 顶部列控件带 | 30px（两行 14px 控件） |

### 实测（间距探针）

```
tableLeft: 62  controlSize: 14
distinct row-control x positions: [46]        ← 两个按钮同一条泳道
deleteRow:0  x=46 right=60 gapToTable= 2  centreY=202 targetY=201.4 delta=0.6
insertRow:0  x=46 right=60 gapToTable= 2  centreY=222 targetY=219.6 delta=2.4
insertRow:1  x=46 right=60 gapToTable= 2  centreY=259 targetY=257.0 delta=2.0
overlaps: none
```

两个按钮 x 完全一致（对齐）、右边缘距表格 **2px**（贴紧）、垂直误差 ≤2.4px（在交界上）、**零重叠**。

### 断言更新

- 已安装验证器：`insertRow` 与 `deleteRow` **都必须**贴紧表格（间距 0–4px）、**且 x 必须相同**（同一条泳道）；`+` 必须落在交界下方 1–5px。
- 静态守卫：锁定 `CONTROL_SIZE = 14` 与 `rowLaneX` 的单泳道定义式。

### 验证

`test:unit`、`test:performance`、`test:markdown-performance` 通过；短文档正/反方向通过；已安装 bundle（SHA256 与工作区一致）12/12 通过。

## 2026-10-06（第八次补充）：多行行的按钮位置错误

用户报告："如果这一行的内容有多行，按钮位置就错误，单行正确。"

### 根因

`bodyCells` 把每一行映射成 **`tr` 的第一个 `.paper-reader-cm-cell`**，然后所有行几何都从这个单元格的矩形推导：

```js
const liveBodyCells = () => [...mountedTable().querySelectorAll('tbody tr')]
  .map((row) => row.querySelector('.paper-reader-cm-cell'));   // ← 只取第一列
```

**行高由该行最高的那个单元格决定**。所以只要**不是第一列**的那一格换行，`tr` 就变高，而按钮仍按第一列的小格子定位——`×` 跑到行顶部、`+` 跑到行中间。

复现数据（面板 620px，第一列短、第二列换行）：

```
row #0: row = 182.7..264.8 (高 82.2)，但首个单元格 = 183.2..219.6 (高 36.4)
deleteRow:0  centreY=202   target=223.8   delta=-21.8
insertRow:0  centreY=222   target=264.8   delta=-42.8     ← 差 43px
```

### 修复

1. **改用 `tr` 自身的矩形**：新增 `liveBodyRows()`，布局与响应区都从 `tr.getBoundingClientRect()` 推导。修复后同样的用例：`deleteRow:0 delta=+0.2`，`insertRow:0 delta=+2.2`。
2. **几何变化时重新布局**：原来布局只在"挂载后一帧"和"指针经过"时重算。文档更新或重渲染改变了行高时，指针不在表格上就不会重算，按钮停在上一次布局的位置（实测整体偏移 20px）。新增 `observeTableGeometry()`，用 `ResizeObserver` 监听 widget 根节点，几何一变就重算（开销可忽略：只在尺寸真正变化时触发）。

### 新增回归测试

已安装验证器新增 "controls stay aligned when a row grows taller than its first cell"：
- 把面板压到 560px 并注入一个"第一列短、第二/三列超长必然换行"的表格；
- 断言至少有一行确实比它的首个单元格高（确认测试条件成立，否则检查会形同虚设）；
- 断言每行的 `×` 在行中心 ±2px、`+` 在行交界 +5px 内。

**这个测试在修复前是失败的**（`wrappedRows:1`、6 项偏移 -10.8 ~ -22.5px），修复后通过——也就是说它真的能抓住这个 bug。

### 验证

`test:unit`、`test:performance`、`test:markdown-performance` 通过；短文档正/反方向通过；长文档 250,974 字符 `maxUpdateMs` 1.1 / `maxParseMs` 8.1 / `fullSourceScans` 22；已安装 bundle（SHA256 与工作区一致）13/13 通过。

## 2026-10-06（第九次补充）：列按钮复查 —— 找到的是"按钮命中不到自己"的系统性问题

用户说"行的按钮修好了，列的按钮同理也要修复"。我先量了列的位置，**列的水平定位本来就是准的**（表头换行、列宽不均时与列真实中心/边界误差 ≤0.4px，行高变化也不影响），列控件与行控件结构完全对称。

于是我把检查换成更严格的问题："**指着某个按钮，能不能把它自己显示出来**"，逐个控件断言。这一下挖出 4 个真实缺陷：

### 1. 两个共享同一区域的控件，只有其中一个能被点到

`insertRow:3`（末行的 `+`）与 `appendRow:3`（末尾加行）共用 `row-junction-3` 区域，但解析器只返回了其中一个（`||` 回退）。结果：被画出来的那个按钮**永远点不到**。改为返回该区域拥有的**全部**控件。

### 2. 末行的 `+` 落在"行中心"区域里，被邻居抢走

区域划分的轴线取在行中心，而按钮在 `行底+2`。行高 36px 时两者相距 20px，`+` 按钮的中心（`行底+2`）落进了"行中心"区域的容差里，于是指着 `+` 却显示 `×`。改为**按两个控件位置的中点切分**（`insertY = 行底+2`、`deleteY = 行中心`、切点 = 两者中点），保证每个区域都装着自己的按钮。

### 3. `appendRow`（末尾加行）的中心落在末行区域内

给它单独的区域与容差（`COLUMN_BAND_HEIGHT + 10`）。

### 4. `deleteTable`（删除表格，表格右上角）完全点不到

它位于表格右侧，但该点的 y 落在末行区域里，被 `insertRow:2` 抢走。给它单独的区域（同时约束 x 靠近它自己）。

### 顺带修掉一个用户可感知的 bug：单元格内拖选会被吞掉

`mousedown` 里那套"聚焦后下一帧补正插入符"的机制，会在**拖选**时把用户刚选中的跨度折叠回插入符（拖拽起点在最左端 → 补正到 offset 0 → 选中内容全丢）。修复：补正前检查选区，**若已是非折叠选区就不再干预**。

### 布局时机改为 measure 阶段

原来用 `requestAnimationFrame` 重算布局，实测会早于编辑器把 widget 重新插入文档，导致按钮停在上一次布局的位置（整体偏 20px）。改为 `view.requestMeasure({ read: ... })`，在几何确定的同一测量阶段完成布局。

### 永久断言（新增/加强）

- **指着每个控件自己的矩形，必须显示出它自己**（逐个遍历所有控件，行与列共用这一条）——这一条正是抓出上述 4 个缺陷的测试。
- 已安装验证器：列控件按**表头与数据格的并集**（列的真实范围）校验中心与边界，而不是只看表头格。
- 静态守卫：锁定 `requestMeasure` 布局与"拒绝未挂载按钮"。

### 验证

`test:unit`、`test:performance`、`test:markdown-performance` 通过；短文档正/反方向通过；长文档 250,974 字符 `maxUpdateMs` 0.2 / `maxParseMs` 5.7 / `fullSourceScans` 22；已安装 bundle（SHA256 与工作区一致）13/13 通过。

## 2026-10-06（第十次补充）：列的删除按钮改为贴住列的起边界

用户截图指出：列的 `×` 悬在**列的正中间**上方（x≈206，而列左边界在 x≈112），离表格左边缘还有 95px。行的 `×` 贴在行的上边界，列的 `×` 按同样的边语义应该贴在**列的起边界**。

### 修复

| 控件 | 新位置 |
|---|---|
| 删除列 `×` | 该列**起边界**正上方（首列即表格左边缘外侧 5px；末列用表格右边缘，否则会和"末尾加列"重叠） |
| 插入列 `+` | 该列**终边界**外侧（首列右边界的右外侧），与右邻列的 `×` 错开约 20px |
| 末尾加列 | 表格右边缘外侧 |

纵向也收紧：`×` 的底边距表格顶边仅 2px（原 21px），两行控件紧贴表头上方。

### 顺带修掉的系统性问题：区域与按钮脱节

排查中发现**揭示区域是"重新算一遍位置"**得到的，而不是用按钮实际摆放的位置。两处算法一旦有细微差别（实测差 9px），按钮就会落进邻居的区域里，**指着它却显示别的按钮**。改成：布局时为每个控件记录它被放置的锚点，区域直接由这些锚点推导。

同时把匹配规则简化成一条用户能预期的规则：

> **指针落在按钮矩形上（±3px）→ 显示该按钮**；否则显示沿"分离轴"最近的那个控件（行按纵向、列按横向）。

这一条同时解决了"表格末端控件（删除表格、末尾加行）点不到"的问题——它们在行泳道之外，按纵向距离永远算不到。

### 永久断言

- 主套件：**遍历每个控件，把指针放在它自己的矩形中心，必须显示出它自己**；并逐个校验"某条边界只能给出对应动作的控件"。
- 静态守卫：锁定"指针在按钮上即显示它"这条规则、锚点来源、以及 `CONTROL_SIZE = 14` / `COLUMN_BAND_HEIGHT` 的定义式。

### 验证

`test:unit`、`test:performance`、`test:markdown-performance` 通过；短文档正/反方向通过；长文档 250,974 字符 `maxUpdateMs` 1.6 / `maxParseMs` 5.6 / `fullSourceScans` 22；已安装 bundle（SHA256 与工作区一致）13/13 通过。

## 2026-10-06（第十一次补充）：列按钮按用户定义定位 + 表格外空白不再"点一下就退回源码"

用户给了两张完整截图，明确指出两件事。

### 1. 列按钮位置（按用户定义，推翻我上一轮的判断）

前一轮我按"行的 `×` 贴在行上边界"的类比，把列的 `×` 放到了**列的起边界**。用户这次明确定义：**`×` 应在该列正中间上方，`+` 在表格外侧的交界处**。已照此重做：

| 控件 | 位置 |
|---|---|
| 删除列 `×` | 该列**水平中心**正上方 |
| 插入列 `+` | 该列**右边界外侧**（表格外） |
| 末尾加列 | 表格右边缘外侧 |

列间距 20px（`rect.right + 半宽 + 6`），两个控制器不会互相抢占指针位置。

### 2. 表格外一圈空白可点击 → 退回纯代码（真 bug）

widget 为按钮预留了左 38px / 上 30px 的留白，**点它会把编辑器光标移到那一段，表格随即退出渲染、变回源码**。两个层面的问题：

- **留白太大**：收紧为左 22px、上 20px（一个控件宽 + 一点余量），并把表格的留白改成 widget 自己的 padding（表格内缩进 padding 里），这样留白属于表格的盒子，而不是飘在盒外的空白。
- **点击会穿透到编辑器**：真正的原因是 CodeMirror 在 `contentDOM` 上以**捕获阶段**监听指针事件，而这个 `contentDOM` 是留白区的**祖先**——我在 widget 上挂的监听（无论捕获与否）都排在它后面，`preventDefault` 也没用。改为在 **window 捕获阶段**拦截：目标是表格 widget 但不在 `<table>` 或控件按钮内时，`preventDefault` + `stopPropagation`。window 捕获排在 `contentDOM` 捕获之前，这一层才拦得住。

### 新增回归测试

已安装验证器新增 "clicking the widget's margin keeps the table rendered"：取 widget 左留白的中点按下并抬起，断言表格仍在渲染。**该测试在修复前失败**（`tables: 0`、wrapper 整个被移除），修复后通过；它同时是我定位这个 bug 的主要手段。

### 验证

`test:unit`、`test:performance`、`test:markdown-performance` 通过；短文档正/反方向通过；长文档 250,974 字符 `maxUpdateMs` 0.1 / `maxParseMs` 4.5 / `fullSourceScans` 22；已安装 bundle（SHA256 与工作区一致）**14/14** 通过。

## 2026-10-06（第十二次补充）：列按钮定位 + 表格外空白点击不再退回源码

用户给了两张截图。

### 图一：`+` 看起来还在表格里

量了截图：`+` 的水平位置**确实在列的右边界上**（表格很宽、截图被裁掉了右半部分，所以看起来像在表格内），但**纵向压住了表格上边框**——一半在表格里、一半在外面，所以视觉上像"在表格里"。

已修：`+` 和 `×` 整体上移到表格上边框之外（留 2px 间隙），并把 widget 的 padding-top 从 20px 加到 34px 以容纳这两行按钮。同时为 `×` 加了一条通用规则：**`×` 悬在该列正中间上方，`+` 悬在该列右边界外侧**。

### 图二：点表格外空白会退回源码（真 bug）

widget 为按钮预留了左 22px / 上 20px 的边距，**点它会移动编辑器光标，表格随即退出渲染变回源码**。

排查清楚了三层原因：

1. **边距不属于 widget 的盒子** → 改为把表格内缩进 widget 的 padding 里，边距成为 widget 自己的区域。
2. **CodeMirror 在 `contentDOM` 上以捕获阶段监听指针事件**，而 `contentDOM` 是 widget 的祖先，所以在 widget 内部挂的监听都排在它后面、`preventDefault` 也无效 → 改为在 **window 捕获阶段**拦截。
3. 拦截范围要**排除单元格和控件按钮**（它们需要浏览器自己的聚焦与光标定位，控件需要自己的激活逻辑），只吃掉剩余部分。

第 3 点是踩过的坑：一度把单元格的整个手势都吃掉，导致单元格点不聚焦（主套件立刻报 `Clicking a table cell must focus the cell`）。最终形态只对"在表格 widget 内、但不在单元格内、也不在控件上"的目标做 `preventDefault + stopPropagation`。

### 仍未解决

点**短单元格文字下方的空白**（多行行里，某格文字只有一行、下方是空的）时，光标**不会**移动。原因是那块空白属于裸 `<td>` 而不属于可编辑的 `.paper-reader-cm-cell`，而 CodeMirror 的 `pointerdown` 会 `preventDefault` 掉后续的 `mousedown`，导致表格自己的 mousedown 处理器永远收不到它。试过让单元格撑满 `<td>`（`min-height` 方案）：能点到了，但把表格撑出大片空白（表头高 141px），而且主套件的单元格聚焦仍失败，已回退。**当前行为：点空白不再毁掉表格（这是用户报的主要问题），但光标不动。** 需要专门处理 `<td>` 的指针手势才能真正修好。

### 验证

`test:unit`、`test:performance`、`test:markdown-performance` 通过；短文档正/反方向通过；长文档 250,974 字符 `maxUpdateMs` 0.9 / `maxParseMs` 8.3 / `fullSourceScans` 22；已安装 bundle（SHA256 与工作区一致）**14/14** 通过，其中含回归测试 "clicking the widget's margin keeps the table rendered"。

## 2026-10-06（第十三次补充）：列按钮真正贴住表格

用户第三次指出列按钮没贴住。这次不再靠推导，直接量了实际渲染坐标：

| 控件 | 位置 | 应有位置 | 判定 |
|---|---|---|---|
| 列边界 | `[46,161]` `[162,410]` `[411,704]` | — | — |
| `+` 水平 | x `[161,175]` | 列边界 161 | ✅ 左边缘正好压在边界上 |
| `+` 纵向 | y `[110,124]` | 紧贴表格顶边（141）之下 | ✅ 底边距顶边 17px（下方是 `×`） |
| `×` 水平 | x `[96,110]` | 列中心 103.5 | ✅ |
| `×` 纵向 | y `[125,139]` | 紧贴表格顶边 | ✅ 底边距顶边 **2px** |

### 之前错在哪

- `+` 水平有 **6px 间隙**（`rect.right + half + 6`）→ 改成 `rect.right + half`，间隙归零。
- `×` 离表格顶边 **35px**、`+` 离 **19px**（因为 `×` 与 `+` 之间留了 3px，`×` 又离表格 2px，但 `×` 的 y 是按"表格顶边 - 半高 - 2"算的，实际渲染却高出很多）→ 重新推：`×` 中心 = 表格顶边 - 半高 - 2，`+` 中心 = `×` 中心 - 控件高 - 1。现在两者只隔 1px，整条带紧贴表格。
- widget 顶部留白相应从 34px 收到 31px，外部 margin 从 6px 收到 4px，保证上方的 `+` 不被裁掉。

### 顺带收紧的校验

已安装验证器新增两条断言：`+` 的水平中心必须在列边界半个控件宽之内（容差 4px），且 `×` 与 `+` 的底边距表格顶边都必须在整条带的高度之内。这样"没贴住"这类回归会在机器上被拦住。

### 验证

`test:unit`、`test:performance`、`test:markdown-performance` 通过；短文档正/反方向通过；长文档 250,974 字符 `maxUpdateMs` 0.1 / `maxParseMs` 8.2 / `fullSourceScans` 22；已安装 bundle（SHA256 与工作区一致）**14/14** 通过。

## 2026-10-06（第十四次）：短单元格空白 —— 尝试未成功，已回退

用户明确要求：**单元格有文字时，该单元格的空间应全部归这些文字占用**（即文字下方的空白也算这个单元格）。

### 尝试过的做法

1. **让 `.paper-reader-cm-cell` 撑满 `<td>`**
   - CSS `display:block; height:100%`：`height:100%` 在表格单元格里实测无效（单元格仍 36px，`<td>` 是 105px）。
   - JS 设 `min-height`（在布局阶段用 `<tr>` 高度）：能撑满，但把表格撑出大片空白（表头高到 141px），且主套件的"点单元格要聚焦"立刻失败，已回退。
2. **把裸 `<td>` 的按键重放到所在单元格的 host 上**
   - 扩宽 `findCellHost`，让 `<td>` 也解析到它内部的 `.paper-reader-cm-cell`。
   - 在 window 捕获阶段拦截 `<td>` 上的 pointerdown，同步 focus + 定位光标，再在下一帧补一次。
   - 独立探针里**一度成功**（表格存活、单元格聚焦、光标落在文字末尾）。
   - 但放进已安装验证器后**稳定失败**（`activeElement` 仍是 `cm-content`）。原因是 `findCellHost` 扩宽后被多处复用，主套件的"点单元格要聚焦"也随即失败。

### 结论

试了三轮都没能稳定成立，**已全部回退到上一轮验证通过的版本**（14/14 通过）。当前行为：

- 点表格外空白 / 裸 `<td>`：**表格不会被毁掉**（这是用户报的主要问题，已修）。
- 但光标**不会**落到该单元格里。

根因已定位清楚：**CodeMirror 的 `pointerdown` 处理器会 `preventDefault`**，从而抑制后续的 `mousedown`；而表格的光标定位逻辑挂在 `<table>` 的 `mousedown` 上，所以对裸 `<td>` 目标永远收不到事件。真正稳的解法是让可编辑 host 在布局上就填满 `<td>`，但 `height:100%` 在表格单元格里不生效，需要换一种撑满方式（例如用 `td` 上的 `align-items: stretch` + `display:flex`，或把 host 提到 `<td>` 的尺寸层），这需要单独一轮来做，并同步改主套件里对 `findCellHost` 的复用。

已把这段结论写进 log，避免下一轮重复踩。

## 2026-10-06（第十五次）：列按钮压到交界线上 + 方案1（单元格撑满）做成

用户第二次说"依旧没有紧贴"，并选了方案1。这次先量像素再动手。

### 问题1：`+` 悬空了一整个控件高

在用户的视口宽度（772）下实测：

| 项 | 值 |
|---|---|
| 列边界（header cell 右边缘） | 139 |
| `+` 水平 | x `[139,153]` → 左边缘 **正好 139** ✅ |
| 表格顶边 | 141 |
| `+` 纵向 | y `[110,124]` → 底边距表格顶边 **17px** ❌ |
| `×` 纵向 | y `[110,124]` 同一条带 |

所以水平其实一直是贴的（用户是在比"列边界"，而截图裁掉了右边），**真正的问题是纵向**：`+` 和 `×` 各占一条带，`+` 在上面那条，离表格一整个控件高。

修法：把两条带对调 —— **`+` 在下面那条（压在表格顶边上），`×` 在上面那条**（`+` 上面 1px）。现在实测 `+` y `[125,139]`，底边距表格顶边 **2px**。

### 问题2：方案1（单元格占满整个 `<td>`）

试过两条路，都失败：

- `height: 100%`：在表格单元格里无效，host 仍只有文字高（36px vs `<td>` 105px）。
- `<td>` 上 `display: flex; align-items: stretch`：能撑满，但**表格行高彻底坏掉** —— 每个 `<td>` 变成独立 flex 行，`tr` 不再共享行高（实测 r0 变成 201–358，列之间错位）。

最终成立的解法（就是方案1的本意）：

1. **去掉 `th/td` 上的 `vertical-align: top`** —— 这一步让 host 从"紧贴文字"变成"占满可用高度"。量到短单元格从 68px 死区降到 **1px**。
2. **在布局阶段把 host 的 `min-height` 设成行高**，补掉剩下的 1px。关键是**先清空所有 min-height、量完所有行高、再统一写入** —— 之前撑爆表格（表头 141px）就是因为边量边写、让上一次写入的高度又进了下一次的行高计算。

最终实测：所有单元格 `td` 与 host 的高度差 **0–1px**，表格总高正常。

### 顺带修掉的坏测试

"controls stay aligned when a row grows taller than its first cell" 原来用"行高 > 首格高"判断是否换行 —— 单元格撑满后这个判据恒为假，测试本身失效。改成**按单元格文字行数**判断（`cellHeight > lineHeight * 2`），这才是"换行"的真实含义。

### 验证

`test:unit`、`test:performance`、`test:markdown-performance` 通过；短文档正/反方向通过；长文档 250,974 字符 `maxUpdateMs` 1.1 / `maxParseMs` 8.3 / `fullSourceScans` 22；已安装 bundle（SHA256 与工作区一致）**16/16** 通过，新增两条：`every cell fills its table cell`、`clicking the bottom of a tall cell puts the caret in that cell`。

## 2026-10-06（第十六次）：列按钮改为单泳道，两个都紧贴

用户最后一句是"都要紧靠！"。根因终于明确：**把 `+` 和 `×` 放在上下两条带里，无论怎么排，总有一个离表格一整个控件高（17px）** —— 因为两条 14px 的带叠起来就有 34px。

对比行的做法：行的两个按钮（`×` 在行中心、`+` 在交界处）**共用一条带**，所以两个都贴住表格左边缘。列也应该这样。

### 改法

`+` 与 `×` 放进**同一条带**（表格上方 2px）。同带不重叠的原因和行一样：两者 x 不同 —— `×` 在列中心，`+` 在该列右边界，水平至少隔半个列宽（≥45px），而按钮只有 14px 宽。

### 实测（视口 772）

| 控件 | x | 距表格顶边 |
|---|---|---|
| deleteColumn:0 | `[96,110]` | **2px** |
| insertColumn:0 | `[161,175]` | **2px** |
| deleteColumn:1 | `[279,293]` | **2px** |
| insertColumn:1 | `[410,424]` | **2px** |
| deleteColumn:2 | `[551,565]` | **2px** |
| appendColumn:2 | `[704,718]` | **2px** |

全部 2px，同一条带，无重叠。

### 永久断言

已安装验证器新增 "both column controls hug the table in one lane"：断言所有列控件的 `bottomGap` 相同且在 0–4px 内、且只有一个不同的 y。这样"某个按钮被挤到另一条带"的回归会被机器拦住。

另外这一轮也顺带修好了两个失效的旧判据：

- "controls stay aligned when a row grows taller than its first cell" 原来用"行高 > 首格高"判断换行 —— 单元格撑满后恒为假。改成按单元格文字行数判断。
- 上一轮"单元格撑满"（方案1）的两条新断言继续有效。

### 验证

`test:unit`、`test:performance`、`test:markdown-performance` 通过；短文档正/反方向通过；长文档 250,974 字符 `maxUpdateMs` 0.2 / `maxParseMs` 5.4 / `fullSourceScans` 22；已安装 bundle（SHA256 与工作区一致）**17/17** 通过。
