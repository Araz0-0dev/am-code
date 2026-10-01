#!/usr/bin/env node
/**
 * Bundles the TypeScript test suites with esbuild and runs them on plain Node.
 * The agent engine (src/core) is deliberately vscode-free, so the whole agent loop,
 * the tool protocols and both HTTP providers can be tested without launching VS Code.
 */
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const esbuild = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
const suites = ['core.test.ts', 'provider.test.ts', 'mcp.test.ts', 'tokenSaver.test.ts'];

let failed = 0;

// the activation suite loads the bundled extension, so build it first
execFileSync(process.execPath, [path.join(root, 'esbuild.js')], { stdio: 'inherit', cwd: root });
for (const suite of suites) {
  const out = path.join(os.tmpdir(), `agentcode-${suite.replace(/\.ts$/, '')}.js`);
  console.log(`\n▶ ${suite}`);
  execFileSync(
    esbuild,
    [path.join(root, 'test', suite), '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`, '--log-level=warning'],
    { stdio: 'inherit', cwd: root }
  );
  try {
    execFileSync(process.execPath, [out], { stdio: 'inherit', cwd: root });
  } catch {
    failed += 1;
  }
  fs.rmSync(out, { force: true });
}

for (const suite of ['activation.test.js', 'webview.test.js']) {
  console.log(`\n▶ ${suite}`);
  try {
    execFileSync(process.execPath, [path.join(root, 'test', suite)], { stdio: 'inherit', cwd: root });
  } catch {
    failed += 1;
  }
}

if (failed) {
  console.error(`\n✗ ${failed} suite(s) failed`);
  process.exit(1);
}
console.log('\n✓ all suites passed');
