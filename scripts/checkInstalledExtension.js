// Verifies the *installed* extension bundle in a real browser: live table editing,
// caret placement, drag selection and the edge controls. Kept small on purpose; the full
// regression suite is scripts/checkMarkdownHeadingSelection.js.
const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const extensionRoot = path.join(
  process.env.USERPROFILE,
  ".vscode",
  "extensions",
  "paper-reader-lab.paper-reader-1.5.6",
);
const mediaRoot = path.join(extensionRoot, "media", "markdown");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const findChrome = () => {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  throw new Error("No Chromium browser found");
};

const getFreePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

class CdpClient {
  constructor(url) { this.nextId = 1; this.pending = new Map(); this.socket = new WebSocket(url); }
  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.exceptionThrown") {
        console.error("PAGE EXCEPTION:", message.params.exceptionDetails?.exception?.description);
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.socket.close(); }
}

const waitForPage = async (port) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = targets.find((target) => target.type === "page");
      if (page) return page;
    } catch {}
    await delay(100);
  }
  throw new Error("Timed out waiting for the browser");
};

const evaluate = async (client, expression) => {
  const result = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
};

const startServer = () =>
  new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const url = decodeURIComponent(request.url.split("?")[0]);
      const serve = (filePath, type) => {
        if (!fs.existsSync(filePath)) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, { "Content-Type": type });
        fs.createReadStream(filePath).pipe(response);
      };
      if (url === "/index.html") {
        const origin = `http://127.0.0.1:${server.address().port}`;
        const html = fs.readFileSync(path.join(mediaRoot, "index.html"), "utf8")
          .replace("{{baseUrl}}", `${origin}/media/markdown`)
          .replace('href="index.css"', `href="${origin}/media/markdown/index.css"`)
          .replace('href="codicons/codicon.css"', `href="${origin}/media/markdown/codicons/codicon.css"`)
          .replace('href="dist/js/katex/katex.min.css"', `href="${origin}/media/markdown/dist/js/katex/katex.min.css"`)
          .replace("</head>", `<script src="${origin}/vscode-shim.js"></script><script>window.__paperReaderMessages=[];window.acquireVsCodeApi=()=>({postMessage:(message)=>window.__paperReaderMessages.push(message)});</script></head>`);
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(html);
        return;
      }
      if (url === "/vscode-shim.js") {
        serve(path.join(extensionRoot, "media", "lib", "vscode.js"), "text/javascript");
        return;
      }
      const filePath = path.resolve(mediaRoot, `.${url.replace("/media/markdown", "")}`);
      if (!filePath.startsWith(mediaRoot)) {
        response.writeHead(403);
        response.end();
        return;
      }
      const type = filePath.endsWith(".js") ? "text/javascript"
        : filePath.endsWith(".css") ? "text/css"
        : filePath.endsWith(".ttf") ? "font/ttf" : "application/octet-stream";
      serve(filePath, type);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

const mouse = (client, type, x, y, extra = {}) =>
  client.send("Input.dispatchMouseEvent", { type, x, y, ...extra });

const click = async (client, x, y) => {
  await mouse(client, "mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1 });
  await mouse(client, "mouseReleased", x, y, { button: "left", buttons: 0, clickCount: 1 });
};

async function main() {
  console.log("extension under test:", extensionRoot);
  const server = await startServer();
  const browserPort = await getFreePort();
  const profile = await fs.promises.mkdtemp(path.join(os.tmpdir(), "paper-reader-installed-"));
  const browser = childProcess.spawn(findChrome(), [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${browserPort}`, `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: "ignore" });
  let client;
  const failures = [];
  const check = (label, ok, detail) => {
    console.log(`${ok ? "ok   " : "FAIL "}${label}${ok ? "" : ` :: ${JSON.stringify(detail)}`}`);
    if (!ok) failures.push(label);
  };
  try {
    const target = await waitForPage(browserPort);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/index.html` });
    await delay(900);
    await evaluate(client, `window.postMessage({type:'open',content:${JSON.stringify({
      content: [
        '## 选择 MinerU 部署方式',
        '',
        '| 对比项 | MinerU API 模式 | 本地 CLI 模式 |',
        '| --- | --- | --- |',
        '| 适合情况 | 轻量阅读电脑连接 GPU 主机 | 在运行扩展的机器上直接处理论文 |',
        '| 如何选择 | apiUrl 填服务根地址 | apiUrl 留空 |',
        '',
      ].join('\n'),
      config: { fontSizes: { body: 14, inlineMath: 15, displayMath: 18 } },
    })}},'*')`);
    await delay(900);
    check("table renders", await evaluate(client, `document.querySelectorAll('.paper-reader-cm-table').length === 1`));

    // The widget reserves a thin margin around the table for the controls. Pressing in that
    // margin is still a press on the table the reader sees, so it must not move focus out of
    // the widget and collapse the table back into Markdown source.
    const marginPoint = await evaluate(client, `(() => {
      const wrapper = document.querySelector('.paper-reader-cm-table');
      const table = wrapper.querySelector('table');
      const wrapperRect = wrapper.getBoundingClientRect();
      const tableRect = table.getBoundingClientRect();
      return {
        // Inside the widget's own box, but outside the table it draws.
        x: Math.round((wrapperRect.left + tableRect.left) / 2),
        y: Math.round(tableRect.top + 6),
        marginWidth: Math.round(tableRect.left - wrapperRect.left),
        marginHeight: Math.round(tableRect.top - wrapperRect.top),
        wrapperTop: Math.round(wrapperRect.top),
        hit: (() => {
          const element = document.elementFromPoint(Math.round((wrapperRect.left + tableRect.left) / 2), Math.round(tableRect.top + 6));
          return element ? String(element.className || element.nodeName).slice(0, 30) : 'none';
        })(),
      };
    })()`);
    await click(client, marginPoint.x, marginPoint.y);
    await delay(250);
    const afterMarginClick = await evaluate(client, `(() => {
      const wrapper = document.querySelector('.paper-reader-cm-table');
      const wrapperRect = wrapper?.getBoundingClientRect();
      const element = document.elementFromPoint(${marginPoint.x}, ${marginPoint.y});
      return {
        tables: document.querySelectorAll('.paper-reader-cm-table').length,
        hasWrapper: !!wrapper,
        wrapperBox: wrapperRect ? [Math.round(wrapperRect.left), Math.round(wrapperRect.top), Math.round(wrapperRect.right)] : null,
        hit: element ? String(element.className || element.nodeName).slice(0, 40) : 'none',
        active: (document.activeElement && document.activeElement.className) || null,
        doc: window.paperReaderMarkdownPerformance.documentText.slice(0, 60),
      };
    })()`);
    check("clicking the widget's margin keeps the table rendered",
      afterMarginClick.tables === 1, { marginPoint, afterMarginClick });


    // 1. Click near the end of a cell: the caret follows the pointer, not the cell start.
    const cellPoint = await evaluate(client, `(() => {
      const cell = document.querySelector('.paper-reader-cm-table tbody tr:first-child td:nth-child(2) .paper-reader-cm-cell');
      const rect = cell.getBoundingClientRect();
      return { x: rect.right - 14, y: rect.top + rect.height / 2, text: cell.textContent };
    })()`);
    await click(client, cellPoint.x, cellPoint.y);
    await delay(150);
    const caret = await evaluate(client, `(() => {
      const selection = window.getSelection();
      return {
        offset: selection?.anchorOffset ?? null,
        inCell: !!document.activeElement?.closest?.('.paper-reader-cm-cell'),
        text: document.activeElement?.textContent,
        tables: document.querySelectorAll('.paper-reader-cm-table').length,
      };
    })()`);
    check("click places the caret at the click point",
      caret.inCell && caret.offset > 0 && caret.tables === 1, { cellPoint, caret });

    // 2. Drag inside the cell: text selection works and the table stays rendered.
    const drag = await evaluate(client, `(() => {
      const cell = document.querySelector('.paper-reader-cm-table tbody tr:first-child td:nth-child(2) .paper-reader-cm-cell');
      const rect = cell.getBoundingClientRect();
      return { sx: rect.left + 3, ex: rect.right - 5, y: rect.top + rect.height / 2 };
    })()`);
    await mouse(client, "mousePressed", drag.sx, drag.y, { button: "left", buttons: 1, clickCount: 1 });
    await mouse(client, "mouseMoved", drag.ex, drag.y, { button: "left", buttons: 1 });
    await mouse(client, "mouseReleased", drag.ex, drag.y, { button: "left", buttons: 0, clickCount: 1 });
    await delay(150);
    const selected = await evaluate(client, `(() => {
      const selection = window.getSelection();
      const cell = document.querySelector('.paper-reader-cm-table tbody tr:first-child td:nth-child(2) .paper-reader-cm-cell');
      return {
        text: selection?.toString() || '',
        inCell: selection?.anchorNode ? cell.contains(selection.anchorNode) : false,
        tables: document.querySelectorAll('.paper-reader-cm-table').length,
      };
    })()`);
    check("drag selects text inside the cell", selected.text.length > 0 && selected.inCell && selected.tables === 1, selected);

    // 3. Controls are hidden until the pointer approaches an edge. Move the pointer away from
    // the table first: a reveal triggered by the previous drag is legitimate, not a leak.
    await mouse(client, "mouseMoved", 5, 5);
    await delay(200);
    const hidden = await evaluate(client, `(() => {
      const visible = [...document.querySelectorAll('.paper-reader-cm-table-control--visible')];
      return {
        visible: visible.length,
        total: document.querySelectorAll('.paper-reader-cm-table-control').length,
        boundaries: [...new Set(visible.map((button) => button.dataset.boundary))],
      };
    })()`);
    check("edge controls hidden once the pointer leaves the table",
      hidden.visible === 0 && hidden.total > 0, hidden);

    // 4. Hovering the last row's bottom edge reveals exactly that row's control.
    const edge = await evaluate(client, `(() => {
      const rows = [...document.querySelectorAll('.paper-reader-cm-table tbody tr')];
      const cell = rows[rows.length - 1].querySelector('td:last-child .paper-reader-cm-cell');
      const rect = cell.getBoundingClientRect();
      return { x: rect.right - 6, y: rect.bottom - 4 };
    })()`);
    await mouse(client, "mouseMoved", 5, 5);
    await delay(60);
    await mouse(client, "mouseMoved", edge.x, edge.y);
    await delay(250);
    const revealed = await evaluate(client, `(() => {
      const button = document.querySelector('.paper-reader-cm-table-control--visible');
      if (!button) return { actions: [], hitTest: false };
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      return { actions: [button.dataset.tableAction], box: { x, y }, hitTest: document.elementFromPoint(x, y) === button };
    })()`);
    check("row edge reveals exactly one control",
      revealed.actions.length === 1 && revealed.hitTest, { edge, revealed });

    if (revealed.actions.length === 1 && revealed.hitTest) {
      // 5. The revealed control must not overlap any other control: stacked buttons are what
      // previously hid the add-column control and crowded the row pair together.
      const layout = await evaluate(client, `(() => {
        const rects = [...document.querySelectorAll('.paper-reader-cm-table-control')].map((button) => {
          const rect = button.getBoundingClientRect();
          return {
            id: button.dataset.tableAction + ':' + button.dataset.tableIndex,
            boundary: button.dataset.boundary || null,
            x: Math.round(rect.left), y: Math.round(rect.top),
            w: Math.round(rect.width), h: Math.round(rect.height),
          };
        });
        const overlaps = [];
        for (let i = 0; i < rects.length; i += 1) {
          for (let j = i + 1; j < rects.length; j += 1) {
            const a = rects[i];
            const b = rects[j];
            if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
              overlaps.push(a.id + '<->' + b.id);
            }
          }
        }
        const actions = new Set(rects.map((rect) => rect.id.split(':')[0]));
        // Every control must be inside the viewport: one that scrolls off or is clipped is
        // unreachable, which reads to the user as "the button is missing".
        const offscreen = rects
          .filter((rect) => rect.w < 8 || rect.h < 8 || rect.x < 0 || rect.y < 0 ||
            rect.x + rect.w > window.innerWidth || rect.y + rect.h > window.innerHeight)
          .map((rect) => rect.id + '@' + rect.x + ',' + rect.y);
        return { overlaps, unplaced: rects.filter((rect) => !rect.boundary).map((rect) => rect.id), offscreen, actions: [...actions] };
      })()`);
      check("no two controls overlap, and all are placed inside the viewport",
        layout.overlaps.length === 0 && layout.unplaced.length === 0 && layout.offscreen.length === 0, layout);
      check("all four row/column actions exist",
        ['insertRow', 'deleteRow', 'insertColumn', 'deleteColumn'].every((action) => layout.actions.includes(action)),
        layout.actions);

      // Each control must sit where its meaning says: the delete control on the row/column it
      // removes, the insert control on the junction towards the next one.
      const semantics = await evaluate(client, `(() => {
        const performance = window.paperReaderMarkdownPerformance;
        const rects = {};
        for (const rect of performance.tableControlRects) rects[rect.id] = rect;
        const centreY = (rect) => rect.y + rect.height / 2;
        const centreX = (rect) => rect.x + rect.width / 2;
        const wrapper = document.querySelector('.paper-reader-cm-table');
        const table = wrapper.querySelector('table');
        const tableRect = table.getBoundingClientRect();
        const cells = [...table.querySelectorAll('tbody tr')].map((row) => {
          const cell = row.querySelector('.paper-reader-cm-cell').getBoundingClientRect();
          return { top: cell.top, bottom: cell.bottom, middle: (cell.top + cell.bottom) / 2 };
        });
        const headers = [...table.querySelectorAll('thead th .paper-reader-cm-cell')].map((cell) => {
          const rect = cell.getBoundingClientRect();
          return { left: rect.left, right: rect.right, middle: (rect.left + rect.right) / 2 };
        });
        const bodyCellsOfColumn = (columnIndex) => {
          const cell = table.querySelector('tbody tr td:nth-child(' + (columnIndex + 1) + ') .paper-reader-cm-cell');
          return cell ? cell.getBoundingClientRect() : null;
        };
        const problems = [];
        cells.forEach((cell, index) => {
          const rowDelete = rects['deleteRow:' + index];
          const rowInsert = rects['insertRow:' + index];
          if (rowDelete && Math.abs(centreY(rowDelete) - cell.middle) > 2) {
            problems.push('deleteRow:' + index + ' is not on its row centre');
          }
          if (rowInsert && (centreY(rowInsert) < cell.bottom - 1 || centreY(rowInsert) > cell.bottom + 5)) {
            problems.push('insertRow:' + index + ' is not on the junction below its row');
          }
          // The junction + hugs the table's left edge from the outside; the row's own x shares
          // that same lane, so the two line up and never collide on a shared row boundary.
          const insertGap = rowInsert ? tableRect.left - (rowInsert.x + rowInsert.width) : null;
          if (insertGap !== null && (insertGap < 0 || insertGap > 4)) {
            problems.push('insertRow:' + index + ' is not flush with the table edge (gap ' + insertGap + ')');
          }
          const deleteGap = rowDelete ? tableRect.left - (rowDelete.x + rowDelete.width) : null;
          if (deleteGap !== null && (deleteGap < 0 || deleteGap > 4)) {
            problems.push('deleteRow:' + index + ' is not flush with the table edge (gap ' + deleteGap + ')');
          }
          if (rowDelete && rowInsert && Math.abs(rowDelete.x - rowInsert.x) > 1) {
            problems.push('row controls of row ' + index + ' are not in the same lane');
          }
        });
        headers.forEach((header, index) => {
          const columnDelete = rects['deleteColumn:' + index];
          const columnInsert = rects['insertColumn:' + index];
          // A column's true extent is the union of its header and body cells; the controls must
          // follow that, not the header cell alone, or uneven column widths push them off.
          const bodyCell = bodyCellsOfColumn(index);
          const trueLeft = bodyCell ? Math.min(header.left, bodyCell.left) : header.left;
          const trueRight = bodyCell ? Math.max(header.right, bodyCell.right) : header.right;
          const trueMiddle = (trueLeft + trueRight) / 2;
          // The delete control sits above the column's own centre: the spot a reader points at
          // when they mean "this column".
          if (columnDelete && Math.abs(centreX(columnDelete) - trueMiddle) > 4) {
            problems.push('deleteColumn:' + index + ' is not above the centre of its column');
          }
          if (columnInsert) {
            // The insert control hugs the junction: its inner edge sits on the column boundary,
            // so it reads as attached rather than floating beside the column.
            const expected = trueRight + columnInsert.width / 2;
            if (Math.abs(centreX(columnInsert) - expected) > 4) {
              problems.push('insertColumn:' + index + ' is not flush with the junction at ' + Math.round(expected));
            }
            if (centreX(columnInsert) <= trueRight) {
              problems.push('insertColumn:' + index + ' is not outside the table');
            }
          }
          // Both of a column's controls hang just above the table's top border, stacked: the
          // delete control nearest the table, the insert control directly above it. Two controls
          // plus their clearance is the whole band, so the upper one is allowed its own height
          // and then some.
          for (const [label, rect] of [['deleteColumn:' + index, columnDelete], ['insertColumn:' + index, columnInsert]]) {
            if (!rect) continue;
            const gap = tableRect.top - (rect.y + rect.height);
            if (gap < -1 || gap > 2 * rect.height + 6) {
              problems.push(label + ' is not hugging the table top (gap ' + Math.round(gap) + ')');
            }
          }
        });
        return { problems, rows: cells.length, columns: headers.length };
      })()`);
      check("each control sits on the row/column or junction it acts on, flush with the table",
        semantics.problems.length === 0, semantics);

      // Every column control shares one lane two pixels above the table. Stacking them in two
      // lanes is what used to push one of the pair a whole control's height away from the table,
      // so neither ever read as attached.
      const lane = await evaluate(client, `(() => {
        const table = document.querySelector('.paper-reader-cm-table table').getBoundingClientRect();
        const rects = {};
        for (const rect of window.paperReaderMarkdownPerformance.tableControlRects) rects[rect.id] = rect;
        const gaps = new Set();
        const ways = new Set();
        for (const [id, rect] of Object.entries(rects)) {
          if (id.indexOf('Column') < 0) continue;
          gaps.add(Math.round(table.top - (rect.y + rect.height)));
          ways.add(Math.round(rect.y));
        }
        return { gaps: [...gaps], lanes: ways.size, controls: Object.keys(rects).filter((id) => id.indexOf('Column') >= 0).length };
      })()`);
      check("both column controls hug the table in one lane",
        lane.controls > 0 && lane.lanes === 1 && lane.gaps.length === 1 && lane.gaps[0] >= 0 && lane.gaps[0] <= 4,
        lane);

      // 6. The control survives the pointer moving onto it, and a real click runs the action.
      await mouse(client, "mouseMoved", revealed.box.x, revealed.box.y);
      await delay(150);
      const armed = await evaluate(client, `(() => {
        const button = document.querySelector('.paper-reader-cm-table-control--visible');
        if (!button) return { missing: true };
        const rect = button.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        return { action: button.dataset.tableAction, x, y, hitTest: document.elementFromPoint(x, y) === button };
      })()`);
      check("control stays visible and clickable while hovered", armed.hitTest === true, armed);

      const before = await evaluate(client, "document.querySelectorAll('.paper-reader-cm-table tbody tr').length");
      const inPage = await evaluate(client, `(() => {
        const button = document.querySelector('.paper-reader-cm-table-control--visible');
        if (!button) return { missing: true };
        button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        button.click();
        return { action: button.dataset.tableAction };
      })()`);
      await delay(300);
      const after = await evaluate(client, `({
        rows: document.querySelectorAll('.paper-reader-cm-table tbody tr').length,
        tables: document.querySelectorAll('.paper-reader-cm-table').length,
        lastControl: window.paperReaderMarkdownPerformance.lastTableControl,
      })`);
      check("clicking the revealed control runs the table handler", !!after.lastControl, { armed, inPage, after });
      check("clicking the revealed control inserts a row",
        after.rows === before + 1 && after.tables === 1, { armed, inPage, before, after });
    }

    // 6. A row is as tall as its tallest cell. Controls used to be anchored to the row's first
    // cell, so any other column wrapping onto a second line pushed them off by tens of pixels.
    // A narrow panel is what guarantees the long cells wrap.
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 560, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await delay(300);
    await evaluate(client, `window.postMessage({type:'update',content:${JSON.stringify([
      '| 对比项 | 说明 | 备注 |',
      '| --- | --- | --- |',
      '| 短标签 | 轻量阅读电脑连接 GPU 主机；或复用本机常驻服务，也可以直接连远程服务；这一格会换成很多行文字，为了确保它一定换行，这里再补上足够长的一段说明文字，让这一列无论如何都放不下 | 见文档 |',
      '| 阅读端依赖 | VS Code | 无 |',
      '| 另一个短标签 | API 服务所在机器上运行，模型常驻显存；这一格同样会换行成很多行文字，同样补上一段足够长的说明，确保这一行比它的第一个单元格高出不少 | 见部署 |',
      '',
    ].join('\n'))}},'*')`);
    await delay(700);
    const tallRows = await evaluate(client, `(() => {
      const table = document.querySelector('.paper-reader-cm-table table');
      const lineHeight = parseFloat(getComputedStyle(document.querySelector('.paper-reader-cm-cell')).lineHeight) || 22;
      const rows = [...table.querySelectorAll('tbody tr')].map((row) => {
        const rect = row.getBoundingClientRect();
        // Whether any cell wrapped is about the cell's own content, not about its height: every
        // cell now fills its row, so height no longer distinguishes a short cell from a tall one.
        const wrappedCell = [...row.querySelectorAll('.paper-reader-cm-cell')]
          .some((cell) => cell.getBoundingClientRect().height > lineHeight * 2);
        return { top: rect.top, bottom: rect.bottom, height: rect.height, wrappedCell };
      });
      const rects = {};
      for (const rect of window.paperReaderMarkdownPerformance.tableControlRects) rects[rect.id] = rect;
      const problems = [];
      let tallest = 0;
      rows.forEach((row, index) => {
        const centreY = (rect) => rect.y + rect.height / 2;
        const rowDelete = rects['deleteRow:' + index];
        const rowInsert = rects['insertRow:' + index];
        const middle = (row.top + row.bottom) / 2;
        if (row.wrappedCell) tallest += 1;
        if (rowDelete && Math.abs(centreY(rowDelete) - middle) > 2) {
          problems.push('deleteRow:' + index + ' off the row centre by ' + (centreY(rowDelete) - middle).toFixed(1) + 'px');
        }
        if (rowInsert && Math.abs(centreY(rowInsert) - row.bottom) > 5) {
          problems.push('insertRow:' + index + ' off the junction by ' + (centreY(rowInsert) - row.bottom).toFixed(1) + 'px');
        }
      });
      return { problems, wrappedRows: tallest, rows: rows.length };
    })()`);
    check("controls stay aligned when a row grows taller than its first cell",
      tallRows.problems.length === 0 && tallRows.wrappedRows > 0, tallRows);

    // A row is as tall as its tallest cell, so every cell in the row must fill its own table
    // cell: the whole box the reader sees belongs to the cell, and a press anywhere in it has to
    // land in that cell rather than in the bare <td> beside the text.
    const cellFill = await evaluate(client, `(() => {
      const table = document.querySelector('.paper-reader-cm-table table');
      const problems = [];
      let rows = 0;
      [...table.querySelectorAll('tr')].forEach((row, rowIndex) => {
        rows += 1;
        row.querySelectorAll('td, th').forEach((container, columnIndex) => {
          const host = container.querySelector('.paper-reader-cm-cell');
          if (!host) return;
          const gap = Math.round(container.getBoundingClientRect().height - host.getBoundingClientRect().height);
          if (gap > 2) {
            problems.push('r' + rowIndex + 'c' + columnIndex + ' leaves ' + gap + 'px of bare table cell');
          }
        });
      });
      return { problems, rows };
    })()`);
    check("every cell fills its table cell, leaving no dead strip beside the text",
      cellFill.problems.length === 0 && cellFill.rows > 0, cellFill);

    // A press at the bottom of a tall cell must land in that cell and keep the table rendered.
    const bottomPoint = await evaluate(client, `(() => {
      const table = document.querySelector('.paper-reader-cm-table table');
      for (const row of table.querySelectorAll('tbody tr')) {
        const host = row.querySelector('.paper-reader-cm-cell');
        const hostRect = host.getBoundingClientRect();
        if (hostRect.height < 40) continue;
        const x = Math.round(hostRect.left + hostRect.width / 2);
        const y = Math.round(hostRect.bottom - 6);
        const at = document.elementFromPoint(x, y);
        return {
          x, y,
          text: host.textContent || '',
          hitIsCell: !!(at && at.closest && at.closest('.paper-reader-cm-cell')),
        };
      }
      return null;
    })()`);
    if (bottomPoint) {
      await click(client, bottomPoint.x, bottomPoint.y);
      await delay(300);
      const caretAtBottom = await evaluate(client, `(() => {
        const cell = document.activeElement?.closest?.('.paper-reader-cm-cell');
        return {
          tables: document.querySelectorAll('.paper-reader-cm-table').length,
          inCell: !!cell,
          offset: window.getSelection()?.anchorOffset ?? null,
          textLength: cell ? (cell.textContent || '').length : null,
        };
      })()`);
      check("clicking the bottom of a tall cell puts the caret in that cell",
        bottomPoint.hitIsCell && caretAtBottom.inCell && caretAtBottom.tables === 1,
        { bottomPoint, caretAtBottom });
    } else {
      check("a cell tall enough to click near its bottom exists", false, cellFill);
    }

    // 7. The explicit source escape hatch is present in the toolbar.
    check("table source button is wired",
      await evaluate(client, `!!document.querySelector('[data-command="table-source"]')`));

    console.log(failures.length
      ? `INSTALLED BUNDLE CHECKS FAILED (${failures.length}): ${failures.join(', ')}`
      : "Installed bundle checks passed");
    process.exitCode = failures.length ? 1 : 0;
  } finally {
    client?.close();
    browser.kill();
    server.close();
    await delay(200);
    await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
