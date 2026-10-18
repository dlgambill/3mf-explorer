import fs from 'node:fs';
import path from 'node:path';

// F9 (1.7.1): a nightly copy of library.db and config.json. The index is
// hours of hashing on a NAS, and the overrides and tags in it exist nowhere
// else, so one bad write should not be able to take them away.
//
// Each run writes library-YYYY-MM-DD.db (through VACUUM INTO, which is a
// consistent snapshot even while the server is writing - a file copy of a
// WAL database is not) and config-YYYY-MM-DD.json into the backup folder,
// then keeps the newest `keep` of each. The folder defaults to backups/
// under the data folder (next to library.db) and is set with "backupDir" in
// config.json. It is never put on the library share by default: a backup on
// the drive it protects is not a backup.

export const dayStamp = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const defaultBackupDir = dataDir => path.join(dataDir, 'backups');

const DB_RX = /^library-(\d{4}-\d{2}-\d{2})\.db$/;
const CFG_RX = /^config-(\d{4}-\d{2}-\d{2})\.json$/;

export const hasBackupFor = (dir, stamp) => fs.existsSync(path.join(dir, `library-${stamp}.db`));

// Writes today's backup (overwriting a half-written one from a crashed run),
// prunes to `keep` per kind, and returns what it did. Throws on failure so
// the caller can log it; nothing here is fatal to the server.
export function runBackup({ db, dataDir, cfgPath, backupDir, keep = 7, now = new Date(), log = () => {} }) {
  const dir = backupDir || defaultBackupDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = dayStamp(now);
  const dbOut = path.join(dir, `library-${stamp}.db`);
  const cfgOut = path.join(dir, `config-${stamp}.json`);
  // VACUUM INTO refuses an existing file; write to a temp name and rename
  // over, so a reader never sees a partial file under the final name.
  const tmp = dbOut + '.tmp';
  try { fs.unlinkSync(tmp); } catch {}
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  fs.renameSync(tmp, dbOut);
  if (cfgPath && fs.existsSync(cfgPath)) fs.copyFileSync(cfgPath, cfgOut);
  const pruned = prune(dir, keep);
  log(`backup: wrote ${path.basename(dbOut)}${pruned.length ? ', removed ' + pruned.join(', ') : ''}`);
  return { dir, db: dbOut, config: cfgOut, pruned };
}

// Keep the newest `keep` of each kind by the date in the name.
export function prune(dir, keep = 7) {
  const removed = [];
  for (const rx of [DB_RX, CFG_RX]) {
    const names = fs.readdirSync(dir).filter(n => rx.test(n)).sort().reverse(); // newest first
    for (const n of names.slice(keep)) {
      try { fs.unlinkSync(path.join(dir, n)); removed.push(n); } catch {}
    }
  }
  return removed;
}

// Milliseconds until the next 03:00 local time.
export function msUntil(hour = 3, now = new Date()) {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

// Once at startup if today has no backup yet, then at 03:00 every day.
// Returns a stop() for tests.
export function scheduleBackups(opts, { hour = 3, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const dir = opts.backupDir || defaultBackupDir(opts.dataDir);
  const run = () => { try { runBackup({ ...opts, log }); } catch (e) { log('backup failed: ' + (e.message || e)); } };
  let t = null;
  const arm = () => { t = setTimer(() => { run(); arm(); }, msUntil(hour)); if (t && t.unref) t.unref(); };
  if (!hasBackupFor(dir, dayStamp())) run();
  arm();
  return () => clearTimer(t);
}
