import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { longPath } from './paths.mjs';

// The archive: files you haven't printed in a long time, moved out of the
// way so they stop showing up with everything else. It is just a folder
// (default "_archive" inside the first library folder). Files keep their
// folder structure inside it, so restoring puts them back exactly where
// they were. Because it sits inside a library folder it is still indexed -
// the page hides it unless "Include archive" is ticked - and U1 Print Hub
// skips folders that start with "_", so archived models leave its shelf too.

const key = p => { const x = path.resolve(p).toLowerCase(); return x.endsWith(path.sep) ? x : x + path.sep; };
export const isUnder = (p, dir) => !!p && !!dir && (path.resolve(p).toLowerCase() + path.sep).startsWith(key(dir));

export function archiveDir(cfg) {
  if (cfg.archive) return path.resolve(cfg.archive);
  return cfg.roots?.[0] ? path.join(path.resolve(cfg.roots[0]), '_archive') : null;
}

const holdingRoot = (file, roots) =>
  roots.map(r => path.resolve(r)).sort((a, b) => b.length - a.length).find(r => isUnder(file, r));

// root\Designer\Model\x.3mf -> archive\Designer\Model\x.3mf. A file in a
// second library folder that does not contain the archive keeps that
// folder's name as an extra level, so two roots can't collide.
export function archiveTarget(file, roots, dir) {
  const r = holdingRoot(file, roots);
  if (!r) throw new Error('not inside a library folder');
  const rel = path.relative(r, file);
  return isUnder(dir, r) ? path.join(dir, rel) : path.join(dir, path.basename(r), rel);
}

// Inverse of archiveTarget, for a file with no recorded move to undo. A
// first level named after one of the OTHER library folders goes back there;
// everything else goes back into the folder that holds the archive. (The
// server prefers the recorded original path, so this is the fallback.)
export function restoreTarget(file, roots, dir) {
  const rel = path.relative(dir, file);
  const parent = holdingRoot(dir, roots);
  const [first, ...rest] = rel.split(path.sep);
  const named = roots.map(r => path.resolve(r))
    .find(r => r !== parent && path.basename(r).toLowerCase() === first.toLowerCase());
  if (named && rest.length) return path.join(named, ...rest);
  return path.join(parent || path.resolve(roots[0]), rel);
}

// Move one file, creating folders on the way in and removing the folders
// it leaves empty on the way out (only empty ones - rmdir refuses anything
// else - and never at or above `stopAt`).
export function moveFile(from, to, stopAt, isProtected = () => false, log) {
  if (fs.existsSync(longPath(to))) throw new Error('something already exists at ' + to);
  fs.mkdirSync(longPath(path.dirname(to)), { recursive: true });
  renameOrCopy(from, to, { log });
  pruneEmpty(path.dirname(from), stopAt, isProtected);
}

// E16 (1.7.1): a rename across drives (quarantine folder next to the app,
// library on the NAS) fails with EXDEV. This falls back to copy, verify
// (size, then sha256 of both files), and only then unlink the source. A copy
// that fails verification is removed so there are never two copies, and the
// source is never touched before the copy has been verified. Every step goes
// to `log`. `ops` is the fs surface it uses, so a test can hand in a
// renameSync that throws EXDEV without touching two real drives.
// Returns 'rename' or 'copy' so callers can say which happened.
const sha256File = (p, ops = fs) => {
  const h = crypto.createHash('sha256');
  const fd = ops.openSync(longPath(p), 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = ops.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { ops.closeSync(fd); }
  return h.digest('hex');
};
export function renameOrCopy(from, to, { log = () => {}, ops = fs } = {}) {
  try { ops.renameSync(longPath(from), longPath(to)); return 'rename'; }
  catch (e) { if (e?.code !== 'EXDEV') throw e; }
  log(`cross-device move: rename failed with EXDEV, copying ${from} -> ${to}`);
  ops.copyFileSync(longPath(from), longPath(to), fs.constants.COPYFILE_EXCL);
  try {
    const a = ops.statSync(longPath(from)).size, b = ops.statSync(longPath(to)).size;
    if (a !== b) throw new Error(`size mismatch after copy (${a} vs ${b} bytes)`);
    log(`cross-device move: size verified (${b} bytes)`);
    const ha = sha256File(from, ops), hb = sha256File(to, ops);
    if (ha !== hb) throw new Error('sha256 mismatch after copy');
    log('cross-device move: sha256 verified');
  } catch (e) {
    try { ops.unlinkSync(longPath(to)); } catch {}
    log(`cross-device move: copy removed, source left in place - ${e.message}`);
    throw new Error('cross-device copy failed verification, source left in place: ' + e.message);
  }
  ops.unlinkSync(longPath(from));
  log(`cross-device move: source removed ${from}`);
  return 'copy';
}

// Remove `d` and its parents while they are empty, stopping below `stopAt`.
// audit gap (1.6.1): a protected folder (_templates, tool/_protected_backups,
// or one listed in Settings) is never removed, even when it is empty - the
// Hub expects it to be there. The probe child name covers "folder/**" entries.
export function pruneEmpty(d, stopAt, isProtected = () => false) {
  while (stopAt && isUnder(d, stopAt) && key(d) !== key(stopAt)) {
    if (isProtected(d) || isProtected(path.join(d, '_'))) break;
    try { fs.rmdirSync(longPath(d)); } catch { break; }
    d = path.dirname(d);
  }
}

// --- when was it last printed ---------------------------------------------
// U1 Print Hub records "last printed" per gcode file (printlog.json, per
// printer type) and remembers which 3MF a gcode was sliced from
// (models-links.json, gcode name -> path inside its models folder). Only
// gcodes with a link can be tied to a 3MF - an unlinked print is invisible
// here, so it can only ever make a file look LESS printed, never more.
// Keys are the path inside the library, lower-case, forward slashes, with a
// leading "U1/" dropped so the raw file and its U1 copy share one history.
export const relKey = rel => String(rel || '').replace(/\\/g, '/').toLowerCase().replace(/^u1\//, '');

// E2: the join key is absolute. The Hub's links are relative to ITS models
// folder and Explorer's rel is relative to a library folder; the two only
// line up when both are anchored to the folder they are relative to. The
// folder goes through realpath first, so a mapped drive (X:\_MMF) and the
// share it maps (\\nas\share\_MMF) give the same key.
const realCache = new Map();
export function realDir(d) {
  if (!d) return '';
  const k = path.resolve(String(d));
  if (realCache.has(k)) return realCache.get(k);
  try { const r = fs.realpathSync.native(k); realCache.set(k, r); return r; }
  catch { return k; }   // not cached: an offline share may come back
}
export const absKey = (base, rel) =>
  base ? realDir(base).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() + '/' + relKey(rel) : '';
export const rowKey = r => absKey(r.root, r.rel);

// The Hub's models folder, from its own config.json (models.folder).
export function hubModelsDir(hubDir) {
  try { return JSON.parse(fs.readFileSync(path.join(hubDir, 'config.json'), 'utf8'))?.models?.folder || ''; }
  catch { return ''; }
}

// Map of absKey -> newest print. `.total` is how many distinct files the
// Hub has a linked print for, so the status can say how many of them match.
export function readHubPrints(hubDir, modelsDir = hubDir ? hubModelsDir(hubDir) : '') {
  const out = new Map();
  out.total = 0;
  if (!hubDir || !modelsDir) return out;
  let plog, links;
  try { plog = JSON.parse(fs.readFileSync(path.join(hubDir, 'printlog.json'), 'utf8')); } catch { return out; }
  try { links = JSON.parse(fs.readFileSync(path.join(hubDir, 'models-links.json'), 'utf8')).links || {}; } catch { return out; }
  const flat = Object.values(plog).some(v => typeof v === 'number') ? { u1: plog } : plog;
  for (const [gcode, rel] of Object.entries(links)) {
    let last = 0;
    for (const [slug, m] of Object.entries(flat)) {
      if (slug.startsWith('__') || !m || typeof m !== 'object') continue;
      if (typeof m[gcode] === 'number') last = Math.max(last, m[gcode]);
    }
    if (last) {
      const k = absKey(modelsDir, rel);
      out.set(k, Math.max(out.get(k) || 0, last));
    }
  }
  out.total = out.size;
  return out;
}

// How many of the Hub's printed files match a row here. 0 of N means the
// join is broken (wrong hub.dir, different folder) and archiving is blind.
export function hubLinkStats(prints, rows) {
  const keys = new Set(rows.map(rowKey));
  let matched = 0;
  for (const k of prints.keys()) if (keys.has(k)) matched++;
  return { matched, total: prints.size };
}

// Which rows the monthly run would archive. A file qualifies only when ALL of:
//   - it has been in the library at least `days` (first_seen; a file this app
//     first saw last week has not "gone a year without printing"),
//   - no print of it is recorded in the last `days`, and it has not been
//     opened in a slicer or marked for print from here in that time,
//   - it is not already archived, not protected, not tagged for-print.
export function eligible(rows, { now = Date.now(), days = 365, prints = new Map(), dir, isProtected = () => false }) {
  const cutoff = now - days * 86400000;
  return rows.filter(r => {
    if (!r.first_seen || r.first_seen > cutoff) return false;
    if (isUnder(r.path, dir) || isProtected(r.path)) return false;
    if ((r.tags || []).includes('for-print')) return false;
    const last = Math.max(prints.get(rowKey(r)) || 0, r.last_used || 0);
    return last <= cutoff;
  });
}
