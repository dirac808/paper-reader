const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return {
      workspace: {
        workspaceFolders: undefined,
        getConfiguration() {
          return {
            get(_key, defaultValue) {
              return defaultValue;
            },
          };
        },
      },
      window: {
        showErrorMessage() {},
      },
      Uri: {
        file(fsPath) {
          return { fsPath, path: fsPath.replace(/\\/g, "/") };
        },
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

async function testMissingTranslationRecovery() {
  const { testingHooks } = require("../out/src/deepSeekClient");
  const units = [
    {
      id: "S0",
      text: "First paragraph.",
      restoreInline: (translated) => translated,
    },
    {
      id: "S1",
      text: "Second paragraph.",
      restoreInline: (translated) => translated,
    },
  ];
  let callCount = 0;

  testingHooks.setPostJsonImplementation(
    async (_baseUrl, _path, _apiKey, body) => {
      callCount += 1;
      const requestedUnits = JSON.parse(body.messages[1].content);
      const content =
        callCount === 1
          ? JSON.stringify([{ id: "S0", translation: "第一段。" }])
          : JSON.stringify(
              requestedUnits.map((unit) => ({
                id: unit.id,
                translation: unit.id === "S1" ? "第二段。" : "补译。",
              }))
            );

      return {
        choices: [
          {
            message: {
              content,
            },
          },
        ],
      };
    }
  );

  try {
    const translations = await testingHooks.translateMarkdownUnits(
      units,
      "key",
      "https://example.com",
      "model",
      "Translate.",
      6,
      undefined
    );
    assert.strictEqual(translations.get("S0"), "第一段。");
    assert.strictEqual(translations.get("S1"), "第二段。");
    assert.strictEqual(callCount, 2);
  } finally {
    testingHooks.resetPostJsonImplementation();
  }
}

async function testMaximumTranslationConcurrency() {
  const { testingHooks } = require("../out/src/deepSeekClient");
  const units = Array.from({ length: 25 }, (_item, index) => ({
    id: `S${index}`,
    text: `${index} `.repeat(2500),
    restoreInline: (translated) => translated,
  }));
  let activeRequests = 0;
  let peakRequests = 0;

  testingHooks.setPostJsonImplementation(
    async (_baseUrl, _path, _apiKey, body) => {
      activeRequests += 1;
      peakRequests = Math.max(peakRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeRequests -= 1;

      const requestedUnits = JSON.parse(body.messages[1].content);
      return {
        choices: [
          {
            message: {
              content: JSON.stringify(
                requestedUnits.map((unit) => ({
                  id: unit.id,
                  translation: `translated ${unit.id}`,
                }))
              ),
            },
          },
        ],
      };
    }
  );

  try {
    const translations = await testingHooks.translateMarkdownUnits(
      units,
      "key",
      "https://example.com",
      "model",
      "Translate.",
      20,
      undefined
    );
    assert.strictEqual(translations.size, 25);
    assert.strictEqual(peakRequests, 20);
  } finally {
    testingHooks.resetPostJsonImplementation();
  }
}

async function testMinerUOriginalMarkdownCache() {
  const { testingHooks } = require("../out/src/paperTranslation");
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "paper-reader-cache-test-")
  );
  const pdfPath = path.join(tempRoot, "paper.pdf");
  fs.writeFileSync(pdfPath, "pdf v1");
  const resource = { fsPath: pdfPath, path: pdfPath.replace(/\\/g, "/") };

  const written = await testingHooks.writeSourceOutput(resource, {
    markdown: "# Original\n\nContent.",
    source: "MinerU",
  });
  assert.ok(fs.existsSync(written.sourcePath));

  const cached = await testingHooks.readCachedMinerUMarkdown(resource);
  assert.ok(cached);
  assert.strictEqual(cached.source, "MinerU cache");
  assert.strictEqual(cached.markdown.trim(), "# Original\n\nContent.");

  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.writeFileSync(pdfPath, "pdf v2");
  const stale = await testingHooks.readCachedMinerUMarkdown(resource);
  assert.strictEqual(stale, undefined);
}

async function testMarkdownAnnotationStore() {
  const { NoteStore } = require("../out/src/noteStore");
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "paper-reader-md-note-test-")
  );
  const originalWorkspaceFolders = module.require("vscode").workspace
    .workspaceFolders;
  module.require("vscode").workspace.workspaceFolders = [
    {
      uri: {
        fsPath: tempRoot,
        path: tempRoot.replace(/\\/g, "/"),
      },
    },
  ];

  let store;
  try {
    store = await NoteStore.create({
      globalStoragePath: path.join(tempRoot, "storage"),
      extensionPath: path.resolve(__dirname, ".."),
    });
    const annotation = store.saveMarkdownAnnotation({
      documentUri: "file:///paper.md",
      documentHash: "doc-hash",
      documentTitle: "paper.md",
      selectedText: "Important sentence.",
      prefixText: "Before ",
      suffixText: " After",
      content: "## Note\n\n",
    });

    assert.ok(annotation.id > 0);
    assert.ok(annotation.exportedPath);
    assert.ok(fs.existsSync(annotation.exportedPath));
    assert.ok(
      fs
        .readFileSync(annotation.exportedPath, "utf8")
        .includes("Important sentence.")
    );

    const annotations = store.getMarkdownAnnotations("doc-hash", "paper.md");
    assert.strictEqual(annotations.length, 1);
    assert.strictEqual(annotations[0].selectedText, "Important sentence.");

    fs.unlinkSync(annotation.exportedPath);
    assert.strictEqual(
      store.getMarkdownAnnotations("doc-hash", "paper.md").length,
      0
    );
  } finally {
    if (store) store.dispose();
    module.require(
      "vscode"
    ).workspace.workspaceFolders = originalWorkspaceFolders;
  }
}

function testMinimalTextChanges() {
  const {
    computeMinimalTextChange,
    normalizeLineEndings,
  } = require("../out/src/textChange");
  const cases = [
    ["abc", "abXc"],
    ["abc", "ac"],
    ["abc", "xyz"],
    ["content", ""],
    ["", "content"],
    ["same", "same"],
  ];
  for (const [current, next] of cases) {
    const change = computeMinimalTextChange(current, next);
    if (!change) {
      assert.strictEqual(current, next);
      continue;
    }
    const applied =
      current.slice(0, change.start) + change.text + current.slice(change.end);
    assert.strictEqual(applied, next);
  }

  const large = `${"a".repeat(500000)}old${"z".repeat(500000)}`;
  const next = `${"a".repeat(500000)}new${"z".repeat(500000)}`;
  const change = computeMinimalTextChange(large, next);
  assert.deepStrictEqual(change, { start: 500000, end: 500003, text: "new" });

  const currentCrlf = "first\r\nsecond\r\nthird\r\n";
  const nextCrlf = normalizeLineEndings(
    "first\nupdated second\nthird\n",
    "\r\n"
  );
  const crlfChange = computeMinimalTextChange(currentCrlf, nextCrlf);
  assert.ok(crlfChange);
  assert.strictEqual(
    currentCrlf.slice(0, crlfChange.start) +
      crlfChange.text +
      currentCrlf.slice(crlfChange.end),
    nextCrlf
  );
}

function testBoundedProcessLog() {
  const { testingHooks } = require("../out/src/paperTranslation");
  let log = "";
  for (let index = 0; index < 400; index += 1) {
    log = testingHooks.appendBoundedLog(
      log,
      `${String(index).padStart(3, "0")}:` + "x".repeat(1024) + "\n"
    );
  }
  assert.ok(log.length <= 256 * 1024);
  assert.ok(log.includes("399:"));
  assert.ok(!log.includes("000:" + "x".repeat(100)));
}

async function testTranslationCancellation() {
  const { testingHooks } = require("../out/src/deepSeekClient");
  let cancelled = false;
  const listeners = new Set();
  const token = {
    get isCancellationRequested() {
      return cancelled;
    },
    onCancellationRequested(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  testingHooks.setPostJsonImplementation(
    async (_baseUrl, _path, _apiKey, _body, cancellation) =>
      new Promise((_resolve, reject) => {
        cancellation.onCancellationRequested(() =>
          reject(new Error("cancelled"))
        );
      })
  );
  const units = Array.from({ length: 8 }, (_item, index) => ({
    id: `S${index}`,
    text: `${index} `.repeat(2500),
    restoreInline: (translated) => translated,
  }));
  const pending = testingHooks.translateMarkdownUnits(
    units,
    "key",
    "https://example.com",
    "model",
    "Translate.",
    4,
    undefined,
    token
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  cancelled = true;
  for (const listener of Array.from(listeners)) listener();
  await assert.rejects(pending, /cancel/i);
  testingHooks.resetPostJsonImplementation();
}

function testNormalizeMarkdownMathDelimiters() {
  const {
    normalizeMarkdownMathDelimiters,
  } = require("../out/src/markdownCleanup");
  const input = [
    "# Paper",
    "",
    "\\[",
    "a+b=c",
    "\\]",
    "",
    "Text",
    "",
    "  \\[ x = y \\]",
    "",
    "```md",
    "\\[",
    "do not touch",
    "\\]",
    "```",
  ].join("\n");

  const result = normalizeMarkdownMathDelimiters(input);
  assert.strictEqual(result.changedBlocks, 2);
  assert.ok(result.markdown.includes("$$\na+b=c\n$$"));
  assert.ok(result.markdown.includes("  $$\nx = y\n  $$"));
  assert.ok(result.markdown.includes("```md\n\\[\ndo not touch\n\\]\n```"));

  const crlf = "\\[\r\nz\r\n\\]\r\n";
  const crlfResult = normalizeMarkdownMathDelimiters(crlf);
  assert.strictEqual(crlfResult.markdown, "$$\r\nz\r\n$$\r\n");
}

async function main() {
  await testMissingTranslationRecovery();
  await testMaximumTranslationConcurrency();
  await testMinerUOriginalMarkdownCache();
  await testMarkdownAnnotationStore();
  testMinimalTextChanges();
  testBoundedProcessLog();
  await testTranslationCancellation();
  testNormalizeMarkdownMathDelimiters();
  console.log("Unit tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
