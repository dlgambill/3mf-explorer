// One file's worth of CPU work, off the main thread.
// Hashing and vertex parsing are both CPU-bound, so this is where the
// scan actually gets its parallelism from.
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { read3mf } from './threemf.mjs';
import { readMeshFile } from './stl.mjs';
import { longPath } from './paths.mjs';

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(longPath(file), { highWaterMark: 1 << 20 });
    s.on('data', d => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

const norm = s => (s || '').toString().trim();

async function handle({ file, thumbDir, geomMaxBytes }) {
  const ext = path.extname(file).toLowerCase();
  const st = await fsp.stat(longPath(file));
  const doGeom = !geomMaxBytes || st.size <= geomMaxBytes;

  const row = {
    path: file, name: path.basename(file), ext,
    folder: path.basename(path.dirname(file)),
    size: st.size, mtime: Math.floor(st.mtimeMs),
    sha256: await sha256(file),
    title: '', designer: '', description: '', license: '', copyright: '',
    application: '', created: '', modified: '', print_time: '', filaments: '',
    objects: 0, plates: 0, layer_height: null, nozzle: null,
    geom: null, vcount: 0, tcount: 0, bbox: '', thumb: null,
  };

  if (ext === '.3mf') {
    const m = await read3mf(longPath(file), { wantGeometry: doGeom });
    Object.assign(row, {
      title: norm(m.title), designer: norm(m.designer), description: norm(m.description),
      license: norm(m.license), copyright: norm(m.copyright), application: norm(m.application),
      created: norm(m.created), modified: norm(m.modified), print_time: norm(m.print_time),
      filaments: norm(m.filaments), objects: m.objects | 0, plates: m.plates | 0,
      layer_height: m.layer_height ?? null, nozzle: m.nozzle ?? null,
      geom: m.geom || null, vcount: m.vcount | 0, tcount: m.tcount | 0, bbox: m.bbox || '',
    });
    // Write the thumbnail here so the big buffer never crosses threads.
    if (m.thumbBuf?.length) {
      const tn = row.sha256.slice(0, 16) + '.png';
      try {
        await fsp.writeFile(longPath(path.join(thumbDir, tn)), m.thumbBuf);
        row.thumb = tn;
      } catch {}
    }
  } else if (doGeom) {
    const g = readMeshFile(longPath(file), ext);
    Object.assign(row, {
      geom: g.geom || null, vcount: g.vcount | 0,
      tcount: g.tcount | 0, bbox: g.bbox || '',
    });
  }

  if (!row.title) row.title = path.basename(file, ext);
  return row;
}

parentPort.on('message', async (job) => {
  if (job === null) { parentPort.close(); return; }
  try {
    parentPort.postMessage({ id: job.id, row: await handle(job) });
  } catch (e) {
    parentPort.postMessage({ id: job.id, error: String(e?.message || e) });
  }
});
