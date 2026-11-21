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

const webviewBuild = {
  entryPoints: ['webview/erd-editor/main.tsx'],
  bundle: true,
  outfile: 'dist/webview/erdEditor.js',
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

async function run() {
  if (watch) {
    const extCtx = await esbuild.context(extensionBuild);
    const webCtx = await esbuild.context(webviewBuild);
    const cliCtx = await esbuild.context(cliBuild);
    await Promise.all([extCtx.watch(), webCtx.watch(), cliCtx.watch()]);
    console.log('Watching extension + webview + cli…');
  } else {
    await Promise.all([
      esbuild.build(extensionBuild),
      esbuild.build(webviewBuild),
      esbuild.build(cliBuild),
    ]);
    console.log('Build complete');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
