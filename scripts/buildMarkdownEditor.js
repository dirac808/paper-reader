const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const codiconSource = path.join(
  'node_modules',
  '@vscode',
  'codicons',
  'dist',
);
const codiconTarget = path.join('media', 'markdown', 'codicons');
fs.mkdirSync(codiconTarget, { recursive: true });
for (const file of ['codicon.css', 'codicon.ttf']) {
  fs.copyFileSync(path.join(codiconSource, file), path.join(codiconTarget, file));
}

esbuild.build({
  entryPoints: ['media/markdown/codemirror-entry.js'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  legalComments: 'none',
  outfile: 'media/markdown/codemirror.bundle.js',
}).catch(() => process.exit(1));
