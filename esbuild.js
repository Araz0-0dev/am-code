const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const base = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  loader: {
    '.html': 'text',
    '.css': 'text',
    '.wvjs': 'text'
  }
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(base);
    await ctx.watch();
    console.log('[esbuild] watching…');
    return;
  }
  await esbuild.build(base);
  console.log(`[esbuild] ${production ? 'production' : 'dev'} build done → dist/extension.js`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
