import * as esbuild from 'esbuild';
import { mkdirSync } from 'fs';

const watch = process.argv.includes('--watch');

mkdirSync('dist', { recursive: true });
mkdirSync('dist/webview', { recursive: true });

const extensionBuild = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

const cliBuild = {
  entryPoints: ['src/cli/erd-cli.ts'],
  bundle: true,
  outfile: 'dist/cli.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
  banner: {
    js: '#!/usr/bin/env node',
  },
};

const webviewCommon = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  loader: {
    '.css': 'css',
  },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
};

const erdWebviewBuild = {
  ...webviewCommon,
  entryPoints: ['webview/erd-editor/main.tsx'],
  outfile: 'dist/webview/erdEditor.js',
};

const sqlResultsWebviewBuild = {
  ...webviewCommon,
  entryPoints: ['webview/sql-results/main.tsx'],
  outfile: 'dist/webview/sqlResults.js',
};

async function run() {
  if (watch) {
    const extCtx = await esbuild.context(extensionBuild);
    const erdCtx = await esbuild.context(erdWebviewBuild);
    const sqlCtx = await esbuild.context(sqlResultsWebviewBuild);
    const cliCtx = await esbuild.context(cliBuild);
    await Promise.all([extCtx.watch(), erdCtx.watch(), sqlCtx.watch(), cliCtx.watch()]);
    console.log('Watching extension + webviews + cli…');
  } else {
    await Promise.all([
      esbuild.build(extensionBuild),
      esbuild.build(erdWebviewBuild),
      esbuild.build(sqlResultsWebviewBuild),
      esbuild.build(cliBuild),
    ]);
    console.log('Build complete');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
