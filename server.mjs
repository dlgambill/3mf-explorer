#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb, getMeta, setMeta } from './lib/db.mjs';
import { scan, longPath, EXTS, normExts } from './lib/scan.mjs';
import * as ren from './lib/rename.mjs';
import * as ct from './lib/cleanTitle.mjs';
import * as xl from './lib/xlsx.mjs';
import { makeProtector, normProtected } from './lib/protect.mjs';

// HERE is where the app's own files are (public/, recycle.ps1). DATA is where
// config.json, library.db and .thumb-cache live: next to server.mjs when run
// with `node server.mjs`, next to the executable when run as a packaged
// binary (the binary's bundled files are read-only).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGED = !!process.pkg;
const DATA = PACKAGED ? path.dirname(process.execPath) : HERE;
const CFG_PATH = path.join(DATA, 'config.json');

// First run: no config.json yet, so write one from config.example.json (or
// from these built-in defaults if the example is missing) instead of crashing.
if (!fs.existsSync(CFG_PATH)) {
  let text;
  try { text = fs.readFileSync(path.join(HERE, 'config.example.json'), 'utf8'); }
  catch {
    text = JSON.stringify({ port: 7333, roots: [], quarantine: '', concurrency: 0,
      geometryMaxMB: 0, openWith: [], hub: { url: 'http://127.0.0.1:4545', token: '' } }, null, 2) + '\n';
  }
  fs.writeFileSync(CFG_PATH, text, 'utf8');
  console.log('  Created ' + CFG_PATH + ' - add your model folders to "roots" there, then restart.');
}
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
cfg.roots = Array.isArray(cfg.roots) ? cfg.roots : [];
// Rebuilt whenever Settings saves the list. See lib/protect.mjs.
let isProtected = makeProtector(cfg.protected);
const PROTECTED_MSG = 'protected in Settings - this app never moves, renames or deletes it';

// Append-only audit trail of everything this app deletes or quarantines,
// one line per file, so "who deleted this?" is a grep, not forensics.
const ACTIONS_LOG = path.join(DATA, '_actions-log.txt');
const logAction = (action, file, extra = '') => {
  try { fs.appendFileSync(ACTIONS_LOG, `${new Date().toISOString()}\t${action}\t${file}${extra ? '\t' + extra : ''}\n`, 'utf8'); }
  catch {}
};
const THUMBS = path.join(DATA, '.thumb-cache');
const db = openDb(path.join(DATA, 'library.db'));

let scanState = { running: false, total: 0, done: 0, added: 0, updated: 0,
                  skipped: 0, failed: 0, removed: 0, startedAt: null, finishedAt: null };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8' };

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  const b = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(b);
};

const readBody = req => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', c => { s += c; if (s.length > 8e6) req.destroy(); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});

// Binary body reader, for the uploaded .xlsx on import - readBody above
// assumes JSON text, which would corrupt a spreadsheet's bytes.
const readRawBody = (req, maxBytes = 50e6) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > maxBytes) { req.destroy(); return reject(new Error('file too large')); }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

// Your edits win over whatever the file says, but the file's own values stay
// intact underneath so clearing an override falls back to them.
const ROW_SELECT = `
  SELECT f.id, f.path, f.root, f.rel, f.folder, f.name, f.ext, f.size, f.mtime,
         f.sha256, f.geom, f.vcount, f.tcount, f.bbox,
         COALESCE(NULLIF(o.title,''),    f.title)    AS title,
         COALESCE(NULLIF(o.designer,''), f.designer) AS designer,
         COALESCE((SELECT group_concat(tag, ', ')
                   FROM (SELECT tag FROM file_tags WHERE sha256 = f.sha256
                         ORDER BY tag)), '')         AS tagstr,
         f.description, f.license, f.copyright, f.application,
         f.created, f.modified, f.objects, f.plates,
         f.layer_height, f.nozzle, f.filaments, f.print_time, f.thumb
  FROM files f LEFT JOIN overrides o ON o.sha256 = f.sha256`;

function dupeGroups() {
  const exact = db.prepare(`
    SELECT sha256 k, COUNT(*) n, SUM(size) bytes FROM files
    WHERE sha256 IS NOT NULL GROUP BY sha256 HAVING n > 1`).all();
  const geom = db.prepare(`
    SELECT geom k, COUNT(*) n, SUM(size) bytes, COUNT(DISTINCT sha256) variants FROM files
    WHERE geom IS NOT NULL AND geom <> '' GROUP BY geom HAVING n > 1`).all();

  const byExact = new Set(exact.map(r => r.k));
  const groups = [];
  for (const g of exact) {
    const files = db.prepare(`${ROW_SELECT} WHERE f.sha256=? ORDER BY f.path`).all(g.k);
    groups.push({ kind: 'exact', key: g.k, count: g.n,
      wasted: g.bytes - (files[0]?.size || 0), files });
  }
  for (const g of geom) {
    // if every member is also byte-identical it's already covered above
    if (g.variants === 1) {
      const one = db.prepare('SELECT sha256 FROM files WHERE geom=? LIMIT 1').get(g.k);
      if (one && byExact.has(one.sha256)) continue;
    }
    const files = db.prepare(`${ROW_SELECT} WHERE f.geom=? ORDER BY f.path`).all(g.k);
    groups.push({ kind: 'geometry', key: g.k, count: g.n,
      wasted: g.bytes - (files[0]?.size || 0), files });
  }
  groups.sort((a, b) => b.wasted - a.wasted);
  return groups;
}

// ---- library folders and file types ------------------------------------
// The index only ever holds files of the chosen types (cfg.fileTypes)
// inside the configured library folders (cfg.roots). This drops every other
// row and re-points root/rel on the rest at the folder that now holds them,
// so changing either setting (Settings tab, or a hand edit of config.json)
// never leaves stale rows behind. Only index rows change - nothing on disk
// is touched, and titles, designers and tags survive because they are keyed
// by sha256, not by path.
const rootKey = r => { const p = path.resolve(r).toLowerCase(); return p.endsWith(path.sep) ? p : p + path.sep; };

function reconcileRoots(roots = cfg.roots, types = normExts(cfg.fileTypes)) {
  if (!roots.length) return { removed: 0, repointed: 0 }; // never empty the index on a blank config
  const rs = roots.map(r => ({ r: path.resolve(r), k: rootKey(r) }))
    .sort((a, b) => b.k.length - a.k.length); // innermost folder wins
  const rows = db.prepare('SELECT id, path, root, rel, ext FROM files').all();
  const del = db.prepare('DELETE FROM files WHERE id=?');
  const upd = db.prepare('UPDATE files SET root=?, rel=? WHERE id=?');
  let removed = 0, repointed = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const ext = (row.ext || path.extname(row.path)).toLowerCase();
      if (!types.has(ext) || isProtected(row.path)) { del.run(row.id); removed++; continue; }
      const lp = path.resolve(row.path).toLowerCase();
      const hit = rs.find(x => lp.startsWith(x.k));
      if (!hit) { del.run(row.id); removed++; continue; }
      const rel = path.relative(hit.r, row.path);
      if (row.root !== hit.r || row.rel !== rel) { upd.run(hit.r, rel, row.id); repointed++; }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { removed, repointed };
}

// Validate, save to config.json, apply live, then rescan. config.json is
// re-read from disk (so hand-added keys like _note survive), backed up to
// config.json.bak, and replaced atomically via a temp file + rename.
function saveSettings(body) {
  if (scanState.running) throw new Error('A scan is running - try again when it finishes.');
  const isAbs = p => path.isAbsolute(p) && !/^[\\/](?![\\/])/.test(p); // "\foo" has no drive
  const isDir = p => { try { return fs.statSync(longPath(p)).isDirectory(); } catch { return false; } };

  const raw = Array.isArray(body?.roots) ? body.roots : [];
  const roots = [];
  for (const r of raw.map(x => String(x).trim()).filter(Boolean)) {
    if (!isAbs(r)) throw new Error(`"${r}" isn't a full path - use something like D:\\3D Models`);
    if (!isDir(r)) throw new Error(`Can't find the folder "${r}"`);
    const abs = path.resolve(r);
    if (!roots.some(x => rootKey(x) === rootKey(abs))) roots.push(abs);
  }
  if (!roots.length) throw new Error('Add at least one library folder.');
  for (const a of roots) for (const b of roots) {
    if (a !== b && rootKey(a).startsWith(rootKey(b)))
      throw new Error(`"${a}" is already inside "${b}" - list just one of them.`);
  }

  let quarantine = String(body?.quarantine ?? '').trim();
  if (quarantine) {
    if (!isAbs(quarantine)) throw new Error(`Quarantine "${quarantine}" isn't a full path`);
    quarantine = path.resolve(quarantine);
    // The scanner skips folders named _quarantine; any other name inside a
    // library folder would get indexed right back.
    const inside = roots.find(r => rootKey(quarantine).startsWith(rootKey(r)));
    if (inside && path.basename(quarantine).toLowerCase() !== '_quarantine')
      throw new Error(`The quarantine folder can't be inside a library folder unless it's named _quarantine.`);
  }

  // File types: a subset of what the parsers read. Left out of the request
  // (an older page) means keep the current choice.
  let fileTypes = [...normExts(cfg.fileTypes)];
  if (Array.isArray(body?.fileTypes)) {
    const asked = body.fileTypes.map(x => String(x).trim().toLowerCase().replace(/^\.?/, '.'));
    const bad = asked.filter(x => !EXTS.has(x));
    if (bad.length) throw new Error(`Unknown file type ${bad.join(', ')} - choose from ${[...EXTS].join(', ')}`);
    if (!asked.length) throw new Error('Pick at least one file type.');
    fileTypes = [...EXTS].filter(x => asked.includes(x)); // canonical order
  }

  // Protected files: left out of the request means keep the current list.
  let prot = normProtected(cfg.protected);
  if (Array.isArray(body?.protected)) {
    for (const s of body.protected.map(x => String(x).trim()).filter(Boolean)) {
      if (/[\\/]/.test(s) && !isAbs(s))
        throw new Error(`Protected "${s}" - use a full path (D:\\Models\\tool) or just a file name (template*.3mf)`);
    }
    prot = normProtected(body.protected);
  }

  const onDisk = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  onDisk.roots = roots;
  onDisk.fileTypes = fileTypes;
  onDisk.protected = prot;
  onDisk.quarantine = quarantine;
  fs.copyFileSync(CFG_PATH, CFG_PATH + '.bak');
  const tmp = CFG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(onDisk, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CFG_PATH);

  cfg.roots = roots;
  cfg.fileTypes = fileTypes;
  cfg.protected = prot;
  isProtected = makeProtector(prot);
  cfg.quarantine = quarantine;
  const r = reconcileRoots(roots, new Set(fileTypes));
  startScan();
  return { ok: true, roots, fileTypes, protected: prot, quarantine, ...r };
}

async function startScan() {
  if (scanState.running) return;
  const roots = cfg.roots || [];
  try { reconcileRoots(roots); } catch (e) { console.error('reconcile:', e.message); }
  scanState = { running: true, total: 0, done: 0, added: 0, updated: 0, skipped: 0,
                failed: 0, removed: 0, startedAt: Date.now(), finishedAt: null };
  try {
    const s = await scan(db, roots, THUMBS, {
      concurrency: cfg.concurrency || 8,
      geometryMaxMB: cfg.geometryMaxMB || 0,
      exts: cfg.fileTypes,
      isProtected,
      onProgress: st => Object.assign(scanState, st),
    });
    Object.assign(scanState, s);
    setMeta(db, 'last_scan', Date.now());
  } catch (e) {
    scanState.error = String(e.message || e);
  } finally {
    scanState.running = false;
    scanState.finishedAt = Date.now();
  }
}

// Shared by /api/edit + /api/tags and the xlsx import handler below, so a
// spreadsheet round-trip changes data the exact same way a manual edit does.
function applyFieldEdit(field, ids, value) {
  const val = String(value ?? '').trim().slice(0, 300);
  const get = db.prepare('SELECT sha256 FROM files WHERE id=?');
  const shas = [...new Set(ids.map(id => get.get(id)?.sha256).filter(Boolean))];
  if (!shas.length) return 0;
  const up = db.prepare(`
    INSERT INTO overrides (sha256, ${field}, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(sha256) DO UPDATE SET ${field}=excluded.${field},
                                      updated_at=excluded.updated_at`);
  for (const s of shas) up.run(s, val, Date.now());
  return shas.length;
}

// The print-request pipeline. Someone marks 3MFs "for print" here; this app
// tags them locally (so the existing tag filter doubles as a history of what
// was asked for) and forwards each one to the U1 Print Hub's own server,
// which cross-references its gcode folder and auto-queues a Dispatch job
// when a match already exists.
// Server-to-server on purpose - a shared secret (cfg.hub.token), not a
// browser session, since Explorer and the Hub don't share a login.
async function forwardToHub(rows) {
  const hub = cfg.hub || {};
  if (!hub.url) return { ok: false, reason: 'no hub.url configured' };
  const base = String(hub.url).replace(/\/+$/, '');
  const results = [];
  for (const r of rows) {
    try {
      const resp = await fetch(base + '/api/models/print-request', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-u1-token': hub.token || '' },
        body: JSON.stringify({ path: r.path, sha256: r.sha256, designer: r.designer, title: r.title || r.name }),
      });
      const j = await resp.json().catch(() => ({}));
      results.push({ id: r.id, path: r.path, ok: resp.ok, status: resp.status, ...j });
    } catch (e) { results.push({ id: r.id, path: r.path, ok: false, error: String(e.message || e) }); }
  }
  return { ok: true, results };
}

function applyTagSet(ids, list) {
  const clean = t => String(t).trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
  const get = db.prepare('SELECT sha256 FROM files WHERE id=?');
  const shas = [...new Set(ids.map(id => get.get(id)?.sha256).filter(Boolean))];
  if (!shas.length) return 0;
  const add = db.prepare('INSERT OR IGNORE INTO file_tags(sha256,tag) VALUES(?,?)');
  const wipe = db.prepare('DELETE FROM file_tags WHERE sha256=?');
  for (const s of shas) {
    wipe.run(s);
    for (const t of list.map(clean).filter(Boolean)) add.run(s, t);
  }
  return shas.length;
}

const routes = {
  'GET /api/config': () => ({
    roots: cfg.roots, port: cfg.port,
    openWith: (cfg.openWith || []).map(a => ({
      name: a.name, default: !!a.default, present: fs.existsSync(a.exe),
    })),
  }),

  'GET /api/settings': () => ({
    roots: cfg.roots, quarantine: cfg.quarantine || '',
    fileTypes: [...normExts(cfg.fileTypes)], allFileTypes: [...EXTS],
    protected: normProtected(cfg.protected),
    quarantineDefault: path.join(DATA, '_quarantine'),
  }),
  'POST /api/settings': (body) => saveSettings(body),

  'GET /api/stats': () => {
    const s = db.prepare(`SELECT COUNT(*) files, COALESCE(SUM(size),0) bytes,
      COUNT(DISTINCT designer) designers FROM files`).get();
    const byExt = db.prepare(
      'SELECT ext, COUNT(*) n, SUM(size) bytes FROM files GROUP BY ext ORDER BY n DESC').all();
    return { ...s, byExt, lastScan: Number(getMeta(db, 'last_scan', 0)), scan: scanState };
  },

  'GET /api/rows': () => {
    const rows = db.prepare(ROW_SELECT).all();
    for (const r of rows) {
      r.tags = r.tagstr ? r.tagstr.split(', ').filter(Boolean) : [];
      delete r.tagstr;
      // The scanner falls back to the filename when a file carries no embedded
      // title, which made Title a copy of Name on most rows. Blank it in that
      // case so a filled Title always means something you or the file chose.
      const stem = r.name.replace(/\.[^.]*$/, '');
      if (r.title && r.title.toLowerCase() === stem.toLowerCase()) r.title = '';
    }
    return rows;
  },

  'GET /api/dupes': () => dupeGroups(),
  'GET /api/scan/status': () => scanState,
  'POST /api/scan': () => { startScan(); return { started: true }; },

  // add / remove / set tags on the selection. `set` replaces the whole list,
  // which is what the comma-separated cell editor sends.
  'POST /api/tags': (body) => {
    const clean = t => String(t).trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
    const get = db.prepare('SELECT sha256 FROM files WHERE id=?');
    const shas = [...new Set((body.ids || []).map(id => get.get(id)?.sha256).filter(Boolean))];
    if (!shas.length) return { updated: 0 };

    const add = db.prepare('INSERT OR IGNORE INTO file_tags(sha256,tag) VALUES(?,?)');
    const del = db.prepare('DELETE FROM file_tags WHERE sha256=? AND tag=?');
    const wipe = db.prepare('DELETE FROM file_tags WHERE sha256=?');

    for (const s of shas) {
      if (Array.isArray(body.set)) {
        wipe.run(s);
        for (const t of body.set.map(clean).filter(Boolean)) add.run(s, t);
      }
      for (const t of (body.add || []).map(clean).filter(Boolean)) add.run(s, t);
      for (const t of (body.remove || []).map(clean).filter(Boolean)) del.run(s, t);
    }
    const q = db.prepare(
      `SELECT COUNT(*) c FROM files WHERE sha256 IN (${shas.map(() => '?').join(',')})`);
    return { updated: q.get(...shas).c, copies: shas.length };
  },

  // Merge or rename a tag across the whole library. Merging is just renaming
  // onto an existing name - the primary key dedupes the overlap.
  'POST /api/tags/rename': (body) => {
    const from = String(body.from || '').trim().toLowerCase();
    const to   = String(body.to   || '').trim().toLowerCase();
    if (!from) throw new Error('nothing to rename');
    const before = db.prepare('SELECT COUNT(*) c FROM file_tags WHERE tag=?').get(from).c;
    if (!before) throw new Error(`no files tagged "${from}"`);
    if (to) {
      db.prepare('INSERT OR IGNORE INTO file_tags (sha256, tag) SELECT sha256, ? FROM file_tags WHERE tag=?')
        .run(to, from);
    }
    db.prepare('DELETE FROM file_tags WHERE tag=?').run(from);
    const after = to ? db.prepare('SELECT COUNT(*) c FROM file_tags WHERE tag=?').get(to).c : 0;
    return { from, to, moved: before, nowOnTag: after };
  },

  'GET /api/tags/all': () =>
    db.prepare(`SELECT ft.tag v, COUNT(DISTINCT f.id) n
      FROM file_tags ft JOIN files f ON f.sha256 = ft.sha256
      GROUP BY ft.tag ORDER BY n DESC, v`).all(),

  // "Mark for print" - the print-request pipeline. Tags the selection
  // for-print locally (visible/filterable right away, even if the Hub is
  // offline) and forwards each file to the Hub so it can auto-queue when a
  // matching gcode already exists.
  'POST /api/print-request': async (body) => {
    const ids = body.ids || [];
    if (!ids.length) throw new Error('select some files first');
    const rows = db.prepare(`${ROW_SELECT} WHERE f.id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    if (!rows.length) throw new Error('unknown files');
    const add = db.prepare('INSERT OR IGNORE INTO file_tags(sha256,tag) VALUES(?,?)');
    for (const r of rows) add.run(r.sha256, 'for-print');
    const hub = await forwardToHub(rows);
    return { tagged: rows.length, hub };
  },

  'POST /api/rename/plan': (body) => {
    const ids = body.ids || [];
    if (!ids.length) return [];
    const q = db.prepare(
      `${ROW_SELECT} WHERE f.id IN (${ids.map(() => '?').join(',')})`);
    const map = new Map(q.all(...ids).map(r => [r.id, r]));
    const ordered = ids.map(i => map.get(i)).filter(Boolean);
    return ren.plan(ordered, body.pattern || '{title}');
  },

  // Edit Title / Designer. Stored as an override against the content hash, so
  // it survives rescans, renames and moves - and every copy of the same file
  // picks it up. Tags work the same way, via /api/tags.
  'POST /api/edit': (body) => {
    const field = String(body.field || '');
    if (!['title', 'designer'].includes(field)) {
      throw new Error('field not editable: ' + field);
    }
    const value = String(body.value ?? '').trim().slice(0, 300);
    const get = db.prepare('SELECT sha256 FROM files WHERE id=?');
    const shas = [...new Set((body.ids || []).map(id => get.get(id)?.sha256).filter(Boolean))];
    if (!shas.length) return { updated: 0 };

    const up = db.prepare(`
      INSERT INTO overrides (sha256, ${field}, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(sha256) DO UPDATE SET ${field}=excluded.${field},
                                        updated_at=excluded.updated_at`);
    for (const s of shas) up.run(s, value, Date.now());
    // how many rows on screen this actually touches
    const q = db.prepare(
      `SELECT COUNT(*) c FROM files WHERE sha256 IN (${shas.map(() => '?').join(',')})`);
    return { updated: q.get(...shas).c, copies: shas.length, field, value };
  },

  // "Apply titles to filenames" - the filename becomes
  // "Designer - Title", growing to "Designer - Tag - Title" only when the
  // short form is already taken. Tags arrive alphabetical, so "first tag"
  // is stable across runs.
  'POST /api/rename/plan-titles': (body) => {
    const ids = body.ids || [];
    if (!ids.length) throw new Error('select some files first');
    const rows = db.prepare(
      `${ROW_SELECT} WHERE f.id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    for (const r of rows) {
      r.tags = r.tagstr ? r.tagstr.split(', ').filter(Boolean) : [];
      const stem = r.name.replace(/\.[^.]*$/, '');
      if (r.title && r.title.toLowerCase() === stem.toLowerCase()) r.title = '';
    }
    const order = new Map(ids.map((id, i) => [id, i]));
    rows.sort((a, b) => order.get(a.id) - order.get(b.id));
    return ren.planFromTitles(rows);
  },

  // The plan comes from the page, so protected files are dropped here too,
  // not just left out of the list the page builds it from.
  'POST /api/rename/apply': (body) => {
    const plan = body.plan || [];
    const blocked = plan.filter(p => isProtected(p.from) || isProtected(p.to));
    const r = ren.apply(db, plan.filter(p => !blocked.includes(p)));
    for (const p of blocked) r.errors.push({ from: p.from, error: PROTECTED_MSG });
    return r;
  },
  'POST /api/rename/undo': (body) => ren.undo(db, body.batch, isProtected),
  'GET /api/rename/batches': () => ren.batches(db),

  // "Clean titles" - strips the designer's name, a short word list (cute,
  // articulated, flexi to start), and a trailing catalog number from the
  // Title field itself. Never touches a file on disk; a later "Titles ->
  // filenames" pass is how a cleaned title becomes the real filename.
  // Plan-only, like rename/plan above - nothing is written until /apply.
  'POST /api/titles/clean-plan': (body) => {
    const ids = body.ids || [];
    if (!ids.length) throw new Error('select some files first');
    const q = db.prepare(`${ROW_SELECT} WHERE f.id IN (${ids.map(() => '?').join(',')})`);
    const map = new Map(q.all(...ids).map(r => [r.id, r]));
    const ordered = ids.map(i => map.get(i)).filter(Boolean);
    return ct.planCleanTitles(ordered, { words: body.words });
  },
  'POST /api/titles/clean-apply': (body) => ct.applyCleanTitles(db, body.items || []),
  'POST /api/titles/clean-undo': (body) => ct.undoCleanTitles(db, body.batch),
  'GET /api/titles/clean-batches': () => ct.cleanBatches(db),
};

// Local convenience actions. Kept out of `routes` because they touch the OS.
const knownPath = p => !!p && !!db.prepare('SELECT 1 FROM files WHERE path=?').get(p);

// 2026-09-28: 3MF Explorer runs as a Windows service (3MFExplorer), and a
// service lives in session 0 - anything it spawns (File Explorer, the
// slicer) opens where nobody can see it. When U1_DESKTOP_LAUNCHER names a
// script (the service's run wrapper sets it), the program goes through it:
// it points an Interactive Task Scheduler task at the program and runs it on
// the signed-in desktop. Started by hand, it spawns directly as before.
// Resolves once the program has been handed to the desktop, rejects with the
// launcher's own error otherwise - so the button reports a failure instead of
// toasting "Opening..." over nothing.
//
// 2026-10-08: this used spawn(..., { detached: true, stdio: 'ignore' }) for the
// launcher too. A detached PowerShell started from the service never got as far
// as re-pointing the desktop task (its action and LastRunTime did not move), and
// with stdio ignored there was no error to see - Open in Snapmaker Orca and Show
// in folder silently did nothing. Same call shape as the Hub's working
// modules/desktop.js now: execFile, wait for it, keep stderr.
function launchOnDesktop(exe, target, prefix = '') {
  const launcher = process.env.U1_DESKTOP_LAUNCHER;
  if (!launcher) {
    return new Promise((resolve, reject) => {
      try { spawn(exe, [prefix + target], { detached: true, stdio: 'ignore' }).unref(); resolve({ via: 'spawn' }); }
      catch (e) { reject(e); }
    });
  }
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-Exe', exe, '-Target', target];
  if (prefix) args.push('-Prefix', prefix);
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', args, { windowsHide: true, timeout: 20000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('could not open on the desktop: ' +
        (String(stderr || '').trim().split(/\r?\n/)[0] || err.message)));
      resolve({ via: 'desktop task' });
    });
  });
}

async function osAction(name, body) {
  if (name === 'reveal') {
    if (!knownPath(body.path)) throw new Error('unknown path');
    await launchOnDesktop('explorer.exe', body.path, '/select,');
    return { ok: true };
  }

  // Launch in a slicer. The exe must be one listed in config.json - we never
  // run an arbitrary path handed to us by the page.
  if (name === 'open') {
    if (!knownPath(body.path)) throw new Error('unknown path');
    const list = cfg.openWith || [];
    const app = body.app
      ? list.find(a => a.name === body.app)
      : (list.find(a => a.default) || list[0]);
    if (!app) throw new Error('no slicer configured');
    if (!fs.existsSync(app.exe)) throw new Error(app.name + ' not found at ' + app.exe);
    await launchOnDesktop(app.exe, body.path);
    return { ok: true, app: app.name };
  }

  // Delete to the Recycle Bin. Recoverable on purpose - nothing here does a
  // hard delete.
  if (name === 'recycle') {
    const get = db.prepare('SELECT path FROM files WHERE id=?');
    const asked = (body.ids || []).map(id => get.get(id)?.path).filter(Boolean);
    const blocked = asked.filter(p => isProtected(p));
    const paths = asked.filter(p => !isProtected(p));
    const note = blocked.length ? `Skipped ${blocked.length} protected file${blocked.length === 1 ? '' : 's'}: ${blocked.join(', ')}` : '';
    if (!paths.length) return { recycled: 0, asked: asked.length, blocked: blocked.length, detail: note };
    const listFile = path.join(DATA, '_recycle.txt');
    fs.writeFileSync(listFile, paths.join('\r\n'), 'utf8');
    // PowerShell can't read a script from inside a packaged binary, so a
    // packaged build writes its bundled copy out to the temp folder first.
    let script = path.join(HERE, 'recycle.ps1');
    if (PACKAGED) {
      const tmp = path.join(os.tmpdir(), '3mf-explorer-recycle.ps1');
      fs.writeFileSync(tmp, fs.readFileSync(script));
      script = tmp;
    }
    const r = spawnSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
       script, '-ListFile', listFile],
      { encoding: 'utf8', windowsHide: true });
    const out = (r.stdout || '') + (r.stderr || '');
    const del = db.prepare('DELETE FROM files WHERE path=?');
    let gone = 0;
    for (const p of paths) if (!fs.existsSync(longPath(p))) { del.run(p); gone++; logAction('recycle', p); }
    for (const p of blocked) logAction('recycle-refused-protected', p);
    try { fs.unlinkSync(listFile); } catch {}
    return { recycled: gone, asked: asked.length, blocked: blocked.length,
             detail: [note, out.trim()].filter(Boolean).join('\n') };
  }

  // Rename a single file in place, recorded so History can undo it.
  if (name === 'renameOne') {
    const row = db.prepare('SELECT id,path,root,name FROM files WHERE id=?').get(body.id);
    if (!row) throw new Error('unknown file');
    if (isProtected(row.path)) throw new Error(`${row.name} is ${PROTECTED_MSG}`);
    const ext = path.extname(row.name);
    const base = ren.clean(String(body.name || '').replace(/\.[^.]*$/, ''));
    if (!base) throw new Error('empty name');
    const target = path.join(path.dirname(row.path), base + ext);
    if (target === row.path) return { ok: true, unchanged: true };
    if (fs.existsSync(longPath(target))) throw new Error('a file with that name already exists');
    fs.renameSync(longPath(row.path), longPath(target));
    db.prepare('UPDATE files SET path=?, name=?, rel=? WHERE id=?')
      .run(target, path.basename(target),
           row.root ? path.relative(row.root, target) : '', row.id);
    db.prepare('INSERT INTO renames(batch,ts,old_path,new_path,undone) VALUES(?,?,?,?,0)')
      .run('single-' + Date.now().toString(36), Date.now(), row.path, target);
    return { ok: true, path: target, name: path.basename(target) };
  }
  if (name === 'quarantine') {
    const dest = cfg.quarantine || path.join(DATA, '_quarantine');
    fs.mkdirSync(longPath(dest), { recursive: true });
    const get = db.prepare('SELECT path,name FROM files WHERE id=?');
    const del = db.prepare('DELETE FROM files WHERE id=?');
    let moved = 0; const errors = [];
    for (const id of body.ids || []) {
      const r = get.get(id);
      if (!r) continue;
      if (isProtected(r.path)) { errors.push({ path: r.path, error: PROTECTED_MSG }); logAction('quarantine-refused-protected', r.path); continue; }
      let target = path.join(dest, r.name);
      let n = 2;
      while (fs.existsSync(longPath(target))) {
        const e = path.extname(r.name);
        target = path.join(dest, `${path.basename(r.name, e)} (${n++})${e}`);
      }
      try { fs.renameSync(longPath(r.path), longPath(target)); del.run(id); moved++; logAction('quarantine', r.path, target); }
      catch (e) { errors.push({ path: r.path, error: String(e.message || e) }); }
    }
    return { moved, dest, errors };
  }
  throw new Error('unknown action');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const key = req.method + ' ' + url.pathname;

    // cached thumbnails
    if (url.pathname.startsWith('/thumb/')) {
      const name = path.basename(url.pathname.slice(7));
      if (!/^[a-f0-9]{16}\.png$/.test(name)) return send(res, 400, 'bad name', 'text/plain');
      try {
        const buf = await fsp.readFile(longPath(path.join(THUMBS, name)));
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=31536000' });
        return res.end(buf);
      } catch { return send(res, 404, 'no thumb', 'text/plain'); }
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/os/')) {
      const body = await readBody(req);
      return send(res, 200, await osAction(url.pathname.slice(8), body));
    }

    // Export the library to an .xlsx. Same row shape and title-blanking as
    // GET /api/rows, so what you see in the app is what lands in the sheet.
    if (req.method === 'GET' && url.pathname === '/api/export/xlsx') {
      const rows = db.prepare(ROW_SELECT).all();
      for (const r of rows) {
        r.tags = r.tagstr ? r.tagstr.split(', ').filter(Boolean) : [];
        const stem = r.name.replace(/\.[^.]*$/, '');
        if (r.title && r.title.toLowerCase() === stem.toLowerCase()) r.title = '';
      }
      const wb = await xl.exportWorkbook(rows);
      const buf = await wb.xlsx.writeBuffer();
      res.writeHead(200, {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': 'attachment; filename="3mf-library.xlsx"',
        'cache-control': 'no-store',
      });
      return res.end(Buffer.from(buf));
    }

    // Import an edited .xlsx. Rows are matched by ID (never by path or name,
    // so an edited Path cell can't redirect an action to another file) and
    // only Title, Designer, Tags and Delete are applied - everything else in
    // the sheet is reference-only. Delete goes through the same Recycle-Bin
    // action as the Delete button; nothing here ever hard-deletes.
    if (req.method === 'POST' && url.pathname === '/api/import/xlsx') {
      const buf = await readRawBody(req);
      const parsed = await xl.parseWorkbook(buf);
      const existing = db.prepare(`${ROW_SELECT} WHERE f.id=?`);
      let titles = 0, designers = 0, tags = 0, skipped = 0;
      const toDelete = [];

      for (const p of parsed) {
        const cur = existing.get(p.id);
        if (!cur) { skipped++; continue; }
        if (p.del) { toDelete.push(p.id); continue; }

        const stem = cur.name.replace(/\.[^.]*$/, '');
        const curTitle = (cur.title && cur.title.toLowerCase() === stem.toLowerCase()) ? '' : (cur.title || '');
        if (p.title !== curTitle) { applyFieldEdit('title', [p.id], p.title); titles++; }

        const curDesigner = cur.designer || '';
        if (p.designer !== curDesigner) { applyFieldEdit('designer', [p.id], p.designer); designers++; }

        const newList = p.tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
        const newStr = [...new Set(newList)].sort().join(', ');
        if (newStr !== (cur.tagstr || '')) { applyTagSet([p.id], newList); tags++; }
      }

      let deleted = 0, recycleDetail = '';
      if (toDelete.length) {
        const r = await osAction('recycle', { ids: toDelete });
        deleted = r.recycled;
        recycleDetail = r.detail || '';
      }
      return send(res, 200, {
        total: parsed.length, skipped, titles, designers, tags,
        askedDelete: toDelete.length, deleted, recycleDetail,
      });
    }

    if (routes[key]) {
      const body = req.method === 'POST' ? await readBody(req) : null;
      return send(res, 200, await routes[key](body));
    }

    // static
    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(HERE, 'public', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(path.join(HERE, 'public'))) return send(res, 403, 'no', 'text/plain');
    try {
      const buf = await fsp.readFile(file);
      return send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
    } catch { return send(res, 404, 'not found', 'text/plain'); }
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) });
  }
});

// A hand edit of config.json's roots takes effect on restart the same way a
// Settings save does: rows outside the folders leave the index.
try {
  const r = reconcileRoots();
  if (r.removed) console.log(`  Dropped ${r.removed} index rows outside the library folders.`);
} catch (e) { console.error('  reconcile failed:', e.message); }

const PORT = cfg.port || 7333;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  3MF Explorer  ->  http://localhost:${PORT}\n`);
  console.log('  roots:');
  for (const r of cfg.roots) console.log('    ' + r + (fs.existsSync(longPath(r)) ? '' : '   (missing)'));
  if (!cfg.roots.length) console.log('    (none yet - open Settings in the app, or add your model folders to "roots" in ' + CFG_PATH + ')');
  const n = db.prepare('SELECT COUNT(*) c FROM files').get().c;
  console.log(`\n  ${n} files indexed. ${n ? '' : 'Hit Rescan in the UI to build the index.'}\n`);
});
