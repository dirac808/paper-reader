# 问题调查、修复与验证日志

README 面向安装、配置与使用；本文集中保存历史故障、修复过程和验证边界，供后续改动时查阅。

本文记录两类内容：

1. **光标与选区**：Paper Reader Markdown 编辑器在 1.5.0 之前遇到的交互故障、定位过程、根因和按五阶段实施的重构。
2. **Markdown 表格原地编辑**（1.6.0）：表格原地编辑模型，以及表格外侧结构控件的定位设计约束、命中区域推导方式和试错结论。

记录重点是可以从代码与回归脚本验证的事实，不把「没有跳出公式块」当成光标正确，也不把模拟单击当作完整的真人验收。

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

| 版本 | 核心变化 | 安装与发布 |
| --- | --- | --- |
| `1.5.0` | CodeMirror 单一解析来源、局部索引更新、精确 pointer/caret 映射、可拖动选择、KaTeX hit map 缓存和性能守卫 | [v1.5.0](https://github.com/dirac808/paper-reader/releases/tag/v1.5.0)；CachyOS 主机 `dell` 的 VS Code 1.138.0 已安装并核验 |
| `1.6.0` | Markdown 表格原地编辑与表格外侧结构控件（详见「Markdown 表格原地编辑」） | [v1.6.0](https://github.com/dirac808/paper-reader/releases/tag/v1.6.0)（附 `paper-reader-1.6.0.vsix`）；`dell` 已安装并核验 bundle SHA256 与工作区一致 |

发布流程见 README 的[开发与验证](README.md#开发与验证)一节。

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

- 新增纯模型模块 `media/markdown/tableModel.js`：`splitTableRowCells` 保留每个单元格的精确源码区间，`serializeTable` / `insertTableRow` / `deleteTableRow` / `insertTableColumn` / `deleteTableColumn` / `parseTableCellLines` 负责解析与增删行列。纯函数，因此可单测。
- `TableWidget` 改为「活 DOM 会话」：`tableSession` 记住已挂载的 `<table>`，事务重建 widget 时把同一元素**移动**进新 wrapper，不重建、不丢焦点与光标；`eq` 在会话存活时判定相等，`tableDomMatchesSessionModel` 保证复用前 DOM 与文档模型一致。
- 单元格是可编辑子元素（CM 强制 widget 根 `contenteditable=false`，可编辑宿主必须是子节点）。编辑采用「文档为准、DOM 领先」：输入时只标记脏单元格，空闲 350ms / 失焦 / Enter / Tab / Escape / 保存前提交，用公共前后缀最小差异做一次 range 替换。因此连续输入只产生一次事务。
- 表格**永不因光标或选区退出表格视图**；只有显式「编辑表格源码」（工具栏按钮 / `editTableSource`）才进入源码模式。
- 表格外侧悬浮控件：行 `+` / 行 `×`、列 `+` / 列 `×`、底部与右侧追加、整表删除；控件不进入 Markdown 文档，一次整表事务完成增删。
- `findEditableBlock` 让「源码模式」只作用于非表格块；`findBlockAt` 供显式源码命令按区间精确命中表格。
- 新增 `scripts/tableModel.test.js`（解析/序列化往返、空单元格、转义、对齐、增删行列不漂移），并纳入 `npm run test:unit`。
- 更新 `scripts/checkMarkdownHeadingSelection.js`：原「点击表格进入源码」的两处断言改为新契约（表格保持渲染、光标仍落在对应源码偏移），并新增单元格编辑、选区、DOM 与模型一致、增删行列、源码模式入口等回归断言。

### 验收后修掉的问题

**1. 光标只能停在单元格开头、拖不动。** 两层原因：`activateRange` 的表格分支把编辑器 selection 强制设到该单元格源码起始偏移，同时 `focus()` 单元格，浏览器因此重置插入符；且 widget 的 `mousedown` 被 CodeMirror `preventDefault()`，原生插入符定位与拖选被取消。修复：表格分支不再改编辑器 selection（只记录诊断信息）；对表格单元格的 mousedown 放行，不调用 `preventDefault()` / `stopPropagation()`；单元格自身用 `document.caretRangeFromPoint` 兜底，把插入符放到点击点的字符偏移。

**2. 外观不像渲染出来的表格。** 去掉 `.paper-reader-cm-table` 的卡片式边框与圆角，只保留行列分隔线；去掉单元格聚焦的 `box-shadow` 焦点框，改为极浅背景色；控件从「常显网格」改为按需显示。

**3. 控件不可用（关键 bug）。** 点击控件时 CodeMirror 会在指针按下期间重建 widget，按钮被移除，`click` 永远不会派发；`mousedown` 冒泡也被编辑器在 content 元素上 `stopPropagation` 截断。真实点击路径是 **`pointerdown`**，而旧实现只监听 `mousedown` / `click`，因此必然失效。修复：把激活绑定在 **document 的 `pointerdown` 捕获阶段**，无论哪个表格 DOM 处于挂载状态都能收到；保留 `mousedown` 合成事件兜底。

### 控件定位：设计约束与踩过的坑

这一节是本功能最耗时的部分，记录结论以免重复踩坑。

#### 最终形态

四个结构按钮**都紧贴表格**，分两条带：

| 按钮 | 位置 |
| --- | --- |
| 行 `×` | 该行正左侧，与行的中线对齐 |
| 行 `+` | 两行交界处，紧贴表格左边缘 |
| 列 `×` | 该列水平中心正上方 |
| 列 `+` | 该列右边界正上方（压在分隔线上） |

行的两个按钮共用**一条竖向泳道**；列的两个按钮共用**一条水平带**（表格上沿之上 2px）。两者能共存不重叠，是因为它们分处不同的另一轴坐标：行的 `×` 与 `+` 垂直相隔半行高，列的 `×` 与 `+` 水平相隔半个列宽，而按钮只有 14px。

#### 关键结论

1. **几何绝不能在构建期捕获。** widget 重建会替换 `<table>`，闭包持有的旧元素已脱离文档，读到的 rect 全是 0。必须用 `mountedTable()` 每次取当前挂载的表格。
2. **行高必须从 `<tr>` 量，不能从单元格量。** 一行的高度等于它最高单元格的高度，锚在第一个单元格上会在任意其它列换行时整体偏掉几十像素。
3. **揭示区域必须由「控件实际被放置的锚点」推导，不能在判定时重算一遍位置。** 两套算法只要差几像素（实测差 9px），按钮就会落进邻居的区域里，表现为「指着它却显示别的按钮」。同时把匹配规则收敛成一条可预期的规则：
   > 指针落在按钮矩形上（±3px）→ 显示该按钮；否则显示沿「分离轴」最近的控件（行按纵向、列按横向）。
   这一条同时解决「表格末端控件（删除表格、末尾加行）点不到」——它们在行泳道之外，按纵向距离永远算不到。
4. **共享同一区域的控件要全部返回。** 末行的 `+` 与「末尾加行」共用交界区域，早先用 `||` 只返回其中一个，导致画出来的那个永远点不到。
5. **列的范围是表头格与数据格的并集。** 只按表头格算中心/边界，列宽不均时会偏。
6. **布局时机用 `view.requestMeasure({ read })`，不要用 `requestAnimationFrame`。** rAF 会早于编辑器把 widget 重新插入文档，实测整体偏 20px。
7. **补正插入符前要检查选区。** 拖选时「聚焦后下一帧补正插入符」会把刚选中的跨度折叠回插入符（起点在最左端 → 补正到 offset 0 → 选中内容全丢）。已是非折叠选区就不再干预。
8. **widget 预留的边距与裸 `<td>` 必须拦住，不能让事件到达编辑器。** 否则点它会把编辑器光标移到那里，表格随即退出渲染变回源码。拦截必须挂在 **window 捕获阶段**：CodeMirror 在 `contentDOM` 上以捕获阶段监听指针事件，而 `contentDOM` 是 widget 的祖先，挂在 widget 内部（无论捕获与否）都排在它后面，`preventDefault` 也无效。

#### 试过但不成立的做法

| 做法 | 结果 |
| --- | --- |
| 用 `min-height` 撑满单元格，在每次布局时写入 | 表格被撑爆（表头 141px）：边量边写，上一次写入的高度又进了下一次行高计算。正确做法是**先清空所有 min-height → 量完所有行高 → 再统一写入** |
| 在 `th/td` 上用 `display: flex` | 表格行高彻底坏掉：每个 `<td>` 变成独立 flex 行，`tr` 不再共享行高，列之间错位 |
| 用 `height: 100%` 撑满单元格 | 在表格单元格里无效，宿主仍只有文字高度 |
| 保留 `th/td` 的 `vertical-align: top` | 会让可编辑宿主紧贴文字而非占满可用高度，短单元格留下 68px 死区 |
| 扩宽 `findCellHost` 让裸 `<td>` 解析到内部宿主，借此重放点击 | `findCellHost` 被多处复用，扩宽后主套件的「点单元格要聚焦」立刻失败 |

**成立的做法**：去掉 `th/td` 的 `vertical-align: top`（死区 68px → 1px），再在布局阶段按行高补 `min-height`（先清空、量完、再写）。现在所有单元格与它所在 `<td>` 的高度差为 0–1px。

#### 已知限制

点**短单元格文字下方的空白**（多行行里某格只有一行文字）时光标不移动。该处现已被撑满的宿主覆盖，正常情况下点击会落到宿主内；极窄的残余边缘（≤1px）仍可能落在裸 `<td>` 上，而 CodeMirror 的 `pointerdown` 会 `preventDefault()` 掉后续 `mousedown`，挂在 `<table>` 上的光标逻辑收不到该事件。彻底解决需要为裸 `<td>` 的指针手势单独开一条路径，同时避免扩宽 `findCellHost` 的副作用。

### 永久断言

- **遍历每个控件，把指针放在它自己的矩形中心，必须显示出它自己**（行与列共用这一条）。这一条抓出了「按钮命中不到自己」的全部缺陷。
- 每个控件必须落在它语义对应的行/列/交界上，且与表格的间距在限定范围内。
- **所有列控件必须在同一条带**（`bottomGap` 相同且在 0–4px 内，且只有一个不同的 y）。
- **每个单元格必须撑满它所在的 `<td>`**（高度差 ≤2px）。
- 点 widget 边距后表格仍在渲染；点高单元格底部时光标落在该单元格。
- 静态守卫（字符串断言）锁定：控件尺寸与泳道公式、`requestMeasure` 布局、「指针在按钮上即显示它」规则、锚点来源。

### 验证

- `npm run compile`、`npm run test:unit`、`npm run test:performance`、`npm run test:markdown-performance` 全部通过。
- `scripts/checkMarkdownHeadingSelection.js` 短文档正/反方向、长文档 250,974 字符分支全部通过。
- `scripts/checkInstalledExtension.js` 对**已安装扩展**的 bundle（SHA256 与工作区一致）跑 17 项检查，全部通过。
- 250,974 字符长文档运行时对比（同一台机器、同一脚本）：

  | 指标 | 改动前 | 改动后 |
  | --- | --- | --- |
  | `maxUpdateMs` | 0.2 | 0.2 |
  | `maxBlockScanMs` | 1.5 | 0.8 |
  | `maxParseMs` | 9.1 | 5.1 |
  | `pointerP95` | 1.1 | 0.7 |
  | `fullSourceScans` | 22 | 22 |
  | `visibleChars` | 1750 | 1750 |

  数值随运行抖动，但无劣化：局部编辑仍只扫描本地区间，`fullSourceScans` 未上升。

### 过程说明

期间为了取性能基线执行了 `git checkout <ref> -- <files>`，误将工作区实现覆盖，随后依据本会话记录逐文件重建并重跑全部测试确认一致。**不要用这条命令取基线。**

控件定位经过多轮返工（同一批按钮反复调整位置与命中区域），本节已把每一轮的**结论**收敛到上面，不再保留逐轮过程。

## 2026-10-06：标题不再显示 `##`

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

