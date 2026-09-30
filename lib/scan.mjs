import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { longPath } from './paths.mjs';

export { longPath };

export const EXTS = new Set(['.3mf', '.stl', '.obj']);
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.profile', 'AppData', '$RECYCLE.BIN',
  'System Volume Information', '.thumb-cache', '_quarantine',
  '__MACOSX',
]);

export function* walk(root, depth = 0) {
  if (depth > 24) return;
  let entries;
  try { entries = fs.readdirSync(longPath(root), { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.isDirectory()) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    // AppleDouble sidecars: 4 KB of resource fork wearing a .3mf extension.
    if (e.name.startsWith('._')) continue;
    const p = path.join(root, e.name);
    if (e.isDirectory()) yield* walk(p, depth + 1);
    else if (EXTS.has(path.extname(e.name).toLowerCase())) yield p;
  }
}

const COLS = ['path','root','rel','folder','name','ext','size','mtime','sha256','geom',
  'vcount','tcount','bbox','title','designer','description','license','copyright',
  'application','created','modified','objects','plates','layer_height','nozzle',
  'filaments','print_time','thumb','indexed_at','search'];

// A packaged binary runs a pre-bundled CommonJS copy of the worker
// (build/worker.cjs, made by scripts/build.mjs); plain `node` runs the source.
const WORKER = process.pkg
  ? fileURLToPath(new URL('../build/worker.cjs', import.meta.url))
  : fileURLToPath(new URL('./worker.mjs', import.meta.url));

export async function scan(db, roots, thumbDir,
                           { concurrency = 0, onProgress, geometryMaxMB = 0 } = {}) {
  const geomMaxBytes = (geometryMaxMB || 0) * 1024 * 1024;
  fs.mkdirSync(longPath(thumbDir), { recursive: true });

  const known = new Map();
  for (const r of db.prepare('SELECT path,size,mtime FROM files').all()) known.set(r.path, r);

  // Walk first so we know the size of the job and can skip unchanged files
  // without paying a worker round-trip for them.
  const jobs = [];
  const seen = new Set();
  let skipped = 0;
  for (const root of roots) {
    if (!fs.existsSync(longPath(root))) continue;
    for (const file of walk(root)) {
      seen.add(file);
      let st;
      try { st = fs.statSync(longPath(file)); } catch { continue; }
      const prev = known.get(file);
      if (prev && prev.size === st.size && prev.mtime === Math.floor(st.mtimeMs)) {
        skipped++;
        continue;
      }
      jobs.push({ file, root });
    }
  }

  const nWorkers = Math.max(1, concurrency || Math.min(12, Math.max(2, os.cpus().length - 2)));
  const stats = { total: jobs.length + skipped, done: skipped, added: 0, updated: 0,
                  skipped, failed: 0, removed: 0, workers: nWorkers, errors: [] };
  const noteError = (file, msg) => {
    stats.failed++;
    if (stats.errors.length < 400) stats.errors.push({ file, error: String(msg).slice(0, 160) });
  };

  const upsert = db.prepare(`
    INSERT INTO files (${COLS.join(',')})
    VALUES (${COLS.map(() => '?').join(',')})
    ON CONFLICT(path) DO UPDATE SET
      ${COLS.filter(c => c !== 'path').map(c => `${c}=excluded.${c}`).join(',')}
  `);

  const commit = (row, job) => {
    row.root = job.root;
    row.rel = path.relative(job.root, row.path);
    row.indexed_at = Date.now();
    row.search = [row.name, row.title, row.designer, row.description,
      row.folder, row.rel, row.license, row.application, row.filaments]
      .join(' ').toLowerCase();
    upsert.run(...COLS.map(c => row[c] ?? null));
    known.has(row.path) ? stats.updated++ : stats.added++;
  };

  // --- worker pool: DB writes stay on this thread, CPU work goes out ---
  // A worker can die on a malformed file. When that happens we requeue its
  // job, retry it once, and replace the worker, so one bad archive costs a
  // single row instead of the rest of the scan.
  if (jobs.length) {
    await new Promise((resolve) => {
      const queue = jobs.map((_, i) => i);
      const attempts = new Array(jobs.length).fill(0);
      const assigned = new Map(); // worker -> job index
      let pending = jobs.length;
      let finished = 0;
      let workers = 0;

      const settle = () => { if (pending <= 0) resolve(); };

      const feed = (w) => {
        const id = queue.shift();
        if (id === undefined) { assigned.delete(w); w.postMessage(null); return; }
        assigned.set(w, id);
        w.postMessage({ id, file: jobs[id].file, thumbDir, geomMaxBytes });
      };

      const spawnWorker = () => {
        const w = new Worker(WORKER);
        workers++;
        w.on('message', (msg) => {
          assigned.delete(w);
          if (msg.error) noteError(jobs[msg.id]?.file, msg.error);
          else {
            try { commit(msg.row, jobs[msg.id]); }
            catch (e) { noteError(jobs[msg.id]?.file, 'db: ' + (e.message || e)); }
          }
          pending--; stats.done++; finished++;
          if (onProgress && finished % 25 === 0) onProgress(stats);
          settle();
          feed(w);
        });
        w.on('error', () => {}); // handled on exit, where we know the job
        w.on('exit', () => {
          workers--;
          const id = assigned.get(w);
          assigned.delete(w);
          if (id !== undefined) {
            // died mid-job
            if (++attempts[id] < 2) queue.push(id);
            else {
              pending--; stats.done++;
              noteError(jobs[id]?.file, 'worker died twice on this file');
              settle();
            }
            if (queue.length && workers < nWorkers) spawnWorker();
          }
          if (workers === 0) settle();
        });
        feed(w);
      };

      for (let i = 0; i < Math.min(nWorkers, jobs.length); i++) spawnWorker();
      if (!jobs.length) resolve();
    });
  }

  // Drop rows whose files are gone - but ONLY within the roots we just
  // walked. Scanning one folder must never prune the rest of the library.
  const scanned = roots.map(r => path.resolve(r).toLowerCase());
  const inScope = p => {
    const lp = path.resolve(p).toLowerCase();
    return scanned.some(r => lp === r || lp.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
  };
  const del = db.prepare('DELETE FROM files WHERE path=?');
  for (const p of known.keys()) {
    if (!seen.has(p) && inScope(p)) { del.run(p); stats.removed++; }
  }

  if (onProgress) onProgress(stats);
  return stats;
}
