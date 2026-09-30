// Ground-truth check: does the chunked/streamed scan see exactly the same
// tokens as reading the whole entry into memory in one go?
import path from 'node:path';
import { openZip, readEntry } from './lib/zip.mjs';
import { read3mf } from './lib/threemf.mjs';
import { walk, longPath } from './lib/scan.mjs';

const TOKEN_RE = /<vertex[^>]*\sx="([-\d.eE+]+)"[^>]*\sy="([-\d.eE+]+)"[^>]*\sz="([-\d.eE+]+)"|<triangle\b/g;

// node verify.mjs "D:\Models"  - checks the first eight .3mf files it finds there
const dir = process.argv[2];
if (!dir) { console.error('usage: node verify.mjs <folder with .3mf files>'); process.exit(1); }

const files = [];
for (const f of walk(dir)) { if (f.toLowerCase().endsWith('.3mf')) files.push(f); if (files.length >= 8) break; }

let bad = 0;
for (const f of files) {
  // truth: whole entry in memory, single scan, no chunk boundaries at all
  const zip = await openZip(longPath(f));
  const names = ['3D/3dmodel.model',
    ...[...zip.entries.keys()].filter(k => /^3D\/Objects\/.*\.model$/i.test(k))];
  let tv = 0, tt = 0;
  for (const n of names) {
    const buf = await readEntry(zip, n);
    if (!buf) continue;
    const s = buf.toString('latin1');
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(s)) !== null) { if (m[1] !== undefined) tv++; else tt++; }
  }

  const got = await read3mf(longPath(f));
  const ok = tv === got.vcount && tt === got.tcount;
  if (!ok) bad++;
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${path.basename(f).slice(0, 46).padEnd(46)} ` +
              `verts ${got.vcount}/${tv}  tris ${got.tcount}/${tt}`);
}
console.log(bad ? `\n${bad} MISMATCH(ES) - streaming is losing tokens`
                : '\nAll match: streamed counts equal whole-file counts.');
