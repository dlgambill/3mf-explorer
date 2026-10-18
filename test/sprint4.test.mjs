import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renameOrCopy } from '../lib/archive.mjs';

// Sprint 4 (1.7.1), Explorer half: E11 quarantine undo, E12 settings,
// E14 search debounce, E16 cross-device moves. F8/F9 are in
// sprint4-ops.test.mjs and F10 in sprint4-ci.test.mjs.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const SERVER = path.join(REPO, 'server.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xsprint4-'));
assert.ok(!/^x:/i.test(tmp), 'tests must never run on X:');
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const read = p => fs.readFileSync(path.join(REPO, p), 'utf8');
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ---- E16: cross-device move ----
const exdev = () => { const e = new Error('EXDEV: cross-device link not permitted'); e.code = 'EXDEV'; return e; };
test('E16: renameOrCopy falls back to copy + verify + unlink on EXDEV, logging each step', () => {
  const from = path.join(tmp, 'x16', 'a.stl'), to = path.join(tmp, 'x16', 'other-drive', 'a.stl');
  write(from, 'solid big\n' + 'facet\n'.repeat(5000) + 'endsolid big\n');
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const before = sha(from);
  const log = [];
  const ops = { ...fs, renameSync: () => { throw exdev(); } };
  const how = renameOrCopy(from, to, { log: m => log.push(m), ops });
  assert.equal(how, 'copy');
  assert.equal(fs.existsSync(from), false, 'source removed after verify');
  assert.equal(sha(to), before, 'destination is byte-identical');
  assert.match(log[0], /EXDEV, copying/);
  assert.match(log.join('\n'), /size verified/);
  assert.match(log.join('\n'), /sha256 verified/);
  assert.match(log.at(-1), /source removed/);
});
test('E16: a copy that fails verification is removed and the source is left alone', () => {
  const from = path.join(tmp, 'x16b', 'b.stl'), to = path.join(tmp, 'x16b', 'elsewhere', 'b.stl');
  write(from, 'solid b\nendsolid b\n');
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const ops = { ...fs, renameSync: () => { throw exdev(); },
    copyFileSync: (s, d) => fs.writeFileSync(d, 'solid b\n') };   // a short copy
  assert.throws(() => renameOrCopy(from, to, { ops }), /size mismatch.*source left in place|source left in place.*size mismatch/);
  assert.equal(fs.existsSync(from), true, 'source untouched');
  assert.equal(fs.existsSync(to), false, 'bad copy removed - never two copies');
});
test('E16: any other rename error is passed through untouched', () => {
  const ops = { ...fs, renameSync: () => { const e = new Error('EACCES: denied'); e.code = 'EACCES'; throw e; } };
  assert.throws(() => renameOrCopy(path.join(tmp, 'nope'), path.join(tmp, 'nope2'), { ops }), /EACCES/);
});
test('E16: quarantine, moveFile and undo all go through renameOrCopy', () => {
  assert.match(read('server.mjs'), /const how = renameOrCopy\(r\.path, target/);
  assert.match(read('lib/archive.mjs'), /renameOrCopy\(from, to, \{ log \}\);\s+pruneEmpty/);
  assert.match(read('lib/rename.mjs'), /renameOrCopy\(r\.new_path, r\.old_path\)/);
});

// ---- E14: debounce + search column ----
test('E14: the search box is debounced 150 ms, Enter applies at once, and the search column is no longer written', () => {
  const app = read('public/app.js');
  assert.match(app, /qTimer = setTimeout\(\(\) => applyQuery\(e\.target\.value\), 150\)/);
  assert.match(app, /if \(e\.key === 'Enter'\) applyQuery\(e\.target\.value\)/);
  assert.doesNotMatch(app, /oninput = e => \{ S\.q = e\.target\.value; recompute\(\); \}/);
  const scan = read('lib/scan.mjs');
  assert.doesNotMatch(scan, /'indexed_at','search'\]/);
  assert.doesNotMatch(scan, /row\.search =/);
  const db = read('lib/db.mjs');
  assert.doesNotMatch(db, /search=\?/);
  assert.match(db, /search    TEXT/, 'the column stays so old databases open');
});

// ---- routes: E11 and E12 against the real server on a throwaway folder ----
const lib = path.join(tmp, 'lib');
const lib2 = path.join(tmp, 'lib2');
let port, child, out = '';
const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const get = async url => { const r = await fetch(`http://127.0.0.1:${port}${url}`); return { status: r.status, json: await r.json().catch(() => null) }; };
const post = async (url, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const waitScan = async () => {
  for (let i = 0; i < 200; i++) {
    const s = (await get('/api/scan/status')).json;
    if (s && !s.running && s.finishedAt) return s;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('scan did not finish');
};
const F = { keep: path.join(lib, 'D', 'keep.stl'), q: path.join(lib, 'D', 'quarantine-me.stl') };
const STL = 'solid x\nendsolid x\n';

before(async () => {
  port = await freePort();
  for (const p of Object.values(F)) write(p, STL);
  fs.mkdirSync(lib2, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    port, roots: [lib], fileTypes: ['.stl'], protected: ['template*.3mf'], quarantine: path.join(tmp, 'q'),
    autoArchive: { enabled: false, days: 365, everyDays: 30 }, openWith: [], hub: { url: '', dir: '', token: '' },
  }));
  child = spawn(process.execPath, [SERVER], { env: { ...process.env, EXPLORER_DATA: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  for (let i = 0; i < 100 && !out.includes('3MF Explorer'); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(out.includes('3MF Explorer'), 'server started: ' + out);
  await post('/api/scan', {});
  await waitScan();
});
after(() => { try { child.kill(); } catch {} });

test('E11 route: quarantine is a History batch and undo puts the file back', async () => {
  const rows = (await get('/api/rows')).json;
  assert.equal(rows.length, 2, 'both scratch files indexed: ' + out);
  const id = rows.find(r => r.path === F.q).id;
  const q = await post('/api/os/quarantine', { ids: [id] });
  assert.equal(q.json.moved, 1);
  assert.match(q.json.batch, /^quarantine-\d{4}-\d{2}-\d{2}-/);
  const moved = path.join(tmp, 'q', 'quarantine-me.stl');
  assert.equal(fs.existsSync(F.q), false);
  assert.equal(fs.existsSync(moved), true);
  const batches = (await get('/api/rename/batches')).json;
  const b = batches.find(x => x.batch === q.json.batch);
  assert.ok(b, 'History lists the quarantine batch');
  assert.equal(b.n, 1); assert.equal(b.undone, 0);
  const u = await post('/api/rename/undo', { batch: q.json.batch });
  assert.equal(u.json.reverted, 1, JSON.stringify(u.json));
  assert.equal(u.json.rescan, true);
  assert.equal(fs.existsSync(F.q), true, 'file is back');
  assert.equal(fs.existsSync(moved), false);
  await waitScan();
  assert.ok((await get('/api/rows')).json.some(r => r.path === F.q), 'the row is back after the rescan');
  assert.equal((await get('/api/rename/batches')).json.find(x => x.batch === q.json.batch).undone, 1);
  const log = fs.readFileSync(path.join(tmp, '_actions-log.txt'), 'utf8');
  assert.match(log, /\tquarantine\t/); assert.match(log, /\tunquarantine\t/);
});

test('E12 route: everyDays saves; an unchanged folder list does not rescan', async () => {
  const s0 = (await get('/api/settings')).json;
  assert.equal(s0.autoArchive.everyDays, 30);
  const before = (await get('/api/scan/status')).json.finishedAt;
  const r = await post('/api/settings', { roots: s0.roots, fileTypes: s0.fileTypes, protected: s0.protected, quarantine: s0.quarantine,
    autoArchive: { enabled: false, days: 365, everyDays: 14 } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.rescan, false);
  assert.deepEqual(r.json.warnings, []);
  assert.equal((await get('/api/settings')).json.autoArchive.everyDays, 14);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8')).autoArchive.everyDays, 14);
  await new Promise(x => setTimeout(x, 300));
  assert.equal((await get('/api/scan/status')).json.finishedAt, before, 'no scan was started');
  const bad = await post('/api/settings', { roots: s0.roots, autoArchive: { enabled: false, days: 365, everyDays: 0 } });
  assert.equal(bad.status, 500); assert.match(bad.json.error, /Archive every/);
});
test('E12 route: a repeated protected entry is reported, not silently dropped', async () => {
  const s0 = (await get('/api/settings')).json;
  const r = await post('/api/settings', { roots: s0.roots, protected: ['template*.3mf', 'TEMPLATE*.3mf', path.join(lib, 'tool'), path.join(lib, 'tool') + path.sep] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.protected, ['template*.3mf', path.join(lib, 'tool')]);
  assert.equal(r.json.droppedProtected.length, 2);
  assert.match(r.json.warnings[0], /Dropped 2 repeated protected entries/);
  assert.equal(r.json.rescan, false);
});
test('E12 route: a library folder that cannot be reached saves with a warning, and a changed list rescans', async () => {
  const s0 = (await get('/api/settings')).json;
  const missing = path.join(tmp, 'nas-offline');
  const r = await post('/api/settings', { roots: [...s0.roots, lib2, missing] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.roots, [lib, lib2, missing]);
  assert.equal(r.json.warnings.length, 1);
  assert.match(r.json.warnings[0], /Can't reach .*nas-offline.* right now - saved anyway/);
  assert.equal(r.json.rescan, true, 'the folder list changed');
  const st = await waitScan();
  assert.equal(st.pruneSkipped.length, 1, 'the missing folder is skipped for pruning, nothing dropped');
  assert.equal((await get('/api/rows')).json.length, 2);
  const stillBad = await post('/api/settings', { roots: ['not-a-full-path'] });
  assert.equal(stillBad.status, 500); assert.match(stillBad.json.error, /full path/);
});
test('E12: the Settings page has an interval field and shows the server warnings', () => {
  const app = read('public/app.js');
  assert.match(app, /every\.value = aa\.everyDays/);
  assert.match(app, /everyDays: Number\(every\.value\)/);
  assert.match(app, /for \(const w of r\.warnings \|\| \[\]\) notes\.push\(w\)/);
  assert.match(app, /if \(r\.rescan\) rescan\(\)/);
});
