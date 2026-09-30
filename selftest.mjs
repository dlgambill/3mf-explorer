import fs from 'node:fs';
import path from 'node:path';
import { read3mf } from './lib/threemf.mjs';
import { readMeshFile } from './lib/stl.mjs';
import { walk, longPath } from './lib/scan.mjs';
import { applyPattern, plan } from './lib/rename.mjs';

// node selftest.mjs "D:\Models\Some Designer"  - any folder with a few .3mf files
const dir = process.argv[2];
if (!dir) { console.error('usage: node selftest.mjs <folder with .3mf files>'); process.exit(1); }

const t0 = Date.now();
const files = [];
for (const f of walk(dir)) { if (f.toLowerCase().endsWith('.3mf')) files.push(f); if (files.length >= 6) break; }
if (!files.length) { console.error('no .3mf files found under ' + dir); process.exit(1); }
console.log('walk found', files.length, 'files\n');

for (const f of files.slice(0, 3)) {
  const m = await read3mf(longPath(f));
  console.log(path.basename(f));
  console.log('   title    :', m.title);
  console.log('   designer :', m.designer || '(empty)');
  console.log('   app      :', m.application);
  console.log('   objects  :', m.objects, ' plates:', m.plates);
  console.log('   layer    :', m.layer_height, ' nozzle:', m.nozzle, ' filament:', m.filaments);
  console.log('   bbox     :', m.bbox, ' tris:', m.tcount, ' verts:', m.vcount);
  console.log('   geom     :', m.geom);
  console.log('   thumb    :', m.thumbBuf ? m.thumbBuf.length + ' bytes' : 'none');
  console.log('');
}

// determinism: same file twice must give the same signature
const a = await read3mf(longPath(files[0]));
const b = await read3mf(longPath(files[0]));
console.log('geometry hash is deterministic:', a.geom === b.geom ? 'YES' : 'NO  <-- PROBLEM');

// rename tokens
const row = { title: 'Sunflower Dragon', designer: 'SomeDesigner', name: 'x.3mf',
  folder: 'Sunflower Dragon', size: 12345678, objects: 3, created: '2024-05-02',
  sha256: 'abcdef1234567890', geom: 'deadbeefcafe', layer_height: 0.2, application: 'BambuStudio-01.09' };
console.log('\npattern {designer} - {title} ({nn}) ->',
  applyPattern('{designer} - {title} ({nn})', row, 4));
console.log('pattern {title}_{layer}_{sha8}   ->',
  applyPattern('{title}_{layer}_{sha8}', row, 0));

console.log('\nelapsed', ((Date.now() - t0) / 1000).toFixed(1) + 's');
