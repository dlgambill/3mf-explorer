import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from '../lib/db.mjs';
import { parseConfigText, validateConfig, BOM } from '../lib/config.mjs';
import { runBackup, scheduleBackups, dayStamp, msUntil } from '../lib/backup.mjs';

// Sprint 4 (1.7.1), operations half: F8 config validation (BOM, types,
// unknown keys, relative paths) and F9 /healthz + nightly backups.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const SERVER = path.join(REPO, 'server.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xsprint4ops-'));
assert.ok(!/^x:/i.test(tmp), 'tests must never run on X:');
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const read = p => fs.readFileSync(path.join(REPO, p), 'utf8');

// ---- F8: config validation ----
test('F8: a BOM is stripped and reported; wrong types fail with the key and the expected type; unknown keys only warn', () => {
  const { raw, bom } = parseConfigText(BOM + '{"port": 7333}');
  assert.equal(bom, true); assert.equal(raw.port, 7333);
  assert.equal(parseConfigText('{"port": 1}').bom, false);
  assert.throws(() => validateConfig({ port: '7333' }), /"port" should be a number \(got string\)/);
  assert.throws(() => validateConfig({ roots: 'D:\\Models' }), /"roots" should be a list of strings \(got string\)/);
  assert.throws(() => validateConfig({ autoArchive: { days: 'a year' } }), /"autoArchive\.days" should be a number/);
  assert.throws(() => validateConfig({ openWith: [{ name: 1 }] }), /"openWith\[0\]\.name" should be a string/);
  assert.throws(() => validateConfig({ hub: 'yes' }), /"hub" should be an object/);
  const { cfg, warnings } = validateConfig({ port: 1, colour: 'red', _help: 'note', hub: { url: '', extra: 1 } });
  assert.deepEqual(warnings, ['config.json: unknown key "colour" is ignored', 'config.json: unknown key "hub.extra" is ignored']);
  assert.equal(cfg.colour, 'red', 'unknown keys are kept, not dropped');
  assert.equal(cfg._help, 'note');
});
test('F8: relative paths resolve against the data folder', () => {
  const dataDir = path.join(tmp, 'data');
  const { cfg } = validateConfig({ roots: ['lib', path.join(tmp, 'abs')], quarantine: '_quarantine', backupDir: 'bk', hub: { dir: 'hub' } }, { dataDir });
  assert.deepEqual(cfg.roots, [path.join(dataDir, 'lib'), path.join(tmp, 'abs')]);
  assert.equal(cfg.quarantine, path.join(dataDir, '_quarantine'));
  assert.equal(cfg.backupDir, path.join(dataDir, 'bk'));
  assert.equal(cfg.hub.dir, path.join(dataDir, 'hub'));
});
test('F8 route: a string where a number is expected stops startup with a clear message', () => {
  const dir = path.join(tmp, 'badcfg');
  write(path.join(dir, 'config.json'), JSON.stringify({ port: '7333', roots: [] }));
  const r = spawnSync(process.execPath, [SERVER], { env: { ...process.env, EXPLORER_DATA: dir }, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /"port" should be a number \(got string\)/);
});

// ---- F9: backups ----
test('F9: runBackup writes library-YYYY-MM-DD.db via VACUUM INTO plus a config copy, and keeps the newest 7', () => {
  const dataDir = path.join(tmp, 'bkdata');
  fs.mkdirSync(dataDir, { recursive: true });
  const cfgPath = path.join(dataDir, 'config.json');
  fs.writeFileSync(cfgPath, '{"port":1}');
  const db = openDb(path.join(dataDir, 'library.db'));
  db.prepare('INSERT INTO meta(k,v) VALUES(?,?)').run('hello', 'world');
  const dir = path.join(dataDir, 'backups');
  const log = [];
  for (let i = 0; i < 9; i++) {
    const r = runBackup({ db, dataDir, cfgPath, now: new Date(2026, 0, 1 + i), log: m => log.push(m) });
    assert.equal(r.dir, dir, 'defaults to backups/ under the data folder');
  }
  const names = fs.readdirSync(dir).sort();
  assert.deepEqual(names.filter(n => n.endsWith('.db')), [3, 4, 5, 6, 7, 8, 9].map(d => `library-2026-01-0${d}.db`));
  assert.deepEqual(names.filter(n => n.endsWith('.json')), [3, 4, 5, 6, 7, 8, 9].map(d => `config-2026-01-0${d}.json`));
  assert.ok(!names.some(n => n.endsWith('.tmp')));
  const copy = openDb(path.join(dir, 'library-2026-01-09.db'));
  assert.equal(copy.prepare('SELECT v FROM meta WHERE k=?').get('hello').v, 'world', 'the copy is a usable database');
  copy.close();
  assert.equal(fs.readFileSync(path.join(dir, 'config-2026-01-09.json'), 'utf8'), '{"port":1}');
  assert.match(log.at(-1), /removed library-2026-01-02\.db/);
  // running twice on one day overwrites rather than failing
  runBackup({ db, dataDir, cfgPath, now: new Date(2026, 0, 9) });
  // a configured folder is honored
  const other = path.join(tmp, 'elsewhere-bk');
  assert.equal(runBackup({ db, dataDir, cfgPath, backupDir: other }).dir, other);
  assert.ok(fs.existsSync(path.join(other, `library-${dayStamp()}.db`)));
  db.close();
});
test('F9: scheduleBackups runs once at startup when today has no backup, then arms a 03:00 timer', () => {
  const dataDir = path.join(tmp, 'bksched');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = openDb(path.join(dataDir, 'library.db'));
  const timers = [];
  const stop = scheduleBackups({ db, dataDir, cfgPath: '' }, { setTimer: (fn, ms) => { timers.push(ms); return 1; }, clearTimer: () => {} });
  assert.ok(fs.existsSync(path.join(dataDir, 'backups', `library-${dayStamp()}.db`)), 'startup backup written');
  assert.equal(timers.length, 1);
  assert.ok(timers[0] > 0 && timers[0] <= 86400000, 'next run within a day');
  const before = fs.statSync(path.join(dataDir, 'backups', `library-${dayStamp()}.db`)).mtimeMs;
  scheduleBackups({ db, dataDir, cfgPath: '' }, { setTimer: () => 1, clearTimer: () => {} });
  assert.equal(fs.statSync(path.join(dataDir, 'backups', `library-${dayStamp()}.db`)).mtimeMs, before, 'a second start today does not back up again');
  stop();
  db.close();
  const noon = new Date(2026, 5, 1, 12, 0, 0);
  assert.equal(msUntil(3, noon), 15 * 3600000);
  assert.equal(msUntil(3, new Date(2026, 5, 1, 2, 59, 0)), 60000);
});

// ---- routes: the server boots on a BOM config and answers /healthz ----
let port, child, out = '';
const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const get = async url => { const r = await fetch(`http://127.0.0.1:${port}${url}`); return { status: r.status, json: await r.json().catch(() => null) }; };

before(async () => {
  port = await freePort();
  const lib = path.join(tmp, 'lib');
  fs.mkdirSync(lib, { recursive: true });
  // F8: the config carries a BOM (as PowerShell 5 writes it) and an unknown key
  fs.writeFileSync(path.join(tmp, 'config.json'), BOM + JSON.stringify({
    port, roots: [lib], fileTypes: ['.stl'], protected: ['template*.3mf'], quarantine: path.join(tmp, 'q'), colour: 'gold',
    autoArchive: { enabled: false, days: 365, everyDays: 30 }, openWith: [], hub: { url: '', dir: '', token: '' },
  }));
  child = spawn(process.execPath, [SERVER], { env: { ...process.env, EXPLORER_DATA: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  for (let i = 0; i < 100 && !out.includes('3MF Explorer'); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(out.includes('3MF Explorer'), 'server started: ' + out);
});
after(() => { try { child.kill(); } catch {} });

test('F8 route: a config.json with a BOM boots, and the BOM and the unknown key are warned about', () => {
  assert.match(out, /byte order mark/);
  assert.match(out, /unknown key "colour" is ignored/);
});
test('F9 route: GET /healthz answers 200 {ok, version, dbOk}', async () => {
  const r = await get('/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.dbOk, true);
  assert.equal(r.json.version, JSON.parse(read('package.json')).version);
});
test('F9 route: a backup for today exists under the data folder after startup', () => {
  assert.ok(fs.existsSync(path.join(tmp, 'backups', `library-${dayStamp()}.db`)));
  assert.ok(fs.existsSync(path.join(tmp, 'backups', `config-${dayStamp()}.json`)));
});

