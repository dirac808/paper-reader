const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");

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
            "</head>",
            `<script>window.__paperReaderMessages=[];window.acquireVsCodeApi=()=>({postMessage:(message)=>window.__paperReaderMessages.push(message)});</script></head>`
          );
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(html);
        return;
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
    throw new Error(result.exceptionDetails.text);
  }
  return result.result.value;
};

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
    const documentContent = longDocument
      ? `${Array.from(
          { length: 600 },
          (_, index) => `Paragraph ${index}.`
        ).join(
          "\n\n"
        )}\n\n## Heading title\n\nParagraph below the heading.\n\n${Array.from(
          { length: 600 },
          (_, index) => `Tail paragraph ${index}.`
        ).join("\n\n")}`
      : "# Heading title\n\nParagraph below the heading.\n";
    await evaluate(
      client,
      `window.postMessage({type:'open',content:${JSON.stringify({
        content: documentContent,
        config: { fontSizes: { body: 14, inlineMath: 15, displayMath: 18 } },
      })}},'*')`
    );
    await delay(300);
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
        content: "",
        config: { fontSizes: { body: 14, inlineMath: 15, displayMath: 18 } },
      })}},'*')`
    );
    await delay(250);
    const emptyLine = await evaluate(
      client,
      `(() => {
        const line = document.querySelector('.cm-line');
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
    await evaluate(
      client,
      `document.querySelector('[data-command="heading"]').click()`
    );
    await client.send("Input.insertText", { text: "Typed heading" });
    await delay(100);
    const headingInputResult = await evaluate(
      client,
      `(() => {
        const line = document.querySelector('.cm-line');
        return {
          text: line.textContent,
          underlined: line.classList.contains('paper-reader-cm-heading-underline'),
        };
      })()`
    );
    assert.strictEqual(headingInputResult.text, "Typed heading");
    assert.strictEqual(headingInputResult.underlined, true);
    await evaluate(
      client,
      `document.querySelector('[data-command="heading-underline"]').click()`
    );
    const underlineToggled = await evaluate(
      client,
      `document.querySelector('.cm-line').classList.contains('paper-reader-cm-heading-underline')`
    );
    assert.strictEqual(underlineToggled, false);
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
