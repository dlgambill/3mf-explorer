import crypto from 'node:crypto';

// Strip the noise that marketplace titles arrive with: the designer's own
// name however it's glued on, a short list of subjective descriptor words
// that don't help you find or tell files apart, and a trailing catalog
// number - but only when the model is still identifiable without it. The
// number check looks at the whole batch being planned before deciding, so
// "Pikachu Pokeball 025" loses its number (nothing else in the batch reads
// "Pikachu Pokeball") while a bare "Pokeball 025" keeps it if there's a
// "Pokeball 004" sitting next to it - stripping both down to plain
// "Pokeball" would make them indistinguishable, which is the one thing this
// is never allowed to do.

export const DEFAULT_WORDS = ['cute', 'articulated', 'flexi'];

const DASH = '[-–—:]'; // hyphen, en dash, em dash, colon
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function collapse(s) {
  return String(s || '')
    .replace(/[()[\]]/g, ' ')          // empty () or [] left behind once a word is gone
    .replace(/\s{2,}/g, ' ')
    .replace(new RegExp(`(${DASH})\\s*\\1+`, 'g'), '$1')
    .replace(new RegExp(`^\\s*${DASH}\\s*`), '')
    .replace(new RegExp(`\\s*${DASH}\\s*$`), '')
    .trim();
}

// "Designer - Title", "Title - Designer", "Title by Designer", "Title (Designer)", "Designer: Title"
export function stripDesigner(title, designer) {
  const d = String(designer || '').trim();
  if (!d || !title) return title;
  const esc = escRe(d);
  let out = title;
  out = out.replace(new RegExp(`^\\s*${esc}\\s*${DASH}\\s*`, 'i'), '');
  out = out.replace(new RegExp(`\\s*${DASH}\\s*${esc}\\s*$`, 'i'), '');
  out = out.replace(new RegExp(`\\s+by\\s+${esc}\\s*$`, 'i'), '');
  out = out.replace(new RegExp(`\\s*\\(\\s*${esc}\\s*\\)\\s*$`, 'i'), '');
  return collapse(out);
}

// Whole-word, case-insensitive, anywhere in the title - "flexi" never
// touches "flexible" because \b requires a non-word character on both sides.
export function stripWords(title, words) {
  let out = String(title || '');
  for (const w of words || []) {
    const esc = escRe(String(w || '').trim());
    if (!esc) continue;
    out = out.replace(new RegExp(`\\b${esc}\\b`, 'gi'), ' ');
  }
  return collapse(out);
}

// Trailing "12", "#12", "No. 12" - never a lone "1:12" scale or "x2" count,
// since those don't sit at the very end after collapsing whitespace.
export function stripTrailingNumber(title) {
  const m = String(title || '').match(/^(.*?)\s*(?:#|No\.?\s*)?\d{1,4}$/i);
  if (!m) return title;
  const base = collapse(m[1]);
  return base || title; // never collapse a title down to nothing
}

const stemOf = n => String(n || '').replace(/\.[^.]*$/, '');

// What counts as "the title" when the Title field itself is empty or is
// just the scanner's own echo of the filename (which is the common case -
// most of this library's .3mf files carry no embedded title metadata at
// all). The library's own folder convention is Creator\Model\, so the
// enclosing folder name IS the real, human-written title in that case -
// "Flexi Alien Cat Print-in-place & Cow Abduction Playset", not
// "FlexiAlienCat_3MF". Only the bare filename stem is left as a last resort.
function titleOf(row) {
  const t = String(row.title || '').trim();
  const stem = stemOf(row.name);
  if (t && t.toLowerCase() !== stem.toLowerCase()) return t;
  const folder = String(row.folder || '').trim();
  return folder || t || stem;
}

// Plan only - touches no database, no files. `rows` need just {id, path,
// title, designer, name, folder}; `opts.words` overrides DEFAULT_WORDS.
export function planCleanTitles(rows, opts = {}) {
  const words = (opts.words && opts.words.length) ? opts.words : DEFAULT_WORDS;

  // Pass 1: designer + word-list. Always safe on its own - no row depends
  // on any other row's outcome.
  const base = rows.map(row => {
    const before = titleOf(row);
    let mid = stripDesigner(before, row.designer);
    mid = stripWords(mid, words);
    return { row, before, mid: mid || before };
  });

  // Pass 2: trailing number, gated on the rest of THIS batch. Group by what
  // the title would read as with the number gone; only drop the number
  // where that result is still unique in the batch.
  const noNumber = base.map(b => stripTrailingNumber(b.mid));
  const counts = new Map();
  for (const t of noNumber) {
    const k = t.toLowerCase();
    counts.set(k, (counts.get(k) || 0) + 1);
  }

  return base.map((b, i) => {
    const hadNumber = noNumber[i].toLowerCase() !== b.mid.toLowerCase();
    const wouldCollide = hadNumber && counts.get(noNumber[i].toLowerCase()) > 1;
    const after = collapse(hadNumber && !wouldCollide ? noNumber[i] : b.mid) || b.before;
    const changed = after.toLowerCase() !== b.before.toLowerCase();

    const removed = [];
    if (b.mid.toLowerCase() !== b.before.toLowerCase()) removed.push('designer/words');
    if (hadNumber && !wouldCollide) removed.push('number');

    const note = wouldCollide
      ? `number kept - "${noNumber[i]}" alone matches ${counts.get(noNumber[i].toLowerCase())} files in this batch`
      : null;

    return {
      id: b.row.id, path: b.row.path, designer: b.row.designer,
      before: b.before, after, changed, removed, note,
    };
  });
}

// ---- apply / undo, mirroring lib/rename.mjs's batch pattern -------------

export function applyCleanTitles(db, items) {
  const batch = crypto.randomUUID().slice(0, 8);
  const ts = Date.now();
  const getRow = db.prepare(`
    SELECT f.sha256 sha256, COALESCE(NULLIF(o.title,''), f.title) title
    FROM files f LEFT JOIN overrides o ON o.sha256 = f.sha256 WHERE f.id = ?`);
  const up = db.prepare(`
    INSERT INTO overrides (sha256, title, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(sha256) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`);
  const ins = db.prepare(
    'INSERT INTO title_edits(batch,ts,sha256,old_title,new_title,undone) VALUES (?,?,?,?,?,0)');

  let ok = 0; const errors = []; const logged = new Set();
  for (const it of items || []) {
    try {
      const row = getRow.get(it.id);
      if (!row || !row.sha256) throw new Error('unknown file');
      const value = String(it.title ?? '').trim().slice(0, 300);
      if (!logged.has(row.sha256)) {
        ins.run(batch, ts, row.sha256, row.title || '', value);
        logged.add(row.sha256);
      }
      up.run(row.sha256, value, ts);
      ok++;
    } catch (e) {
      errors.push({ id: it.id, error: String(e.message || e) });
    }
  }
  return { batch, updated: ok, errors };
}

export function undoCleanTitles(db, batch) {
  const rows = db.prepare(
    'SELECT * FROM title_edits WHERE batch=? AND undone=0').all(batch);
  const mark = db.prepare('UPDATE title_edits SET undone=1 WHERE id=?');
  const up = db.prepare(`
    INSERT INTO overrides (sha256, title, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(sha256) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`);

  let ok = 0; const errors = [];
  for (const r of rows) {
    try {
      up.run(r.sha256, r.old_title || '', Date.now());
      mark.run(r.id);
      ok++;
    } catch (e) {
      errors.push({ sha256: r.sha256, error: String(e.message || e) });
    }
  }
  return { reverted: ok, errors };
}

export function cleanBatches(db) {
  return db.prepare(`
    SELECT batch, MIN(ts) ts, COUNT(*) n, SUM(undone) undone
    FROM title_edits GROUP BY batch ORDER BY ts DESC LIMIT 50`).all();
}
