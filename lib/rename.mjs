import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { longPath } from './scan.mjs';
import { renameOrCopy } from './archive.mjs';

const BAD = /[<>:"/\\|?*\x00-\x1f]/g;

export const clean = s => String(s ?? '')
  .replace(BAD, ' ').replace(/\s+/g, ' ').trim().replace(/\.+$/, '').trim();

// Tokens available in a rename pattern. Anything unrecognised is left alone
// so a stray brace in a filename can't silently vanish.
export function applyPattern(pattern, row, index) {
  const pad = (n, w) => String(n).padStart(w, '0');
  const map = {
    title:    clean(row.title),
    designer: clean(row.designer) || 'Unknown',
    name:     clean(path.basename(row.name, path.extname(row.name))),
    folder:   clean(row.folder),
    app:      clean((row.application || '').split('-')[0]),
    license:  clean(row.license),
    objects:  row.objects ?? 0,
    plates:   row.plates ?? 0,
    layer:    row.layer_height != null ? row.layer_height + 'mm' : '',
    nozzle:   row.nozzle != null ? row.nozzle + 'mm' : '',
    mb:       row.size ? (row.size / 1048576).toFixed(1) + 'MB' : '',
    date:     (row.created || '').slice(0, 10),
    year:     (row.created || '').slice(0, 4),
    sha8:     (row.sha256 || '').slice(0, 8),
    geom8:    (row.geom || '').slice(0, 8),
    n:        String(index + 1),
    nn:       pad(index + 1, 2),
    nnn:      pad(index + 1, 3),
  };
  let out = pattern.replace(/\{(\w+)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(map, k) ? String(map[k]) : m);
  out = out.replace(/\s{2,}/g, ' ').replace(/\s*([_-])\s*\1+/g, '$1').trim();
  return clean(out);
}

// Work out what a batch would do, without touching anything.
export function plan(rows, pattern) {
  const out = [];
  const taken = new Set();
  rows.forEach((row, i) => {
    const ext = path.extname(row.name);
    const dir = path.dirname(row.path);
    let base = applyPattern(pattern, row, i);
    if (!base) base = path.basename(row.name, ext);

    let target = path.join(dir, base + ext);
    const key0 = target.toLowerCase();

    let status = 'rename';
    if (target === row.path) {
      status = 'unchanged';
    } else {
      // de-collide against both the filesystem and earlier rows in this batch
      let n = 2, key = key0;
      while (taken.has(key) || fs.existsSync(longPath(target))) {
        target = path.join(dir, `${base} (${n})${ext}`);
        key = target.toLowerCase();
        n++;
        if (n > 999) { status = 'collision'; break; }
      }
      if (key !== key0) status = 'deconflicted';
      taken.add(key);
    }
    out.push({ id: row.id, from: row.path, to: target, status });
  });
  return out;
}

// Last check before a rename batch touches disk. `planned` must come from
// plan() / planFromTitles() run on the server against `rows` (id -> the
// file's row); this still verifies every entry against that row, so a bug
// upstream can't turn a rename into a move. A rename keeps the file in its
// own folder, inside a configured library folder, and never onto or off a
// protected name.
export function checkPlan(planned, rows, { isProtected = () => false, rootOf = () => undefined } = {}) {
  const ok = [], refused = [];
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  for (const p of planned || []) {
    const row = rows.get(p.id);
    let error = null;
    if (!row) error = 'unknown file';
    else if (!p.from || !p.to || !same(p.from, row.path)) error = 'the plan does not match this file - preview again';
    else if (isProtected(p.from) || isProtected(p.to)) error = 'protected in Settings - this app never moves, renames or deletes it';
    else if (!same(path.dirname(p.to), path.dirname(row.path))) error = 'a rename has to stay in the same folder';
    else if (!rootOf(p.to)) error = 'the new name is not inside a library folder';
    if (error) refused.push({ id: p.id, from: p.from, error });
    else ok.push(p);
  }
  return { ok, refused };
}

// E15 (1.6.1): fs.renameSync replaces an existing file on Windows. The plan is
// rebuilt right before apply, but a file can still appear in between, so every
// rename checks its destination immediately before moving and records a
// per-file error instead. A case-only rename (a.3mf -> A.3mf) is the same file
// and is allowed. A protected destination name is refused like a protected source.
export function apply(db, planned, isProtected = () => false) {
  const batch = crypto.randomUUID().slice(0, 8);
  const ts = Date.now();
  const ins = db.prepare(
    'INSERT INTO renames(batch,ts,old_path,new_path,undone) VALUES(?,?,?,?,0)');
  const upd = db.prepare('UPDATE files SET path=?, name=?, rel=? WHERE id=?');
  const getRoot = db.prepare('SELECT root FROM files WHERE id=?');

  let ok = 0; const errors = [];
  for (const p of planned) {
    if (p.status === 'unchanged' || p.status === 'collision') continue;
    try {
      if (isProtected(p.to)) throw new Error('the new name is protected in Settings - left alone');
      const sameFile = p.from.toLowerCase() === p.to.toLowerCase();
      if (!sameFile && fs.existsSync(longPath(p.to))) throw new Error('something already exists at ' + p.to + ' - left alone');
      fs.renameSync(longPath(p.from), longPath(p.to));
      const root = getRoot.get(p.id)?.root || '';
      upd.run(p.to, path.basename(p.to), root ? path.relative(root, p.to) : '', p.id);
      ins.run(batch, ts, p.from, p.to);
      ok++;
    } catch (e) {
      errors.push({ from: p.from, error: String(e.message || e) });
    }
  }
  return { batch, renamed: ok, errors };
}

// isProtected (optional): a file sitting at a protected path is left where
// it is rather than moved back out of it.
export function undo(db, batch, isProtected = () => false) {
  const rows = db.prepare(
    'SELECT * FROM renames WHERE batch=? AND undone=0 ORDER BY id DESC').all(batch);
  const mark = db.prepare('UPDATE renames SET undone=1 WHERE id=?');
  const upd  = db.prepare('UPDATE files SET path=?, name=?, rel=?, folder=? WHERE path=?');
  const getRoot = db.prepare('SELECT root FROM files WHERE path=?');

  let ok = 0; const errors = [];
  for (const r of rows) {
    try {
      if (isProtected(r.new_path)) throw new Error('protected in Settings - left where it is');
      // audit gap (1.6.1): the restore target is a destination too.
      if (isProtected(r.old_path)) throw new Error('the original name is protected in Settings - left where it is');
      if (fs.existsSync(longPath(r.old_path))) {
        throw new Error('something already exists at the original name');
      }
      // A library reorg moves files across folders and tidies the emptied
      // ones, so the original folder may be gone - recreate it first.
      fs.mkdirSync(longPath(path.dirname(r.old_path)), { recursive: true });
      // E16 (1.7.1): undoing a quarantine can cross drives - copy, verify, unlink.
      renameOrCopy(r.new_path, r.old_path);
      const root = getRoot.get(r.new_path)?.root || '';
      upd.run(r.old_path, path.basename(r.old_path),
              root ? path.relative(root, r.old_path) : '',
              path.basename(path.dirname(r.old_path)), r.new_path);
      mark.run(r.id);
      ok++;
    } catch (e) {
      errors.push({ path: r.new_path, error: String(e.message || e) });
    }
  }
  return { reverted: ok, errors };
}

export function batches(db) {
  return db.prepare(`
    SELECT batch, MIN(ts) ts, COUNT(*) n, SUM(undone) undone
    FROM renames GROUP BY batch ORDER BY ts DESC LIMIT 50`).all();
}

// "Apply titles to filenames".
//
// The shape is  Designer - Title, and  Designer - Tag - Title  when the short
// form is already taken. The tag only appears when it has to, so two models
// with the same title from the same designer are the only ones that carry one.
// With no designer the prefix is simply dropped. A counter is the last resort.
//
// Idempotent: running it on names it produced leaves them alone, because the
// leading designer and tag are stripped back off before the name is rebuilt.

// "Matt Mire Makes - Pocket Pals - Bearded Dragon" -> "Bearded Dragon",
// given that designer and that tag. Only strips what actually leads.
function stripPrefix(base, word) {
  if (!word) return base;
  const p = word.toLowerCase() + ' - ';
  return base.toLowerCase().startsWith(p) ? base.slice(p.length).trim() : base;
}

// Tags are stored lowercase for matching; in a filename they should read like
// a name. Words that already carry capitals (PLA, D&D) are left alone.
const titleCase = s => s.replace(/\S+/g,
  w => /[A-Z]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1));

export function planFromTitles(rows) {
  const out = [];
  const taken = new Set();

  for (const row of rows) {
    const ext = path.extname(row.name);
    const dir = path.dirname(row.path);
    const stem = path.basename(row.name, ext);
    const designer = clean(row.designer);
    const firstTag = titleCase(clean((row.tags || [])[0] || ''));

    // The Title is the subject when there is one; otherwise the current
    // filename is standing in for it. Either way, peel off a designer or tag
    // this function put there on an earlier run so they don't stack up.
    let subject = clean(row.title) || stem;
    subject = stripPrefix(subject, designer);
    subject = stripPrefix(subject, firstTag);
    subject = stripPrefix(subject, designer);
    if (!subject) subject = stem;

    const lead = designer ? designer + ' - ' : '';
    const candidates = [lead + subject];
    if (firstTag) candidates.push(`${lead}${firstTag} - ${subject}`);

    const free = t =>
      !taken.has(t.toLowerCase()) &&
      (!fs.existsSync(longPath(t)) || t.toLowerCase() === row.path.toLowerCase());

    let chosen = null, why = null;
    for (let i = 0; i < candidates.length; i++) {
      const t = path.join(dir, clean(candidates[i]) + ext);
      if (free(t)) { chosen = t; why = i === 1 ? 'tag added to de-conflict' : null; break; }
    }
    if (!chosen) {
      const longest = clean(candidates[candidates.length - 1]);
      for (let n = 2; n < 500; n++) {
        const t = path.join(dir, `${longest} (${n})${ext}`);
        if (free(t)) { chosen = t; why = 'numbered'; break; }
      }
    }

    if (!chosen) {
      out.push({ id: row.id, from: row.path, to: row.path, status: 'collision' });
      continue;
    }
    taken.add(chosen.toLowerCase());
    out.push({
      id: row.id, from: row.path, to: chosen,
      status: chosen.toLowerCase() === row.path.toLowerCase() ? 'unchanged' : 'rename',
      why,
    });
  }
  return out;
}
