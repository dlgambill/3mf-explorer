import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from '../lib/db.mjs';
import { scan } from '../lib/scan.mjs';

// Sprint 3 (1.7.0): E6 slim payloads + gzip, E7 scan problems reach the
// page, E8 every destructive action handles a server error, E10 scan
// efficiency (batched stats, transactions, index, async recycle).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const SERVER = path.join(REPO, 'server.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xsprint3-'));
assert.ok(!/^x:/i.test(tmp), 'tests must never run on X:');
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const read = p => fs.readFileSync(path.join(REPO, p), 'utf8');

// ---- E10 unit: the scan writes in transactions and stats in batches ----
test('E10: scan() batches stats and wraps upserts in transactions', () => {
  const src = read('lib/scan.mjs');
  assert.match(src, /STAT_BATCH = 16/);
  assert.match(src, /Promise\.all\(files\.map\(f => fs\.promises\.stat/);
  assert.match(src, /db\.exec\('BEGIN'\)/);
  assert.match(src, /db\.exec\('COMMIT'\)/);
  assert.match(src, /txEnd\(\);\s+\/\/ E10/);
});
test('E10: renames(new_path) is indexed; recycle no longer uses spawnSync', () => {
  assert.match(read('lib/db.mjs'), /ix_newpath ON renames\(new_path\)/);
  const srv = read('server.mjs');
  assert.doesNotMatch(srv, /spawnSync\('powershell\.exe'/);
  assert.match(srv, /spawn\('powershell\.exe'/);
});
test('E10: a scan over a scratch library still indexes everything and prunes nothing it should keep', async () => {
  const root = path.join(tmp, 'scanlib');
  for (let i = 0; i < 40; i++) write(path.join(root, 'd' + (i % 4), 'f' + i + '.stl'), 'solid x\nendsolid x\n');
  const db = openDb(path.join(tmp, 'scan.db'));
  const st = await scan(db, [root], path.join(tmp, 'thumbs'), { concurrency: 2, exts: ['.stl'], log: () => {} });
  assert.equal(st.added, 40);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM files').get().c, 40);
  const again = await scan(db, [root], path.join(tmp, 'thumbs'), { concurrency: 2, exts: ['.stl'], log: () => {} });
  assert.equal(again.skipped, 40, 'unchanged files are skipped, not re-read');
  assert.equal(again.removed, 0);
  db.close();
});

// ---- E8: the page guards its destructive actions ----
test('E8: previewRename, applyRename, History undo and quarantine catch server errors; toasts unwrap {error}', () => {
  const app = read('public/app.js');
  assert.doesNotMatch(app, /toast\(e\.message/);
  assert.match(app, /showPlan\(await api\('\/api\/rename\/plan', req\), 'Pattern'\);\s+S\.planReq = req;[^}]*\}\s+catch \(e\) \{ toast\(errText\(e\), true\); \}/);
  assert.match(app, /try \{ r = await api\('\/api\/rename\/apply'/);
  assert.match(app, /try \{ r = await api\(undoUrl, \{ batch: b\.batch \}\); \}/);
  assert.match(app, /try \{ r = await api\('\/api\/os\/quarantine', \{ ids \}\); \}/);
});
// ---- E7: scan problems reach the page ----
test('E7: after a scan the page reports failed files and skipped prunes', () => {
  const app = read('public/app.js');
  assert.match(app, /could not be read/);
  assert.match(app, /unreachable, rows kept/);
  assert.match(app, /Scan finished with problems/);
});

// ---- routes: E6 ----
const lib = path.join(tmp, 'lib');
let port, child, out = '';
const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const get = async (url, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${url}`, { headers });
  return { status: r.status, headers: r.headers, json: await r.json().catch(() => null) };
};

before(async () => {
  port = await freePort();
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    port, roots: [lib], fileTypes: ['.3mf'], protected: [], quarantine: path.join(tmp, 'q'),
    autoArchive: { enabled: false, days: 365, everyDays: 30 }, openWith: [], hub: { url: '', dir: '', token: '' },
  }));
  fs.mkdirSync(lib, { recursive: true });
  child = spawn(process.execPath, [SERVER], { env: { ...process.env, EXPLORER_DATA: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  for (let i = 0; i < 100 && !out.includes('3MF Explorer'); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(out.includes('3MF Explorer'), 'server started: ' + out);
  const db = openDb(path.join(tmp, 'library.db'));
  const ins = db.prepare('INSERT INTO files(path, root, rel, folder, name, ext, size, mtime, sha256, geom, description, first_seen) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  const long = 'd'.repeat(2000);
  for (let i = 0; i < 300; i++) {
    const p = path.join(lib, 'D' + (i % 7), 'file' + i + '.3mf');
    write(p, 'x' + i);
    // files 0..9 share one sha (an exact dupe group); 20..24 share a geometry
    const sha = i < 10 ? 'same-sha' : 'sha' + i;
    const geom = (i >= 20 && i < 25) ? 'same-geom' : 'geom' + i;
    ins.run(p, lib, path.relative(lib, p), 'D' + (i % 7), 'file' + i + '.3mf', '.3mf', 10 + i, 1, sha, geom, long, 1);
  }
  db.close();
});
after(() => { try { child.kill(); } catch {} });

test('E6 route: /api/rows is gzipped when the client accepts it, plain when it does not', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/rows`, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-encoding'), 'gzip');
  const raw = Buffer.from(await r.arrayBuffer());
  // undici decompresses for us unless we ask for the raw bytes; check both ways
  const text = (raw[0] === 0x1f && raw[1] === 0x8b) ? zlib.gunzipSync(raw).toString() : raw.toString();
  const rows = JSON.parse(text);
  assert.equal(rows.length, 300);
  const r2 = await fetch(`http://127.0.0.1:${port}/api/rows`, { headers: { 'accept-encoding': 'identity' } });
  assert.equal(r2.headers.get('content-encoding'), null);
});
test('E6 route: the list carries at most 400 characters of description; /api/row has it all', async () => {
  const rows = (await get('/api/rows', { 'accept-encoding': 'identity' })).json;
  assert.ok(rows.every(r => String(r.description || '').length <= 400));
  const one = (await get('/api/row?id=' + rows[0].id)).json;
  assert.equal(one.description.length, 2000);
});
test('E6 route: /api/dupes sends ids, not rows', async () => {
  const groups = (await get('/api/dupes')).json;
  assert.ok(Array.isArray(groups) && groups.length === 2, JSON.stringify(groups).slice(0, 200));
  for (const g of groups) {
    assert.ok(Array.isArray(g.ids) && g.ids.length > 1);
    assert.equal(g.files, undefined);
    assert.ok(['exact', 'geometry'].includes(g.kind));
    assert.equal(typeof g.wasted, 'number');
  }
  assert.equal(groups.find(g => g.kind === 'exact').ids.length, 10);
  assert.equal(groups.find(g => g.kind === 'geometry').ids.length, 5);
});
test('E6 route: small answers are not gzipped', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/scan/status`, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(r.headers.get('content-encoding'), null);
});
