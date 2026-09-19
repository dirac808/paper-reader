const esbuild = require('esbuild');

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
