import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { openDb } from '../lib/db.mjs';

// Route-level protection tests (Sprint 1). The real server runs against a
// throwaway folder (EXPLORER_DATA) with an EMPTY "protected" list in its
// config, so every refusal below comes from the built-in floor (E5). Each
// test posts a protected id or path to a route that moves, renames or
// deletes files, and checks the refusal and that the file is untouched.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xroutes-'));
assert.ok(!/^x:/i.test(tmp), 'route tests must never run on X:');
const lib = path.join(tmp, 'lib');
const F = {
  template:  path.join(lib, 'u1_template.3mf'),
  supports:  path.join(lib, 'Designer', 'u1_template_supports.3mf'),
  filament:  path.join(lib, 'filament_types.3mf'),
  inTpl:     path.join(lib, '_templates', 'base.3mf'),
  backup:    path.join(lib, 'tool', '_protected_backups', 'old.3mf'),
  archived:  path.join(lib, '_archive', 'Designer', 'u1_template.3mf'),
  normal:    path.join(lib, 'Designer', 'normal.3mf'),
};
const PROTECTED = ['template', 'supports', 'filament', 'inTpl', 'backup', 'archived'];
let port, child, out = '', db;
const ids = {};

const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function post(url, body, raw) {
  const r = await fetch(`http://127.0.0.1:${port}${url}`, {
    method: 'POST',
    headers: { 'content-type': raw ? 'application/octet-stream' : 'application/json' },
    body: raw || JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}
const get = async url => (await fetch(`http://127.0.0.1:${port}${url}`)).json();
const untouched = keys => {
  for (const k of keys) assert.equal(fs.readFileSync(F[k], 'utf8'), 'content of ' + k, k + ' must be untouched');
};
const pids = () => PROTECTED.map(k => ids[k]);

before(async () => {
  for (const [k, p] of Object.entries(F)) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'content of ' + k); }
  port = await freePort();
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    port, roots: [lib], fileTypes: ['.3mf'], protected: [], quarantine: path.join(tmp, 'q'),
    autoArchive: { enabled: true, days: 365, everyDays: 30 }, openWith: [], hub: { url: '', dir: '', token: '' },
  }));
  child = spawn(process.execPath, [SERVER], { env: { ...process.env, EXPLORER_DATA: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  for (let i = 0; i < 100 && !out.includes('3MF Explorer'); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(out.includes('3MF Explorer'), 'server started: ' + out);
  // Rows are added after startup, as if indexed before the files became
  // protected - startup reconcile would otherwise drop them, which is the
  // point of protection, but leaves nothing to attack.
  db = openDb(path.join(tmp, 'library.db'));
  const ins = db.prepare('INSERT INTO files(path, root, rel, folder, name, ext, size, mtime, sha256, first_seen) VALUES(?,?,?,?,?,?,?,?,?,?)');
  let n = 0;
  for (const [k, p] of Object.entries(F)) {
    ins.run(p, lib, path.relative(lib, p), path.basename(path.dirname(p)), path.basename(p), '.3mf', 10, 1, 'sha' + (n++), 1);
    ids[k] = db.prepare('SELECT id FROM files WHERE path=?').get(p).id;
  }
});

after(() => {
  child?.kill();
  db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('E5: startup warns that the configured protected list is empty', () => {
  assert.match(out, /"protected" in config\.json is empty - only the built-in floor applies/);
});

test('recycle (Delete) refuses every protected file', async () => {
  const r = await post('/api/os/recycle', { ids: pids() });
  assert.equal(r.status, 200);
  assert.equal(r.json.recycled, 0);
  assert.equal(r.json.blocked, PROTECTED.length);
  untouched(PROTECTED);
});

test('quarantine refuses every protected file', async () => {
  const r = await post('/api/os/quarantine', { ids: pids() });
  assert.equal(r.json.moved, 0);
  assert.equal(r.json.errors.length, PROTECTED.length);
  untouched(PROTECTED);
});

test('renameOne refuses a protected file', async () => {
  for (const k of PROTECTED) {
    const r = await post('/api/os/renameOne', { id: ids[k], name: 'renamed' });
    assert.equal(r.status, 500);
    assert.match(r.json.error, /protected/);
  }
  untouched(PROTECTED);
});

test('rename/apply refuses protected files and refuses a page-built plan outright (E1)', async () => {
  const r = await post('/api/rename/apply', { ids: pids(), pattern: 'renamed {n}' });
  assert.equal(r.json.renamed, 0);
  assert.equal(r.json.errors.length, PROTECTED.length);
  const forged = await post('/api/rename/apply', { plan: [{ id: ids.normal, from: F.normal, to: path.join(tmp, 'escaped.3mf'), status: 'rename' }] });
  assert.equal(forged.status, 500);
  assert.match(forged.json.error, /not accepted/);
  assert.equal(fs.existsSync(path.join(tmp, 'escaped.3mf')), false);
  untouched([...PROTECTED, 'normal']);
});

test('rename/undo leaves a file at a protected path where it is', async () => {
  const away = path.join(lib, 'Designer', 'moved-away.3mf');
  db.prepare('INSERT INTO renames(batch, ts, old_path, new_path, undone) VALUES(?,?,?,?,0)').run('evil-undo', Date.now(), away, F.template);
  const r = await post('/api/rename/undo', { batch: 'evil-undo' });
  assert.equal(r.json.reverted, 0);
  assert.match(r.json.errors[0].error, /protected/);
  assert.equal(fs.existsSync(away), false);
  untouched(['template']);
});

test('archive refuses every protected file', async () => {
  const r = await post('/api/archive', { ids: pids() });
  assert.equal(r.json.moved, 0);
  untouched(PROTECTED);
});

test('unarchive refuses a protected file inside the archive', async () => {
  const r = await post('/api/unarchive', { ids: [ids.archived] });
  assert.equal(r.json.moved, 0);
  assert.match(r.json.errors[0].error, /protected/);
  untouched(['archived']);
});

test('xlsx import Delete column refuses every protected file', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Files');
  ws.addRow(['ID', 'Delete', 'Title', 'Designer', 'Tags']);
  for (const id of pids()) ws.addRow([id, true, '', '', '']);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const r = await post('/api/import/xlsx', null, buf);
  assert.equal(r.status, 200);
  assert.equal(r.json.askedDelete, PROTECTED.length);
  assert.equal(r.json.deleted, 0);
  untouched(PROTECTED);
});

test('E2: archive status reports review and Hub matching; the reviewed run checks the count and never takes a protected file', async () => {
  let st = await get('/api/archive/status');
  assert.equal(st.needsReview, true);
  assert.equal(st.nextRun, null, 'no automatic run is scheduled before the review');
  assert.deepEqual(st.hubLinks, { matched: 0, total: 0 });
  assert.equal(st.wouldArchive, 1, 'only the normal file qualifies');
  const stale = await post('/api/archive/run', { expect: 999 });
  assert.equal(stale.status, 500);
  assert.match(stale.json.error, /count changed/);
  assert.equal(fs.existsSync(F.normal), true);
  const ok = await post('/api/archive/run', { expect: 1 });
  assert.equal(ok.json.moved, 1);
  assert.equal(fs.existsSync(path.join(lib, '_archive', 'Designer', 'normal.3mf')), true);
  st = await get('/api/archive/status');
  assert.equal(st.needsReview, false);
  assert.ok(st.nextRun > Date.now());
  untouched(PROTECTED);
});
