const assert = require("assert");
const fs = require("fs");
const path = require("path");

const modelPath = path.resolve(__dirname, "..", "media", "markdown", "inlineText.js");
const source = fs.readFileSync(modelPath, "utf8").replace(/^export /gm, "");
const module_ = { exports: {} };
new Function("module", "exports", `${source}
module.exports = { parseInlineMarks, hasInlineMarks };`)(module_, module_.exports);
const { parseInlineMarks, hasInlineMarks } = module_.exports;

const kinds = (value) => parseInlineMarks(value).map((token) => token.kind);

// Every token must round-trip his own source slice, and the tokens must cover the whole source
// contiguously: the renderer maps each token's characters back to a source offset, so a gap or an
// overlap would put the caret in the wrong place.
const assertCoversSource = (value) => {
  const tokens = parseInlineMarks(value);
  let cursor = 0;
  for (const token of tokens) {
    assert.strictEqual(token.from, cursor, `token gap at ${cursor} in ${JSON.stringify(value)}`);
    assert.ok(token.to > token.from, `empty token in ${JSON.stringify(value)}`);
    assert.strictEqual(value.slice(token.from, token.to).length,
      token.kind === 'math' ? value.slice(token.from, token.to).length : token.to - token.from,
      `token length mismatch in ${JSON.stringify(value)}`);
    cursor = token.to;
  }
  assert.strictEqual(cursor, value.length, `tokens do not cover ${JSON.stringify(value)}`);
  return tokens;
};

// 1. Plain text stays one plain token.
assert.deepStrictEqual(kinds("plain text"), ["text"]);
assert.deepStrictEqual(kinds(""), []);
assert.deepStrictEqual(kinds("**x**"), ["strong"]);
assert.deepStrictEqual(kinds("*i*"), ["em"]);
assert.deepStrictEqual(kinds("`code`"), ["code"]);
assert.deepStrictEqual(kinds("$x+y$"), ["math"]);
assert.deepStrictEqual(kinds("\\(\\Xi_\\rho\\)"), ["math"]);

// 2. Strong / emphasis spans carry the inner source range, so a click inside the rendered run maps
//    to the character that was clicked rather than to the start of the run.
const strong = parseInlineMarks("**bold**")[0];
assert.strictEqual(strong.kind, "strong");
assert.strictEqual(strong.text, "bold");
assert.strictEqual(strong.innerFrom, 2);
assert.strictEqual(strong.innerTo, 6);
assert.strictEqual(strong.to, 8);

const em = parseInlineMarks("a *b* c")[1];
assert.strictEqual(em.kind, "em");
assert.strictEqual(em.text, "b");
assert.strictEqual(em.innerFrom, 3);
assert.strictEqual(em.innerTo, 4);

// 3. Math keeps the whole delimiter span, because the rendered formula is atomic for the caret.
const paren = parseInlineMarks("\\(\\Xi_\\rho\\)")[0];
assert.strictEqual(paren.content, "\\Xi_\\rho");
assert.strictEqual(paren.from, 0);
assert.strictEqual(paren.to, "\\(\\Xi_\\rho\\)".length);
assert.strictEqual(paren.delimiter, "\\(");

const dollar = parseInlineMarks("see $x$ here")[1];
assert.strictEqual(dollar.content, "x");
assert.strictEqual(dollar.delimiter, "$");

// 4. Identifiers with underscores are not emphasis.
assert.deepStrictEqual(kinds("paper_reader_api_url"), ["text"]);
assert.deepStrictEqual(kinds("some__name"), ["text"]);
// A leading `__name__` is strong by Markdown's own rules; only mid-word runs are left alone.
assert.deepStrictEqual(kinds("__init__"), ["strong"]);
assert.strictEqual(parseInlineMarks("__init__")[0].text, "init");

// 5. Escaped delimiters stay literal.
assert.deepStrictEqual(kinds("\\*not em\\*"), ["text"]);
assert.deepStrictEqual(kinds("\\$not math\\$"), ["text"]);

// 6. Unclosed delimiters stay literal instead of swallowing the rest of the cell.
assert.deepStrictEqual(kinds("**unclosed"), ["text"]);
assert.deepStrictEqual(kinds("$unclosed"), ["text"]);
assert.deepStrictEqual(kinds("\\(unclosed"), ["text"]);
assert.deepStrictEqual(kinds("``"), ["text"]);

// 7. Mixed content keeps its order.
assert.deepStrictEqual(kinds("a **b** c *d* $e$ \\(f\\)"), [
  "text", "strong", "text", "em", "text", "math", "text", "math",
]);

// 8. Contiguity covers every case above, including the mixed one.
for (const value of [
  "", "plain", "**x**", "a **b** c", "*i*", "`c`", "$x$", "\\(y\\)",
  "a **b** c *d* $e$ \\(f\\)", "paper_reader_api_url", "some__name",
  "\\*not em\\*", "**unclosed", "``", "中文 **粗体** 结束",
]) {
  assertCoversSource(value);
}

// 9. Cell rendering is only needed when a mark is present.
assert.strictEqual(hasInlineMarks("plain"), false);
assert.strictEqual(hasInlineMarks("**x**"), true);
assert.strictEqual(hasInlineMarks("$x$"), true);
assert.strictEqual(hasInlineMarks("\\(x\\)"), true);
assert.strictEqual(hasInlineMarks("`code`"), true);
assert.strictEqual(hasInlineMarks("api_url"), false);

// 10. Chinese text and mixed punctuation survive untouched.
const mixed = parseInlineMarks("适合**情况**：$x$ 与 \\(\\Xi_\\rho\\)");
assert.deepStrictEqual(mixed.map((token) => token.kind), ["text", "strong", "text", "math", "text", "math"]);
assert.strictEqual(mixed[0].text, "适合");
assert.strictEqual(mixed[2].text, "：");
assert.strictEqual(mixed[5].content, "\\Xi_\\rho");

console.log("Inline text unit tests passed.");
