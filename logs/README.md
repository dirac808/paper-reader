# Markdown 编辑器重构记录

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
- 使用 `MARKDOWN_FIXTURE=E:\Desktop\repo\paper-reader\test.md` 与 `MARKDOWN_SWEEP=true` 的严格扫描通过：显示公式 `300/300`、行内公式 `100/100`、正文 `100/100`；`sourceCaret.failures`、正文失败和公式失败均为空。独立展示 `\\tag{4}` 近邻偏移的回归也通过。
- VS Code 集成测试 `npm test` 的 7 个用例通过，测试宿主退出码为 0。Windows 上必须将 `VSCODE_TEST_EXECUTABLE` 指向真正的 `Code.exe`；PATH 中的 `code.cmd` 会导致测试用例虽通过、外层进程却以退出码 1 结束。
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
$env:MARKDOWN_CURSOR_REGRESSION = 'true'; npm run test:markdown-selection
$env:MARKDOWN_FIXTURE = 'E:\Desktop\repo\paper-reader\test.md'
$env:MARKDOWN_SWEEP = 'true'
npm run test:markdown-selection
```

逐点扫描要求 CodeMirror 实际 selection 与目标 UTF-16 源码偏移完全相等，包括显示公式、行内公式和公式 tag 附近字符。短文档还需验证拖选方向正向和反向，以及标题和引用的真实选择文本。性能检查验证 506,670 字节文档只扫描 16,000 字节可见区（可见比例 `0.0316`），并验证局部编辑没有新增全文扫描；这不等同于所有机器上的绝对延迟保证。

测试文件 `E:\Desktop\repo\paper-reader\test.md` 引用了不在其同目录下的 `assets/images`。因此打开此 fixture 时图片请求失败是资源缺失，不能作为插件图片渲染故障结论。真实 VS Code Webview 的 URI/CSP 和图片资源验收需要存在的资源文件。

早期测试报告曾出现独立公式 `156/300`、行内公式 `21/100` 的字符级失败。该结果说明当时光标问题确实未解决；后续版本加入 glyph hit map、冻结手势起点和精确断言后，必须以重新运行的完整扫描结果替代这组历史数字，不能把历史失败隐去或当成当前结果。

## 发布记录

- 目标稳定版：`1.5.0`
- 核心变化：CodeMirror 单一解析来源、局部索引更新、精确 pointer/caret 映射、可拖动选择、KaTeX hit map 缓存和性能守卫。
- CachyOS 主机 `dell` 的 VS Code 1.138.0 已从生成的 VSIX 安装并核验 `paper-reader-lab.paper-reader@1.5.0`。
- GitHub Release：https://github.com/dirac808/paper-reader/releases/tag/v1.5.0（附带 `paper-reader-1.5.0.vsix`）。
