// Verify documentation links, TOC anchors, and that documented commands exist.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const docs = ["README.md", "CHANGELOG.md", "log.md", "logs/README.md", "THIRD_PARTY_NOTICES.md"];

// GitHub's heading slug: strip punctuation, spaces become dashes, keep CJK.
const slug = (heading) => heading
  .toLowerCase()
  .replace(/`/g, "")
  .replace(/[^\p{L}\p{N}\s-]/gu, "")
  .trim()
  .replace(/\s+/g, "-");

const verifyDocs = () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const headings = [...readme.matchAll(/^#{2,4} (.+)$/gm)].map((m) => m[1]);
  const anchorSet = new Set(headings.map(slug));

  // 1. README's own table of contents must point at real headings.
  const badAnchors = [];
  for (const m of readme.matchAll(/\]\(#([^)]+)\)/g)) {
    if (!anchorSet.has(m[1])) badAnchors.push(m[1]);
  }

  // 2. Every relative link in every doc must exist on disk, and a cross-file anchor must resolve.
  const problems = [];
  let linkCount = 0;
  for (const doc of docs) {
    const docPath = path.join(root, doc);
    if (!fs.existsSync(docPath)) continue;
    const text = fs.readFileSync(docPath, "utf8");
    const dir = path.dirname(docPath);
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [filePart, anchor] = target.split("#");
      if (!filePart) continue; // a same-file anchor, covered by step 1 for README
      linkCount += 1;
      const resolved = path.resolve(dir, filePart);
      if (!fs.existsSync(resolved)) {
        problems.push(`${doc} -> ${target} (missing file)`);
        continue;
      }
      if (anchor && /\.md$/.test(resolved)) {
        const other = fs.readFileSync(resolved, "utf8");
        const otherHeadings = [...other.matchAll(/^#{1,6} (.+)$/gm)].map((x) => slug(x[1]));
        if (!otherHeadings.includes(anchor)) problems.push(`${doc} -> ${target} (missing anchor)`);
      }
    }
  }

  // 3. Documented npm scripts must exist in package.json.
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const scripts = new Set(Object.keys(pkg.scripts || {}));
  const documented = new Set();
  for (const doc of docs) {
    const docPath = path.join(root, doc);
    if (!fs.existsSync(docPath)) continue;
    const text = fs.readFileSync(docPath, "utf8");
    for (const m of text.matchAll(/npm run ([a-z:0-9-]+)/g)) documented.add(m[1]);
    if (/npm test\b/.test(text)) documented.add("test");
  }
  for (const name of documented) {
    if (!scripts.has(name)) problems.push(`npm run ${name} is not in package.json`);
  }

  // 4. Referenced source files must exist.
  for (const doc of docs) {
    const docPath = path.join(root, doc);
    if (!fs.existsSync(docPath)) continue;
    const text = fs.readFileSync(docPath, "utf8");
    for (const m of text.matchAll(/\]\(((?:src|scripts|media)\/[^)#]+)\)/g)) {
      if (!fs.existsSync(path.resolve(root, m[1]))) problems.push(`${doc} -> ${m[1]} (missing source file)`);
    }
  }

  // 5. Markdown structure: balanced code fences, consistent tables. Repeated sub-headings such
  // as `### 验证` under different chapters are normal, so they are not treated as problems.
  const structure = [];
  for (const doc of docs) {
    const docPath = path.join(root, doc);
    if (!fs.existsSync(docPath)) continue;
    const lines = fs.readFileSync(docPath, "utf8").split(/\r?\n/);

    let fence = null;
    let table = null;
    for (const [index, line] of lines.entries()) {
      const fenceMatch = /^\s*(```|~~~)/.exec(line);
      if (fenceMatch) {
        if (!fence) fence = { marker: fenceMatch[1], line: index + 1 };
        else if (fence.marker === fenceMatch[1]) fence = null;
        continue;
      }
      if (fence) continue;
      if (/^\s*\|/.test(line)) {
        const pipes = (line.match(/\|/g) || []).length;
        if (!table) table = { pipes, line: index + 1 };
        else if (pipes !== table.pipes) {
          structure.push(`${doc}: table row at line ${index + 1} has ${pipes} pipes but the table starting at line ${table.line} has ${table.pipes}`);
          table = { pipes, line: index + 1 };
        }
      } else {
        table = null;
      }
    }
    if (fence) structure.push(`${doc}: unclosed code fence opened at line ${fence.line}`);
  }

  // 6. The version must agree everywhere it is stated.
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const stated = {
    "package.json": pkg.version,
    "package-lock.json": lock.version,
    "package-lock root": lock.packages && lock.packages[""] ? lock.packages[""].version : null,
    "README.md": (readme.match(/当前稳定版：`([^`]+)`/) || [])[1],
    "CHANGELOG.md": (fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8").match(/^## (\S+)/m) || [])[1],
  };
  const distinct = new Set(Object.values(stated).filter(Boolean));
  if (distinct.size !== 1) {
    problems.push(`version mismatch: ${JSON.stringify(stated)}`);
  }

  assert.deepStrictEqual(badAnchors, [], `README anchors must resolve: ${badAnchors.join(", ")}`);
  assert.deepStrictEqual(problems, [], `documentation problems:\n  ${problems.join("\n  ")}`);
  assert.deepStrictEqual(structure, [], `markdown structure problems:\n  ${structure.join("\n  ")}`);
  return { anchors: anchorSet.size, links: linkCount, scripts: documented.size, version: [...distinct][0] };
};

if (require.main === module) {
  try {
    const result = verifyDocs();
    console.log(`Documentation checks passed (${result.links} links, ${result.anchors} anchors, ${result.scripts} scripts, version ${result.version}).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { verifyDocs };

