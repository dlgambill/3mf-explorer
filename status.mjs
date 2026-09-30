// node status.mjs - quick look at the index without starting the server.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './lib/db.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const db = openDb(path.join(HERE, 'library.db'));

const t = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(size),0) b FROM files').get();
const e = db.prepare(`SELECT COUNT(*) c FROM (SELECT sha256 FROM files
  WHERE sha256 IS NOT NULL GROUP BY sha256 HAVING COUNT(*)>1)`).get().c;
const g = db.prepare(`SELECT COUNT(*) c FROM (SELECT geom FROM files
  WHERE geom IS NOT NULL AND geom<>'' GROUP BY geom HAVING COUNT(*)>1)`).get().c;
const wasted = db.prepare(`SELECT COALESCE(SUM(b),0) t FROM (
  SELECT SUM(size) - MAX(size) b FROM files WHERE sha256 IS NOT NULL
  GROUP BY sha256 HAVING COUNT(*)>1)`).get().t;

console.log(`${t.c} files indexed, ${(t.b / 1e9).toFixed(1)} GB`);
console.log(`duplicate groups: ${e} byte-identical, ${g} same-geometry`);
console.log(`recoverable from exact duplicates: ${(wasted / 1e9).toFixed(2)} GB`);
console.log('\nby root:');
for (const r of db.prepare(
  'SELECT root, COUNT(*) n, SUM(size) b FROM files GROUP BY root ORDER BY n DESC').all()) {
  console.log(`  ${String(r.root).padEnd(20)} ${String(r.n).padStart(6)}  ${(r.b / 1e9).toFixed(1)} GB`);
}
console.log('\ntop designers:');
for (const r of db.prepare(`SELECT designer, COUNT(*) n FROM files
  WHERE designer <> '' GROUP BY designer ORDER BY n DESC LIMIT 8`).all()) {
  console.log(`  ${String(r.designer).padEnd(24)} ${r.n}`);
}
