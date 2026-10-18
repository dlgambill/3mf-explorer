import { DatabaseSync } from 'node:sqlite';
import { metaText } from './metatext.mjs';

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  // The CLI scanner and the server are separate processes on one file.
  // WAL lets them read/write concurrently; this keeps a writer from
  // erroring out if the other one holds the lock for a moment.
  db.exec('PRAGMA busy_timeout = 15000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id        INTEGER PRIMARY KEY,
      path      TEXT UNIQUE NOT NULL,
      root      TEXT, rel TEXT, folder TEXT, name TEXT, ext TEXT,
      size      INTEGER, mtime INTEGER,
      sha256    TEXT,
      geom      TEXT, vcount INTEGER, tcount INTEGER, bbox TEXT,
      title     TEXT, designer TEXT, description TEXT,
      license   TEXT, copyright TEXT, application TEXT,
      created   TEXT, modified TEXT,
      objects   INTEGER, plates INTEGER,
      layer_height REAL, nozzle REAL, filaments TEXT, print_time TEXT,
      thumb     TEXT,
      indexed_at INTEGER,
      search    TEXT    -- unused since 1.7.1 (E14); kept so older databases open
    );
    CREATE INDEX IF NOT EXISTS ix_sha  ON files(sha256);
    CREATE INDEX IF NOT EXISTS ix_geom ON files(geom);
    CREATE INDEX IF NOT EXISTS ix_ext  ON files(ext);
    CREATE INDEX IF NOT EXISTS ix_desg ON files(designer);

    CREATE TABLE IF NOT EXISTS tags (
      file_id INTEGER NOT NULL, tag TEXT NOT NULL,
      PRIMARY KEY (file_id, tag)
    );
    CREATE INDEX IF NOT EXISTS ix_tag ON tags(tag);

    CREATE TABLE IF NOT EXISTS renames (
      id INTEGER PRIMARY KEY, batch TEXT, ts INTEGER,
      old_path TEXT, new_path TEXT, undone INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS ix_batch ON renames(batch);
    CREATE INDEX IF NOT EXISTS ix_newpath ON renames(new_path);

    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

    -- 2026-09-28: undo log for "Clean titles" batches, same shape as
    -- renames above but keyed by content hash, since title edits land in
    -- the overrides table per-sha256 rather than per file path.
    CREATE TABLE IF NOT EXISTS title_edits (
      id INTEGER PRIMARY KEY, batch TEXT, ts INTEGER,
      sha256 TEXT, old_title TEXT, new_title TEXT, undone INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS ix_title_batch ON title_edits(batch);

    -- Your edits to Title / Designer / Classification. Kept out of the files
    -- table so a rescan never overwrites them, and keyed by content hash so
    -- they survive renames and moves. Nothing is written back into the 3MF.
    CREATE TABLE IF NOT EXISTS overrides (
      sha256         TEXT PRIMARY KEY,
      title          TEXT,
      designer       TEXT,
      classification TEXT,
      updated_at     INTEGER
    );

    -- Tags, keyed by content hash like the other overrides so they survive
    -- rescans, renames and moves.
    CREATE TABLE IF NOT EXISTS file_tags (
      sha256 TEXT NOT NULL,
      tag    TEXT NOT NULL,
      PRIMARY KEY (sha256, tag)
    );
    CREATE INDEX IF NOT EXISTS ix_ftag ON file_tags(tag);
  `);
  migrate(db);
  addArchiveColumns(db);
  cleanMetaText(db);
  return db;
}

// 1.5.0: first_seen (when this app first indexed the file - kept across
// rescans, renames and moves because those update the row in place) and
// last_used (last Open in slicer / Mark for print from here). The monthly
// archive needs both. Existing rows get first_seen = their indexed_at, the
// earliest time this database knows about - never the file's own mtime,
// which an unzip can set years into the past.
function addArchiveColumns(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(files)').all().map(c => c.name));
  if (!cols.has('first_seen')) db.exec('ALTER TABLE files ADD COLUMN first_seen INTEGER');
  if (!cols.has('last_used')) db.exec('ALTER TABLE files ADD COLUMN last_used INTEGER');
  db.exec('UPDATE files SET first_seen = indexed_at WHERE first_seen IS NULL AND indexed_at IS NOT NULL');
}

// 1.0.1: rows indexed by 1.0.0 hold metadata exactly as the old reader left
// it (latin1-decoded UTF-8, undecoded entities, escaped HTML descriptions).
// metaText() is the same function the reader now uses, and it is pure, so
// running it once over those stored values gives what a full rescan would -
// without re-reading thousands of files off the share. Your own edits live in
// `overrides` and are not touched. The flag makes it run once.
function cleanMetaText(db) {
  if (getMeta(db, 'meta_text_v1') === '1') return;
  const FIELDS = ['title', 'designer', 'description', 'license', 'copyright'];
  const rows = db.prepare(`SELECT id, ${FIELDS.join(',')} FROM files`).all();
  const upd = db.prepare(`UPDATE files SET ${FIELDS.map(f => f + '=?').join(',')} WHERE id=?`);
  let changed = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const v = FIELDS.map(f => metaText(r[f]));
      if (v.every((x, i) => x === (r[FIELDS[i]] ?? ''))) continue;
      upd.run(...v, r.id);   // E14 (1.7.1): the search column is no longer maintained
      changed++;
    }
    setMeta(db, 'meta_text_v1', '1');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return changed;
}

// Fold the two older tag-ish systems into file_tags. Idempotent - the flag
// stops it re-running, and every insert is OR IGNORE anyway.
function migrate(db) {
  if (getMeta(db, 'tags_merged') === '1') return;
  try {
    db.exec(`
      INSERT OR IGNORE INTO file_tags (sha256, tag)
      SELECT f.sha256, LOWER(TRIM(t.tag)) FROM tags t
      JOIN files f ON f.id = t.file_id
      WHERE f.sha256 IS NOT NULL AND TRIM(t.tag) <> ''`);

    // classification was a single free-text value; split it on commas
    const rows = db.prepare(`SELECT sha256, classification FROM overrides
      WHERE classification IS NOT NULL AND classification <> ''`).all();
    const ins = db.prepare('INSERT OR IGNORE INTO file_tags (sha256, tag) VALUES (?,?)');
    for (const r of rows) {
      for (const t of String(r.classification).split(',')) {
        const v = t.trim().toLowerCase();
        if (v) ins.run(r.sha256, v);
      }
    }
    setMeta(db, 'tags_merged', '1');
  } catch { /* a fresh database has nothing to migrate */ }
}

export const getMeta = (db, k, d = null) =>
  db.prepare('SELECT v FROM meta WHERE k=?').get(k)?.v ?? d;

export const setMeta = (db, k, v) =>
  db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
    .run(k, String(v));
