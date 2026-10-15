import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from '../lib/db.mjs';
import * as ren from '../lib/rename.mjs';
import { pruneEmpty } from '../lib/archive.mjs';
import { makeProtector } from '../lib/protect.mjs';
import { postGuard } from '../lib/guard.mjs';
import { isNetworkPath } from '../lib/drives.mjs';

// Sprint 2 (1.6.1): E4 network-drive delete goes to quarantine, E9 POST
// guard, E15 and the audit gaps (every move checks its destination first).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xsprint2-'));
assert.ok(!/^x:/i.test(tmp), 'tests must never run on X:');
const isProtected = makeProtector([]);
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

// ---- E9 ---------------------------------------------------------------
test('E9: a POST must be application/json (octet-stream for the xlsx import)', () => {
  const r = (ct, url = '/api/os/recycle', extra = {}) => postGuard({ url, headers: { host: '127.0.0.1:7333', 'content-type': ct, ...extra } });
  assert.notEqual(r('text/plain'), '');
  assert.notEqual(r('application/x-www-form-urlencoded'), '');
  assert.notEqual(r(undefined), '');
  assert.equal(r('application/json'), '');
  assert.equal(r('application/json; charset=utf-8'), '');
  assert.equal(r('application/octet-stream', '/api/import/xlsx'), '');
  assert.notEqual(r('text/plain', '/api/import/xlsx'), '');
});
test('E9: an Origin from another site is refused; the app\'s own origin is not', () => {
  const r = (origin, extra = {}, opts) => postGuard({ url: '/api/os/recycle', headers: { host: '127.0.0.1:7333', 'content-type': 'application/json', origin, ...extra } }, opts);
  assert.notEqual(r('http://evil.example'), '');
  assert.notEqual(r('null'), '');
  assert.notEqual(r('http://127.0.0.1:9999'), '');
  assert.equal(r('http://127.0.0.1:7333'), '');
  assert.equal(r('https://3mf.example.net', { 'x-forwarded-host': '3mf.example.net' }), '');
  assert.equal(r('https://lib.example.net', {}, { allowedOrigins: ['https://lib.example.net'] }), '');
});

// ---- E4 unit ----------------------------------------------------------
test('E4: UNC paths and network drive letters are network; unknown means network', () => {
  assert.equal(isNetworkPath('\\\\server\\share\\a.3mf', new Set()), true);
  assert.equal(isNetworkPath('X:\\_MMF\\a.3mf', new Set(['X'])), true);
  assert.equal(isNetworkPath('C:\\Models\\a.3mf', new Set(['X'])), false);
  assert.equal(isNetworkPath('C:\\Models\\a.3mf', null), true, 'when Windows cannot be asked, quarantine');
});

// ---- E15 and the audit gaps -------------------------------------------
test('E15: rename apply never replaces a file that exists at the destination', () => {
  const dir = path.join(tmp, 'e15');
  const a = path.join(dir, 'a.3mf'), b = path.join(dir, 'b.3mf');
  write(a, 'A'); write(b, 'B');
  const db = openDb(path.join(dir, 'lib.db'));
  const id = db.prepare('INSERT INTO files(path, root, rel, folder, name, ext, size, mtime, sha256, first_seen) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(a, dir, 'a.3mf', 'e15', 'a.3mf', '.3mf', 1, 1, 'x', 1).lastInsertRowid;
  const r = ren.apply(db, [{ id, from: a, to: b, status: 'ok' }], isProtected);
  assert.equal(r.renamed, 0);
  assert.equal(r.errors.length, 1);
  assert.equal(fs.readFileSync(a, 'utf8'), 'A');
  assert.equal(fs.readFileSync(b, 'utf8'), 'B');
  db.close();
});
test('audit: rename apply refuses a protected destination name', () => {
  const dir = path.join(tmp, 'e15p');
  const a = path.join(dir, 'a.3mf'), t = path.join(dir, 'u1_template.3mf');
  write(a, 'A');
  const db = openDb(path.join(dir, 'lib.db'));
  const id = db.prepare('INSERT INTO files(path, root, rel, folder, name, ext, size, mtime, sha256, first_seen) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(a, dir, 'a.3mf', 'e15p', 'a.3mf', '.3mf', 1, 1, 'x', 1).lastInsertRowid;
  const r = ren.apply(db, [{ id, from: a, to: t, status: 'ok' }], isProtected);
  assert.equal(r.renamed, 0);
  assert.ok(fs.existsSync(a) && !fs.existsSync(t));
  db.close();
});
test('audit: undo refuses to restore onto a protected name', () => {
  const dir = path.join(tmp, 'undo');
  const now = path.join(dir, 'renamed.3mf'), was = path.join(dir, 'filament_types.3mf');
  write(now, 'N');
  const db = openDb(path.join(dir, 'lib.db'));
  db.prepare('INSERT INTO renames(batch,ts,old_path,new_path,undone) VALUES(?,?,?,?,0)').run('b1', 1, was, now);
  const r = ren.undo(db, 'b1', isProtected);
  assert.equal(r.reverted, 0);
  assert.ok(fs.existsSync(now) && !fs.existsSync(was));
  db.close();
});
test('audit: pruneEmpty never removes a protected folder, even an empty one', () => {
  const root = path.join(tmp, 'prune');
  const tpl = path.join(root, '_templates');
  const bak = path.join(root, 'tool', '_protected_backups');
  const plain = path.join(root, 'Designer', 'Empty');
  for (const d of [tpl, bak, plain]) fs.mkdirSync(d, { recursive: true });
  pruneEmpty(tpl, root, isProtected);
  pruneEmpty(bak, root, isProtected);
  pruneEmpty(plain, root, isProtected);
  assert.ok(fs.existsSync(tpl), '_templates kept');
  assert.ok(fs.existsSync(bak), 'tool/_protected_backups kept');
  assert.ok(!fs.existsSync(plain) && !fs.existsSync(path.dirname(plain)), 'an ordinary empty folder is still tidied');
});

// ---- routes -----------------------------------------------------------
const lib = path.join(tmp, 'lib');
const netRoot = path.join(lib, 'net');
const F = { onNet: path.join(netRoot, 'Designer', 'remote.3mf'), plain: path.join(lib, 'Designer', 'plain.3mf'), csrf: path.join(lib, 'Designer', 'csrf.3mf') };
let port, child, out = '';
const ids = {};
const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const post = async (url, body, headers = { 'content-type': 'application/json' }) => {
  const r = await fetch(`http://127.0.0.1:${port}${url}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};

before(async () => {
  for (const [k, p] of Object.entries(F)) write(p, 'content of ' + k);
  port = await freePort();
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    port, roots: [lib], fileTypes: ['.3mf'], protected: [], quarantine: path.join(tmp, 'q'),
    autoArchive: { enabled: false, days: 365, everyDays: 30 }, openWith: [], hub: { url: '', dir: '', token: '' },
  }));
  child = spawn(process.execPath, [SERVER], { env: { ...process.env, EXPLORER_DATA: tmp, EXPLORER_NETWORK_PREFIXES: netRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  for (let i = 0; i < 100 && !out.includes('3MF Explorer'); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(out.includes('3MF Explorer'), 'server started: ' + out);
  const db = openDb(path.join(tmp, 'library.db'));
  const ins = db.prepare('INSERT INTO files(path, root, rel, folder, name, ext, size, mtime, sha256, first_seen) VALUES(?,?,?,?,?,?,?,?,?,?)');
  let n = 0;
  for (const [k, p] of Object.entries(F)) ids[k] = Number(ins.run(p, lib, path.relative(lib, p), path.basename(path.dirname(p)), path.basename(p), '.3mf', 10, 1, 's' + (n++), 1).lastInsertRowid);
  db.close();
});
after(() => { try { child.kill(); } catch {} });

test('E9 route: a text/plain POST to recycle is refused and nothing moves', async () => {
  const r = await post('/api/os/recycle', { ids: [ids.csrf] }, { 'content-type': 'text/plain' });
  assert.equal(r.status, 403);
  assert.ok(fs.existsSync(F.csrf));
});
test('E9 route: a POST from another site\'s page is refused and nothing moves', async () => {
  const r = await post('/api/os/recycle', { ids: [ids.csrf] }, { 'content-type': 'application/json', origin: 'http://evil.example' });
  assert.equal(r.status, 403);
  assert.ok(fs.existsSync(F.csrf));
});
test('E4 route: Delete on a network drive moves the file to quarantine instead', async () => {
  const r = await post('/api/os/recycle', { ids: [ids.onNet] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.quarantined, 1, JSON.stringify(r.json));
  assert.ok(!fs.existsSync(F.onNet), 'gone from the library folder');
  assert.ok(fs.existsSync(path.join(tmp, 'q', 'remote.3mf')), 'and waiting in quarantine');
});
test('E4 route: /api/config says which library folders are on a network drive', async () => {
  const c = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
  assert.ok(Array.isArray(c.networkRoots));
});
test('audit route: rename-one refuses a protected destination name', async () => {
  const r = await post('/api/os/renameOne', { id: ids.plain, name: 'u1_template' });
  assert.notEqual(r.status, 200);
  assert.ok(fs.existsSync(F.plain));
  assert.ok(!fs.existsSync(path.join(lib, 'Designer', 'u1_template.3mf')));
});
