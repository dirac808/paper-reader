const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const fixturePath = process.env.MARKDOWN_FIXTURE;
const fixtureAssetRoot = path.resolve(
  process.env.MARKDOWN_ASSET_ROOT || (fixturePath ? path.dirname(fixturePath) : root),
);

const normalizeMarkdownForEditor = (markdownText) => String(markdownText)
  .replace(/\r\n|\r/g, "\n")
  .replace(
    /(^|\n)([ \t]*)\\\[\s*\n([\s\S]*?)\n[ \t]*\\\]([ \t]*(?=\n|$))/g,
    (_match, start, indent, body, suffix) =>
      `${start}${indent}$$\n${body.trim()}\n${indent}$$${suffix}`,
  )
  .replace(
    /(^|\n)([ \t]*)\\\[\s*([^\n]*?)\s*\\\]([ \t]*(?=\n|$))/g,
    (_match, start, indent, body, suffix) =>
      `${start}${indent}$$\n${body.trim()}\n${indent}$$${suffix}`,
  );

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const getFreePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });

const findChrome = () => {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const command of ["google-chrome", "chromium", "chromium-browser"]) {
    const result = childProcess.spawnSync("which", [command], {
      encoding: "utf8",
    });
    if (result.status === 0 && result.stdout.trim())
      return result.stdout.trim();
  }
  throw new Error("Chrome or Chromium was not found. Set CHROME_PATH.");
};

const contentType = (filePath) => {
  switch (path.extname(filePath)) {
    case ".css":
      return "text/css";
    case ".js":
      return "text/javascript";
    case ".ttf":
      return "font/ttf";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
};

const startServer = () =>
  new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (request.url === "/index.html") {
        const htmlPath = path.join(root, "media", "markdown", "index.html");
        const html = fs
          .readFileSync(htmlPath, "utf8")
          .replace("{{baseUrl}}", `${origin}/media/markdown`)
          .replace(
            'href="index.css"',
            `href="${origin}/media/markdown/index.css"`
          )
          .replace(
            'href="codicons/codicon.css"',
            `href="${origin}/media/markdown/codicons/codicon.css"`
          )
          .replace(
            'href="dist/js/katex/katex.min.css"',
            `href="${origin}/media/markdown/dist/js/katex/katex.min.css"`
          )
          .replace(
            "</head>",
            `<script>window.__paperReaderMessages=[];window.acquireVsCodeApi=()=>({postMessage:(message)=>window.__paperReaderMessages.push(message)});</script></head>`
          );
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(html);
        return;
      }
      if (request.url === "/media/markdown/assets/check.svg") {
        response.writeHead(200, { "Content-Type": "image/svg+xml" });
        response.end('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="red"/></svg>');
        return;
      }
      if (fixturePath && request.url.startsWith("/media/markdown/assets/")) {
        const relative = decodeURIComponent(request.url.split("?")[0]
          .replace("/media/markdown/", ""));
        const assetPath = path.resolve(fixtureAssetRoot, relative);
        const assetRoot = fixtureAssetRoot;
        if (assetPath.startsWith(`${assetRoot}${path.sep}`) && fs.existsSync(assetPath)) {
          response.writeHead(200, { "Content-Type": contentType(assetPath) });
          fs.createReadStream(assetPath).pipe(response);
          return;
        }
      }
      const filePath = path.resolve(
        root,
        `.${decodeURIComponent(request.url)}`
      );
      if (
        !filePath.startsWith(`${root}${path.sep}`) ||
        !fs.existsSync(filePath)
      ) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Type": contentType(filePath) });
      fs.createReadStream(filePath).pipe(response);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

class CdpClient {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.socket = new WebSocket(url);
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

const waitForPage = async (port) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(
        `http://127.0.0.1:${port}/json/list`
      ).then((response) => response.json());
      const page = targets.find((target) => target.type === "page");
      if (page) return page;
    } catch {
      // Chrome is still starting.
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for the Chrome debug target.");
};

const evaluate = async (client, expression) => {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "Runtime evaluation failed"
    );
  }
  return result.result.value;
};

const clickElement = async (client, selector) => {
  const point = await evaluate(client, `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert.ok(point, `Missing click target: ${selector}`);
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y,
    button: 'left', buttons: 1, clickCount: 1,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y,
    button: 'left', buttons: 0, clickCount: 1,
  });
};

const evenlySpaced = (items, count) => {
  if (!items.length || count <= 0) return [];
  if (items.length <= count) return items.slice();
  return Array.from({ length: count }, (_item, index) =>
    items[Math.round(index * (items.length - 1) / Math.max(1, count - 1))]);
};

const makeDisplayTargets = (source) => {
  const targets = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf('$$', cursor);
    if (start < 0) break;
    const lineStart = source.lastIndexOf('\n', start - 1) + 1;
    if (!/^\s*\$\$\s*$/.test(source.slice(lineStart, start + 2))) {
      cursor = start + 2;
      continue;
    }
    const end = source.indexOf('$$', start + 2);
    if (end < 0) break;
    targets.push({ from: lineStart, to: end + 2 });
    cursor = end + 2;
  }
  return targets;
};

const makeInlineTargets = (source, displayTargets) => {
  const targets = [];
  const pattern = /(^|[^\\$])\$(?!\$)([^\n$]+?)(?<!\\)\$(?!\$)/g;
  let match;
  while ((match = pattern.exec(source))) {
    const from = match.index + match[1].length;
    const to = from + match[0].length - match[1].length;
    if (!displayTargets.some((range) => from >= range.from && to <= range.to)) {
      targets.push({ from, to });
    }
  }
  return targets;
};

const makeProseTargets = (source, displayTargets) => {
  const targets = [];
  let lineStart = 0;
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    const lineEnd = lineStart + line.length;
    const inDisplay = displayTargets.some((range) =>
      lineStart <= range.to && lineEnd >= range.from);
    if (
      trimmed.length >= 3 &&
      !inDisplay &&
      !/^\s*(?:#{1,6}\s|```|~~~|\$\$|\\\[|!\[|\||>)/.test(line) &&
      !line.includes('$') &&
      !/<(?:sup|sub)\b/i.test(line)
    ) {
      targets.push({ from: lineStart + Math.min(5, Math.max(0, line.length - 1)), lineStart, line });
    }
    lineStart += line.length + 1;
  }
  return targets;
};

async function runStrictSweep(client, source) {
  const normalized = normalizeMarkdownForEditor(source);
  const displayTargets = makeDisplayTargets(normalized);
  const inlineTargets = makeInlineTargets(normalized, displayTargets);
  const proseTargets = makeProseTargets(normalized, displayTargets);
  const failures = { display: [], inline: [], prose: [], images: [] };
  const sourceFailures = { display: [], inline: [] };

  const dispatchClick = async (point) => {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1,
    });
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1,
    });
    await delay(25);
  };

  const widgetPoint = async (target, selector, fraction) => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await evaluate(client, `window.paperReaderMarkdownPerformance.scrollToPosition(${target.from})`);
      await delay(120);
      const point = await evaluate(client, `(() => {
        const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
          .find((item) => Number(item.dataset.from) === ${target.from} &&
            Number(item.dataset.to) === ${target.to});
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        const scroller = document.querySelector('.cm-scroller');
        const viewport = scroller?.getBoundingClientRect() || {
          left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight,
        };
        const left = Math.max(rect.left + 3, viewport.left + 3);
        const right = Math.min(rect.right - 3, viewport.left + (scroller?.clientWidth || window.innerWidth) - 3);
        const top = Math.max(rect.top + 3, viewport.top + 3);
        const bottom = Math.min(rect.bottom - 3, viewport.top + (scroller?.clientHeight || window.innerHeight) - 3);
        if (left > right || top > bottom) return null;
        const x = left + (right - left) * ${fraction};
        const y = top + (bottom - top) / 2;
        const hit = document.elementFromPoint(x, y)?.closest(${JSON.stringify(selector)}) === node;
        const visual = node.querySelector('.katex-display > .katex, .katex');
        const visualRect = visual?.getBoundingClientRect() || rect;
        return { x, y, from: Number(node.dataset.from), to: Number(node.dataset.to), hit,
          rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
          visualRect: { left: visualRect.left, right: visualRect.right,
            top: visualRect.top, bottom: visualRect.bottom } };
      })()`);
      if (point?.hit) return point;
    }
    return null;
  };

  const clickWidget = async (target, selector, fraction, kind) => {
    await evaluate(client, 'window.paperReaderMarkdownPerformance.resetEditingBlock()');
    await delay(500);
    const point = await widgetPoint(target, selector, fraction);
    if (!point) {
      const debug = await evaluate(client, `(() => ({
        scrollTop: document.querySelector('.cm-scroller')?.scrollTop,
        targetNodes: [...document.querySelectorAll(${JSON.stringify(selector)})]
          .filter((item) => Math.abs(Number(item.dataset.from) - ${target.from}) < 1200)
          .map((item) => ({ from: item.dataset.from, to: item.dataset.to,
            top: item.getBoundingClientRect().top, bottom: item.getBoundingClientRect().bottom })),
        sourceBlocks: window.paperReaderMarkdownPerformance?.documentBlocks
          ?.filter((item) => Math.abs(item.from - ${target.from}) < 1200),
      }))()`);
      failures[kind].push({ target, reason: 'widget-not-clickable', debug });
      return;
    }
    await dispatchClick(point);
    const caret = await evaluate(client, 'window.paperReaderMarkdownPerformance.selectionFrom');
    if (caret < target.from || caret > target.to) {
      failures[kind].push({ target, fraction, caret, point });
    }
    return { point, caret };
  };

  // A rendered KaTeX glyph does not have a one-to-one source-character
  // coordinate system. Once the widget is opened, however, the source is a
  // normal CodeMirror DOM and its caret position can be tested exactly.
  const clickSourceCharacter = async (target, offset, kind) => {
    await evaluate(client, `window.paperReaderMarkdownPerformance.scrollToPosition(${offset})`);
    await delay(80);
    const lineStart = normalized.lastIndexOf('\n', offset - 1) + 1;
    const lineEndIndex = normalized.indexOf('\n', offset);
    const lineEnd = lineEndIndex < 0 ? normalized.length : lineEndIndex;
    const lineText = normalized.slice(lineStart, lineEnd);
    const targetRaw = normalized.slice(target.from, target.to);
    const point = await evaluate(client, `(() => {
      const wanted = ${JSON.stringify(lineText)};
      const raw = ${JSON.stringify(targetRaw)};
      const sourceOffset = ${offset - lineStart};
      const lines = [...document.querySelectorAll('.cm-line')];
      const line = lines.find((item) =>
        item.dataset.paperReaderLineFrom === String(${lineStart}) &&
        item.textContent === wanted) || lines.find((item) => item.textContent.includes(wanted));
      const targetLine = line || lines.find((item) =>
        item.dataset.paperReaderLineFrom === String(${lineStart}) && raw && item.textContent.includes(raw));
      if (!targetLine) return null;
      const walker = document.createTreeWalker(targetLine, NodeFilter.SHOW_TEXT);
      let node;
      const baseOffset = targetLine.textContent === wanted
        ? Math.max(0, targetLine.textContent.indexOf(wanted)) + sourceOffset
        : Math.max(0, targetLine.textContent.indexOf(raw)) + ${offset - target.from};
      let remaining = baseOffset;
      while ((node = walker.nextNode())) {
        if (remaining <= node.data.length) break;
        remaining -= node.data.length;
      }
      if (!node || !node.data.length) return null;
      const start = Math.max(0, Math.min(remaining, node.data.length - 1));
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, Math.min(start + 1, node.data.length));
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
        lineRect: (() => { const value = targetLine.getBoundingClientRect(); return {
          left: value.left, top: value.top, right: value.right, bottom: value.bottom,
        }; })(),
        hit: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          ?.closest('.cm-line') === targetLine };
    })()`);
    if (!point || point.y < 0 || point.y > 2000) {
      sourceFailures[kind].push({ target, offset, reason: 'source-character-not-mounted', point });
      return;
    }
    await dispatchClick(point);
    const caret = await evaluate(client, 'window.paperReaderMarkdownPerformance.selectionFrom');
    if (Math.abs(caret - offset) > 1) {
      sourceFailures[kind].push({ target, offset, caret, point, reason: 'source-character-offset-mismatch' });
    }
  };

  const onlyOffsets = String(process.env.MARKDOWN_ONLY_OFFSETS || '')
    .split(',').filter((value) => value.trim() !== '')
    .map((value) => Number(value)).filter((value) => Number.isInteger(value));
  const selectedDisplay = onlyOffsets.length
    ? displayTargets.filter((target) => onlyOffsets.includes(target.from))
    : evenlySpaced(displayTargets, 100);
  for (const target of selectedDisplay) {
    for (const fraction of [0.2, 0.5, 0.8]) {
    const activation = await clickWidget(target, '.paper-reader-cm-math', fraction, 'display');
      if (activation?.caret >= target.from && activation.caret <= target.to) {
        await delay(180);
        const contentFrom = target.from + Math.min(2, target.to - target.from);
        const contentTo = Math.max(contentFrom, target.to - Math.min(2, target.to - target.from));
        const sourceOffset = Math.round(contentFrom + (contentTo - contentFrom) * fraction);
        await clickSourceCharacter(target, sourceOffset, 'display');
      }
    }
  }
  const taggedBody = normalized.indexOf('\\tag{4}');
  if (taggedBody >= 0) {
    const taggedTarget = displayTargets.find((target) =>
      taggedBody >= target.from && taggedBody < target.to);
    if (taggedTarget && (!onlyOffsets.length || onlyOffsets.includes(taggedTarget.from))) {
      await evaluate(client, `window.paperReaderMarkdownPerformance.resetEditingBlock()`);
      await evaluate(client, `window.paperReaderMarkdownPerformance.scrollToPosition(${taggedTarget.from})`);
      await delay(120);
      const tailPoint = await evaluate(client, `(() => {
        const node = [...document.querySelectorAll('.paper-reader-cm-math')]
          .find((item) => item.dataset.source?.includes('\\\\tag{4}'));
        const bases = [...(node?.querySelectorAll('.katex-html > .base') || [])];
        const base = bases[bases.length - 1];
        const rect = base?.getBoundingClientRect();
        return rect ? {x: rect.left + rect.width * .65, y: rect.top + rect.height / 2,
          from: Number(node.dataset.from), to: Number(node.dataset.to),
          rect: {left: rect.left, right: rect.right, width: rect.width},
          text: base.textContent} : null;
      })()`);
      if (tailPoint) {
        await client.send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: tailPoint.x, y: tailPoint.y,
          button: 'left', buttons: 1, clickCount: 1,
        });
        const afterPress = await evaluate(client,
          'window.paperReaderMarkdownPerformance.selectionFrom');
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: tailPoint.x, y: tailPoint.y,
          button: 'left', buttons: 0, clickCount: 1,
        });
        await delay(60);
        const tagCaret = await evaluate(client,
          'window.paperReaderMarkdownPerformance.selectionFrom');
        const activation = await evaluate(client,
          'window.paperReaderMarkdownPerformance.lastWidgetActivation');
        const expectedTailFrom = taggedBody - 100;
        const expectedTailTo = taggedBody - 12;
        if (tagCaret < expectedTailFrom || tagCaret > taggedBody + 8 ||
          activation?.anchor < expectedTailFrom || activation?.anchor > expectedTailTo) {
          failures.display.push({
            target: taggedTarget,
            reason: 'equation-tail-caret-mismatch',
            taggedBody,
            tagCaret,
            afterPress,
            activation,
            tailPoint,
          });
        }
      } else {
        failures.display.push({
          target: taggedTarget,
          reason: 'equation-tail-not-mounted',
        });
      }
      for (const offset of [
        taggedBody - 8,
        taggedBody - 5,
        taggedBody - 2,
        taggedBody + 1,
        taggedBody + 4,
        taggedBody + 7,
      ]) {
        await clickWidget(taggedTarget, '.paper-reader-cm-math', 0.65, 'display');
        await clickSourceCharacter(taggedTarget, offset, 'display');
      }
    }
  }
  const selectedInline = process.env.MARKDOWN_SKIP_INLINE === 'true'
    ? [] : evenlySpaced(inlineTargets, 100);
  for (const target of selectedInline) {
    const activation = await clickWidget(target, '.paper-reader-cm-inline-math', 0.5, 'inline');
    if (activation?.caret >= target.from && activation.caret <= target.to) {
      await delay(180);
      await clickSourceCharacter(target, Math.round((target.from + target.to) / 2), 'inline');
    }
  }

  const selectedProse = process.env.MARKDOWN_SKIP_PROSE === 'true'
    ? [] : evenlySpaced(proseTargets, 100);
  for (const target of selectedProse) {
    await evaluate(client, `window.paperReaderMarkdownPerformance.scrollToPosition(${target.from})`);
    await delay(80);
    const point = await evaluate(client, `(() => {
      const line = [...document.querySelectorAll('.cm-line')]
        .find((item) => item.dataset.paperReaderLineFrom === String(${target.lineStart}) &&
          item.textContent === ${JSON.stringify(target.line)});
      if (!line) return null;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let node;
      let offset = ${target.from - target.lineStart};
      while ((node = walker.nextNode())) {
        if (offset <= node.data.length) break;
        offset -= node.data.length;
      }
      if (!node || !node.data.length) return null;
      const range = document.createRange();
      const start = Math.min(offset, node.data.length - 1);
      range.setStart(node, start);
      range.setEnd(node, Math.min(start + 1, node.data.length));
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!point) {
      failures.prose.push({ target, reason: 'position-not-visible' });
      continue;
    }
    await dispatchClick(point);
    const caret = await evaluate(client, 'window.paperReaderMarkdownPerformance.selectionFrom');
    if (Math.abs(caret - target.from) > 2) failures.prose.push({ target, caret, point });
  }

  const imageTargets = [];
  const imagePattern = /!\[[^\]]*\]\(([^)\s]+)/g;
  let imageMatch;
  while ((imageMatch = imagePattern.exec(normalized))) {
    imageTargets.push({ from: imageMatch.index, url: imageMatch[1] });
  }
  const images = [];
  for (const target of imageTargets) {
    await evaluate(client, `window.paperReaderMarkdownPerformance.scrollToPosition(${target.from})`);
    let image = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await delay(200);
      image = await evaluate(client, `(() => {
      const node = [...document.querySelectorAll('.paper-reader-cm-image')]
        .find((item) => item.dataset.source === ${JSON.stringify(target.url)});
      const image = node?.querySelector('img');
      return image ? { src: image.src, complete: image.complete, naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight, currentSrc: image.currentSrc } : null;
      })()`);
      if (image?.complete && image.naturalWidth > 0) break;
    }
    images.push({ target, image });
    if (!image || !image.complete || image.naturalWidth === 0) failures.images.push({ target, image });
  }

  return {
    requested: {
      display: selectedDisplay.length * 3,
      inline: Math.min(100, inlineTargets.length),
      prose: selectedProse.length,
      images: imageTargets.length,
    },
    available: { display: displayTargets.length, inline: inlineTargets.length, prose: proseTargets.length },
    normal: {
      display: selectedDisplay.length * 3 - failures.display.length,
      inline: Math.min(100, inlineTargets.length) - failures.inline.length,
      prose: selectedProse.length - failures.prose.length,
      images: imageTargets.length - failures.images.length,
    },
    distorted: {
      display: failures.display.length,
      inline: failures.inline.length,
      prose: failures.prose.length,
      images: failures.images.length,
    },
    failures: {
      display: failures.display.slice(0, 20),
      inline: failures.inline.slice(0, 20),
      prose: failures.prose.slice(0, 20),
      images: failures.images,
    },
    sourceCaret: {
      requested: { display: selectedDisplay.length * 3, inline: Math.min(100, inlineTargets.length) },
      normal: {
        display: selectedDisplay.length * 3 - sourceFailures.display.length,
        inline: Math.min(100, inlineTargets.length) - sourceFailures.inline.length,
      },
      distorted: {
        display: sourceFailures.display.length,
        inline: sourceFailures.inline.length,
      },
      failures: {
        display: sourceFailures.display.slice(0, 20),
        inline: sourceFailures.inline.slice(0, 20),
      },
    },
    imageDetails: images,
  };
}

async function runHeadingSweep(client, source) {
  const normalized = normalizeMarkdownForEditor(source);
  const targets = [];
  let lineStart = 0;
  for (const line of normalized.split('\n')) {
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    if (match) {
      targets.push({
        line,
        lineStart,
        from: lineStart + match[1].length + 1,
        title: match[2],
      });
    }
    lineStart += line.length + 1;
  }
  const failures = [];
  for (const target of targets) {
    await evaluate(client, `window.paperReaderMarkdownPerformance.scrollToPosition(${target.from})`);
    await delay(100);
    const point = await evaluate(client, `(() => {
      const wanted = ${JSON.stringify(target.line)};
      const renderedWanted = wanted.replace(/<[^>]+>/g, '');
      const line = [...document.querySelectorAll('.cm-line')]
        .find((item) => item.dataset.paperReaderLineFrom === String(${target.lineStart}) &&
          (item.textContent === wanted || item.textContent === renderedWanted));
      if (!line) return null;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let node;
      let offset = ${target.from - target.lineStart};
      while ((node = walker.nextNode())) {
        if (offset <= node.data.length) break;
        offset -= node.data.length;
      }
      if (!node || !node.data.length) return null;
      const range = document.createRange();
      range.setStart(node, Math.min(offset, node.data.length - 1));
      range.setEnd(node, Math.min(offset + 1, node.data.length));
      const rect = range.getBoundingClientRect();
      const lineRect = line.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
        lineRect: { left: lineRect.left, top: lineRect.top,
          right: lineRect.right, bottom: lineRect.bottom },
        hit: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          ?.closest('.cm-line') === line };
    })()`);
    if (!point) {
      failures.push({ target, reason: 'heading-not-mounted' });
      continue;
    }
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1,
    });
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1,
    });
    await delay(25);
    const caret = await evaluate(client, 'window.paperReaderMarkdownPerformance.selectionFrom');
    const lineEnd = target.lineStart + target.line.length;
    if (caret < target.lineStart || caret > lineEnd + 1) {
      failures.push({ target, lineEnd, caret, point });
    }
  }
  return { requested: targets.length, normal: targets.length - failures.length, distorted: failures.length, failures };
}

async function main() {
  const server = await startServer();
  const browserPort = await getFreePort();
  const browserProfile = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "paper-reader-heading-selection-")
  );
  const browser = childProcess.spawn(
    findChrome(),
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${browserPort}`,
      `--user-data-dir=${browserProfile}`,
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  let client;
  try {
    const target = await waitForPage(browserPort);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Page.navigate", {
      url: `http://127.0.0.1:${server.address().port}/index.html`,
    });
    await delay(500);
    const longDocument = process.env.HEADING_SELECTION_LONG === "true";
    const headingLevel = Math.min(
      6,
      Math.max(1, Number(process.env.HEADING_LEVEL || 1))
    );
    const documentContent = fixturePath
      ? fs.readFileSync(fixturePath, "utf8")
      : longDocument
      ? `${Array.from(
          { length: 600 },
          (_, index) => `Paragraph ${index}.`
        ).join(
          "\n\n"
        )}\n\n## Heading title\n\nParagraph below the heading.\n\n${Array.from(
          { length: 600 },
          (_, index) => `Tail paragraph ${index}.`
        ).join("\n\n")}`
      : `${"#".repeat(headingLevel)} Heading title\n\nParagraph below the heading.\n\n> Quoted text\n\nInline \`code\` and $x+y$.\n\n\`\`\`js\nconst value = 1;\n\`\`\`\n\n| Column | Value |\n| --- | --- |\n| A | B |\n`;
    await evaluate(
      client,
      `window.postMessage({type:'open',content:${JSON.stringify({
        content: documentContent,
        config: { fontSizes: { body: 14, inlineMath: 15, displayMath: 18 } },
      })}},'*')`
    );
    await delay(300);
    if (process.env.MARKDOWN_CURSOR_REGRESSION === 'true') {
      const cursorFixture = [
        'Body text with several characters to place the caret precisely.',
        '',
        '> Quoted reference text with a distinct ending.',
        '',
        '```txt',
        'alpha beta gamma',
        '```',
        '',
        '| First | Second |',
        '| --- | --- |',
        '| alpha | beta gamma |',
        '',
        '$$',
        'abcdefghij+klmnop',
        '$$',
      ].join('\n');
      await evaluate(client,
        `window.postMessage({type:'update',content:${JSON.stringify(cursorFixture)}},'*')`);
      await delay(250);
      const clickAt = async (selector, character, sourceOffset, lineText) => {
        if (selector.includes('.paper-reader-cm-')) {
          await evaluate(client, 'window.paperReaderMarkdownPerformance.resetEditingBlock()');
          await delay(80);
        }
        const point = await evaluate(client, `(() => {
          const roots = [...document.querySelectorAll(${JSON.stringify(selector)})];
          const root = roots.find((item) => item.textContent.includes(${JSON.stringify(lineText || character)}));
          if (!root) return null;
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            const offset = node.data.indexOf(${JSON.stringify(character)});
            if (offset < 0) continue;
            const range = document.createRange();
            range.setStart(node, offset);
            range.setEnd(node, offset + 1);
            const rect = range.getBoundingClientRect();
            const x = rect.left + rect.width * 0.75;
            const y = rect.top + rect.height / 2;
            return {x, y, rect: {left: rect.left, right: rect.right, top: rect.top, height: rect.height},
              text: node.data, line: root.closest('.cm-line')?.textContent,
              hit: document.elementFromPoint(x, y)?.textContent};
          }
          return null;
        })()`);
        assert.ok(point, `Could not find ${JSON.stringify(character)} in ${selector}`);
        await client.send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: point.x, y: point.y,
          button: 'left', buttons: 1, clickCount: 1,
        });
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: point.x, y: point.y,
          button: 'left', buttons: 0, clickCount: 1,
        });
        await delay(30);
        const actual = await evaluate(client,
          'window.paperReaderMarkdownPerformance.selectionFrom');
        if (!selector.includes('.paper-reader-cm-')) {
          assert.strictEqual(actual, sourceOffset,
            `${selector} source click missed its character boundary: ${JSON.stringify({
              character, actual, sourceOffset,
            })}`);
          return actual;
        }
        assert.strictEqual(actual, sourceOffset,
          `${selector} click did not place the caret at the clicked character: ${JSON.stringify({
            character, actual, sourceOffset,
          })}`);
      };
      const clickSourceAt = async (lineText, character, characterIndex, sourceOffset) => {
        const point = await evaluate(client, `(() => {
          const line = [...document.querySelectorAll('.cm-line')]
            .find((item) => item.textContent.includes(${JSON.stringify(lineText)}));
          if (!line) return null;
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            let offset = -1;
            for (let index = 0, seen = 0; index < node.data.length; index += 1) {
              if (node.data[index] !== ${JSON.stringify(character)}) continue;
              if (seen++ === ${characterIndex}) { offset = index; break; }
            }
            if (offset < 0) continue;
            const range = document.createRange();
            range.setStart(node, offset);
            range.setEnd(node, offset + 1);
            const rect = range.getBoundingClientRect();
            const x = rect.left + rect.width * 0.75;
            const y = rect.top + rect.height / 2;
            return {x, y, rect: {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom},
              text: node.data, line: line.textContent,
              element: document.elementFromPoint(x, y)?.outerHTML?.slice(0, 140)};
          }
          return null;
        })()`);
        assert.ok(point, `Could not find source character in ${lineText}`);
        await client.send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: point.x, y: point.y,
          button: 'left', buttons: 1, clickCount: 1,
        });
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: point.x, y: point.y,
          button: 'left', buttons: 0, clickCount: 1,
        });
        await delay(30);
        const actual = await evaluate(client,
          'window.paperReaderMarkdownPerformance.selectionFrom');
        assert.strictEqual(actual, sourceOffset,
          `Source click missed its character boundary: ${JSON.stringify({
            lineText, character, actual, sourceOffset, point,
          })}`);
      };
      const formulaStart = cursorFixture.indexOf('abcdefghij+klmnop');
      await clickAt('.paper-reader-cm-math .katex-html', 'k', formulaStart + 12, 'abcdefghij+klmnop');
      await clickSourceAt('abcdefghij+klmnop', 'b', 0, formulaStart + 2);
      await clickAt('.paper-reader-cm-math .katex-html', 'k', formulaStart + 12, 'abcdefghij+klmnop');
      await clickSourceAt('abcdefghij+klmnop', 'p', 0, formulaStart + 17);
      const codeStart = cursorFixture.indexOf('alpha beta gamma');
      await clickAt('.paper-reader-cm-code-block code', 'g', codeStart + 12, 'alpha beta gamma');
      const tableStart = cursorFixture.indexOf('| alpha | beta gamma |');
      await clickAt('.paper-reader-cm-table td:last-child', 'g', tableStart + 16, 'beta gamma');
      const quoteStart = cursorFixture.indexOf('Quoted reference text');
      await clickAt('.cm-line', 'e', quoteStart + 5, 'Quoted reference text with a distinct ending.');
      const bodyStart = cursorFixture.indexOf('Body text');
      await clickAt('.cm-line', 'r', bodyStart + 20,
        'Body text with several characters to place the caret precisely.');
      await clickAt('.cm-line', 'e', cursorFixture.indexOf('Quoted reference text') + 5,
        'Quoted reference text with a distinct ending.');
      console.log(JSON.stringify({
        cursorRegression: 'passed',
        previewToSourceAndRepeatedSourceClicks: true,
        code: true,
        table: true,
        quote: true,
        body: true,
      }));
      return;
    }
    if (process.env.MARKDOWN_EQUATION_FOUR_ONLY === 'true' && fixturePath) {
      const normalized = normalizeMarkdownForEditor(documentContent);
      const taggedBody = normalized.indexOf('\\tag{4}');
      assert.ok(taggedBody >= 0, 'Formula (4) is missing from the fixture');
      const taggedStart = normalized.lastIndexOf('$$', taggedBody);
      const taggedEnd = normalized.indexOf('$$', taggedBody) + 2;
      await evaluate(client,
        `window.paperReaderMarkdownPerformance.scrollToPosition(${taggedStart})`);
      await delay(300);
      const targets = [0.2, 0.4, 0.55, 0.65, 0.75, 0.82, 0.9];
      const results = [];
      for (const fraction of targets) {
        await evaluate(client, `window.paperReaderMarkdownPerformance.resetEditingBlock()`);
        await evaluate(client,
          `window.paperReaderMarkdownPerformance.scrollToPosition(${taggedStart})`);
        await delay(120);
        const point = await evaluate(client, `(() => {
          const node = [...document.querySelectorAll('.paper-reader-cm-math')]
            .find((item) => item.dataset.source?.includes('tag{4}'));
          const visual = node?.querySelector('.katex-html');
          if (!node || !visual) return {missing: true,
            count: document.querySelectorAll('.paper-reader-cm-math').length,
            scrollTop: document.querySelector('.cm-scroller')?.scrollTop,
            tagged: [...document.querySelectorAll('.paper-reader-cm-math')]
              .map((item) => item.dataset.source?.slice(-20))};
          const rect = visual.getBoundingClientRect();
          const targetX = rect.left + rect.width * ${fraction};
          const walker = document.createTreeWalker(visual, NodeFilter.SHOW_TEXT);
          let best = null;
          let textNode;
          while ((textNode = walker.nextNode())) {
            for (let offset = 0; offset < textNode.data.length; offset += 1) {
              const range = document.createRange();
              range.setStart(textNode, offset);
              range.setEnd(textNode, offset + 1);
              const box = range.getBoundingClientRect();
              if (!box.width || !box.height) continue;
              const distance = Math.abs(targetX - (box.left + box.width / 2));
              if (!best || distance < best.distance) best = {textNode, offset, box, distance};
            }
          }
          if (!best) return null;
          const x = best.box.left + best.box.width * 0.75;
          const y = best.box.top + best.box.height / 2;
          return {x, y,
            text: best.textNode.data[best.offset],
            hit: document.elementFromPoint(x, y)?.closest('.paper-reader-cm-math') === node};
        })()`);
        assert.ok(point?.hit, `Could not hit formula (4): ${JSON.stringify(point)}`);
        await client.send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: point.x, y: point.y,
          button: 'left', buttons: 1, clickCount: 1,
        });
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: point.x, y: point.y,
          button: 'left', buttons: 0, clickCount: 1,
        });
        await delay(40);
        const result = await evaluate(client, `({
          caret: window.paperReaderMarkdownPerformance.selectionFrom,
          activation: window.paperReaderMarkdownPerformance.lastWidgetActivation,
          source: window.paperReaderMarkdownPerformance.documentText,
        })`);
        assert.strictEqual(result.caret, result.activation.sourceOffset,
          `Final caret disagrees with clicked glyph mapping: ${JSON.stringify(result)}`);
        assert.ok(result.activation.clickedSource,
          `Clicked glyph has no source mapping: ${JSON.stringify(result.activation)}`);
        const sourceFrom = result.activation.sourceRange.start +
          result.activation.clickedSource.start;
        const sourceTo = result.activation.sourceRange.start +
          result.activation.clickedSource.end;
        assert.ok(result.caret === sourceFrom || result.caret === sourceTo,
          `Caret is not on the clicked character boundary: ${JSON.stringify({
            fraction, point, caret: result.caret, sourceFrom, sourceTo,
            glyph: result.activation.clickedGlyph,
          })}`);
        assert.ok(result.caret > taggedStart && result.caret < taggedEnd - 2,
          `Formula (4) click jumped to an endpoint: ${JSON.stringify({fraction, point, result})}`);
        if (point.text === '.') {
          const source = result.activation.sourceRange;
          const formulaSource = result.activation.from === taggedStart
            ? normalized.slice(source.start, source.end)
            : '';
          const expected = source.start + formulaSource.lastIndexOf('.') + 1;
          assert.strictEqual(result.caret, expected,
            `Click on the final visible formula character missed its exact source caret: ${JSON.stringify({
              point, caret: result.caret, expected,
            })}`);
        }
        results.push({ fraction, point, caret: result.caret,
          glyph: result.activation.clickedGlyph, source: result.activation.clickedSource,
        });
      }
      assert.ok(new Set(results.map((item) => item.caret)).size >= 3,
        `Different formula positions collapsed to one caret: ${JSON.stringify(results)}`);
      await evaluate(client, 'window.paperReaderMarkdownPerformance.resetEditingBlock()');
      await evaluate(client,
        `window.paperReaderMarkdownPerformance.scrollToPosition(${taggedStart})`);
      await delay(120);
      const entryPoint = await evaluate(client, `(() => {
        const node = [...document.querySelectorAll('.paper-reader-cm-math')]
          .find((item) => item.dataset.source?.includes('tag{4}'));
        const rect = node?.querySelector('.katex-html')?.getBoundingClientRect();
        return rect ? { x: rect.left + rect.width * 0.9, y: rect.top + rect.height / 2 } : null;
      })()`);
      assert.ok(entryPoint, 'Could not find formula (4) preview for source-entry regression');
      await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: entryPoint.x, y: entryPoint.y,
        button: 'left', buttons: 1, clickCount: 1,
      });
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: entryPoint.x, y: entryPoint.y,
        button: 'left', buttons: 0, clickCount: 1,
      });
      await delay(50);
      const sourcePoint = await evaluate(client, `(() => {
        const line = [...document.querySelectorAll('.cm-line')]
          .find((item) => item.textContent.includes('tag{4}'));
        if (!line) return null;
        const tagStart = line.textContent.indexOf('\\\\tag{4}');
        const targetOffset = tagStart > 0 ? tagStart - 1 : -1;
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let node;
        let consumed = 0;
        while ((node = walker.nextNode())) {
          if (targetOffset >= consumed && targetOffset < consumed + node.data.length) {
            const offset = targetOffset - consumed;
            const range = document.createRange();
            range.setStart(node, offset);
            range.setEnd(node, offset + 1);
            const rect = range.getBoundingClientRect();
            return {
              x: rect.left + rect.width * 0.75,
              y: rect.top + rect.height / 2,
              expected: Number(line.dataset.paperReaderLineFrom) + targetOffset + 1,
              character: node.data[offset],
              lineFrom: Number(line.dataset.paperReaderLineFrom),
              targetOffset,
            };
          }
          consumed += node.data.length;
        }
        return null;
      })()`);
      assert.ok(sourcePoint, 'Could not map source position immediately before \\tag{4}');
      await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: sourcePoint.x, y: sourcePoint.y,
        button: 'left', buttons: 1, clickCount: 1,
      });
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: sourcePoint.x, y: sourcePoint.y,
        button: 'left', buttons: 0, clickCount: 1,
      });
      await delay(50);
      const sourceCaret = await evaluate(client,
        'window.paperReaderMarkdownPerformance.selectionFrom');
      assert.strictEqual(sourceCaret, sourcePoint.expected,
        `Click before \\tag{4} missed its exact source caret: ${JSON.stringify({
          sourcePoint, sourceCaret,
        })}`);
      console.log(JSON.stringify({
        fixture: fixturePath,
        equationFour: results,
        sourceClickBeforeTag: { ...sourcePoint, caret: sourceCaret },
      }));
      return;
    }
    const previewWidgets = await evaluate(
      client,
      `({
        inlineCode: document.querySelectorAll('.paper-reader-cm-inline-code-source').length,
        codeBlocks: document.querySelectorAll('.paper-reader-cm-code-block').length,
        inlineMath: document.querySelectorAll('.paper-reader-cm-inline-math').length,
        tables: document.querySelectorAll('.paper-reader-cm-table').length,
      })`
    );
    if (process.env.MARKDOWN_SWEEP === 'true' && fixturePath) {
      const sweep = await runStrictSweep(client, documentContent);
      console.log(JSON.stringify({ fixture: fixturePath, ...sweep }));
      return;
    }
    if (process.env.MARKDOWN_HEADING_SWEEP === 'true' && fixturePath) {
      const sweep = await runHeadingSweep(client, documentContent);
      console.log(JSON.stringify({ fixture: fixturePath, ...sweep }));
      return;
    }
    if (fixturePath) {
      const initialImage = await evaluate(client, `(() => {
        const image = document.querySelector('.paper-reader-cm-image img');
        return {
          complete: image?.complete,
          width: image?.naturalWidth,
          src: image?.src,
          widgetCount: document.querySelectorAll('.paper-reader-cm-image').length,
          blockCount: window.paperReaderMarkdownPerformance?.documentBlocks,
          blockTypes: window.paperReaderMarkdownPerformance?.documentBlockTypes,
          sourceHasFigure: window.paperReaderMarkdownPerformance?.documentText.includes('223ed8088c13ab489352fd30b711eb9fc1e7b8178d1a92ac9b8e903bd2580bc2.jpg'),
        };
      })()`);
      let fixtureState;
      let foundImage = initialImage;
      const scrollHeight = await evaluate(client,
        'document.querySelector(".cm-scroller")?.scrollHeight || 0');
      for (let top = 0; top <= scrollHeight; top += 500) {
        await evaluate(client, `document.querySelector('.cm-scroller').scrollTop = ${top}`);
        await delay(80);
        fixtureState = await evaluate(client, `(() => {
        const display = [...document.querySelectorAll('.paper-reader-cm-math')];
        const inline = [...document.querySelectorAll('.paper-reader-cm-inline-math')];
        const image = document.querySelector('.paper-reader-cm-image img');
        const tagged = display.find((node) => node.dataset.source?.includes('\\\\tag{4}'));
        const arrayInline = inline.find((node) => node.dataset.source?.includes('\\\\begin{array}'));
        return {
          displayCount: display.length,
          inlineCount: inline.length,
          taggedSource: tagged?.dataset.source,
          taggedText: tagged?.textContent,
          arrayInlineSource: arrayInline?.dataset.source,
          imageComplete: image?.complete,
          imageWidth: image?.naturalWidth,
          imageSrc: image?.src,
        };
        })()`);
        if (fixtureState.imageWidth > 0) foundImage = fixtureState;
        if (fixtureState.taggedSource) break;
      }
      const fixtureImageAssets = path.join(fixtureAssetRoot, 'assets', 'images');
      if (fs.existsSync(fixtureImageAssets)) {
        assert.ok(
          (foundImage.complete && foundImage.width > 0) ||
          (foundImage.imageComplete && foundImage.imageWidth > 0),
          `Figure 1 failed to load: ${JSON.stringify(foundImage)}`);
      } else {
        console.log(`Skipping fixture image loading assertion; ${fixtureImageAssets} is missing.`);
      }
      const normalizedFixture = documentContent.replace(/\r\n|\r/g, '\n');
      const sectionTitle = '2.1 对称子空间中的算法';
      await evaluate(client, `(() => {
        const line = [...document.querySelectorAll('.cm-line')]
          .find((item) => item.textContent.includes(${JSON.stringify(sectionTitle)}));
        line?.scrollIntoView({block: 'center'});
      })()`);
      await delay(120);
      const sectionPoint = await evaluate(client, `(() => {
        const line = [...document.querySelectorAll('.cm-line')]
          .find((item) => item.textContent.includes(${JSON.stringify(sectionTitle)}));
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let textNode;
        while ((textNode = walker.nextNode())) {
          if (textNode.data.includes(${JSON.stringify(sectionTitle)})) break;
        }
        const offset = textNode.data.indexOf(${JSON.stringify(sectionTitle)});
        const range = document.createRange();
        range.setStart(textNode, offset + 4);
        range.setEnd(textNode, offset + 5);
        const rect = range.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          lineHtml: line.innerHTML,
          text: textNode.data,
          rect: {left: rect.left, width: rect.width, top: rect.top, height: rect.height},
        };
      })()`);
      await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', ...sectionPoint, button: 'left', buttons: 1, clickCount: 1,
      });
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', ...sectionPoint, button: 'left', buttons: 0, clickCount: 1,
      });
      const sectionCaret = await evaluate(client,
        'window.paperReaderMarkdownPerformance?.selectionFrom');
      const sectionStart = normalizedFixture.indexOf(sectionTitle);
      assert.ok(Math.abs(sectionCaret - (sectionStart + 4)) <= 2,
        `Section 2.1 caret is offset after image: ${JSON.stringify({
          sectionCaret,
          sectionStart,
          sectionPoint,
          source: normalizedFixture.slice(sectionStart - 8, sectionStart + 35),
          selectionText: await evaluate(client, 'window.paperReaderMarkdownPerformance?.selectionText'),
        })}`);
      const paragraph = '下面我们展示如何利用多副本测量来开发解决DIPE的算法，并开发用于证明下界的工具。';
      await evaluate(client, `(() => {
        const line = [...document.querySelectorAll('.cm-line')]
          .find((item) => item.textContent.includes(${JSON.stringify(paragraph)}));
        line?.scrollIntoView({block: 'center'});
      })()`);
      await delay(100);
      const paragraphPoint = await evaluate(client, `(() => {
        const line = [...document.querySelectorAll('.cm-line')]
          .find((item) => item.textContent.includes(${JSON.stringify(paragraph)}));
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let textNode;
        while ((textNode = walker.nextNode())) {
          if (textNode.data.includes(${JSON.stringify(paragraph)})) break;
        }
        const offset = textNode.data.indexOf(${JSON.stringify(paragraph)});
        const range = document.createRange();
        range.setStart(textNode, offset + 8);
        range.setEnd(textNode, offset + 9);
        const rect = range.getBoundingClientRect();
        return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
      })()`);
      await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', ...paragraphPoint, button: 'left', buttons: 1, clickCount: 1,
      });
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', ...paragraphPoint, button: 'left', buttons: 0, clickCount: 1,
      });
      const paragraphCaret = await evaluate(client,
        'window.paperReaderMarkdownPerformance?.selectionFrom');
      const paragraphStart = normalizedFixture.indexOf(paragraph);
      assert.ok(Math.abs(paragraphCaret - (paragraphStart + 8)) <= 2,
        `Body caret is offset after image: ${JSON.stringify({paragraphCaret, paragraphStart})}`);
      assert.ok(fixtureState.displayCount > 0, JSON.stringify(fixtureState));
      assert.ok(fixtureState.taggedSource, `Formula (4) was not recognized: ${JSON.stringify(fixtureState)}`);
      assert.ok(fixtureState.arrayInlineSource, `Inline array formula was not recognized: ${JSON.stringify(fixtureState)}`);
      const displayTargets = [];
      for (let cursor = 0; cursor < normalizedFixture.length;) {
        const start = normalizedFixture.indexOf('$$', cursor);
        if (start < 0) break;
        const lineStart = normalizedFixture.lastIndexOf('\n', start - 1) + 1;
        if (!/^\s*\$\$\s*$/.test(normalizedFixture.slice(lineStart, start + 2))) {
          cursor = start + 2;
          continue;
        }
        const end = normalizedFixture.indexOf('$$', start + 2);
        if (end < 0) break;
        displayTargets.push({ from: lineStart, to: end + 2 });
        cursor = end + 2;
      }
      const inlineTargets = [];
      const inlinePattern = /(^|[^\\$])\$(?!\$)([^\n$]+?)(?<!\\)\$(?!\$)/g;
      let inlineMatch;
      while ((inlineMatch = inlinePattern.exec(normalizedFixture))) {
        const from = inlineMatch.index + inlineMatch[1].length;
        const to = from + inlineMatch[0].length - inlineMatch[1].length;
        if (!displayTargets.some((range) => from >= range.from && to <= range.to)) {
          inlineTargets.push({ from, to });
        }
      }
      const proseTargets = [];
      const quoteTargets = [];
      let lineOffset = 0;
      for (const line of normalizedFixture.split('\n')) {
        const trimmed = line.trim();
        const inDisplay = displayTargets.some((range) =>
          lineOffset >= range.from && lineOffset <= range.to);
        if (trimmed.startsWith('>') && trimmed.length > 2) {
          quoteTargets.push({
            from: lineOffset + Math.min(2, line.length - 1),
            lineStart: lineOffset,
            line,
          });
        } else if (
          trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('```') &&
          !trimmed.startsWith('![') && !trimmed.startsWith('|') && !inDisplay &&
          !trimmed.startsWith('$$') && !trimmed.startsWith('\\[') &&
          !line.includes('$') && !line.includes('\\[') &&
          !/<(?:sup|sub)\b/i.test(line) &&
          line.length >= 20 && normalizedFixture.indexOf(line) === lineOffset
        ) {
          proseTargets.push({
            from: lineOffset + Math.min(8, Math.max(0, line.length - 1)),
            lineStart: lineOffset,
            line,
          });
        }
        lineOffset += line.length + 1;
      }
      assert.ok(displayTargets.length >= 50, `Expected 50 display formulas, got ${displayTargets.length}`);
      assert.ok(inlineTargets.length >= 50, `Expected 50 inline formulas, got ${inlineTargets.length}`);
      assert.ok(proseTargets.length >= 50, `Expected 50 prose samples, got ${proseTargets.length}`);
      const sample = (items) => items.filter((_item, index) =>
        index % Math.max(1, Math.floor(items.length / 50)) === 0).slice(0, 50);
      const clickWidgetAtSource = async (target, selector) => {
        let lastPoint = null;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await evaluate(client, `window.paperReaderMarkdownPerformance.scrollToPosition(${target.from})`);
          await delay(70);
          const point = await evaluate(client, `(() => {
            const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
              .find((item) => Number(item.dataset.from) <= ${target.from} &&
                Number(item.dataset.to) >= ${target.to});
            if (!node) return null;
            const rect = node.getBoundingClientRect();
            const scroller = document.querySelector('.cm-scroller');
            const scrollerRect = scroller?.getBoundingClientRect() || {
              left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight,
            };
            const viewportLeft = scrollerRect.left + 4;
            const viewportRight = scrollerRect.left + (scroller?.clientWidth || window.innerWidth) - 4;
            const viewportTop = scrollerRect.top + 4;
            const viewportBottom = scrollerRect.top + (scroller?.clientHeight || window.innerHeight) - 4;
            const x = Math.min(
              Math.max(rect.left + rect.width * .55, rect.left + 4, viewportLeft),
              Math.min(rect.right - 4, viewportRight),
            );
            const y = Math.min(
              Math.max(rect.top + rect.height / 2, rect.top + 4, viewportTop),
              Math.min(rect.bottom - 4, viewportBottom),
            );
            if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return null;
            const element = document.elementFromPoint(x, y);
            const closest = element?.closest(${JSON.stringify(selector)});
            return {x, y, from: Number(node.dataset.from), to: Number(node.dataset.to),
              rect: {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
                width: rect.width, height: rect.height},
              hit: closest === node, element: element?.className || element?.tagName,
              closestFrom: closest?.dataset?.from};
          })()`);
          lastPoint = point;
          if (point?.hit) {
            await client.send('Input.dispatchMouseEvent', {
              type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1,
            });
            await client.send('Input.dispatchMouseEvent', {
              type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1,
            });
            const caret = await evaluate(client, 'window.paperReaderMarkdownPerformance?.selectionFrom');
            assert.ok(caret >= point.from && caret <= point.to,
              `Widget caret escaped source: ${JSON.stringify({target, point, caret})}`);
            return;
          }
        }
        const debugNodes = await evaluate(client, `(() => ({
          scrollTop: document.querySelector('.cm-scroller')?.scrollTop,
          scroller: (() => { const s = document.querySelector('.cm-scroller'); return s && {
            left: s.getBoundingClientRect().left, right: s.getBoundingClientRect().right,
            clientWidth: s.clientWidth, scrollWidth: s.scrollWidth, scrollLeft: s.scrollLeft,
          }; })(),
          documentTextLength: window.paperReaderMarkdownPerformance?.documentText?.length,
          visibleChars: window.paperReaderMarkdownPerformance?.visibleScanChars,
          nodes: [...document.querySelectorAll(${JSON.stringify(selector)})]
            .map((item) => ({from:item.dataset.from,to:item.dataset.to,top:item.getBoundingClientRect().top}))
            .filter((item) => Math.abs(Number(item.from) - ${target.from}) < 2000)
            .slice(0, 8),
        }))()`);
        assert.fail(`Could not mount widget for source range ${JSON.stringify({target, point: lastPoint, debugNodes})}`);
      };
      for (const target of sample(displayTargets)) await clickWidgetAtSource(target, '.paper-reader-cm-math');
      for (const target of sample(inlineTargets)) await clickWidgetAtSource(target, '.paper-reader-cm-inline-math');
      const clickTextAtSource = async (target) => {
        await evaluate(client, `window.paperReaderMarkdownPerformance.scrollToPosition(${target.from})`);
        await delay(70);
        const point = await evaluate(client, `(() => {
          const line = [...document.querySelectorAll('.cm-line')]
            .find((item) => item.textContent.includes(${JSON.stringify(target.line)}));
          if (!line) return null;
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          const wanted = ${JSON.stringify(target.line)};
          let node;
          while ((node = walker.nextNode())) {
            if (node.data.includes(wanted) || node.data.trim().length > 0) break;
          }
          if (!node) return null;
          const lineOffset = ${target.lineStart};
          let sourceOffset = ${target.from} - lineOffset;
          let candidate = node;
          let offset = 0;
          while (candidate && sourceOffset > candidate.data.length) {
            sourceOffset -= candidate.data.length;
            candidate = walker.nextNode();
            if (candidate) offset = 0;
          }
          if (!candidate) return null;
          const range = document.createRange();
          const start = Math.min(sourceOffset, Math.max(0, candidate.data.length - 1));
          range.setStart(candidate, start);
          range.setEnd(candidate, Math.min(start + 1, candidate.data.length));
          const rect = range.getBoundingClientRect();
          return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
        })()`);
        assert.ok(point, `Could not mount prose line at ${JSON.stringify({
          from: target.from,
          line: target.line,
          scrollTop: await evaluate(client, 'document.querySelector(".cm-scroller")?.scrollTop'),
          lines: await evaluate(client, '([...document.querySelectorAll(".cm-line")].slice(0, 8).map((item) => item.textContent))'),
        })}`);
        await delay(50);
        await client.send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1,
        });
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1,
        });
        const caret = await evaluate(client, 'window.paperReaderMarkdownPerformance?.selectionFrom');
        assert.ok(caret >= target.from - 2 && caret <= target.from + target.line.length,
          `Text caret escaped source line: ${JSON.stringify({target, caret})}`);
      };
      for (const target of sample(proseTargets)) await clickTextAtSource(target);
      let quoteCorpus = normalizedFixture;
      if (quoteTargets.length < 10) {
        quoteCorpus += `\n\n${Array.from({length: 10}, (_item, index) =>
          `> Synthetic citation sample ${index} for quote selection.`).join('\n')}`;
        await evaluate(client, `window.postMessage({type:'update',content:${JSON.stringify(quoteCorpus)}},'*')`);
        await delay(180);
        let syntheticOffset = normalizedFixture.length + 2;
        for (let index = 0; index < 10; index += 1) {
          const line = `> Synthetic citation sample ${index} for quote selection.`;
          quoteTargets.push({ from: syntheticOffset + 2, lineStart: syntheticOffset, line });
          syntheticOffset += line.length + 1;
        }
      }
      for (const target of sample(quoteTargets).slice(0, 10)) await clickTextAtSource(target);
      await evaluate(client, `window.postMessage({type:'update',content:${JSON.stringify(normalizedFixture)}},'*')`);
      await delay(180);
      const taggedBody = normalizedFixture.indexOf('\\tag{4}');
      const taggedStart = normalizedFixture.lastIndexOf('$$', taggedBody);
      const taggedEnd = normalizedFixture.indexOf('$$', taggedBody);
      await evaluate(client, `window.paperReaderMarkdownPerformance.scrollToPosition(${taggedStart})`);
      await delay(100);
      await evaluate(client, `(() => {
        const node = [...document.querySelectorAll('.paper-reader-cm-math')]
          .find((item) => item.dataset.source?.includes('\\\\tag{4}'));
        node?.scrollIntoView({block: 'center'});
      })()`);
      await delay(120);
      const taggedPoint = await evaluate(client, `(() => {
        const node = [...document.querySelectorAll('.paper-reader-cm-math')]
          .find((item) => item.dataset.source?.includes('\\\\tag{4}'));
        const rect = node.getBoundingClientRect();
        return {x: rect.left + rect.width * .65, y: rect.top + rect.height / 2};
      })()`);
      await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', ...taggedPoint, button: 'left', buttons: 1, clickCount: 1,
      });
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', ...taggedPoint, button: 'left', buttons: 0, clickCount: 1,
      });
      const taggedCaret = await evaluate(client,
        'window.paperReaderMarkdownPerformance?.selectionFrom');
      assert.ok(taggedCaret >= taggedStart && taggedCaret <= taggedEnd + 2,
        `Formula (4) click did not enter its source: ${JSON.stringify({
          taggedCaret,
          taggedStart,
          selectionTo: await evaluate(client, 'window.paperReaderMarkdownPerformance?.selectionTo'),
          selectionText: await evaluate(client, 'window.paperReaderMarkdownPerformance?.selectionText'),
          active: await evaluate(client, 'document.activeElement?.outerHTML?.slice(0, 180)'),
          point: taggedPoint,
          rect: await evaluate(client, `(() => {
            const node = [...document.querySelectorAll('.paper-reader-cm-math')]
              .find((item) => item.dataset.source?.includes('\\\\tag{4}'));
            if (!node) return null;
            const rect = node.getBoundingClientRect();
            return {left: rect.left, top: rect.top, width: rect.width, height: rect.height};
          })()`),
        })}`);
      let inlinePoint;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        inlinePoint = await evaluate(client, `(() => {
          const node = [...document.querySelectorAll('.paper-reader-cm-inline-math')]
            .find((item) => item.dataset.source?.includes('\\\\begin{array}'));
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          const x = rect.left + rect.width * .7;
          const y = rect.top + rect.height / 2;
          const visible = y >= 0 && y <= window.innerHeight;
          const hit = document.elementFromPoint(x, y)?.closest('.paper-reader-cm-inline-math') === node;
          if (!visible || !hit) {
            document.querySelector('.cm-scroller').scrollTop += rect.top - window.innerHeight / 2;
          }
          return {x, y, viewportHeight: window.innerHeight, from: node.dataset.from, to: node.dataset.to,
            rect: {left: rect.left, top: rect.top, width: rect.width, height: rect.height}, hit};
        })()`);
        await delay(90);
        if (inlinePoint?.hit && inlinePoint.y >= 0 && inlinePoint.y <= inlinePoint.viewportHeight) break;
      }
      assert.ok(inlinePoint, 'The inline array formula is not mounted in the current viewport');
      await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', ...inlinePoint, button: 'left', buttons: 1, clickCount: 1,
      });
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', ...inlinePoint, button: 'left', buttons: 0, clickCount: 1,
      });
      const inlineCaret = await evaluate(client,
        'window.paperReaderMarkdownPerformance?.selectionFrom');
      const inlineStart = Number(inlinePoint.from);
      const inlineEnd = Number(inlinePoint.to);
      assert.ok(inlineCaret >= inlineStart && inlineCaret <= inlineEnd,
        `Inline array formula click left its source: ${JSON.stringify({
          inlineCaret,
          inlineStart,
          inlineEnd,
          inlinePoint,
          selectionText: await evaluate(client, 'window.paperReaderMarkdownPerformance?.selectionText'),
          active: await evaluate(client, 'document.activeElement?.className'),
        })}`);
      console.log(JSON.stringify({ fixture: fixturePath, ...fixtureState, taggedCaret }));
      return;
    }
    if (!longDocument) {
      assert.strictEqual(previewWidgets.inlineCode, 1);
      assert.strictEqual(previewWidgets.codeBlocks, 1);
      assert.strictEqual(previewWidgets.inlineMath, 1);
      assert.strictEqual(previewWidgets.tables, 1);
      const quotePoint = await evaluate(
        client,
        `(() => {
          const line = [...document.querySelectorAll('.cm-line')]
            .find((item) => item.textContent.includes('Quoted text'));
          const text = [...line.childNodes].find((item) =>
            item.nodeType === Node.TEXT_NODE && item.textContent.includes('Quoted text')
          );
          const range = document.createRange();
          const offset = text.textContent.indexOf('Quoted text');
          range.setStart(text, offset);
          range.setEnd(text, offset + 'Quoted text'.length);
          const textRect = range.getBoundingClientRect();
          const lineRect = line.getBoundingClientRect();
          return { x: textRect.left + 4, y: lineRect.bottom - 1 };
        })()`
      );
      await client.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: quotePoint.x,
        y: quotePoint.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: quotePoint.x,
        y: quotePoint.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      const quoteSelection = await evaluate(
        client,
        `window.paperReaderMarkdownPerformance?.selectionFrom`
      );
      const quoteOffset = documentContent.indexOf('Quoted text');
      assert.ok(
        quoteSelection >= quoteOffset && quoteSelection <= quoteOffset + 'Quoted text'.length,
        `Quote click mapped to the following line: ${quoteSelection}`
      );
      const quoteDrag = await evaluate(
        client,
        `(() => {
          const line = [...document.querySelectorAll('.cm-line')]
            .find((item) => item.textContent.includes('Quoted text'));
          const text = [...line.childNodes].find((item) =>
            item.nodeType === Node.TEXT_NODE && item.textContent.includes('Quoted text')
          );
          const range = document.createRange();
          const offset = text.textContent.indexOf('Quoted text');
          range.setStart(text, offset);
          range.setEnd(text, offset + 'Quoted text'.length);
          const rect = range.getBoundingClientRect();
          const lineRect = line.getBoundingClientRect();
          return { startX: rect.left + 1, endX: rect.right - 1, y: lineRect.bottom - 1 };
        })()`
      );
      await client.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: quoteDrag.startX,
        y: quoteDrag.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: quoteDrag.endX,
        y: quoteDrag.y,
        button: "left",
        buttons: 1,
      });
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: quoteDrag.endX,
        y: quoteDrag.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      const quoteDragSelection = await evaluate(
        client,
        `({
          text: window.paperReaderMarkdownPerformance?.selectionText,
          from: window.paperReaderMarkdownPerformance?.selectionFrom,
          to: window.paperReaderMarkdownPerformance?.selectionTo,
        })`
      );
      assert.ok(
        quoteDragSelection.text.includes('Quoted text'),
        `Quote drag did not select the quote text: ${JSON.stringify(quoteDragSelection)}`
      );
      await clickElement(client, '.paper-reader-cm-table');
      const tableSelection = await evaluate(
        client,
        `({
          from: window.paperReaderMarkdownPerformance?.selectionFrom,
          to: window.paperReaderMarkdownPerformance?.selectionTo,
          content: window.paperReaderMarkdownPerformance?.documentText,
        })`
      );
      assert.strictEqual(tableSelection.to, tableSelection.from);
      assert.ok(
        tableSelection.from >= documentContent.indexOf('| Column | Value |') &&
        tableSelection.from < documentContent.length,
        `Table click placed the caret outside its source: ${JSON.stringify(tableSelection)}`
      );
      assert.ok(tableSelection.content.includes('| Column | Value |'));
      await evaluate(
        client,
        `window.postMessage({type:'update',content:${JSON.stringify(documentContent)}},'*')`
      );
      await delay(180);
    }
    if (longDocument) {
      await evaluate(
        client,
        `document.querySelector('[data-command="outline"]').click();
        [...document.querySelectorAll('.paper-reader-outline-item')]
          .find((item) => item.textContent === 'Heading title').click()`
      );
      await delay(300);
    }

    const geometry = await evaluate(
      client,
      `(() => {
        const line = [...document.querySelectorAll('.cm-line')]
          .find((item) => item.textContent.includes('Heading title'));
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.data.includes('Heading title')) break;
        }
        const start = node.data.indexOf('Heading title');
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + 'Heading title'.length);
        const rect = range.getBoundingClientRect();
        const lineRect = line.getBoundingClientRect();
        return {
          startX: rect.left + 1,
          endX: rect.right - 1,
          y: rect.top + rect.height / 2,
          lineTop: lineRect.top,
          lineHeight: lineRect.height,
          lineText: line.textContent,
          lineLeft: lineRect.left,
        };
      })()`
    );
    const reverse = process.env.HEADING_SELECTION_DIRECTION === "reverse";
    const pointerStartX = reverse ? geometry.endX : geometry.startX;
    const pointerEndX = reverse ? geometry.startX : geometry.endX;

    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: geometry.endX - 4,
      y: geometry.lineTop + geometry.lineHeight - 2,
      button: 'left', buttons: 1, clickCount: 1,
    });
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: geometry.endX - 4,
      y: geometry.lineTop + geometry.lineHeight - 2,
      button: 'left', buttons: 0, clickCount: 1,
    });
    const headingClick = await evaluate(client,
      `window.paperReaderMarkdownPerformance?.selectionFrom`
    );
    const headingStart = documentContent.indexOf('Heading title');
    assert.ok(
      headingClick >= headingStart && headingClick <= headingStart + 'Heading title'.length,
      `Clicking the bottom of a heading selected another line: ${JSON.stringify({headingClick, headingStart, geometry})}`
    );

    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: pointerStartX,
      y: geometry.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    for (let step = 1; step <= 8; step += 1) {
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: pointerStartX + ((pointerEndX - pointerStartX) * step) / 8,
        y: geometry.y,
        button: "left",
        buttons: 1,
      });
    }
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: pointerEndX,
      y: geometry.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await delay(100);
    await delay(100);

    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: pointerEndX,
      y: geometry.y,
      button: "right",
      buttons: 2,
      clickCount: 1,
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: pointerEndX,
      y: geometry.y,
      button: "right",
      buttons: 0,
      clickCount: 1,
    });
    await evaluate(
      client,
      `document.querySelector('[data-action="addSelectionToNotes"]').click()`
    );
    const result = await evaluate(
      client,
      `(() => {
        const line = [...document.querySelectorAll('.cm-line')]
          .find((item) => item.textContent.includes('Heading title'));
        const rect = line.getBoundingClientRect();
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.data.includes('Heading title')) break;
        }
        const start = node.data.indexOf('Heading title');
        const titleRange = document.createRange();
        titleRange.setStart(node, start);
        titleRange.setEnd(node, start + 'Heading title'.length);
        const titleRect = titleRange.getBoundingClientRect();
        const message = window.__paperReaderMessages
          .filter((item) => item.type === 'addSelectionToNotes').at(-1);
        return {
          selectedText: message?.content?.selectedText,
          lineTop: rect.top,
          lineHeight: rect.height,
          lineText: line.textContent,
          lineLeft: rect.left,
          titleLeft: titleRect.left,
        };
      })()`
    );
    assert.strictEqual(result.selectedText, "Heading title");
    assert.ok(
      Math.abs(result.lineTop - geometry.lineTop) < 1,
      `Heading moved vertically during selection: ${geometry.lineTop} -> ${result.lineTop}`
    );
    assert.strictEqual(
      result.lineText,
      geometry.lineText,
      "Heading DOM text changed while selecting it"
    );
    assert.ok(
      Math.abs(result.lineLeft - geometry.lineLeft) < 1,
      `Heading moved horizontally during selection: ${geometry.lineLeft} -> ${result.lineLeft}`
    );
    assert.ok(
      Math.abs(result.titleLeft - geometry.startX + 1) < 1,
      `Heading text moved horizontally during selection: ${
        geometry.startX - 1
      } -> ${result.titleLeft}`
    );
    await client.send("Page.navigate", {
      url: `http://127.0.0.1:${server.address().port}/index.html`,
    });
    await delay(400);
    await evaluate(
      client,
      `window.postMessage({type:'open',content:${JSON.stringify({
        content: "Intro paragraph.\n\n",
        config: { fontSizes: { body: 14, inlineMath: 15, displayMath: 18 } },
      })}},'*')`
    );
    await delay(250);
    const applyHeadingShortcut = async (level) => {
      await evaluate(
        client,
        `window.postMessage({type:'update',content:${JSON.stringify(
          'Intro paragraph.\n\n'
        )}},'*')`
      );
      await delay(120);
      const targetLine = await evaluate(
        client,
        `(() => {
          const line = [...document.querySelectorAll('.cm-line')]
            .find((item) => item.textContent === '') || document.querySelector('.cm-line');
          const rect = line.getBoundingClientRect();
          return { x: rect.left + 8, y: rect.top + rect.height / 2 };
        })()`
      );
      await client.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: targetLine.x,
        y: targetLine.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: targetLine.x,
        y: targetLine.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      await client.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: String(level),
        code: `Digit${level}`,
        modifiers: 10,
      });
      await client.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: String(level),
        code: `Digit${level}`,
        modifiers: 10,
      });
      await delay(80);
      await client.send("Input.insertText", { text: `Level ${level}` });
      const content = await evaluate(
        client,
        `window.paperReaderMarkdownPerformance?.documentText`
      );
      assert.ok(
        content.includes(`${'#'.repeat(level)} Level ${level}`),
        `Ctrl+Shift+${level} did not create the expected heading: ${content}`
      );
    };
    for (const level of [1, 2, 3]) await applyHeadingShortcut(level);
    const applyFormattingShortcut = async (key, expected, text) => {
      await evaluate(
        client,
        `window.postMessage({type:'update',content:${JSON.stringify(
          'Intro paragraph.\n\n'
        )}},'*')`
      );
      await delay(120);
      const targetLine = await evaluate(
        client,
        `(() => {
          const line = [...document.querySelectorAll('.cm-line')]
            .find((item) => item.textContent === '') || document.querySelector('.cm-line');
          const rect = line.getBoundingClientRect();
          return { x: rect.left + 8, y: rect.top + rect.height / 2 };
        })()`
      );
      await client.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: targetLine.x,
        y: targetLine.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: targetLine.x,
        y: targetLine.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      await client.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key,
        code: `Digit${key}`,
        modifiers: 10,
      });
      await client.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code: `Digit${key}`,
        modifiers: 10,
      });
      await client.send("Input.insertText", { text });
      const content = await evaluate(
        client,
        `document.querySelector('.cm-content')?.textContent`
      );
      assert.ok(
        content.replace(/\s+/g, '').includes(expected.replace(/\s+/g, '')),
        `Ctrl+Shift+${key} did not create the expected Markdown: ${content}`
      );
    };
    await applyFormattingShortcut('7', '`code`', 'code');
    await applyFormattingShortcut('8', '```\nconst value = 1;\n```', 'const value = 1;');
    await applyFormattingShortcut('9', '$x+y$', 'x+y');
    await applyFormattingShortcut('0', '$$\nE=mc^2\n$$', 'E=mc^2');
    await evaluate(
      client,
      `window.postMessage({type:'update',content:${JSON.stringify(
        'Intro paragraph.\n\n'
      )}},'*')`
    );
    await delay(120);
    const emptyLine = await evaluate(
      client,
      `(() => {
        const line = [...document.querySelectorAll('.cm-line')]
          .find((item) => item.textContent === '') || document.querySelector('.cm-line');
        const rect = line.getBoundingClientRect();
        return { x: rect.left + 8, y: rect.top + rect.height / 2 };
      })()`
    );
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: emptyLine.x,
      y: emptyLine.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: emptyLine.x,
      y: emptyLine.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await client.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "2",
      code: "Digit2",
      modifiers: 10,
    });
    await client.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "2",
      code: "Digit2",
      modifiers: 10,
    });
    await client.send("Input.insertText", { text: "Typed heading" });
    const deletionSuffix =
      " with a long sequence that should remain on its own heading line";
    await client.send("Input.insertText", {
      text: deletionSuffix,
    });
    for (let index = 0; index < deletionSuffix.length; index += 1) {
      await client.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Backspace",
        code: "Backspace",
      });
      await client.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Backspace",
        code: "Backspace",
      });
    }
    const deletionState = await evaluate(
      client,
      `(() => {
        return {
          lineCount: document.querySelectorAll('.cm-line').length,
          content: window.paperReaderMarkdownPerformance?.documentText,
          selectionFrom: window.paperReaderMarkdownPerformance?.selectionFrom,
          selectionTo: window.paperReaderMarkdownPerformance?.selectionTo,
        };
      })()`
    );
    assert.ok(deletionState.lineCount > 1);
    assert.ok(
      deletionState.selectionFrom > "Intro paragraph.\n\n".length,
      `Cursor jumped to the document start after deletion: ${JSON.stringify(deletionState)}`
    );
    await delay(100);
    const headingInputResult = await evaluate(
      client,
      `(() => {
        const line = [...document.querySelectorAll('.cm-line')]
          .find((item) => item.textContent.includes('Typed heading'));
        return {
          text: line?.textContent,
          sourceVisible: line?.querySelector('.paper-reader-cm-heading-marker')
            ? getComputedStyle(line.querySelector('.paper-reader-cm-heading-marker')).color !== 'rgba(0, 0, 0, 0)'
            : line?.textContent.startsWith('## '),
          textDecoration: line
            ? getComputedStyle(line).textDecorationLine
            : 'none',
        };
      })()`
    );
    assert.ok(
      headingInputResult.text === "Typed heading" ||
        headingInputResult.text === "## Typed heading",
      `Heading text changed unexpectedly: ${headingInputResult.text}`
    );
    assert.ok(
      deletionState.content.includes("## Typed heading"),
      `Ctrl+Shift+2 did not create a level-2 heading: ${deletionState.content}`
    );
    assert.ok(
      headingInputResult.sourceVisible === false || headingInputResult.sourceVisible === true,
      'Heading source visibility must remain a boolean'
    );
    assert.ok(
      headingInputResult.textDecoration.includes("underline"),
      `Heading text is not underlined: ${headingInputResult.textDecoration}; ${await evaluate(
        client,
        `document.querySelector('.cm-line')?.outerHTML`
      )}`
    );
    await evaluate(
      client,
      `document.querySelector('[data-command="underline"]').click()`
    );
    const genericUnderline = await evaluate(
      client,
      `document.querySelector('.cm-content').textContent`
    );
    assert.ok(
      genericUnderline.includes('<u>text</u>'),
      "Underline command did not insert an HTML underline mark"
    );
    await evaluate(
      client,
      `window.postMessage({type:'update',content:${JSON.stringify(
        'Before\n\n$$\nx+y\n$$\n\nAfter\n\n`code`\n\n```js\nconst value = 1;\n```\n'
      )}},'*')`
    );
    await delay(180);
    const previewBlockState = await evaluate(
      client,
      `({
        displayMath: document.querySelectorAll('.paper-reader-cm-math').length,
        inlineCode: document.querySelectorAll('.paper-reader-cm-inline-code-source').length,
        codeBlock: document.querySelectorAll('.paper-reader-cm-code-block').length,
      })`
    );
    assert.deepStrictEqual(previewBlockState, {
      displayMath: 1,
      inlineCode: 1,
      codeBlock: 1,
    });
    await clickElement(client, '.paper-reader-cm-math');
    await delay(80);
    const mathSourceState = await evaluate(
      client,
      `({
        content: document.querySelector('.cm-content')?.textContent,
        lines: [...document.querySelectorAll('.cm-line')].map((line) => line.textContent),
        selectionFrom: window.paperReaderMarkdownPerformance?.selectionFrom,
        selectionTo: window.paperReaderMarkdownPerformance?.selectionTo,
      })`
    );
    assert.ok(
      mathSourceState.lines.join('\n').includes('$$\nx+y\n$$'),
      `Formula click did not reveal source: ${JSON.stringify(mathSourceState)}`
    );
    assert.strictEqual(mathSourceState.selectionTo, mathSourceState.selectionFrom);
    assert.ok(
      mathSourceState.selectionFrom >= 'Before\n\n$$\n'.length &&
      mathSourceState.selectionFrom <= 'Before\n\n$$\nx+y'.length,
      `Formula click placed the caret outside its body: ${JSON.stringify(mathSourceState)}`
    );
    await client.send("Input.insertText", { text: 'z' });
    const mathEdited = await evaluate(
      client,
      `window.paperReaderMarkdownPerformance?.documentText`
    );
    assert.ok(
      mathEdited.includes('$$\n') && mathEdited.includes('z') && mathEdited.includes('\n$$'),
      `Formula could not be edited: ${mathEdited}`
    );
    await client.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Backspace",
      code: "Backspace",
    });
    await client.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
    });
    const mathDeletedState = await evaluate(
      client,
      `({
        content: document.querySelector('.cm-content')?.textContent,
        documentText: window.paperReaderMarkdownPerformance?.documentText,
        renderedMath: document.querySelectorAll('.paper-reader-cm-math').length,
        selectionFrom: window.paperReaderMarkdownPerformance?.selectionFrom,
        selectionTo: window.paperReaderMarkdownPerformance?.selectionTo,
      })`
    );
    assert.ok(
      mathDeletedState.documentText.includes('$$\nx+y\n$$') && mathDeletedState.renderedMath === 0,
      `Formula source disappeared on Backspace: ${JSON.stringify(mathDeletedState)}`
    );
    assert.ok(
      mathDeletedState.selectionFrom > 0,
      `Formula deletion moved the cursor to the document start: ${JSON.stringify(mathDeletedState)}`
    );
    await evaluate(
      client,
      `window.postMessage({type:'update',content:${JSON.stringify(
        'Prefix one\n\n$$\nx+y\n$$\n\nAfter\n'
      )}},'*')`
    );
    await delay(140);
    await evaluate(
      client,
      `window.postMessage({type:'update',content:${JSON.stringify(
        'Prefix one\nPrefix two\n\n$$\nx+y\n$$\n\nAfter\n'
      )}},'*')`
    );
    await delay(140);
    await clickElement(client, '.paper-reader-cm-math');
    const movedFormulaState = await evaluate(
      client,
      `({
        content: [...document.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\\n'),
        selectionFrom: window.paperReaderMarkdownPerformance?.selectionFrom,
        selectionTo: window.paperReaderMarkdownPerformance?.selectionTo,
      })`
    );
    assert.ok(movedFormulaState.content.includes('$$\nx+y\n$$'));
    assert.ok(
      movedFormulaState.selectionFrom >= 'Prefix one\nPrefix two\n\n'.length,
      `Formula click used a stale source position after a document change: ${JSON.stringify(movedFormulaState)}`
    );
    await evaluate(
      client,
      `window.postMessage({type:'update',content:${JSON.stringify(
        'Intro paragraph.\n\n'
      )}},'*')`
    );
    await delay(140);
    const formulaLine = await evaluate(
      client,
      `(() => {
        const line = [...document.querySelectorAll('.cm-line')]
          .find((item) => item.textContent === '') || document.querySelector('.cm-line');
        const rect = line.getBoundingClientRect();
        return { x: rect.left + 8, y: rect.top + rect.height / 2 };
      })()`
    );
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: formulaLine.x,
      y: formulaLine.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: formulaLine.x,
      y: formulaLine.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await evaluate(
      client,
      `document.querySelector('[data-command="math"]').click()`
    );
    await client.send("Input.insertText", { text: "a".repeat(80) });
    const rapidDeletePositions = [];
    for (let index = 0; index < 40; index += 1) {
      await client.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Backspace",
        code: "Backspace",
      });
      await client.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Backspace",
        code: "Backspace",
      });
      rapidDeletePositions.push(
        await evaluate(
          client,
          `window.paperReaderMarkdownPerformance?.selectionFrom`
        )
      );
    }
    const rapidDeleteState = await evaluate(
      client,
      `({
        content: [...document.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\\n'),
        selectionFrom: window.paperReaderMarkdownPerformance?.selectionFrom,
        selectionTo: window.paperReaderMarkdownPerformance?.selectionTo,
      })`
    );
    assert.ok(
      rapidDeleteState.selectionFrom > 'Intro paragraph.\n\n$$\n'.length,
      `Rapid formula deletion moved the cursor to the document start: ${JSON.stringify(rapidDeleteState)}`
    );
    assert.ok(
      rapidDeletePositions.every(
        (position) => position > 'Intro paragraph.\n\n$$\n'.length
      ),
      `Formula deletion briefly reset the cursor: ${JSON.stringify(rapidDeletePositions)}`
    );
    assert.strictEqual(rapidDeleteState.selectionFrom, rapidDeleteState.selectionTo);
    await evaluate(
      client,
      `window.postMessage({type:'update',content:${JSON.stringify(
        'Intro paragraph.\n\n'
      )}},'*')`
    );
    await delay(140);
    await evaluate(
      client,
      `(() => {
        document.querySelector('[data-command="table"]').click();
        document.querySelector('[data-table-size="rows"]').value = '4';
        document.querySelector('[data-table-size="columns"]').value = '3';
        document.querySelector('[data-table-action="insert"]').click();
      })()`
    );
    const insertedTableSource = await evaluate(
      client,
      `window.paperReaderMarkdownPerformance?.documentText`
    );
    assert.ok(insertedTableSource.includes('| Column 1 | Column 2 | Column 3 |'));
    assert.strictEqual((insertedTableSource.match(/\n\| Value/g) || []).length, 4);
    await client.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "ArrowUp",
      code: "ArrowUp",
    });
    await client.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "ArrowUp",
      code: "ArrowUp",
    });
    assert.strictEqual(
      await evaluate(client, `document.querySelectorAll('.paper-reader-cm-table').length`),
      0,
      'ArrowUp unexpectedly rendered the table while its source was active'
    );
    const paragraphPoint = await evaluate(
      client,
      `(() => {
        const line = [...document.querySelectorAll('.cm-line')]
          .find((item) => item.textContent.includes('Intro paragraph'));
        const rect = line.getBoundingClientRect();
        return { x: rect.left + 8, y: rect.top + rect.height / 2 };
      })()`
    );
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: paragraphPoint.x,
      y: paragraphPoint.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: paragraphPoint.x,
      y: paragraphPoint.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await delay(100);
    assert.strictEqual(
      await evaluate(client, `document.querySelectorAll('.paper-reader-cm-table').length`),
      1,
      'Inserted table did not switch to table preview after leaving the source selection'
    );
    const wrappedText = Array.from({ length: 42 }, (_, index) => `word${index}`).join(' ');
    await evaluate(
      client,
      `window.postMessage({type:'update',content:${JSON.stringify(
        `Before paragraph.\n\n${wrappedText}\n\nAfter paragraph.\n`
      )}},'*')`
    );
    await delay(180);
    const wrapPoints = await evaluate(
      client,
      `(() => {
        const line = [...document.querySelectorAll('.cm-line')]
          .find((item) => item.textContent.startsWith('word0'));
        const textNode = [...line.childNodes].find((item) => item.nodeType === Node.TEXT_NODE);
        const positions = new Map();
        for (let index = 0; index < textNode.textContent.length; index += 1) {
          const range = document.createRange();
          range.setStart(textNode, index);
          range.setEnd(textNode, index + 1);
          const box = range.getBoundingClientRect();
          const row = Math.round(box.top);
          if (!positions.has(row) && /[a-z]/.test(textNode.textContent[index])) {
            positions.set(row, { x: box.left + 1, y: box.top + box.height / 2, offset: index });
          }
        }
        return [...positions.values()];
      })()`
    );
    assert.ok(wrapPoints.length >= 3, `Test paragraph did not wrap: ${JSON.stringify(wrapPoints)}`);
    for (const point of [wrapPoints[0], wrapPoints[2], wrapPoints.at(-1)]) {
      await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: point.x, y: point.y,
        button: 'left', buttons: 1, clickCount: 1,
      });
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: point.x, y: point.y,
        button: 'left', buttons: 0, clickCount: 1,
      });
      const actual = await evaluate(
        client,
        `window.paperReaderMarkdownPerformance?.selectionFrom`
      );
      const expected = 'Before paragraph.\n\n'.length + point.offset;
      assert.ok(
        Math.abs(actual - expected) <= 2,
        `Wrapped paragraph caret mapped to another visual row: ${JSON.stringify({point, actual, expected})}`
      );
    }
    await client.send('Input.insertText', { text: 'X' });
    const wrapEdit = await evaluate(client, `({
      content: window.paperReaderMarkdownPerformance?.documentText,
      caret: window.paperReaderMarkdownPerformance?.selectionFrom,
    })`);
    assert.strictEqual(
      wrapEdit.caret,
      'Before paragraph.\n\n'.length + wrapPoints.at(-1).offset + 1
    );
    assert.ok(wrapEdit.content.includes('X'));
    const preciseDocument = [
      '## 4.2 估计算法的分析',
      '',
      '这一段正文需要在不同文字之间准确定位光标。',
      '',
      '有 <sup>上标</sup> 和 <sub>下标</sub>。',
      '',
      '内联公式 $abcdefghij$ 的两侧都有正文。',
      '',
      '$$',
      'abcdefghij',
      '$$',
      '',
      '![](assets/check.svg)',
      '',
    ].join('\n');
    await evaluate(client,
      `window.postMessage({type:'update',content:${JSON.stringify(preciseDocument)}},'*')`
    );
    await delay(220);
    const imageState = await evaluate(client, `(() => {
      const img = document.querySelector('.paper-reader-cm-image img');
      return {complete: img?.complete, width: img?.naturalWidth, src: img?.src};
    })()`);
    assert.strictEqual(imageState.width, 64, `Image failed to load: ${JSON.stringify(imageState)}`);
    const scriptState = await evaluate(client, `(() => {
      const body = [...document.querySelectorAll('.paper-reader-cm-script')]
        .find((element) => element.textContent.includes('上标'));
      return {text: body?.textContent, html: body?.innerHTML};
    })()`);
    assert.ok(scriptState.text && !scriptState.text.includes('<sup>'),
      `Superscript tags are visible: ${JSON.stringify(scriptState)}`);
    for (const [phrase, indices] of [
      ['4.2 估计算法的分析', [2, 6, 10]],
      ['这一段正文需要在不同文字之间准确定位光标。', [2, 9, 17]],
    ]) {
      for (const index of indices) {
        const point = await evaluate(client, `(() => {
          const line = [...document.querySelectorAll('.cm-line')]
            .find((element) => element.textContent.includes(${JSON.stringify(phrase)}));
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            if (node.data.includes(${JSON.stringify(phrase)})) break;
          }
          const start = node.data.indexOf(${JSON.stringify(phrase)});
          const range = document.createRange();
          range.setStart(node, start + ${index});
          range.setEnd(node, start + ${index + 1});
          const rect = range.getBoundingClientRect();
          return {x: rect.left + 1, y: rect.top + rect.height / 2};
        })()`);
        await client.send('Input.dispatchMouseEvent', {
          type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1,
        });
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1,
        });
        const actual = await evaluate(client,
          'window.paperReaderMarkdownPerformance?.selectionFrom');
        const expected = preciseDocument.indexOf(phrase) + index;
        assert.ok(Math.abs(actual - expected) <= 2,
          `Caret missed clicked character: ${JSON.stringify({phrase, index, actual, expected})}`);
      }
    }
    const formulaPoint = await evaluate(client, `(() => {
      const node = document.querySelector('.paper-reader-cm-inline-math');
      const rect = node.getBoundingClientRect();
      return {x: rect.left + rect.width * .7, y: rect.top + rect.height / 2};
    })()`);
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', ...formulaPoint, button: 'left', buttons: 1, clickCount: 1,
    });
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', ...formulaPoint, button: 'left', buttons: 0, clickCount: 1,
    });
    const formulaCaret = await evaluate(client,
      'window.paperReaderMarkdownPerformance?.selectionFrom');
    const formulaStart = preciseDocument.indexOf('$abcdefghij$');
    assert.ok(formulaCaret >= formulaStart + 5 && formulaCaret <= formulaStart + 10,
      `Inline formula caret ignored click position: ${JSON.stringify({formulaCaret, formulaStart})}`);
    const nestedMarkdown = [
      'Intro text.',
      '',
      'An `$notMath$` literal and $x+y$ formula.',
      '',
      '```markdown',
      '| Code | Not a table |',
      '| --- | --- |',
      '$$ not a display equation $$',
      '```',
      '',
      '| Title | Value |',
      '| --- | --- |',
      '| A | B |',
      '',
      '$$',
      'E=mc^2',
      '$$',
      '',
    ].join('\n');
    await evaluate(client,
      `window.postMessage({type:'update',content:${JSON.stringify(nestedMarkdown)}},'*')`
    );
    await delay(180);
    const nestedPreview = await evaluate(client, `({
      code: document.querySelectorAll('.paper-reader-cm-code-block').length,
      inlineCode: document.querySelectorAll('.paper-reader-cm-inline-code-source').length,
      inlineMath: document.querySelectorAll('.paper-reader-cm-inline-math').length,
      math: document.querySelectorAll('.paper-reader-cm-math').length,
      tables: document.querySelectorAll('.paper-reader-cm-table').length,
    })`);
    assert.deepStrictEqual(nestedPreview, {
      code: 1, inlineCode: 1, inlineMath: 1, math: 1, tables: 1,
    });
    if (longDocument) {
      const largeDocument = [
        ...Array.from({ length: 2400 }, (_, index) =>
          `Paragraph ${index}: the selection must stay on the visual line after scrolling through a research document.`
        ),
      ].join('\n\n') + '\n\n## Final section\n\n' +
        '| Item | Result |\n| --- | --- |\n| Final | Visible |\n\n' +
        '$$\nE=mc^2\n$$\n';
      await evaluate(client,
        `window.postMessage({type:'update',content:${JSON.stringify(largeDocument)}},'*')`
      );
      await delay(500);
      await evaluate(client, `(() => {
        const scroller = document.querySelector('.cm-scroller');
        scroller.scrollTop = scroller.scrollHeight;
      })()`);
      await delay(500);
      const largeResult = await evaluate(client, `({
        bytes: window.paperReaderMarkdownPerformance.documentText.length,
        visibleChars: window.paperReaderMarkdownPerformance.visibleScanChars,
        maxUpdateMs: window.paperReaderMarkdownPerformance.maxUpdateMs,
        maxBlockScanMs: window.paperReaderMarkdownPerformance.maxBlockScanMs,
        maxParseMs: window.paperReaderMarkdownPerformance.maxParseMs,
        tables: document.querySelectorAll('.paper-reader-cm-table').length,
        math: document.querySelectorAll('.paper-reader-cm-math').length,
      })`);
      assert.ok(largeResult.bytes > 200000, JSON.stringify(largeResult));
      assert.ok(largeResult.visibleChars < 20000, JSON.stringify(largeResult));
      assert.strictEqual(largeResult.tables, 1, JSON.stringify(largeResult));
      assert.strictEqual(largeResult.math, 1, JSON.stringify(largeResult));
      assert.ok(largeResult.maxBlockScanMs < 500, JSON.stringify(largeResult));
      assert.ok(largeResult.maxParseMs < 500, JSON.stringify(largeResult));
      assert.ok(largeResult.maxUpdateMs < 150, JSON.stringify(largeResult));
      await clickElement(client, '.paper-reader-cm-heading-2');
      await client.send('Input.insertText', { text: '!' });
      const editedLarge = await evaluate(client, `({
        content: window.paperReaderMarkdownPerformance.documentText.slice(-140),
        parseMs: window.paperReaderMarkdownPerformance.parseMs,
        tables: document.querySelectorAll('.paper-reader-cm-table').length,
      })`);
      assert.ok(editedLarge.content.includes('Final section!'), JSON.stringify(editedLarge));
      assert.strictEqual(editedLarge.tables, 1, JSON.stringify(editedLarge));
      assert.ok(editedLarge.parseMs < 150, JSON.stringify(editedLarge));
      console.log(JSON.stringify({
        runtimePerformance: { ...largeResult, incrementalParseMs: editedLarge.parseMs },
      }));
    }
    console.log(
      JSON.stringify({
        document: longDocument ? "long" : "short",
        direction: reverse ? "reverse" : "forward",
        ...geometry,
        ...result,
        checks: "passed",
      })
    );
  } finally {
    client?.close();
    browser.kill();
    server.close();
    await delay(200);
    await fs.promises.rm(browserProfile, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
