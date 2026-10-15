import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveDir, archiveTarget, restoreTarget, isUnder, relKey, absKey, eligible, readHubPrints, hubLinkStats, moveFile } from '../lib/archive.mjs';

const isWin = process.platform === 'win32';
const root = isWin ? 'D:\\Models' : '/models';
const other = isWin ? 'E:\\More' : '/more';
const j = (...p) => path.join(...p);
const DAY = 86400000;

test('archive folder defaults to _archive inside the first library folder', () => {
  assert.equal(archiveDir({ roots: [root, other] }), j(root, '_archive'));
  assert.equal(archiveDir({ roots: [root], archive: j(root, 'Old') }), j(root, 'Old'));
  assert.equal(archiveDir({ roots: [] }), null);
});

test('isUnder is case-insensitive and does not match a sibling with the same prefix', () => {
  assert.equal(isUnder(j(root, '_archive', 'a.3mf'), j(root, '_ARCHIVE')), true);
  assert.equal(isUnder(j(root, '_archive2', 'a.3mf'), j(root, '_archive')), false);
  assert.equal(isUnder(j(root, '_archive'), j(root, '_archive')), true);
  assert.equal(isUnder(null, root), false);
  assert.equal(isUnder(j(root, 'a'), null), false);
});

test('archiveTarget mirrors the path inside the library folder', () => {
  const dir = j(root, '_archive');
  assert.equal(archiveTarget(j(root, 'Designer', 'Set', 'a.3mf'), [root], dir), j(dir, 'Designer', 'Set', 'a.3mf'));
  // a file from another library folder keeps that folder's name as a prefix
  assert.equal(archiveTarget(j(other, 'b.stl'), [root, other], dir), j(dir, path.basename(other), 'b.stl'));
  assert.throws(() => archiveTarget(j(isWin ? 'C:\\' : '/', 'elsewhere', 'c.3mf'), [root], dir), /not inside/);
});

test('restoreTarget is the inverse of archiveTarget', () => {
  const dir = j(root, '_archive');
  for (const f of [j(root, 'Designer', 'Set', 'a.3mf'), j(other, 'sub', 'b.stl')]) {
    const a = archiveTarget(f, [root, other], dir);
    assert.equal(restoreTarget(a, [root, other], dir), f);
  }
});

test('relKey folds slashes, case and the U1/ copy folder together', () => {
  assert.equal(relKey('U1\\Designer\\A.3mf'), 'designer/a.3mf');
  assert.equal(relKey('Designer/A.3mf'), 'designer/a.3mf');
  assert.equal(relKey(null), '');
});

test('eligible only picks files that have sat a full year unprinted and unused', () => {
  const now = Date.UTC(2027, 9, 1);
  const old = now - 400 * DAY, recent = now - 20 * DAY;
  const dir = j(root, '_archive');
  const row = (name, extra = {}) => ({ path: j(root, name), root, rel: name, first_seen: old, last_used: null, tags: [], ...extra });
  const rows = [
    row('stale.3mf'),
    row('new.3mf', { first_seen: recent }),
    row('never-seen.3mf', { first_seen: null }),
    row('opened.3mf', { last_used: recent }),
    row('printed.3mf'),
    row('printed-long-ago.3mf'),
    row('queued.3mf', { tags: ['for-print'] }),
    row('keep.3mf'),
    { path: j(dir, 'already.3mf'), rel: '_archive/already.3mf', first_seen: old, tags: [] },
  ];
  const prints = new Map([[absKey(root, 'printed.3mf'), recent], [absKey(root, 'printed-long-ago.3mf'), old]]);
  const got = eligible(rows, { now, days: 365, prints, dir, isProtected: p => p.endsWith('keep.3mf') }).map(r => r.rel);
  assert.deepEqual(got.sort(), ['printed-long-ago.3mf', 'stale.3mf']);
});

// E2: print history is keyed by absolute path - the Hub's models folder
// (from its config.json) plus the link, against the Explorer root plus rel.
function hubFixture(modelsFolder) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ models: { folder: modelsFolder, explorerToken: 'x' } }));
  fs.writeFileSync(path.join(tmp, 'printlog.json'), JSON.stringify({
    u1: { 'a.gcode': 100, 'b.gcode': 50 }, u1max: { 'a.gcode': 300 }, __filaments: { x: 1 },
  }));
  fs.writeFileSync(path.join(tmp, 'models-links.json'), JSON.stringify({
    links: { 'a.gcode': 'U1/Designer/A.3mf', 'b.gcode': 'Designer/A.3mf', 'c.gcode': 'Other.3mf', 'd.gcode': 'Never.3mf' },
  }));
  return tmp;
}

test('readHubPrints joins the print log to the models links by absolute path, newest print wins', () => {
  const models = fs.mkdtempSync(path.join(os.tmpdir(), 'models-'));
  const hub = hubFixture(models);
  const m = readHubPrints(hub);
  assert.equal(m.get(absKey(models, 'Designer/A.3mf')), 300);
  assert.equal(m.has(absKey(models, 'Other.3mf')), false);   // linked, never printed
  assert.equal(m.has('designer/a.3mf'), false);               // no relative keys any more
  assert.equal(m.total, 1);                                   // distinct printed files
  assert.equal(readHubPrints(path.join(hub, 'nope')).size, 0);
  fs.rmSync(hub, { recursive: true, force: true });
  fs.rmSync(models, { recursive: true, force: true });
});

test('the same folder reached two ways (drive letter vs share) still matches; a different folder does not', () => {
  const models = fs.mkdtempSync(path.join(os.tmpdir(), 'models-'));
  const alias = models + '-alias';
  fs.symlinkSync(models, alias, 'junction');   // stands in for X:\_MMF -> \\nas\share\_MMF
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'other-'));
  const hub = hubFixture(models);
  fs.writeFileSync(path.join(hub, 'printlog.json'), JSON.stringify({ u1: { 'a.gcode': 400 * DAY } }));
  const prints = readHubPrints(hub);
  const row = r => ({ path: path.join(r, 'Designer', 'A.3mf'), root: r, rel: path.join('Designer', 'A.3mf'), first_seen: 1, tags: [] });
  const elig = r => eligible([row(r)], { now: 401 * DAY, days: 30, prints, dir: path.join(r, '_archive') }).length;
  assert.equal(elig(alias), 0, 'printed via the Hub, seen through the alias: not eligible');
  assert.equal(elig(other), 1, 'same relative path in an unrelated folder must not borrow the print');
  assert.deepEqual(hubLinkStats(prints, [row(alias)]), { matched: 1, total: 1 });
  assert.deepEqual(hubLinkStats(prints, [row(other)]), { matched: 0, total: 1 });
  // a junction is a directory on Windows (rmdir), a symlink on Linux/macOS (unlink); both leave the target alone
  try { fs.rmdirSync(alias); } catch { fs.unlinkSync(alias); }
  for (const d of [hub, models, other]) fs.rmSync(d, { recursive: true, force: true });
});

test('moveFile refuses to overwrite and tidies only the folders it emptied', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
  const lib = path.join(tmp, 'lib');
  fs.mkdirSync(path.join(lib, 'D', 'Set'), { recursive: true });
  fs.mkdirSync(path.join(lib, 'D', 'Keep'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'D', 'Set', 'a.3mf'), 'x');
  fs.writeFileSync(path.join(lib, 'D', 'Keep', 'k.3mf'), 'k');
  const to = path.join(lib, '_archive', 'D', 'Set', 'a.3mf');
  moveFile(path.join(lib, 'D', 'Set', 'a.3mf'), to, lib);
  assert.equal(fs.readFileSync(to, 'utf8'), 'x');
  assert.equal(fs.existsSync(path.join(lib, 'D', 'Set')), false);   // emptied, removed
  assert.equal(fs.existsSync(path.join(lib, 'D')), true);           // still has Keep
  fs.writeFileSync(path.join(lib, 'D', 'Keep', 'a.3mf'), 'y');
  assert.throws(() => moveFile(path.join(lib, 'D', 'Keep', 'a.3mf'), to, lib), /already exists/);
  assert.equal(fs.readFileSync(to, 'utf8'), 'x');
  fs.rmSync(tmp, { recursive: true, force: true });
});
