const fs = require('fs');

const viewer = fs.readFileSync('lib/web/viewer.js', 'utf8');
const configStart = viewer.indexOf('function getViewerConfiguration()');
const configEnd = viewer.indexOf('function webViewerLoad()', configStart);
const config = viewer.slice(configStart, configEnd);
const template = fs.readFileSync('src/pdfPreview.ts', 'utf8');
const requiredIds = [
  ...config.matchAll(/getElementById\("([^\"]+)/g),
].map((match) => match[1]);
const presentIds = new Set(
  [...template.matchAll(/id="([^\"]+)/g)].map((match) => match[1])
);

console.log(requiredIds.filter((id) => !presentIds.has(id)));
