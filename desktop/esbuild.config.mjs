/**
 * Desktop build: bundles the Electron main process together with the *extension* sources.
 * `vscode` is aliased to the shim, so the desktop app runs the same agent engine and panel.
 */
import { build, context } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * The agent engine lives in the extension sources. Two layouts are supported:
 *   - monorepo/worktree:  <repo>/desktop  +  <repo>/agentcode/src      (this workspace)
 *   - GitHub repo:        <repo>/desktop  +  <repo>/src               (after the zip is uploaded)
 */
const candidates = [path.resolve(here, '..', 'src'), path.resolve(here, '..', 'agentcode', 'src')];
const extensionSrc = candidates.find((dir) => fs.existsSync(path.join(dir, 'extension.ts'))) ?? candidates[0];
console.log(`[desktop] agent sources: ${extensionSrc}`);

/** @type {import('esbuild').Plugin} */
const shimVscode = {
  name: 'vscode-shim',
  setup(build) {
    build.onResolve({ filter: /^vscode$/ }, () => ({ path: path.join(here, 'src', 'vscode-shim.ts') }));
    build.onResolve({ filter: /^@amcode\/extension$/ }, () => ({ path: path.join(extensionSrc, 'extension.ts') }));
  }
};

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  external: ['electron'],
  loader: { '.css': 'text', '.html': 'text', '.wvjs': 'text' },
  plugins: [shimVscode],
  logLevel: 'info'
};

const targets = [
  { ...common, entryPoints: [path.join(here, 'src', 'main.ts')], outfile: path.join(here, 'dist', 'main.js') },
  { ...common, entryPoints: [path.join(here, 'src', 'preload.ts')], outfile: path.join(here, 'dist', 'preload.js') },
  { ...common, entryPoints: [path.join(here, 'src', 'preload-aux.ts')], outfile: path.join(here, 'dist', 'preload-aux.js') }
];

if (process.argv.includes('--watch')) {
  for (const target of targets) {
    const ctx = await context(target);
    await ctx.watch();
  }
  console.log('[desktop] watching…');
} else {
  for (const target of targets) {
    await build(target);
  }
  console.log('[desktop] build done → dist/');
}
