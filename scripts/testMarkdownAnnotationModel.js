"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

async function loadModel() {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "media", "markdown", "annotationModel.js"),
    "utf8"
  );
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

async function main() {
  const { findAnnotationTextRange } = await loadModel();

  assert.deepStrictEqual(
    findAnnotationTextRange("before selected after", {
      selectedText: "selected",
      textOffset: 7,
    }),
    { start: 7, end: 15 }
  );

  const legacyText = "First line with  extra space\nand a second line.";
  const legacyMatch = findAnnotationTextRange(legacyText, {
    selectedText: "with extra space and a second",
    textOffset: -1,
  });
  assert.deepStrictEqual(legacyMatch, {
    start: legacyText.indexOf("with"),
    end: legacyText.indexOf(" line."),
  });

  const repeated = "alpha target omega; beta target gamma";
  const repeatedMatch = findAnnotationTextRange(repeated, {
    selectedText: "target",
    prefixText: "beta ",
    suffixText: " gamma",
  });
  assert.deepStrictEqual(repeatedMatch, {
    start: repeated.lastIndexOf("target"),
    end: repeated.lastIndexOf("target") + "target".length,
  });

  assert.strictEqual(
    findAnnotationTextRange("unrelated", { selectedText: "missing" }),
    null
  );

  console.log("Markdown annotation model tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
