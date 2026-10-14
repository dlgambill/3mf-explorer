import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../lib/db.mjs';
import { scan, walkAsync } from '../lib/scan.mjs';

// E3: prune only on a clean walk. A library folder that is missing (NAS
// offline, drive not mapped yet) or that threw errors part-way through must
// keep its rows - otherwise first_seen and every edit keyed by path is lost.
function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
  const good = path.join(tmp, 'good'), gone = path.join(tmp, 'gone');
  fs.mkdirSync(good);
  const keep = path.join(good, 'keep.stl');
  fs.writeFileSync(keep, 'solid x\nendsolid x\n');
  const st = fs.statSync(keep);
  const db = openDb(path.join(tmp, 'library.db'));
  const ins = db.prepare('INSERT INTO files(path, root, rel, name, ext, size, mtime) VALUES(?,?,?,?,?,?,?)');
  ins.run(keep, good, 'keep.stl', 'keep.stl', '.stl', st.size, Math.floor(st.mtimeMs));
  ins.run(path.join(good, 'deleted.stl'), good, 'deleted.stl', 'deleted.stl', '.stl', 1, 1);
  ins.run(path.join(gone, 'a.stl'), gone, 'a.stl', 'a.stl', '.stl', 1, 1);
  ins.run(path.join(gone, 'sub', 'b.stl'), gone, 'sub/b.stl', 'b.stl', '.stl', 1, 1);
  const paths = () => db.prepare('SELECT path FROM files ORDER BY path').all().map(r => r.path);
  return { tmp, good, gone, keep, db, paths };
}

test('a missing library folder keeps its rows; a clean folder still prunes', async () => {
  const s = setup();
  const st = await scan(s.db, [s.good, s.gone], path.join(s.tmp, 'thumbs'), { exts: ['.stl'] });
  const left = s.paths();
  assert.ok(left.includes(path.join(s.gone, 'a.stl')), 'rows under the missing folder survive');
  assert.ok(left.includes(path.join(s.gone, 'sub', 'b.stl')));
  assert.ok(!left.includes(path.join(s.good, 'deleted.stl')), 'a clean walk still prunes deleted files');
  assert.ok(left.includes(s.keep));
  assert.equal(st.removed, 1);
  assert.deepEqual(st.pruneSkipped.map(x => x.root), [s.gone]);
  s.db.close(); fs.rmSync(s.tmp, { recursive: true, force: true });
});

test('a folder whose walk hit read errors is not pruned at all', async () => {
  const s = setup();
  // A walker that lists nothing and reports one unreadable subfolder - what a
  // NAS hiccup in the middle of a walk looks like from here.
  const flaky = async function* (root, depth, exts, onError) {
    if (root === s.good) { onError?.(path.join(root, 'sub'), new Error('EIO')); return; }
    yield* walkAsync(root, depth, exts, onError);
  };
  const logs = [];
  const st = await scan(s.db, [s.good], path.join(s.tmp, 'thumbs'), { exts: ['.stl'], walk: flaky, log: m => logs.push(m) });
  assert.ok(s.paths().includes(path.join(s.good, 'deleted.stl')), 'nothing pruned after an unclean walk');
  assert.ok(s.paths().includes(s.keep));
  assert.equal(st.removed, 0);
  assert.equal(st.pruneSkipped[0].errors, 1);
  assert.ok(logs.some(m => m === `skipped prune for ${s.good}: 1 errors`), logs.join('|'));
  s.db.close(); fs.rmSync(s.tmp, { recursive: true, force: true });
});

test('walkAsync reports a folder it cannot read instead of swallowing it', async () => {
  const errs = [];
  const missing = path.join(os.tmpdir(), 'no-such-folder-' + Date.now());
  for await (const _ of walkAsync(missing, 0, new Set(['.stl']), (p, e) => errs.push(p))) { /* none */ }
  assert.deepEqual(errs, [missing]);
});
