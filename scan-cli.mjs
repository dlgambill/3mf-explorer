// node scan-cli.mjs            - scan every root in config.json
// node scan-cli.mjs "D:\Models" - scan just one folder
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, setMeta } from './lib/db.mjs';
import { scan } from './lib/scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
const db = openDb(path.join(HERE, 'library.db'));

const roots = process.argv.slice(2).length ? process.argv.slice(2) : cfg.roots;
console.log('roots:');
for (const r of roots) console.log('  ' + r);

const t0 = Date.now();
let lastLine = 0;
const s = await scan(db, roots, path.join(HERE, '.thumb-cache'), {
  concurrency: cfg.concurrency || 8,
  geometryMaxMB: cfg.geometryMaxMB || 0,
  exts: cfg.fileTypes,
  onProgress: st => {
    const now = Date.now();
    if (now - lastLine < 2000) return;
    lastLine = now;
    const pct = st.total ? ((st.done / st.total) * 100).toFixed(1) : '0.0';
    const rate = st.done / Math.max(1, (now - t0) / 1000);
    const left = rate > 0 ? Math.round((st.total - st.done) / rate) : 0;
    console.log(`  ${st.done}/${st.total} (${pct}%)  +${st.added} new  ~${st.updated} upd  ` +
                `=${st.skipped} same  !${st.failed} err  eta ${Math.floor(left / 60)}m${left % 60}s`);
  },
});
setMeta(db, 'last_scan', Date.now());

const secs = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\ndone in ${Math.floor(secs / 60)}m${secs % 60}s`);
console.log(`  added ${s.added}, updated ${s.updated}, unchanged ${s.skipped}, ` +
            `failed ${s.failed}, removed ${s.removed}`);

if (s.errors?.length) {
  // group by message so 200 failures do not become 200 lines
  const by = new Map();
  for (const e of s.errors) {
    if (!by.has(e.error)) by.set(e.error, []);
    by.get(e.error).push(e.file);
  }
  console.log('\nfailures by cause:');
  for (const [msg, files] of [...by.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(files.length).padStart(4)}  ${msg}`);
    for (const f of files.slice(0, 3)) console.log(`        e.g. ${f}`);
  }
  fs.writeFileSync(path.join(HERE, '_scan-errors.json'), JSON.stringify(s.errors, null, 1));
  console.log(`\n  full list -> _scan-errors.json`);
}

const tot = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(size),0) b FROM files').get();
const dupE = db.prepare(`SELECT COUNT(*) c FROM (SELECT sha256 FROM files
  WHERE sha256 IS NOT NULL GROUP BY sha256 HAVING COUNT(*)>1)`).get().c;
const dupG = db.prepare(`SELECT COUNT(*) c FROM (SELECT geom FROM files
  WHERE geom IS NOT NULL AND geom<>'' GROUP BY geom HAVING COUNT(*)>1)`).get().c;
console.log(`  library: ${tot.c} files, ${(tot.b / 1e9).toFixed(1)} GB`);
console.log(`  duplicate groups: ${dupE} byte-identical, ${dupG} same-geometry`);
