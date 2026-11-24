import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** ssh2 optionally loads native addons inside try/catch; keep them out of the bundle. */
const nativeExternal = {
  name: 'native-external',
  setup(build) {
    build.onResolve({ filter: /\.node$/ }, (args) => ({ path: args.path, external: true }));
  },
};

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode', 'cpu-features'],
    plugins: [nativeExternal],
  }),
  esbuild.context({
    ...common,
    entryPoints: {
      connection: 'webview-ui/connection/main.ts',
      grid: 'webview-ui/grid/main.ts',
      importer: 'webview-ui/importer/main.ts',
    },
    outdir: 'dist/webview',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    loader: { '.css': 'css' },
  }),
]);

mkdirSync('dist/webview', { recursive: true });
cpSync('node_modules/@vscode/codicons/dist/codicon.css', 'dist/webview/codicon.css');
cpSync('node_modules/@vscode/codicons/dist/codicon.ttf', 'dist/webview/codicon.ttf');
cpSync('webview-ui/common/base.css', 'dist/webview/base.css');

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
