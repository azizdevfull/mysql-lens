import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(here, 'dist');
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** ssh2 optionally loads native addons inside try/catch; keep them out of the bundle. */
const nativeExternal = {
  name: 'native-external',
  setup(build) {
    build.onResolve({ filter: /\.node$/ }, (args) => ({ path: args.path, external: true }));
  },
};

const common = { bundle: true, minify: production, sourcemap: !production, logLevel: 'info', absWorkingDir: root, nodePaths: [join(root, 'node_modules')] };

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'webview'), { recursive: true });

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: { main: join(here, 'main/main.ts'), preload: join(here, 'main/preload.ts') },
    outdir: out,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron', 'cpu-features'],
    plugins: [nativeExternal],
  }),
  esbuild.context({
    ...common,
    entryPoints: { shell: join(here, 'renderer/shell/main.ts') },
    outdir: out,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
  }),
  esbuild.context({
    ...common,
    entryPoints: {
      grid: join(root, 'webview-ui/grid/main.ts'),
      connection: join(root, 'webview-ui/connection/main.ts'),
      importer: join(root, 'webview-ui/importer/main.ts'),
    },
    outdir: join(out, 'webview'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
  }),
]);

// Static files
const copy = (from, to) => cpSync(from, join(out, to), { recursive: true });
copy(join(here, 'renderer/index.html'), 'index.html');
copy(join(here, 'renderer/theme.css'), 'theme.css');
copy(join(here, 'renderer/monaco-env.js'), 'monaco-env.js');
copy(join(here, 'renderer/monaco-worker.js'), 'monaco-worker.js');
copy(join(here, 'renderer/views'), 'views');
copy(join(here, 'build/icon.png'), 'icon.png');
copy(join(root, 'node_modules/@vscode/codicons/dist/codicon.css'), 'webview/codicon.css');
copy(join(root, 'node_modules/@vscode/codicons/dist/codicon.ttf'), 'webview/codicon.ttf');
copy(join(root, 'webview-ui/common/base.css'), 'webview/base.css');

// Monaco: the editor core plus only the SQL language.
const vs = join(here, 'node_modules/monaco-editor/min/vs');
copy(vs, 'vs');
const langs = join(out, 'vs/basic-languages');
for (const d of readdirSync(langs)) {
  if (d !== 'sql' && !d.endsWith('.js')) rmSync(join(langs, d), { recursive: true, force: true });
}
for (const d of ['language/css', 'language/html', 'language/json', 'language/typescript']) rmSync(join(out, 'vs', d), { recursive: true, force: true });

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
