"use strict";

const fs = require("fs");
const path = require("path");
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");

pdfjs.GlobalWorkerOptions.workerSrc = require.resolve(
  "pdfjs-dist/legacy/build/pdf.worker.js"
);

function formatPageText(items) {
  return items
    .map((item) => item.str || "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

async function extract(pdfPath) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const document = await pdfjs.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
  }).promise;

  const sections = [
    `# ${path.basename(pdfPath)}`,
    "",
    "> Extracted with the built-in PDF.js fallback. MinerU integration can replace this extractor later.",
    "",
  ];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = formatPageText(content.items);
    if (text) {
      sections.push(`## Page ${pageNumber}`, "", text, "");
    }
  }

  if (process.send) {
    process.send({ ok: true, markdown: sections.join("\n") });
  } else {
    process.stdout.write(sections.join("\n"));
  }
}

extract(process.argv[2]).catch((error) => {
  const message = error && error.stack ? error.stack : String(error);
  if (process.send) {
    process.send({ ok: false, error: message });
  } else {
    process.stderr.write(message);
  }
  process.exit(1);
});
