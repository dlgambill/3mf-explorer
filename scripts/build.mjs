// Build the standalone binaries into dist/.
//
//   npm run build                  all four targets
//   npm run build -- win linux     only the ones named (win, mac-arm, mac-intel, linux)
//
// Two steps:
//
// 1. esbuild bundles server.mjs (with lib/ and exceljs) and lib/worker.mjs
//    into CommonJS files under build/, because the packaged runtime loads
//    CommonJS, not ES modules. Every source file's `import.meta.url` is
//    rewritten to point at that file's original location, so paths the app
//    works out from its own folder (public/, recycle.ps1, config.example.json)
//    resolve exactly as they do when you run `node server.mjs`.
//
// 2. @yao-pkg/pkg wraps build/server.cjs in a Node 24 runtime (node:sqlite
//    needs Node 22.13 or newer) together with the assets listed under "pkg"
//    in package.json. It downloads the base runtime for each target the first
//    time, so the first build needs network access. Bytecode is off so every
//    target can be built from any OS.
import { build } from 'esbuild';
import { exec as pkg } from '@yao-pkg/pkg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = 'node24';

const TARGETS = {
  'win':       { target: `${NODE}-win-x64`,     out: '3MF-Explorer-Windows-x64.exe' },
  'mac-arm':   { target: `${NODE}-macos-arm64`, out: '3MF-Explorer-macOS-AppleSilicon' },
  'mac-intel': { target: `${NODE}-macos-x64`,   out: '3MF-Explorer-macOS-Intel' },
  'linux':     { target: `${NODE}-linux-x64`,   out: '3MF-Explorer-Linux-x64' },
};

const asked = process.argv.slice(2);
for (const a of asked) {
  if (!TARGETS[a]) { console.error(`unknown target "${a}" - use: ${Object.keys(TARGETS).join(', ')}`); process.exit(1); }
}
const wanted = asked.length ? asked : Object.keys(TARGETS);

// import.meta.url -> the URL of the original source file, worked out at run
// time from the bundle's own folder (build/ sits one level below the root).
const metaUrl = {
  name: 'meta-url',
  setup(b) {
    b.onLoad({ filter: /\.mjs$/ }, async (args) => {
      const rel = path.relative(ROOT, args.path);
      if (rel.startsWith('..') || rel.includes('node_modules')) return undefined;
      const src = await fs.promises.readFile(args.path, 'utf8');
      const relUrl = JSON.stringify(rel.split(path.sep).join('/'));
      return { contents: src.replaceAll('import.meta.url', `__metaUrl(${relUrl})`), loader: 'js' };
    });
  },
};

console.log('bundling with esbuild...');
fs.rmSync(path.join(ROOT, 'build'), { recursive: true, force: true });
await build({
  absWorkingDir: ROOT,
  entryPoints: { server: 'server.mjs', worker: 'lib/worker.mjs' },
  outdir: 'build',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'warning',
  banner: { js: "const __metaUrl = rel => require('url').pathToFileURL(require('path').join(__dirname, '..', rel)).href;" },
  plugins: [metaUrl],
});

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
for (const name of wanted) {
  const t = TARGETS[name];
  console.log(`\npackaging ${t.out} (${t.target})...`);
  await pkg([
    path.join(ROOT, 'build', 'server.cjs'),
    '--config', path.join(ROOT, 'package.json'),
    '--targets', t.target,
    '--output', path.join(ROOT, 'dist', t.out),
    '--no-bytecode', '--public', '--public-packages', '*',
  ]);
}

console.log('\ndone:');
for (const name of wanted) {
  const f = path.join(ROOT, 'dist', TARGETS[name].out);
  if (fs.existsSync(f)) console.log(`  ${TARGETS[name].out}  ${(fs.statSync(f).size / 1048576).toFixed(1)} MB`);
}
