import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveDir, archiveTarget, restoreTarget, isUnder, relKey, eligible, readHubPrints, moveFile } from '../lib/archive.mjs';

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
  const row = (name, extra = {}) => ({ path: j(root, name), rel: name, first_seen: old, last_used: null, tags: [], ...extra });
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
  const prints = new Map([['printed.3mf', recent], ['printed-long-ago.3mf', old]]);
  const got = eligible(rows, { now, days: 365, prints, dir, isProtected: p => p.endsWith('keep.3mf') }).map(r => r.rel);
  assert.deepEqual(got.sort(), ['printed-long-ago.3mf', 'stale.3mf']);
});

test('readHubPrints joins the print log to the models links, newest print wins', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  fs.writeFileSync(path.join(tmp, 'printlog.json'), JSON.stringify({
    u1: { 'a.gcode': 100, 'b.gcode': 50 }, u1max: { 'a.gcode': 300 }, __filaments: { x: 1 },
  }));
  fs.writeFileSync(path.join(tmp, 'models-links.json'), JSON.stringify({
    links: { 'a.gcode': 'U1/Designer/A.3mf', 'b.gcode': 'Designer/A.3mf', 'c.gcode': 'Other.3mf' },
  }));
  const m = readHubPrints(tmp);
  assert.equal(m.get('designer/a.3mf'), 300);
  assert.equal(m.has('other.3mf'), false);
  assert.equal(readHubPrints(path.join(tmp, 'nope')).size, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
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
